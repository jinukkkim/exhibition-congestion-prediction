import json
import logging
from collections.abc import Sequence
from dataclasses import asdict
from datetime import datetime, time
from time import monotonic, sleep
from zoneinfo import ZoneInfo

import httpx

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.cache import set_latest
from app.config import MMCA_DISABLED_SPACE_CODES, settings
from app.db import SessionLocal
from app.mmca_api import MmcaCongestionReading, fetch_congestion as fetch_mmca_congestion
from app.models import ForecastCongestion, ForecastWeather, RawCongestion, RawMmcaCongestion
from app.seoul_api import (
    CongestionForecast,
    CongestionReading,
    WeatherForecast,
    fetch_congestion,
)

logger = logging.getLogger(__name__)


def store_forecast_revisions(
    session: Session,
    model: type[ForecastCongestion] | type[ForecastWeather],
    issued_at: datetime,
    forecasts: Sequence[CongestionForecast] | Sequence[WeatherForecast],
) -> int:
    """Add only the forecasts that differ from the last one stored for their
    target time.

    The API repeats every forecast on all 288 daily polls, so without this the
    tables would grow ~40x for no added information. Comparing against the
    latest stored row (not against everything ever stored) is what keeps a
    value that flips back to an earlier one recorded as its own revision.

    "Latest" means latest *as of issued_at*, not latest overall. For live
    collection those are the same thing, but it's what makes replaying old
    polls over an already-populated table a no-op instead of re-inserting
    every row — see scripts/backfill_forecasts.py.

    Read-then-insert isn't atomic across processes, so running the backfill
    against a live DB can duplicate a row. Left unguarded on purpose: the only
    reachable duplicate is byte-identical (both writers saw the same API
    response), the ordering above tolerates the tie, and a UNIQUE constraint
    would instead abort the collector's whole transaction — losing the
    raw_congestion row too — the first time one poll revised a forecast
    without the API advancing PPLTN_TIME.
    """
    stored = 0
    for forecast in forecasts:
        values = asdict(forecast)
        target_at = values.pop("target_at")
        latest = (
            session.query(model)
            .filter(model.target_at == target_at, model.issued_at <= issued_at)
            .order_by(model.issued_at.desc(), model.id.desc())
            .first()
        )
        if latest is not None and all(
            getattr(latest, name) == value for name, value in values.items()
        ):
            continue
        session.add(model(issued_at=issued_at, target_at=target_at, **values))
        stored += 1
    return stored


# The Seoul Open API intermittently answers a 200 with a non-JSON body, which
# surfaces as JSONDecodeError rather than an HTTP error — the same data.go.kr
# behaviour collect_mmca_once already guards against per room. Six polls hit it
# in the week of 2026-08-11, and each one was isolated: the 5-minute polls on
# either side succeeded, so a retry a couple of seconds later recovers the
# reading instead of leaving a hole in the series.
#
# No equivalent retry for collect_mmca_once: losing one room of fifteen is a
# far smaller hole than losing the only call of a round, and the schedule is
# sized against a quota ceiling (see _COLLECTION_START) that retries would eat
# into on exactly the days it's tightest.
_FETCH_ATTEMPTS = 3
_FETCH_RETRY_SECONDS = 2

# KeyError joins the two network-shaped failures because the API can answer
# 200 with well-formed JSON that simply lacks CITYDATA — seoul_api and mmca_api
# both index straight into the payload, so a shape change surfaces as a
# KeyError that neither httpx nor json would ever raise.
_FETCH_FAILURES = (httpx.HTTPError, json.JSONDecodeError, KeyError)


def _fetch_congestion_with_retry(client: httpx.Client) -> CongestionReading:
    # Elapsed time is logged on every attempt, success included, because a
    # ReadTimeout alone cannot answer the question that decides what to do
    # about it: did the response arrive at 11 seconds, or never? The timeout
    # says only "not within the budget". On 2026-08-30 the API failed 17% of
    # polls this way while healthy responses took 0.23s, and there was no way
    # to tell whether a longer timeout would have caught them — so the retry
    # design could not be changed on evidence. These numbers are what make
    # that decision possible next time.
    #
    # Success is logged at debug so a healthy day stays quiet; failures carry
    # the elapsed time at warning, where the journal already keeps them.
    started = monotonic()
    for attempt in range(1, _FETCH_ATTEMPTS + 1):
        attempt_started = monotonic()
        try:
            reading = fetch_congestion(client, settings.seoul_area_name, settings.seoul_api_key)
        except _FETCH_FAILURES as exc:
            elapsed = monotonic() - attempt_started
            # Still raised once the attempts run out: a sustained outage should
            # reach the scheduler's error listener, unlike a single flake.
            if attempt == _FETCH_ATTEMPTS:
                logger.warning(
                    "Seoul fetch gave up after %d attempts in %.1fs, last %s after %.1fs",
                    _FETCH_ATTEMPTS,
                    monotonic() - started,
                    type(exc).__name__,
                    elapsed,
                )
                raise
            logger.warning(
                "Seoul fetch attempt %d/%d failed after %.1fs, retrying: %r",
                attempt,
                _FETCH_ATTEMPTS,
                elapsed,
                exc,
            )
            sleep(_FETCH_RETRY_SECONDS)
        else:
            if attempt > 1:
                # The recovery case is the informative one: it bounds how long
                # a bad spell actually lasts, which is exactly what a retry
                # change would have to be sized against.
                logger.warning(
                    "Seoul fetch recovered on attempt %d/%d after %.1fs total",
                    attempt,
                    _FETCH_ATTEMPTS,
                    monotonic() - started,
                )
            else:
                logger.debug("Seoul fetch ok in %.1fs", monotonic() - attempt_started)
            return reading
    raise AssertionError("unreachable")  # pragma: no cover


def collect_once(session_factory=SessionLocal) -> CongestionReading:
    with httpx.Client() as client:
        reading = _fetch_congestion_with_retry(client)

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
        # issued_at is the poll's own observed_at rather than wall-clock now:
        # it's the API's timestamp for this response, so it lines up with
        # raw_congestion rows and doesn't depend on the server's clock.
        store_forecast_revisions(
            session, ForecastCongestion, reading.observed_at, reading.congestion_forecasts
        )
        store_forecast_revisions(
            session, ForecastWeather, reading.observed_at, reading.weather_forecasts
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
# 1,000-call/day cap on extended-hours (수/토) days: 15 * 66 = 990. That's
# the ceiling, not the norm — the empty-room skip below takes real usage to
# roughly 400-550 calls/day (measured over 2026-08-09..13), so the headroom
# only disappears if most rooms are running exhibitions at once.
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
            except _FETCH_FAILURES as exc:
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

    # A round that lost rooms still returns successfully, so without this line
    # a partially-collected round is indistinguishable from a full one in the
    # logs — the per-room warnings above only say something failed, never how
    # much of the round survived.
    if len(readings) < len(space_codes):
        logger.warning(
            "MMCA round %s collected %d/%d rooms", round_time, len(readings), len(space_codes)
        )

    with session_factory() as session:
        for reading in readings:
            session.add(
                RawMmcaCongestion(
                    observed_at=reading.observed_at,
                    space_code=reading.space_code,
                    space_nm=reading.space_nm,
                    agnc_nm=reading.agnc_nm,
                    congestion_nm=reading.congestion_nm,
                )
            )
        session.commit()

    return readings
