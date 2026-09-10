import json
import logging
from collections.abc import Sequence
from dataclasses import asdict
from datetime import date, datetime, time, timedelta
from time import monotonic, sleep
from zoneinfo import ZoneInfo

import httpx

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.cache import set_latest
from app.config import MUSEUM_CLOSED_DAYS, MUSEUM_PUBLIC_HOLIDAYS, settings
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
# No equivalent retry for collect_mmca_once: losing one room of seventeen is a
# far smaller hole than losing the only call of a round, and that room's retry
# is simply the next round — two minutes away on the MMCA_POLL_MINUTES grid,
# against the ten it was before that constant went 10 -> 1 -> 2. An in-round
# retry would buy back all but a few seconds of that wait and nothing else, so
# the grid is what removed the case for one, at either of the finer settings.
# The quota argument that used to sit here is void either way: see
# MMCA_POLL_MINUTES, where that arithmetic now lives.
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

# MMCA 수집 그리드(분). 스케줄러의 cron 과 위 round_time 의 내림이 **반드시**
# 같은 값을 써야 해서 상수 하나로 묶여 있다. 어긋나면(예: cron 1분 + 내림 10분)
# 라운드 10개가 같은 observed_at 으로 찍히고, /mmca/daily 의 분 버킷이 방별
# dict 라 마지막 것만 남는다 — 수집은 정상, API 응답만 90% 사라지는 유일한
# 조용한 실패 경로다.
#
# 100,000/day 쿼터 대비 비용: 최대일(수/토 — 세 관 모두 개관, 서울·덕수궁이
# 21:00 까지)에 10분이 995콜(1.0%), 2분이 4,907콜(4.9%), 1분이 9,797콜(9.8%).
# 방 17개지만 과천은 18:00 에 닫아 하루 241라운드, 나머지 9개 방이 331라운드다.
# 쿼터는 어느 쪽도 제약하지 않는다 — 간격을 정하는 값이 아니다.
#
# 1분이었다가 2분이 됐다. 1분을 고를 때 남겨 둔 두 질문에 하루치 실측이 답했다:
#
# (a) 라운드 실행 시간 — 넘쳤다. 방을 순차 호출하므로 라운드 최악 시간이
#     `방 수 × 방당 timeout` 인데 그 timeout 이 10초라 멈춘 방 6개면 60초
#     격자를 넘었고, 넘으면 다음 라운드가 스킵된다(APScheduler max_instances
#     기본값 1. EVENT_JOB_MAX_INSTANCES 는 EVENT_JOB_ERROR 가 아니라
#     scheduler.py 의 _log_job_error 가 반응하지 않는다). 2026-09-03 에
#     라운드 407개 중 55개가 통째로 스킵돼 20.6% 를 잃었다. 이건 간격이 아니라
#     timeout 이 원인이라 그쪽에서 고쳤다 — mmca_api.py 의
#     FETCH_TIMEOUT_SECONDS 에 산식과 근거가 있다.
#
# (b) 상류 갱신 주기 — 실시간이다. /congestion 응답에 타임스탬프가 없어
#     페이로드만으로는 알 수 없었는데, 1분 수집 하루치의 전이 시각이 답을 줬다:
#     1분 해상도 전이 159건의 발생 분을 5·10 으로 나눈 나머지가 완전 균일해
#     (mod 5: 28/35/33/28/35, mod 10: 11~21) 상류에 5분·10분 주기가 없다.
#
# 그런데 (b) 는 1분을 정당화하지 않는다. 상류가 매분 바뀐다는 것과 매분 받을
# 값이 있다는 것은 다르다. 처음에 근거로 삼았던 "간격별 포착 전이 수"(1분 208,
# 2분 174, 10분 87)는 폐기했다 — 208건 중 34% 가 2분 이하만 유지되고 바뀐 것,
# 37% 가 3분 안에 직전 값으로 되돌아간 왕복이라, 그 표는 센서 임계 근처의
# 잡음에 대한 충실도를 이득으로 세고 있었다.
#
# 간격은 소비자가 실제로 그리는 값으로 정해야 한다. 차트는 10분 버킷 평균을
# 그리므로(프론트 MmcaRoomChartCard), 1분 수집으로 만든 버킷 값을 기준으로
# 간격별 오차를 재면:
#
#     2분   평균 0.016 등급, 최대 0.333, 0.5 이상 벗어난 버킷 0개
#     3분   평균 0.031,      최대 0.500, 1개
#     5분   평균 0.054,      최대 0.889, 6개
#    10분   평균 0.073,      최대 0.889, 13개
#
# 2분은 1분과 화면상 구분되지 않는다. 뒤집으면 1분이 2분보다 얻는 것이 없다는
# 뜻이고, 비용은 두 배다. 3분이 경계선이라 그 아래로는 내려가지 않는다.
#
# 간격을 바꾸는 것이 안전해진 것은 PR #84 이후다. 그전에는 build_profile 이
# 셀 안의 판독을 통째로 평균내 판독 수가 곧 가중치였고, 간격을 바꾸면 예측이
# 조용히 따라 움직였다. 지금은 날짜별 선평균이라 간격과 예측이 분리돼 있다.
MMCA_POLL_MINUTES = 2

