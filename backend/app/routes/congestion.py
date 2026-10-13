import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy.orm import undefer

from app.cache import get_latest, get_weekly_profile, revive, set_weekly_profile
from app.db import SessionLocal
from app.models import RawCongestion
from app.prediction.seoul import OPEN_MINUTES, build_profile, close_minutes
from app.schemas import (
    CongestionHistoryPoint,
    CurrentCongestion,
    DailyLogPoint,
    RawLogPoint,
    WeeklyProfile,
    WeeklyProfileCell,
)

router = APIRouter()

# Matches app/routes/mmca.py's _SEOUL_TZ — observed_at values come from the
# Seoul Open API's own KST timestamps, so a naive datetime.now() would
# misalign "today" whenever the server's OS timezone isn't KST.
_SEOUL_TZ = ZoneInfo("Asia/Seoul")


def _day_bounds(date: str | None) -> tuple[datetime, datetime]:
    """The naive [start, end) of one Seoul day, defaulting to today."""
    if date is None:
        day_start = datetime.now(_SEOUL_TZ).replace(
            tzinfo=None, hour=0, minute=0, second=0, microsecond=0
        )
    else:
        try:
            day_start = datetime.strptime(date, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="date must be in YYYY-MM-DD format")
    return day_start, day_start + timedelta(days=1)


@router.get("/congestion/current", response_model=CurrentCongestion)
def current_congestion() -> CurrentCongestion:
    cached = revive(get_latest(), CurrentCongestion)
    if cached is not None:
        return cached

    with SessionLocal() as session:
        row = (
            session.query(RawCongestion)
            .order_by(RawCongestion.observed_at.desc())
            .first()
        )
    if row is None:
        raise HTTPException(status_code=503, detail="no congestion data yet")

    return CurrentCongestion(
        observed_at=row.observed_at.isoformat(),
        congest_level=row.congest_level,
        population_avg=row.population_avg,
    )


@router.get("/congestion/history", response_model=list[CongestionHistoryPoint])
def congestion_history(
    hours: int = Query(default=6, ge=1, le=24)
) -> list[CongestionHistoryPoint]:
    # Same Seoul pinning as congestion_daily below — observed_at holds the
    # Open API's KST wall-clock times, so a naive now() would compare them
    # against the server's clock (Etc/UTC in production) and widen the window
    # by the offset: "last 6 hours" would return the last 15.
    cutoff = datetime.now(_SEOUL_TZ).replace(tzinfo=None) - timedelta(hours=hours)
    with SessionLocal() as session:
        rows = (
            session.query(RawCongestion)
            .filter(RawCongestion.observed_at >= cutoff)
            .order_by(RawCongestion.observed_at.asc())
            .all()
        )
    return [
        CongestionHistoryPoint(
            observed_at=row.observed_at.isoformat(),
            population_avg=row.population_avg,
        )
        for row in rows
    ]


@router.get("/congestion/daily", response_model=list[DailyLogPoint])
def congestion_daily(date: str | None = Query(default=None)) -> list[DailyLogPoint]:
    day_start, day_end = _day_bounds(date)

    with SessionLocal() as session:
        rows = (
            session.query(RawCongestion)
            .filter(RawCongestion.observed_at >= day_start, RawCongestion.observed_at < day_end)
            .order_by(RawCongestion.observed_at.asc())
            .all()
        )
    return [
        DailyLogPoint(
            observed_at=row.observed_at.isoformat(),
            congest_level=row.congest_level,
            population_min=row.population_min,
            population_max=row.population_max,
            male_ppltn_rate=row.male_ppltn_rate,
            female_ppltn_rate=row.female_ppltn_rate,
            ppltn_rate_0=row.ppltn_rate_0,
            ppltn_rate_10=row.ppltn_rate_10,
            ppltn_rate_20=row.ppltn_rate_20,
            ppltn_rate_30=row.ppltn_rate_30,
            ppltn_rate_40=row.ppltn_rate_40,
            ppltn_rate_50=row.ppltn_rate_50,
            ppltn_rate_60=row.ppltn_rate_60,
            ppltn_rate_70=row.ppltn_rate_70,
            resnt_ppltn_rate=row.resnt_ppltn_rate,
            non_resnt_ppltn_rate=row.non_resnt_ppltn_rate,
        )
        for row in rows
    ]


