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
# 75 was chosen against 45 days of collection history (2026-07-16..08-31),
# not from a formula. Worst observed age per day, where age = gap + the ~30
# minute publication lag:
#
#   2026-08-30   70 min   ← Open API answered ~17% of polls with ReadTimeout
#   2026-07-27   50 min       on a 10s budget; healthy responses took 0.23s
#   2026-08-11   45 min
#   2026-08-31   45 min
#   7 other days 40 min
#   36 days      no gap over 6 minutes
#
# Alerting days by threshold: 45 → 2, 60 → 1, 75 → 0, 90 → 0, 120 → 0.
# Past 75 there is nothing left to buy — 90 and 120 alert on the same zero
# days while taking longer to notice a collector that has actually died.
#
# It was 45 until 2026-08-30, when the uptime monitor mailed "server down"
# five times for a process that never restarted (NRestarts=0). The headroom
# was the real problem: a healthy age is already ~34 minutes, so 45 left
# barely 11 — one missed cycle plus jitter tripped it.
#
# The asymmetry decides the direction. A dead collector stays dead, so
# noticing 30 minutes later costs almost nothing; false alarms cost the
# monitor its credibility, which is the one thing it has.
#
# 8/30 is an outlier at twice the second-worst day, so the margin above it is
# thin (5 minutes) on purpose: a day worse than 8/30 leaves the prediction's
# 120-minute anchor window short of readings and puts a hole in the chart,
# which is worth hearing about. Re-run this table before moving the number;
# measuring our own collection gap directly would need a separate
# collected_at column.
SEOUL_STALE_MINUTES = 75

# collect_mmca_once polls on the MMCA_POLL_MINUTES grid, but only while a venue
# is open, so this threshold only applies inside opening hours. It is sized as
# "a few missed rounds", which means it has to move whenever that grid moves —
# the number is minutes, but the failure it detects is counted in rounds.
#
# It was 25, set when the grid was 10 minutes (2.5 rounds). Leaving it there
# through the 10 -> 1 -> 2 changes was defended as "a finer grid only makes it
# more forgiving, never noisier". That is true and was the problem: at */2 it
# allows 12.5 missed rounds, and it did not catch the outage that made it worth
# rechecking. On 2026-09-03 a per-room timeout let rounds overrun their grid
# (see mmca_api.py's FETCH_TIMEOUT_SECONDS); 55 of 407 rounds were dropped and
# 20.6% of the day's readings were lost, with a worst round-to-round gap of 9
# minutes on the 1-minute grid — 18 minutes' worth of missed rounds at */2, and
# still under 25. The monitor stayed green through a fifth of a day going
# missing.
#
# 12 comes from 37 days of collection history (2026-07-29..09-03), measured as
# the worst gap between one room's own readings inside opening hours, in units
# of the grid in force that day, then read back at */2. Rooms with no active
# exhibition are excluded: they answer resultCode 0002 for weeks on end (room
# 1002's gap is 120 minutes nearly every day) and the frontend already demotes
# them to an inactive card with no freshness badge at all.
#
#   threshold   days it would flag
#      6 min     8 / 37
#      8 min     5 / 37
#     10 min     4 / 37
#     12 min     2 / 37   <-- knee
#     15 min     2 / 37
#     20 min     2 / 37
#     25 min     1 / 37
#
# Past 12 there is nothing left to buy — 15 and 20 flag the same two days while
# taking longer to notice a collector that has actually died. Both remaining
# days are ones where saying "stale" is correct: 09-03 above, and 09-01, where
# room 1003 went through an exhibition changeover mid-window.
#
# The asymmetry runs the same way as SEOUL_STALE_MINUTES: a dead collector
# stays dead, so this endpoint is read through max(observed_at) across every
# room, which is far harder to make stale than any single room. At 12 minutes
# that is one alerting day in 40 — and it is the one day that deserved it.
#
# Re-run this table before moving the number, and move it whenever
# MMCA_POLL_MINUTES moves. frontend/src/lib/freshness.ts holds the same
# constant for the badge; the two must agree or the badge and the healthcheck
# disagree about the same reading.
MMCA_STALE_MINUTES = 12


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