# 진행 중인 전시가 없는 방(resultCode 0002)을 다시 확인하는 주기(분). 그 사이
# 라운드에서는 그런 방을 아예 부르지 않는다.
#
# 이 스킵은 한 번 있었다가 지워진 적이 있다. 옛 1,000콜/일 상한 때문에 11시부터
# 2시간 주기로 떨어뜨렸는데, 낮에 새로 여는 전시를 최대 2시간 뒤에야 잡아서
# 상한이 풀리자마자 걷어냈다. 지금 다시 넣는 근거는 쿼터가 아니다 — 쿼터는
# 100,000/일 대비 4.9% 라 어느 쪽도 제약하지 않는다(MMCA_POLL_MINUTES 참조).
#
# 근거는 두 가지다:
#
#   행 노이즈. 2026-08-25~09-06 실측으로 17방 중 7방(1002·1004·1008·2002·
#   2004·2006·4001)이 판독 100% 가 빈 응답이었다. 매 라운드 담으면 하루
#   2,300여 행이 정보 0으로 쌓이고, 콜의 41% 가 그 행을 만드는 데 쓰인다.
#
#   라운드 길이. 방을 순차로 부르므로 라운드 시간이 `방 수 × 방당 timeout` 이고,
#   그 값이 격자를 넘으면 다음 라운드가 통째로 버려진다(2026-09-03 에 407라운드
#   중 55개). 30라운드 중 29개가 10방 30초로 줄어, 상류가 느려졌을 때 걸려 있는
#   방이 절반이 된다.
#
# 다만 두 번째 근거는 **최악 시간을 줄이지 않는다** — probe 라운드는 여전히
# 17방이라 최악은 51초 그대로다. mmca_api.py 의 FETCH_TIMEOUT_SECONDS 산식을
# 묶고 있는 것은 계속 그 라운드이고, 방이 늘면 여기가 아니라 그쪽을 봐야 한다.
# (2026-09-08 실측으로 51초는 120초 격자 안에 들어간다: 그날 4,097콜 전부 성공,
# 손실 0.)
#
# 30분인 이유는 되살아나는 방이 실재하기 때문이다. 1003·1005 는 7/26 부터 37일
# 내리 0002 였다가 **9/1 15:00 에** 살아났다 — 개장 시각이 아니라 장중이었다.
# 하루 한 번 확인이었다면 그날을 통째로 놓쳤다. 30분이면 늦어도 그 안에 잡고,
# 옛 스킵이 지워진 이유였던 "최대 2시간"의 1/4 이다. 지연을 더 줄이고 싶으면
# 이 값만 내리면 된다 — 비용은 probe 라운드 하나당 7콜뿐이다.
_PROBE_MINUTES = 30

