from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Response
from sqlalchemy import func, select

# Private, but same package: the staleness rule has to agree with the
# collector's own opening-hours gate or the two drift apart silently.
from app.collector import _COLLECTION_START, _is_venue_open
from app.config import settings
from app.db import SessionLocal
from app.models import RawCongestion, RawMmcaCongestion

router = APIRouter()

_SEOUL_TZ = ZoneInfo("Asia/Seoul")

# Seoul's observed_at is the Open API's own PPLTN_TIME — the measurement time
# it publishes, NOT when we polled (contrast mmca_api.py, which stamps
# datetime.now()). Publication lags roughly 30 minutes, so a healthy system's
# newest reading is already that old: measured 34.1 minutes on 2026-08-22 while
# the same day's readings were a gapless 5-minute series. A threshold below
# that can never be satisfied, which is how this endpoint sat at a permanent
# 503 and made the uptime monitor it exists for useless.
#
# 45 = ~30 publication lag + 5 minute granularity + two missed 5-minute cycles.
# Widen it rather than tightening if false alarms appear; measuring our own
# collection gap directly would need a separate collected_at column.
SEOUL_STALE_MINUTES = 45

# collect_mmca_once polls every 10 minutes, but only while a venue is open, so
# this threshold only applies inside opening hours.
MMCA_STALE_MINUTES = 25


def _age_minutes(last: datetime | None, now: datetime) -> float | None:
    return None if last is None else round((now - last).total_seconds() / 60, 1)


def _last_offsite_backup(now: datetime) -> tuple[str | None, float | None]:
    """When an off-box DB copy last landed, from the stamp backup_db.sh touches.

    The script touches it only after the upload PUT returns, so this measures the
    guarantee that matters — a copy that survives losing the instance — rather
    than "a file exists on the same disk we are trying to protect against".

    Deliberately reported without a `stale` flag and without voting on the
    status code. Tightening a threshold this endpoint could not satisfy is what
    once pinned it at a permanent 503 (see SEOUL_STALE_MINUTES); a late backup
    is worth seeing, not worth paging for, and it must not be able to mask a
    real collection outage by sharing the same 503.

    A missing stamp reads as None, not as a failure: dev machines have no
    backup dir at all.
    """
    try:
        mtime = (Path(settings.backup_dir) / ".last_upload").stat().st_mtime
    except OSError:
        return None, None

    uploaded = datetime.fromtimestamp(mtime, _SEOUL_TZ).replace(tzinfo=None)
    return uploaded.isoformat(), round((now - uploaded).total_seconds() / 3600, 1)


def _mmca_is_stale(last: datetime | None, now: datetime) -> bool:
    """Whether MMCA collection has stopped, as opposed to being off-hours.

    Outside opening hours there is nothing to collect, so the last round is
    legitimately hours old and staleness is meaningless. Just after opening it
    is still legitimately old — the first round of the day hasn't run yet — so
    the venue has to have been open longer than the threshold before a gap
    counts as a failure.
    """
    if not any(_is_venue_open(venue, now) for venue in settings.mmca_venue_space_codes):
        return False

    open_since = now.replace(
        hour=_COLLECTION_START.hour, minute=_COLLECTION_START.minute, second=0, microsecond=0
    )
    if now - open_since < timedelta(minutes=MMCA_STALE_MINUTES):
        return False

    return last is None or now - last > timedelta(minutes=MMCA_STALE_MINUTES)


@router.get("/health/collection")
def collection_health(response: Response) -> dict:
    """Whether data is still arriving, for an external monitor to poll.

    Deliberately separate from /health: that one answers "is the process up",
    which is what deploy.sh checks right after a restart, when collection has
    by definition not run yet. Folding freshness into it would fail every
    deploy. This endpoint answers "is the process still doing its job".
    """
    now = datetime.now(_SEOUL_TZ).replace(tzinfo=None)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    with SessionLocal() as session:
        seoul_last = session.scalar(select(func.max(RawCongestion.observed_at)))
        mmca_last = session.scalar(select(func.max(RawMmcaCongestion.observed_at)))
        mmca_calls_today = session.scalar(
            select(func.count(RawMmcaCongestion.id)).where(
                RawMmcaCongestion.observed_at >= today_start
            )
        )
        mmca_rooms_last_round = (
            session.scalar(
                select(func.count(RawMmcaCongestion.id)).where(
                    RawMmcaCongestion.observed_at == mmca_last
                )
            )
            if mmca_last is not None
            else 0
        )

    seoul_stale = seoul_last is None or now - seoul_last > timedelta(minutes=SEOUL_STALE_MINUTES)
    backup_at, backup_age = _last_offsite_backup(now)
    mmca_stale = _mmca_is_stale(mmca_last, now)

    if seoul_stale or mmca_stale:
        response.status_code = 503

    return {
        "status": "stale" if seoul_stale or mmca_stale else "ok",
        "checked_at": now.isoformat(),
        "seoul": {
            "last_observed_at": seoul_last.isoformat() if seoul_last else None,
            "age_minutes": _age_minutes(seoul_last, now),
            "stale_after_minutes": SEOUL_STALE_MINUTES,
            "stale": seoul_stale,
        },
        "mmca": {
            "last_observed_at": mmca_last.isoformat() if mmca_last else None,
            "age_minutes": _age_minutes(mmca_last, now),
            "stale_after_minutes": MMCA_STALE_MINUTES,
            "stale": mmca_stale,
            "rooms_in_last_round": mmca_rooms_last_round,
            # Successful calls only — a room that errored isn't recorded, so
            # this is a floor on quota spent, not the exact figure.
            "calls_today": mmca_calls_today or 0,
        },
        # No "stale" key here on purpose — see _last_offsite_backup.
        "backup": {
            "last_offsite_upload_at": backup_at,
            "age_hours": backup_age,
        },
    }
