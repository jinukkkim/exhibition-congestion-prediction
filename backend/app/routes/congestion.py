from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Query

from app.cache import get_latest
from app.db import SessionLocal
from app.models import RawCongestion
from app.schemas import CongestionHistoryPoint, CurrentCongestion

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
