from collections import defaultdict
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func

from app.cache import (
    MMCA_PREDICTION_TTL_FUTURE_SECONDS,
    MMCA_PREDICTION_TTL_TODAY_SECONDS,
    get_mmca_exhibitions,
    get_mmca_prediction,
    get_mmca_weekly_profile,
    revive,
    set_mmca_exhibitions,
    set_mmca_prediction,
    set_mmca_weekly_profile,
)
# 개관 시각·야간개장 요일·주간 휴관 요일은 수집기가 이미 갖고 있다. 값을 옮겨
# 적으면 그 순간부터 둘이 갈라지므로 import 한다 — scripts/purge_out_of_hours_mmca.py
# 가 _is_venue_open 을 재구현하지 않는 것과 같은 규율이다. _is_venue_open 자체를
# 쓰지 않는 이유는 _in_profile_window 의 주석에 있다.
from app.collector import (
    _COLLECTION_START,
    _LONG_CLOSE,
    _LONG_DAYS,
    _NORMAL_CLOSE,
    _VENUE_CLOSED_DAYS,
)
from app.config import MMCA_SPACE_NAMES, settings
from app.db import SessionLocal
from app.mmca_exhibitions import current_exhibitions, fetch_exhibitions
from app.models import RawMmcaCongestion
from app.prediction.mmca import (
    MIN_SAMPLE_DAYS,
    PROFILE_WINDOW_DAYS,
    RAMP_MINUTES,
    build_profile,
    curve,
    sample_days,
    seam,
    today_shift,
)
from app.schemas import (
    MmcaDailyLogPoint,
    MmcaDailyRoom,
    MmcaExhibition,
    MmcaPredictionPoint,
    MmcaRoomPrediction,
    MmcaRoomStatus,
    MmcaWeeklyProfile,
    MmcaWeeklyProfileCell,
    MmcaWeeklyProfileRoom,
)

router = APIRouter()

# observed_at is always stored pinned to Asia/Seoul (see collector.py,
# mmca_api.py) — a naive datetime.now() would use the server's OS timezone
# instead, misaligning "today" whenever the server isn't KST (e.g. a UTC
# container).
_SEOUL_TZ = ZoneInfo("Asia/Seoul")


@router.get("/mmca/rooms", response_model=list[MmcaRoomStatus])
def mmca_rooms(venue: str) -> list[MmcaRoomStatus]:
    codes = settings.mmca_venue_space_codes.get(venue)
    if codes is None:
        raise HTTPException(status_code=400, detail=f"unknown venue: {venue}")

    with SessionLocal() as session:
        codes_with_history = {
            row[0]
            for row in session.query(RawMmcaCongestion.space_code)
            .filter(RawMmcaCongestion.space_code.in_(codes))
            .distinct()
            .all()
        }

        if not codes_with_history:
            raise HTTPException(status_code=503, detail="no MMCA congestion data yet")

        # A room can have history from earlier days but nothing yet today
        # (e.g. business hours just started, before the collector's first
        # poll) — only ever surface a *today* reading, never fall back to a
        # stale prior-day value.
        day_start = datetime.now(_SEOUL_TZ).replace(
            tzinfo=None, hour=0, minute=0, second=0, microsecond=0
        )
        latest_ids = [
            row[0]
            for row in session.query(func.max(RawMmcaCongestion.id))
            .filter(
                RawMmcaCongestion.space_code.in_(codes_with_history),
                RawMmcaCongestion.observed_at >= day_start,
            )
            .group_by(RawMmcaCongestion.space_code)
            .all()
        ]
        rows = session.query(RawMmcaCongestion).filter(RawMmcaCongestion.id.in_(latest_ids)).all()

    rows_by_code = {row.space_code: row for row in rows}
    return [
        MmcaRoomStatus(
            space_code=code,
            space_nm=(rows_by_code[code].space_nm if code in rows_by_code else None)
            or MMCA_SPACE_NAMES.get(code),
            congestion_nm=rows_by_code[code].congestion_nm if code in rows_by_code else None,
            observed_at=rows_by_code[code].observed_at.isoformat() if code in rows_by_code else None,
        )
        for code in sorted(codes_with_history)
    ]