# 요일 휴관. 덕수궁관은 궁 안에 있고 과천관도 화~일 주간을 지킨다 — 매주 월요일
# 문을 여는 것은 서울관뿐이다.
#
# 폐관 중에도 API 는 에러가 아니라 정상 응답으로 "여유"를 돌려준다. 그래서 이
# 게이트는 쿼터 장치가 아니라 데이터 품질 장치다: 없으면 "닫혀서 빈 것"이
# "열려 있는데 한산함"으로 히스토리에 쌓이고, build_profile 이 (방, 요일, 시각)
# 평균을 내므로 예측 프로파일을 그대로 끌어내린다. 과천 월요일 895 건이 전부
# 여유인 것이 그 증거다(공휴일 월요일은 이 895 건에서 빠진다 — 그날은 문을 열어
# non-여유가 섞이고, 아래 _is_closed_day 문서의 185건이 그 표본이다).
_VENUE_CLOSED_DAYS: dict[str, set[int]] = {
    "gwacheon": {0},  # 월요일 휴무
    "deoksugung": {0},  # 월요일 휴무
}


def _is_closed_day(venue: str, day: date) -> bool:
    """그날 그 관이 문을 닫는가.

    프론트 src/lib/museumCalendar.ts 의 isClosedDay 와 같은 규칙이다. 목록은
    shared/museum-holidays.json 하나뿐이고 규칙만 양쪽에 있다 — 값이 아니라
    목록을 중복하는 쪽이 위험해서 그것만 공유한다.

    공휴일 월요일에 문을 열고 다음 날 쉬는 규칙(아래 둘째·셋째 갈래)의 출처는
    **공식 문서가 아니라 실측**이다. 과천·덕수궁 관람정보와 MMCA FAQ 모두
    "1월1일, 매주 월요일" 만 적는다. 근거는 2026-08-17(월, 광복절 대체)에
    과천관 non-여유 185건, 이튿날 219 판독 전부 여유 하나뿐이다 — 신호는
    모호하지 않지만 표본이 하나다. 2026-10-05(월, 공휴일)는 둘째 갈래를 다시
    검증할 다음 기회다 — 그날 과천관이 non-빈 값을 수집하면 확인된다. 하지만
    셋째 갈래(대체휴무일)는 이 배포 이후로는 우리 데이터로 재검증할 수 없다:
    _is_venue_open 이 10/06 을 닫힘으로 판정해 _open_space_codes 가 그날
    과천관을 아예 빼 버리기 때문이다. 10/06 이 실제로 휴관인지는 이제 관측이
    아니라 관 공지나 방문으로만 확인할 수 있다.
    """
    if day.isoformat() in MUSEUM_CLOSED_DAYS.get(venue, frozenset()):
        return True

    weekly_closed = _VENUE_CLOSED_DAYS.get(venue, set())
    if day.weekday() in weekly_closed:
        return day.isoformat() not in MUSEUM_PUBLIC_HOLIDAYS

    previous = day - timedelta(days=1)
    return previous.weekday() in weekly_closed and previous.isoformat() in MUSEUM_PUBLIC_HOLIDAYS


def _is_venue_open(venue: str, now: datetime) -> bool:
    if _is_closed_day(venue, now.date()):
        return False
    close = _LONG_CLOSE if now.weekday() in _LONG_DAYS.get(venue, set()) else _NORMAL_CLOSE
    # Truncate to the minute before comparing. The scheduler only ever fires
    # exactly on the grid but real execution lands a little after that
    # instant, and closing time's inclusive upper bound is exact-second — a
    # poll running even 1ms past close would otherwise read as closed,
    # silently dropping the closing-time reading on every business day.
    now_minute = now.time().replace(second=0, microsecond=0)
    return _COLLECTION_START <= now_minute <= close


def _open_space_codes(now: datetime) -> list[str]:
    """지금 개관 중인 관의 전시실 코드 전부."""
    return [
        space_code
        for venue, codes in settings.mmca_venue_space_codes.items()
        if _is_venue_open(venue, now)
        for space_code in codes
    ]


