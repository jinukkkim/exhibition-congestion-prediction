from fastapi import APIRouter, HTTPException
from sqlalchemy import func

from app.db import SessionLocal
from app.models import RawMmcaCongestion
from app.schemas import MmcaRoomStatus

router = APIRouter()


@router.get("/mmca/rooms", response_model=list[MmcaRoomStatus])
def mmca_rooms() -> list[MmcaRoomStatus]:
    with SessionLocal() as session:
        latest_ids = [
            row[0]
            for row in session.query(func.max(RawMmcaCongestion.id))
            .group_by(RawMmcaCongestion.space_code)
            .all()
        ]
        rows = (
            session.query(RawMmcaCongestion)
            .filter(RawMmcaCongestion.id.in_(latest_ids))
            .order_by(RawMmcaCongestion.space_code)
            .all()
        )

    if not rows:
        raise HTTPException(status_code=503, detail="no MMCA congestion data yet")

    return [
        MmcaRoomStatus(
            space_code=row.space_code,
            space_nm=row.space_nm,
            congestion_nm=row.congestion_nm,
            observed_at=row.observed_at.isoformat(),
        )
        for row in rows
    ]