# The sections of the archived body whose scalars are one-per-reading, so they
# belong in a row. LIVE_SUB_PPLTN / LIVE_BUS_PPLTN are also archived but are
# per-station lists — those are for the row-expansion view, not columns.
_FLAT_SECTIONS = ("LIVE_PPLTN_STTS", "WEATHER_STTS")


def _raw_fields(row: RawCongestion) -> dict[str, str | int | float | None]:
    """Everything we kept for one reading, keyed by the API's own field names.

    The parsed columns go in first, so readings from before raw_response
    existed (2026-07-15..17) still fill the table. The archived body then
    overwrites those same keys with identical values and adds the fields we
    never promoted to columns — weather above all.
    """
    fields: dict[str, str | int | float | None] = {
        "AREA_CONGEST_LVL": row.congest_level,
        "AREA_PPLTN_MIN": row.population_min,
        "AREA_PPLTN_MAX": row.population_max,
        "MALE_PPLTN_RATE": row.male_ppltn_rate,
        "FEMALE_PPLTN_RATE": row.female_ppltn_rate,
        "PPLTN_RATE_0": row.ppltn_rate_0,
        "PPLTN_RATE_10": row.ppltn_rate_10,
        "PPLTN_RATE_20": row.ppltn_rate_20,
        "PPLTN_RATE_30": row.ppltn_rate_30,
        "PPLTN_RATE_40": row.ppltn_rate_40,
        "PPLTN_RATE_50": row.ppltn_rate_50,
        "PPLTN_RATE_60": row.ppltn_rate_60,
        "PPLTN_RATE_70": row.ppltn_rate_70,
        "RESNT_PPLTN_RATE": row.resnt_ppltn_rate,
        "NON_RESNT_PPLTN_RATE": row.non_resnt_ppltn_rate,
    }
    if not row.raw_response:
        return fields

    body = json.loads(row.raw_response)
    for section in _FLAT_SECTIONS:
        entry = (body.get(section) or [{}])[0]
        fields.update(
            {
                key: value
                for key, value in entry.items()
                # Nested blocks aren't table cells: FCST_PPLTN's revisions have
                # their own table (ForecastCongestion), the rest is row-expansion
                # material.
                if not isinstance(value, (list, dict))
                # PPLTN_TIME is where observed_at came from — a second column of
                # the same timestamp is just noise in a ~40-column table.
                and key != "PPLTN_TIME"
            }
        )
    return fields


@router.get("/congestion/daily/raw", response_model=list[RawLogPoint])
def congestion_daily_raw(date: str | None = Query(default=None)) -> list[RawLogPoint]:
    """One day of readings with every field we kept, not just the parsed ones.

    Separate from /congestion/daily on purpose: that endpoint feeds the venue
    page's chart, and undeferring a ~7KB blob per row (288 rows/day) there
    would slow the main screen down for data it never reads.
    """
    day_start, day_end = _day_bounds(date)

    with SessionLocal() as session:
        rows = (
            session.query(RawCongestion)
            .options(undefer(RawCongestion.raw_response))
            .filter(RawCongestion.observed_at >= day_start, RawCongestion.observed_at < day_end)
            .order_by(RawCongestion.observed_at.asc())
            .all()
        )
    return [
        RawLogPoint(observed_at=row.observed_at.isoformat(), fields=_raw_fields(row))
        for row in rows
    ]


def _full_hour_open(stamp: datetime) -> bool:
    """정시 버킷이 통째로 개관 시간 안에 드는가.

    prediction 의 in_business_hours 보다 좁다. 그쪽은 판독 하나가 영업시간 안이냐만
    물으면 되지만, 여기는 한 시간을 한 칸으로 평균 내 "몇 시가 한산한가"를 말한다.
    개관이 09:30, 평일 폐관이 17:30 이라 9시 칸과 17시 칸에는 반 시간치 판독만
    들어가고, 21:00 정각에 닫는 수·토의 21시 칸에는 한두 개만 들어간다. 값이 낮게
    깔리는 얇은 칸들이라 "가장 한산한 시각"으로 뽑히기 가장 쉬운 칸이 곧 가장
    못 믿을 칸이 된다 — 이 페이지가 내세우는 문장 하나가 통째로 틀린다.

    그래서 평일은 10~16시, 야간개장인 수·토는 10~20시가 남는다. 요일마다 칸 수가
    다른 것은 결함이 아니라 야간개장 그 자체다.
    """
    return stamp.hour * 60 >= OPEN_MINUTES and (stamp.hour + 1) * 60 <= close_minutes(stamp.date())