def _rooms_to_poll(session: Session, space_codes: list[str], round_time: datetime) -> list[str]:
    """이번 라운드에 실제로 부를 방 — 상시 0002 인 방은 probe 라운드에만 낀다.

    "상시 0002" 를 별도 상태로 들고 있지 않고 직전 _PROBE_MINUTES 창의 판독으로
    매번 다시 판정한다. 재시작이 상태를 지울 수 없고, 방이 살아나면 그 판독
    자체가 다음 라운드의 판정을 바꿔 놓는다 — 되돌릴 자리가 따로 없다.
    """
    # `== 0` 이 아니라 `< MMCA_POLL_MINUTES` 인 이유: 격자가 30 을 나누지 않는
    # 값이 되면 30분 자리에 라운드가 아예 없다. 4분이면 분이 0,4,…,28,32,… 라
    # 30 을 건너뛰어 probe 가 시간당 한 번으로 줄어든다(정각은 어느 격자에서도
    # 나오므로 멈추지는 않는다). 30분 창의 **첫 라운드**를 잡으면 격자가
    # 무엇이든 창마다 정확히 하나가 probe 다 — 라운드 간격이 곧
    # MMCA_POLL_MINUTES 라 폭 안에 마크가 둘 들어올 수 없다.
    if round_time.minute % _PROBE_MINUTES < MMCA_POLL_MINUTES:
        return space_codes

    since = round_time - timedelta(minutes=_PROBE_MINUTES)
    # max() 는 NULL 을 무시하므로, 창 안에 산 판독이 하나라도 있던 방만 값이
    # non-NULL 로 나온다.
    rows = session.execute(
        select(RawMmcaCongestion.space_code, func.max(RawMmcaCongestion.congestion_nm))
        .where(RawMmcaCongestion.observed_at >= since)
        .group_by(RawMmcaCongestion.space_code)
    ).all()
    # 창이 통째로 비어 있으면 "전부 0002" 가 아니라 "판정할 근거가 없다" 는
    # 뜻이다 — 개관 직후이거나 재시작 직후다. 빈 결과를 스킵으로 읽으면 다음
    # probe 까지 최대 _PROBE_MINUTES 를 통째로 잃는다.
    if not rows:
        return space_codes

    live = {space_code for space_code, congestion_nm in rows if congestion_nm is not None}
    return [space_code for space_code in space_codes if space_code in live]


def collect_mmca_once(session_factory=SessionLocal, now: datetime | None = None) -> list[MmcaCongestionReading]:
    # Server local time isn't guaranteed to be KST (e.g. a UTC container), so
    # pin explicitly to Asia/Seoul instead of a naive datetime.now().
    now = now or datetime.now(_SEOUL_TZ).replace(tzinfo=None)
    # The scheduler fires this on the MMCA_POLL_MINUTES cron grid, but
    # scheduler jitter or a misfire-grace-time catch-up run can land the
    # actual invocation off that mark. Every reading in this round is stamped
    # with the grid mark itself (not raw `now`), so collection rounds always
    # land on a fixed, predictable grid regardless of when the round ran.
    round_time = now.replace(
        minute=(now.minute // MMCA_POLL_MINUTES) * MMCA_POLL_MINUTES, second=0, microsecond=0
    )

    space_codes = _open_space_codes(now)
    if not space_codes:
        return []

    with session_factory() as session:
        space_codes = _rooms_to_poll(session, space_codes, round_time)
    if not space_codes:
        return []

    readings: list[MmcaCongestionReading] = []
    with httpx.Client() as client:
        for space_code in space_codes:
            try:
                reading = fetch_mmca_congestion(client, space_code, settings.mmca_api_key)
            except _FETCH_FAILURES as exc:
                # data.go.kr can return a non-JSON (e.g. XML error) body with
                # a 200 status — response.json() then raises JSONDecodeError,
                # not HTTPError. Isolate it per-room the same way. (Key errors
                # are not that case on this endpoint: measured 2026-09-02 they
                # are 4xx, so they arrive here as HTTPStatusError. Same handler
                # either way — see mmca_api's _EXPECTED_RESULT_CODES.)
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
