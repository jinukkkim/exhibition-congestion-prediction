import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy.orm import undefer

from app.cache import get_latest, revive
from app.db import SessionLocal
from app.models import RawCongestion
from app.schemas import CongestionHistoryPoint, CurrentCongestion, DailyLogPoint, RawLogPoint

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
