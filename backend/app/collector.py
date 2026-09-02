import json
import logging
from collections.abc import Sequence
from dataclasses import asdict
from datetime import datetime, time
from time import monotonic, sleep
from zoneinfo import ZoneInfo

import httpx

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
# into on exactly the days it was tightest. That ceiling is now 100x higher,
# so this number is free to grow if flaky rounds ever justify it.
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
    # Success is logged at info, not debug: it is the only record of when a
    # poll actually ran. raw_congestion.observed_at is the Open API's own
    # publication time, not ours, so the DB cannot answer "when did we
    # collect" — reconstructing a collection gap from it means assuming the
    # ~30 minute publication lag, which is exactly the assumption that made
    # the first reconstruction of 2026-08-30 come out as zero outage windows
    # instead of five.
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
                logger.info("Seoul fetch ok in %.1fs", monotonic() - attempt_started)
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


_NORMAL_CLOSE = time(18, 0)
_LONG_CLOSE = time(21, 0)

# 야간개장 요일. datetime.weekday(): Mon=0 ... 수=2, 토=5. 과천관은 야간개장이
# 없어 여기 없다 — 공식 관람정보가 "화~일요일 10:00~18:00"이고, 수집한 판독도
# 과천관 수·토 18:20 이후 620여 건이 예외 없이 여유다(= 빈 건물).
_LONG_DAYS: dict[str, set[int]] = {
    "seoul": {2, 5},
    "deoksugung": {2, 5},
}
_SEOUL_TZ = ZoneInfo("Asia/Seoul")

# Collection starts at the opening time the frontend shows, so the day's first
# sample is the opening minute itself.
#
# It was 10:10 to fit the MMCA API's old 1,000-call/day cap: 15 rooms * 66
# rounds came to 990, and dropping the 10:00 round bought that last slot. The
# cap is now 100,000/day. Recorded so the saving is not re-derived — opening
# congestion being reliably 여유 was the stated reason, never the real one.
_COLLECTION_START = time(10, 0)

# 요일 휴관. 덕수궁관은 궁 안에 있고 과천관도 화~일 주간을 지킨다 — 매주 월요일
# 문을 여는 것은 서울관뿐이다.
#
# 폐관 중에도 API 는 에러가 아니라 정상 응답으로 "여유"를 돌려준다. 그래서 이
# 게이트는 쿼터 장치가 아니라 데이터 품질 장치다: 없으면 "닫혀서 빈 것"이
# "열려 있는데 한산함"으로 히스토리에 쌓이고, build_profile 이 (방, 요일, 시각)
# 평균을 내므로 예측 프로파일을 그대로 끌어내린다. 과천 월요일 895 건이 전부
# 여유인 것이 그 증거다.
#
# ponytail: 요일만 본다. 대체공휴일 월요일에는 실제로 문을 열지만(2026-08-17
# 과천관에 정상 혼잡 기록이 있다) 그날은 수집하지 않는다. 프론트의
# mmcaBusinessHours 도 같은 한계를 안고 있어, 공휴일 달력이 들어오면 함께 고친다.
_VENUE_CLOSED_DAYS: dict[str, set[int]] = {
    "gwacheon": {0},  # 월요일 휴무
    "deoksugung": {0},  # 월요일 휴무
}


def _is_venue_open(venue: str, now: datetime) -> bool:
    if now.weekday() in _VENUE_CLOSED_DAYS.get(venue, set()):
        return False
    close = _LONG_CLOSE if now.weekday() in _LONG_DAYS.get(venue, set()) else _NORMAL_CLOSE
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
