from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Query

from app.cache import get_latest
from app.db import SessionLocal
from app.models import RawCongestion
from app.schemas import CongestionHistoryPoint, CurrentCongestion, DailyLogPoint

router = APIRouter()


@router.get("/congestion/current", response_model=CurrentCongestion)
def current_congestion() -> CurrentCongestion:
    cached = get_latest()
    if cached is not None:
        return CurrentCongestion(**cached)

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
    cutoff = datetime.now() - timedelta(hours=hours)
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
    day_start = (
        datetime.strptime(date, "%Y-%m-%d")
        if date
        else datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    )
    day_end = day_start + timedelta(days=1)

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