@router.get("/mmca/daily", response_model=list[MmcaDailyLogPoint])
def mmca_daily(venue: str, date: str | None = Query(default=None)) -> list[MmcaDailyLogPoint]:
    codes = settings.mmca_venue_space_codes.get(venue)
    if codes is None:
        raise HTTPException(status_code=400, detail=f"unknown venue: {venue}")

    if date is None:
        day_start = datetime.now(_SEOUL_TZ).replace(
            tzinfo=None, hour=0, minute=0, second=0, microsecond=0
        )
    else:
        try:
            day_start = datetime.strptime(date, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="date must be in YYYY-MM-DD format")
    day_end = day_start + timedelta(days=1)

    with SessionLocal() as session:
        rows = (
            session.query(RawMmcaCongestion)
            .filter(
                RawMmcaCongestion.space_code.in_(codes),
                RawMmcaCongestion.observed_at >= day_start,
                RawMmcaCongestion.observed_at < day_end,
            )
            .order_by(RawMmcaCongestion.observed_at.asc())
            .all()
        )

    # 한 라운드의 판독은 collector 가 전부 라운드 격자 마크로 찍어 두므로
    # (collect_mmca_once 의 round_time) 분 버킷이 곧 라운드다 — 라운드가 분
    # 경계를 넘어도 갈리지 않는다.
    buckets: dict[datetime, dict[str, RawMmcaCongestion]] = defaultdict(dict)
    for row in rows:
        bucket_key = row.observed_at.replace(second=0, microsecond=0)
        buckets[bucket_key][row.space_code] = row

    return [
        MmcaDailyLogPoint(
            observed_at=bucket_time.isoformat(),
            rooms=[
                MmcaDailyRoom(
                    space_code=code,
                    space_nm=(row.space_nm if (row := buckets[bucket_time].get(code)) else None)
                    or MMCA_SPACE_NAMES.get(code),
                    congestion_nm=row.congestion_nm if row else None,
                )
                for code in codes
            ],
        )
        for bucket_time in sorted(buckets)
    ]


# 영업시간의 최대 범위. 수/토는 21시 폐관, 그 외는 18시다. 여기서 좁히지 않고
# 프로파일에 셀이 있는 시각만 나가게 둔다 — 화요일 19시 셀은 애초에 없으므로
# 자기 제한적이고, 최종 클립은 프론트의 open/close 가 한다.
_PREDICTION_HOURS = range(10, 22)


def _now_seoul() -> datetime:
    """KST 벽시계의 현재 시각 (naive).

    별도 함수인 이유는 테스트가 몽키패치할 자리가 필요해서다 — 오늘 곡선은
    "최근 120분"에 매달려 있어, 심어 둔 판독이 실행 시각의 앵커 창 밖으로
    나가면 `anchored` 가 벽시계에 따라 흔들린다. routes/prediction.py 의
    _today_seoul() 과 같은 형태다.
    """
    return datetime.now(_SEOUL_TZ).replace(tzinfo=None)