@router.get("/congestion/weekly-profile", response_model=WeeklyProfile)
def weekly_profile() -> WeeklyProfile:
    """수집 전체 기간의 (요일, 시각) 평균 — "언제 가면 한산한가" 한 장.

    예측이 쓰는 프로파일과 같은 build_profile 을 부르지만 창이 다르다. 예측은
    7일(PROFILE_WINDOW_DAYS)이고, 그건 롤링 오리진 백테스트가 *예측 오차*로 고른
    창이지(7일 168 / 28일 180) 요일 성격을 *설명*하기 좋은 창이 아니다 — 요일마다
    하루씩만 들어간다. 이쪽은 설명이 목적이라 수집 전체를 쓴다.

    휴관일을 빼지 않는다. 이 관의 혼잡도는 관람객 수가 아니라 그 지역 생활인구라
    닫은 날에도 값이 나오고, 예측 프로파일도 같은 이유로 빼지 않는다. 국립중앙
    박물관의 달력 휴관일은 1월 1일·설날·추석 사흘뿐이라 8주 평균에서 한 칸이
    움직일 여지도 거의 없다.
    """
    # revive 를 거친다 — 생성자에 바로 넣으면 모델에 필드가 하나 느는 배포
    # 직후 여섯 시간(이 응답의 TTL) 동안 모든 요청이 500 이다. 그 helper 의
    # docstring 이 같은 사고를 기록하고 있다.
    cached = revive(get_weekly_profile(), WeeklyProfile)
    if cached is not None:
        return cached

    # ponytail: 기간 제한 없는 전체 스캔. 이 파일의 다른 라우트가 모두 시간
    # 범위를 거는 것과 다른데, 그 차이가 곧 이 응답의 정의다 — "수집 전체
    # 기간"이라 창을 걸면 답이 달라진다.
    #
    # 측정(2026-09-14, 16,881행): 스캔 + 집계 중앙값 93ms, 6시간 캐시 뒤라 하루
    # 네 번. 행당 비용이 선형이고 서울 수집이 24시간 */5 = 288행/일이므로,
    # 1년 뒤 10.5만행 ≈ 0.6초, 5년 뒤 52.6만행 ≈ 2.9초(이 랩톱 기준, 프로덕션
    # 박스는 더 느리다).
    #
    # load_only 로 컬럼을 좁히는 것은 효과가 없다 — 재어 보면 오히려 느리다
    # (중앙값 93.5ms -> 103.2ms). raw_response 가 이미 deferred 라 큰 페이로드는
    # 원래 실리지 않고, 지연 컬럼 처리 비용이 좁아진 SELECT 를 상쇄한다.
    #
    # 한 번의 갱신이 1초를 넘기기 시작하면(대략 1년) 예측처럼 일일 배치가 미리
    # 계산해 캐시에 넣는 쪽으로 옮긴다. 그 전까지는 이 편이 단순하다.
    with SessionLocal() as session:
        rows = session.query(RawCongestion).order_by(RawCongestion.observed_at.asc()).all()

    open_rows = [row for row in rows if _full_hour_open(row.observed_at)]
    if not open_rows:
        # 캐시하지 않는다 — 판독이 하나도 없는 상태는 수집이 시작되면 몇 분 안에
        # 풀린다. 6시간 TTL 에 얼려두면 그 사이 들어온 데이터가 보이지 않는다.
        return WeeklyProfile(status="collecting", cells=[])

    profile = build_profile(open_rows)
    result = WeeklyProfile(
        status="ready",
        since=open_rows[0].observed_at.date().isoformat(),
        until=open_rows[-1].observed_at.date().isoformat(),
        samples=len(open_rows),
        cells=[
            WeeklyProfileCell(weekday=weekday, hour=hour, population_avg=round(value, 1))
            for (weekday, hour), value in sorted(profile.items())
        ],
    )
    set_weekly_profile(result.model_dump())
    return result
