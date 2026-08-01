import json
import logging
from datetime import datetime, time
from zoneinfo import ZoneInfo

import httpx

from sqlalchemy import select

from app.cache import set_latest
from app.config import MMCA_DISABLED_SPACE_CODES, settings
from app.db import SessionLocal
from app.mmca_api import MmcaCongestionReading, fetch_congestion as fetch_mmca_congestion
from app.models import RawCongestion, RawMmcaCongestion
from app.seoul_api import CongestionReading, fetch_congestion

logger = logging.getLogger(__name__)


def collect_once(session_factory=SessionLocal) -> CongestionReading:
    with httpx.Client() as client:
        reading = fetch_congestion(client, settings.seoul_area_name, settings.seoul_api_key)

    with session_factory() as session:
        session.add(
            RawCongestion(
                observed_at=reading.observed_at,
                congest_level=reading.congest_level,
                population_min=reading.population_min,
                population_max=reading.population_max,
                male_ppltn_rate=reading.male_ppltn_rate,
                female_ppltn_rate=reading.female_ppltn_rate,
                ppltn_rate_0=reading.ppltn_rate_0,
                ppltn_rate_10=reading.ppltn_rate_10,
                ppltn_rate_20=reading.ppltn_rate_20,
                ppltn_rate_30=reading.ppltn_rate_30,
                ppltn_rate_40=reading.ppltn_rate_40,
                ppltn_rate_50=reading.ppltn_rate_50,
                ppltn_rate_60=reading.ppltn_rate_60,
                ppltn_rate_70=reading.ppltn_rate_70,
                resnt_ppltn_rate=reading.resnt_ppltn_rate,
                non_resnt_ppltn_rate=reading.non_resnt_ppltn_rate,
                raw_response=reading.raw_response,
            )
        )
        session.commit()

    set_latest(reading)
    return reading


_SEOUL_BRANCH_NORMAL_CLOSE = time(18, 0)
_SEOUL_BRANCH_LONG_CLOSE = time(21, 0)
_LONG_DAYS = {2, 5}  # datetime.weekday(): Mon=0 ... 수=2, 토=5
_SEOUL_TZ = ZoneInfo("Asia/Seoul")

# Collection starts 10 minutes after the real 10:00 opening time (still what
# the frontend shows as "open") — congestion right at opening is reliably
# 여유, so skipping that one poll buys back a 10-minute slot/day. That's
# what keeps the 15-room, 10-minute schedule under the MMCA API's
# 1,000-call/day cap on extended-hours (수/토) days: 15 * 66 = 990.
_COLLECTION_START = time(10, 10)

# Same open/close hours as Seoul; only Deoksugung (inside the palace grounds)
# is closed on Mondays.
_VENUE_CLOSED_DAYS: dict[str, set[int]] = {
    "deoksugung": {0},  # 월요일 휴무
}

# A room with no ongoing exhibition rarely opens one mid-day, so once a room
# reads empty for its whole first hour, fall back to a 2-hour recheck
# interval instead of the normal 10-minute one for the rest of the day — cheap
# insurance against the rare same-day opening, at a fraction of the API cost.
# ponytail: this only exists because 15 rooms * 66 rounds/day sits right up
# against the MMCA API's 1,000-call/day cap (see MMCA_DISABLED_SPACE_CODES).
# If that cap goes away, remove this and just poll every room every round.
_MMCA_EMPTY_CONFIRM_CUTOFF = time(11, 0)
_MMCA_EMPTY_RECHECK_INTERVAL_HOURS = 2


def _mmca_room_confirmed_empty_today(session, space_code: str, round_time: datetime) -> bool:
    day_start = round_time.replace(hour=0, minute=0, second=0, microsecond=0)
    cutoff = round_time.replace(
        hour=_MMCA_EMPTY_CONFIRM_CUTOFF.hour, minute=_MMCA_EMPTY_CONFIRM_CUTOFF.minute
    )
    # congestion_nm is only ever null when resultCode is 0002 (no ongoing
    # exhibition) — see MmcaCongestionReading.congestion_nm / mmca_api.py. A
    # real reading at any point today — even one caught by an earlier 2-hour
    # recheck — means the room has reopened, so resume normal 10-minute
    # polling for the rest of the day instead of staying stuck on the
    # empty-room cadence.
    reopened_today = session.scalars(
        select(RawMmcaCongestion.id).where(
            RawMmcaCongestion.space_code == space_code,
            RawMmcaCongestion.observed_at >= day_start,
            RawMmcaCongestion.observed_at < round_time,
            RawMmcaCongestion.congestion_nm.isnot(None),
        )
    ).first()
    if reopened_today is not None:
        return False

    # No real reading yet today (checked above over the whole day so far,
    # which covers this range too) — confirmed empty once the first hour has
    # actually been polled at least once.
    first_hour_reading = session.scalars(
        select(RawMmcaCongestion.id).where(
            RawMmcaCongestion.space_code == space_code,
            RawMmcaCongestion.observed_at >= day_start,
            RawMmcaCongestion.observed_at < cutoff,
        )
    ).first()
    return first_hour_reading is not None


