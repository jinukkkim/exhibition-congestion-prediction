from collections import defaultdict
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.db import SessionLocal
from app.models import RawMmcaCongestion
from app.schemas import MmcaDailyLogPoint, MmcaDailyRoom, MmcaRoomStatus

router = APIRouter()


def _last_known_names(session: Session, codes: list[str]) -> dict[str, str]:
    latest_named_ids = [
        row[0]
        for row in session.query(func.max(RawMmcaCongestion.id))
        .filter(
            RawMmcaCongestion.space_code.in_(codes),
            RawMmcaCongestion.space_nm.isnot(None),
        )
        .group_by(RawMmcaCongestion.space_code)
        .all()
    ]
    rows = session.query(RawMmcaCongestion).filter(RawMmcaCongestion.id.in_(latest_named_ids)).all()
    return {row.space_code: row.space_nm for row in rows}


@router.get("/mmca/rooms", response_model=list[MmcaRoomStatus])
def mmca_rooms(venue: str) -> list[MmcaRoomStatus]:
    codes = settings.mmca_venue_space_codes.get(venue)
    if codes is None:
        raise HTTPException(status_code=400, detail=f"unknown venue: {venue}")

    with SessionLocal() as session:
        latest_ids = [
            row[0]
            for row in session.query(func.max(RawMmcaCongestion.id))
            .filter(RawMmcaCongestion.space_code.in_(codes))
            .group_by(RawMmcaCongestion.space_code)
            .all()
        ]
        rows = (
            session.query(RawMmcaCongestion)
            .filter(RawMmcaCongestion.id.in_(latest_ids))
            .order_by(RawMmcaCongestion.space_code)
            .all()
        )
        last_known = _last_known_names(session, codes)

    if not rows:
        raise HTTPException(status_code=503, detail="no MMCA congestion data yet")

    return [
        MmcaRoomStatus(
            space_code=row.space_code,
            space_nm=row.space_nm or last_known.get(row.space_code),
            congestion_nm=row.congestion_nm,
            observed_at=row.observed_at.isoformat(),
        )
        for row in rows
    ]


@router.get("/mmca/daily", response_model=list[MmcaDailyLogPoint])
def mmca_daily(venue: str, date: str | None = Query(default=None)) -> list[MmcaDailyLogPoint]:
    codes = settings.mmca_venue_space_codes.get(venue)
    if codes is None:
        raise HTTPException(status_code=400, detail=f"unknown venue: {venue}")

    if date is None:
        day_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
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
                    space_nm=buckets[bucket_time][code].space_nm if code in buckets[bucket_time] else None,
                    congestion_nm=buckets[bucket_time][code].congestion_nm
                    if code in buckets[bucket_time]
                    else None,
                )
                for code in codes
            ],
        )
        for bucket_time in sorted(buckets)
    ]
