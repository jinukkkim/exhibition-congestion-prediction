from collections import defaultdict
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func

from app.config import MMCA_DISABLED_SPACE_CODES, MMCA_SPACE_NAMES, settings
from app.db import SessionLocal
from app.models import RawMmcaCongestion
from app.schemas import MmcaDailyLogPoint, MmcaDailyRoom, MmcaRoomStatus

router = APIRouter()


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
        day_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
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
                    space_nm=(row.space_nm if (row := buckets[bucket_time].get(code)) else None)
                    or MMCA_SPACE_NAMES.get(code),
                    congestion_nm=row.congestion_nm if row else None,
                )
                for code in codes
            ],
        )
        for bucket_time in sorted(buckets)
    ]