def _mmca_room_due_for_recheck(round_time: datetime) -> bool:
    # Only compares hours, so this assumes _MMCA_EMPTY_CONFIRM_CUTOFF falls on
    # an exact hour (currently 11:00) — if the cutoff ever moves off :00, this
    # needs a minute-aware interval, not just an hour difference.
    hours_since_cutoff = round_time.hour - _MMCA_EMPTY_CONFIRM_CUTOFF.hour
    return (
        round_time.minute == _MMCA_EMPTY_CONFIRM_CUTOFF.minute
        and hours_since_cutoff % _MMCA_EMPTY_RECHECK_INTERVAL_HOURS == 0
    )


def _is_venue_open(venue: str, now: datetime) -> bool:
    if now.weekday() in _VENUE_CLOSED_DAYS.get(venue, set()):
        return False
    close = _SEOUL_BRANCH_LONG_CLOSE if now.weekday() in _LONG_DAYS else _SEOUL_BRANCH_NORMAL_CLOSE
    # Truncate to the minute before comparing. The scheduler only ever fires
    # exactly on the grid but real execution lands a little after that
    # instant, and closing time's inclusive upper bound is exact-second — a
    # poll running even 1ms past close would otherwise read as closed,
    # silently dropping the closing-time reading on every business day.
    now_minute = now.time().replace(second=0, microsecond=0)
    return _COLLECTION_START <= now_minute <= close


def collect_mmca_once(session_factory=SessionLocal, now: datetime | None = None) -> list[MmcaCongestionReading]:
    # Server local time isn't guaranteed to be KST (e.g. a UTC container), so
    # pin explicitly to Asia/Seoul instead of a naive datetime.now().
    now = now or datetime.now(_SEOUL_TZ).replace(tzinfo=None)
    # The scheduler fires this on a 10-minute cron grid, but scheduler
    # jitter or a misfire-grace-time catch-up run can land a few minutes off
    # that mark. Every reading in this round is stamped with the grid mark
    # itself (not raw `now`), so collection rounds always land on a fixed,
    # predictable 10-minute grid regardless of when the round actually ran.
    round_time = now.replace(minute=(now.minute // 10) * 10, second=0, microsecond=0)

    space_codes = [
        space_code
        for venue, codes in settings.mmca_venue_space_codes.items()
        if _is_venue_open(venue, now)
        for space_code in codes
        if space_code not in MMCA_DISABLED_SPACE_CODES
    ]
    if not space_codes:
        return []

    if round_time.time() >= _MMCA_EMPTY_CONFIRM_CUTOFF and not _mmca_room_due_for_recheck(round_time):
        with session_factory() as session:
            space_codes = [
                code
                for code in space_codes
                if not _mmca_room_confirmed_empty_today(session, code, round_time)
            ]
        if not space_codes:
            return []

    readings: list[MmcaCongestionReading] = []
    with httpx.Client() as client:
        for space_code in space_codes:
            try:
                reading = fetch_mmca_congestion(client, space_code, settings.mmca_api_key)
            except (httpx.HTTPError, json.JSONDecodeError) as exc:
                # data.go.kr can return a non-JSON (e.g. XML error) body with a
                # 200 status on key/quota errors — response.json() then raises
                # JSONDecodeError, not HTTPError. Isolate it per-room the same way.
                logger.warning("MMCA fetch failed for %s: %r", space_code, exc)
                continue
            # fetch_mmca_congestion stamps its own wall-clock time per HTTP
            # call. Rooms are polled sequentially, so a slow batch can drift
            # across a minute boundary mid-round — normalize every reading in
            # this round to the round's grid mark so they land in one
            # /mmca/daily bucket together instead of splitting across two.
            reading.observed_at = round_time
            readings.append(reading)

    with session_factory() as session:
        for reading in readings:
            session.add(
                RawMmcaCongestion(
                    observed_at=reading.observed_at,
                    space_code=reading.space_code,
                    space_nm=reading.space_nm,
                    agnc_nm=reading.agnc_nm,
                    congestion_nm=reading.congestion_nm,
                    raw_response=reading.raw_response,
                )
            )
        session.commit()

    return readings
