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
    set_mmca_exhibitions,
    set_mmca_prediction,
)
from app.config import MMCA_DISABLED_SPACE_CODES, MMCA_SPACE_NAMES, settings
from app.db import SessionLocal
from app.mmca_exhibitions import current_exhibitions, fetch_exhibitions
from app.models import RawMmcaCongestion
from app.prediction.mmca import (
    CONGESTION_RANKS,
    MIN_SAMPLE_DAYS,
    PROFILE_WINDOW_DAYS,
    RAMP_MINUTES,
    build_profile,
    curve,
    sample_days,
    today_shift,
)
from app.schemas import (
    MmcaDailyLogPoint,
    MmcaExhibition,
    MmcaDailyRoom,
    MmcaPredictionPoint,
    MmcaRoomPrediction,
    MmcaRoomStatus,
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

        # Disabled rooms must always render their "서비스 예정" placeholder,
        # regardless of whether they happen to have historical rows from
        # before they were disabled — don't let that appear/disappear based
        # on data retention.
        codes_to_return = codes_with_history | (set(codes) & MMCA_DISABLED_SPACE_CODES)

        if not codes_with_history:
            if all(code in MMCA_DISABLED_SPACE_CODES for code in codes):
                # Every room this venue has is permanently disabled (e.g.
                # Deoksugung's only code, MMCA-SPACE-4001) — collection will
                # never backfill history for it, so a fresh/empty DB must not
                # 503 forever. Placeholder rows let the frontend's "서비스 예정"
                # UI render instead of falling through to a generic error page.
                return [
                    MmcaRoomStatus(
                        space_code=code,
                        space_nm=MMCA_SPACE_NAMES.get(code),
                        congestion_nm=None,
                        observed_at=None,
                    )
                    for code in codes
                ]
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
        for code in sorted(codes_to_return)
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

    # ponytail: assumes one poll batch finishes within the same minute it
    # starts (true today — an 8-room batch takes ~4s). If room counts grow
    # enough to push a batch past a minute boundary, switch to a real
    # batch_id instead of bucketing by minute.
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

    cached = get_mmca_prediction(venue, target.isoformat())
    if cached is not None:
        return [MmcaRoomPrediction(**room) for room in cached]

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

    latest: dict[str, tuple[int, int]] = {}
    for row in today_rows:
        rank = CONGESTION_RANKS.get(row.congestion_nm)
        if rank is None:
            continue
        latest[row.space_code] = (row.observed_at.hour * 60 + row.observed_at.minute, rank)

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

    cached = get_mmca_exhibitions(venue)
    if cached is not None:
        return [MmcaExhibition(**row) for row in cached]

    # 한 번 부르면 세 관의 목록이 한꺼번에 나온다. 관마다 따로 캐시에 넣어야
    # 다른 관 페이지가 같은 호출을 반복하지 않는다 — 전시가 없는 관도 빈
    # 목록으로 넣는다.
    with httpx.Client() as client:
        by_venue = current_exhibitions(fetch_exhibitions(client))

    for venue_id, exhibitions in by_venue.items():
        set_mmca_exhibitions(venue_id, [vars(e) for e in exhibitions])
    return [MmcaExhibition(**vars(e)) for e in by_venue.get(venue, [])]