@router.get("/mmca/prediction", response_model=list[MmcaRoomPrediction])
def mmca_prediction(venue: str, date: str | None = Query(default=None)) -> list[MmcaRoomPrediction]:
    codes = settings.mmca_venue_space_codes.get(venue)
    if codes is None:
        raise HTTPException(status_code=400, detail=f"unknown venue: {venue}")

    now = _now_seoul()
    if date is None:
        target = now.date()
    else:
        try:
            target = datetime.strptime(date, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(status_code=400, detail="date must be in YYYY-MM-DD format")

    # 과거 날짜는 예측하지 않는다. 프로파일 창이 "오늘 −14일"이라 과거 타깃에는
    # 그 날짜 이후 데이터가 섞여 look-ahead 곡선이 된다. 그 날의 실제 기록은
    # /mmca/daily 에 이미 있고, 회고 예측은 백테스트 스크립트의 몫이다.
    if target < now.date():
        return []

    cached = revive(get_mmca_prediction(venue, target.isoformat()), MmcaRoomPrediction)
    if cached is not None:
        return cached

    is_today = target == now.date()
    window_start = now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(
        days=PROFILE_WINDOW_DAYS
    )
    day_start = datetime.combine(now.date(), datetime.min.time())

    with SessionLocal() as session:
        profile_rows = (
            session.query(RawMmcaCongestion)
            .filter(
                RawMmcaCongestion.space_code.in_(codes),
                RawMmcaCongestion.observed_at >= window_start,
                RawMmcaCongestion.observed_at < day_start,
                RawMmcaCongestion.congestion_nm.isnot(None),
            )
            .all()
        )
        today_rows = (
            session.query(RawMmcaCongestion)
            .filter(
                RawMmcaCongestion.space_code.in_(codes),
                RawMmcaCongestion.observed_at >= day_start,
                RawMmcaCongestion.congestion_nm.isnot(None),
            )
            .order_by(RawMmcaCongestion.observed_at.asc())
            .all()
            if is_today
            else []
        )

    profile = build_profile(profile_rows)
    days_by_code = sample_days(profile_rows)
    shifts = today_shift(profile, today_rows, now=now) if is_today else {}

    # 램프의 출발점. 마지막 판독 하나가 아니라 그 판독이 속한 마크의 평균이다 —
    # 이유는 prediction/mmca.py 의 seam() 에 있다.
    latest = seam(today_rows) if is_today else {}

    now_minutes = now.hour * 60 + now.minute
    if is_today:
        # 지나간 시각에 점선을 그리지 않는다. last 를 떨어뜨렸을 때
        # curve 가 10~21시 전부를 내는 것도 이 필터가 막는다.
        hours = [hour for hour in _PREDICTION_HOURS if hour * 60 >= now_minutes]
    else:
        hours = list(_PREDICTION_HOURS)

    names = {row.space_code: row.space_nm for row in profile_rows if row.space_nm}
    result: list[MmcaRoomPrediction] = []
    for code in sorted(codes):
        if days_by_code.get(code, 0) < MIN_SAMPLE_DAYS:
            continue
        shift = shifts.get(code)
        last = latest.get(code) if is_today else None
        # 램프의 측정된 유효 범위는 판독으로부터 90분이다. 그보다 낡은 점은
        # 어차피 weight=1.0 이라 곡선에 기여하지 않으면서, 수집기 장애 구간을
        # 가로지르는 가짜 이음매만 만든다.
        #
        # 이 창(90분)은 anchored 를 정하는 창(ANCHOR_WINDOW_MINUTES, 120분)과
        # 일부러 다르다. 두 값이 각각 독립적으로 측정돼 확정됐고 서로 다른
        # 질문에 답한다 — 90분은 "이 판독에서 램프를 시작해도 되는가",
        # 120분은 "오늘 수준으로 곡선을 옮겨도 되는가". 그래서 마지막 판독이
        # 90~120분 낡은 좁은 구간에서는 anchored:true 이면서 램프 없이 보정된
        # 프로파일에서 곡선이 시작한다. 이는 결함이 아니다: 편차는 실제로
        # 오늘 판독에서 나왔고(범례의 "오늘 반영"이 정확하다), 실선이 끝난
        # 지점과 점선이 시작하는 지점 사이의 빈 구간이 곧 그 시간 동안
        # 수집이 없었다는 사실이다. 한쪽 상수를 다른 쪽에 맞추지 말 것 —
        # 그러려면 scripts/backtest_mmca_prediction.py 로 다시 재야 한다.
        if last is not None and now_minutes - last[0] > RAMP_MINUTES:
            last = None
        points = curve(
            profile,
            code,
            target,
            hours=hours,
            shift=shift if shift is not None else 0.0,
            last=last,
        )
        # 점 하나로는 프론트가 경로를 그릴 수 없다 (smoothPath 는 2점 이상 필요) —
        # 폐관 직후처럼 이음매만 살아남은 방은 통째로 빼야, 프론트가 조용히
        # 버리는 대신 애초에 응답에 없는 방이 된다.
        if len(points) <= 1:
            continue
        result.append(
            MmcaRoomPrediction(
                space_code=code,
                space_nm=names.get(code) or MMCA_SPACE_NAMES.get(code),
                anchored=shift is not None,
                sample_days=days_by_code[code],
                points=[
                    MmcaPredictionPoint(
                        observed_at=datetime.combine(target, datetime.min.time())
                        .replace(hour=p.minutes // 60, minute=p.minutes % 60)
                        .isoformat(),
                        tier=p.tier,
                        label=p.label,
                    )
                    for p in points
                ],
            )
        )

    set_mmca_prediction(
        venue,
        target.isoformat(),
        [room.model_dump() for room in result],
        MMCA_PREDICTION_TTL_TODAY_SECONDS if is_today else MMCA_PREDICTION_TTL_FUTURE_SECONDS,
    )
    return result


@router.get("/mmca/exhibitions", response_model=list[MmcaExhibition])
def mmca_exhibitions(venue: str) -> list[MmcaExhibition]:
    if venue not in settings.mmca_venue_space_codes:
        raise HTTPException(status_code=400, detail=f"unknown venue: {venue}")

    cached = revive(get_mmca_exhibitions(venue), MmcaExhibition)
    if cached is not None:
        return cached

    # 한 번 부르면 세 관의 목록이 한꺼번에 나온다. 관마다 따로 캐시에 넣어야
    # 다른 관 페이지가 같은 호출을 반복하지 않는다 — 전시가 없는 관도 빈
    # 목록으로 넣는다.
    with httpx.Client() as client:
        by_venue = current_exhibitions(fetch_exhibitions(client))

    for venue_id, exhibitions in by_venue.items():
        set_mmca_exhibitions(venue_id, [vars(e) for e in exhibitions])
    return [MmcaExhibition(**vars(e)) for e in by_venue.get(venue, [])]


def _in_profile_window(venue: str, stamp: datetime) -> bool:
    """이 판독이 요일 × 시각 프로파일에 들어가는가.

    두 가지를 건다.

    **주간 휴관 요일은 통째로 뺀다.** _is_venue_open 을 그대로 쓰지 않는 이유가
    이것이다 — 그쪽은 공휴일 월요일을 "열림"으로 판정하는 것이 옳고(실제로 문을
    연다), 여기서는 그 하루가 "월요일" 행 전체가 되는 것이 문제다. 과천관
    월요일 판독은 2026-08-17 하루뿐이고 그날은 광복절 대체공휴일이라 평소보다
    붐볐다 — 그대로 두면 평소 문을 닫는 요일이 그 관의 가장 붐비는 시각으로
    뽑힌다. 행이 아예 없는 편이 맞다.

    **정시가 개관 시간에 온전히 들어갈 때만 센다.** 한 시간을 한 칸으로 평균
    내므로, 폐관 정각이 걸친 칸은 판독 한둘로 값이 낮게 깔린 채 "가장 한산한
    시각"으로 뽑힌다(routes/congestion.py 의 _full_hour_open 과 같은 이유).
    남는 것은 과천관 10~17시, 야간개장이 있는 서울관은 수·토에 10~20시다.
    """
    if stamp.weekday() in _VENUE_CLOSED_DAYS.get(venue, set()):
        return False
    close = _LONG_CLOSE if stamp.weekday() in _LONG_DAYS.get(venue, set()) else _NORMAL_CLOSE
    open_minutes = _COLLECTION_START.hour * 60 + _COLLECTION_START.minute
    close_minutes = close.hour * 60 + close.minute
    return stamp.hour * 60 >= open_minutes and (stamp.hour + 1) * 60 <= close_minutes


@router.get("/mmca/weekly-profile", response_model=MmcaWeeklyProfile)
def mmca_weekly_profile(venue: str) -> MmcaWeeklyProfile:
    """수집 전체 기간의 (요일, 시각) 평균 등급 — 관 단위 한 장과 전시실별 한 장씩.

    서울시 쪽(/congestion/weekly-profile)과 같은 목적이지만 축이 하나 더 있다.
    값이 방마다 따로 나오므로 관 단위 칸은 **방 평균들의 평균**이다 — 판독이
    많은 방이 가중치를 더 갖지 않는다. 방 자체는 MIN_SAMPLE_DAYS 로 거른다.
    예측이 쓰는 것과 같은 게이트이며, 전시가 없어 혼잡도를 주지 않는 방이 상시로
    있기 때문에 필요하다.

    창은 예측의 14일(PROFILE_WINDOW_DAYS)이 아니라 수집 전체다. 그 14일은
    백테스트가 *예측 오차*로 고른 값이고, 여기 목적은 요일 성격의 *설명*이다.

    덕수궁관을 따로 막지 않는다 — 판독이 전부 혼잡도 없는 값이라 프로파일이
    비고, 그대로 collecting 으로 나간다. 없는 조건에 가드를 세우지 않는다.
    """
    codes = settings.mmca_venue_space_codes.get(venue)
    if codes is None:
        raise HTTPException(status_code=400, detail=f"unknown venue: {venue}")

    # revive 를 거치는 이유는 그 docstring 에 적힌 그대로다 — 배포로 모델에
    # 필드가 하나 늘면 직전 버전이 써 둔 payload 는 되살아나지 않고, 그대로
    # 생성자에 넣으면 TTL 이 다 될 때까지 여섯 시간 동안 모든 요청이 500 이
    # 된다. 캐시는 버려도 되는 값이므로 못 읽으면 없는 값으로 친다.
    cached = revive(get_mmca_weekly_profile(venue), MmcaWeeklyProfile)
    if cached is not None:
        return cached

    with SessionLocal() as session:
        rows = (
            session.query(RawMmcaCongestion)
            .filter(RawMmcaCongestion.space_code.in_(codes))
            .order_by(RawMmcaCongestion.observed_at.asc())
            .all()
        )

    window = [row for row in rows if _in_profile_window(venue, row.observed_at)]
    days_by_code = sample_days(window)
    kept = {code for code, days in days_by_code.items() if days >= MIN_SAMPLE_DAYS}
    counted = [row for row in window if row.space_code in kept and row.congestion_nm is not None]
    if not counted:
        # 캐시하지 않는다 — 수집이 시작되면 풀리는 상태다(congestion 쪽과 같다).
        return MmcaWeeklyProfile(status="collecting", cells=[], rooms=[])

    profile = build_profile(counted)

    by_room: dict[str, list[MmcaWeeklyProfileCell]] = defaultdict(list)
    venue_cells: dict[tuple[int, int], list[float]] = defaultdict(list)
    for (space_code, weekday, hour), rank in sorted(profile.items()):
        by_room[space_code].append(
            MmcaWeeklyProfileCell(weekday=weekday, hour=hour, rank=round(rank, 2))
        )
        venue_cells[(weekday, hour)].append(rank)

    result = MmcaWeeklyProfile(
        status="ready",
        since=counted[0].observed_at.date().isoformat(),
        until=counted[-1].observed_at.date().isoformat(),
        samples=len(counted),
        cells=[
            MmcaWeeklyProfileCell(
                weekday=weekday, hour=hour, rank=round(sum(ranks) / len(ranks), 2)
            )
            for (weekday, hour), ranks in sorted(venue_cells.items())
        ],
        rooms=[
            MmcaWeeklyProfileRoom(
                space_code=code, space_nm=MMCA_SPACE_NAMES.get(code), cells=by_room[code]
            )
            for code in sorted(by_room)
        ],
    )
    set_mmca_weekly_profile(venue, result.model_dump())
    return result
