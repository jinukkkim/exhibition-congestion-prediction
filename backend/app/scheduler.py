import logging
from zoneinfo import ZoneInfo

from apscheduler.events import EVENT_JOB_ERROR
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from app.collector import MMCA_POLL_MINUTES, collect_mmca_once, collect_once
from app.prediction.batch import run_daily_batch

logger = logging.getLogger(__name__)

# Every cron field below is a wall-clock time in the venues' timezone, but
# APScheduler resolves them against the server's clock by default — and
# production runs on Etc/UTC, which put the "3am" batch at noon KST.
#
# This has to go on each CronTrigger, not just on the scheduler: a trigger
# built by hand captures its own timezone at construction, so the scheduler's
# default only ever reaches jobs added by trigger *alias* ("cron", hour=3).
# It's set in both places anyway so a future alias-style job inherits Seoul
# rather than silently falling back to the server clock.
_SEOUL_TZ = ZoneInfo("Asia/Seoul")


def _log_job_error(event):
    logger.error(
        "Scheduled job %s failed: %s",
        event.job_id,
        type(event.exception).__name__,
    )


def build_scheduler() -> BackgroundScheduler:
    scheduler = BackgroundScheduler(timezone=_SEOUL_TZ)
    scheduler.add_job(
        collect_once,
        # Cron-aligned to :00/:05/:10/... so collection always lands on a
        # fixed grid regardless of when the server restarts, instead of
        # free-running from server start.
        trigger=CronTrigger(minute="*/5", timezone=_SEOUL_TZ),
        id="collect_congestion",
        misfire_grace_time=60,
    )
    scheduler.add_job(
        collect_mmca_once,
        # Same reasoning as collect_congestion: cron-align to a fixed grid
        # instead of free-running from server start. The spacing lives in
        # MMCA_POLL_MINUTES because collect_mmca_once floors its stamps to the
        # same grid — see that constant for the quota arithmetic and for what
        # actually bounds the interval.
        trigger=CronTrigger(minute=f"*/{MMCA_POLL_MINUTES}", timezone=_SEOUL_TZ),
        id="collect_mmca_congestion",
        misfire_grace_time=60,
    )
    scheduler.add_job(
        run_daily_batch,
        # 자정 직후 — 배치가 만드는 것이 "오늘부터 7일의 커브"이므로 하루가
        # 시작될 때 도는 것이 맞다. 03:00 이던 동안에는 자정~03:00 에 들어온
        # 사람에게 목록의 첫 항목이 어제였다.
        #
        # 정각이 아닌 이유는 서울시 수집기가 */5 라 5의 배수 분에 동시 발사되기
        # 때문이다. 그쪽은 영업시간 게이트가 없어 자정에도 실제로 API 를 치고
        # DB 에 쓴다. MMCA 는 */2 라 짝수 분인 :02 가 그 격자 위에 있지만,
        # 겹칠 상대가 없다 — 자정의 collect_mmca_once 는 _is_venue_open 에서
        # 걸려 HTTP 도 DB 도 없이 빈 리스트로 즉시 반환한다. 그래서 이 분을
        # 고르는 데 MMCA 격자는 고려 대상이 아니다. 매분 발사되던 동안에도
        # 같은 이유로 무관했다.
        trigger=CronTrigger(hour=0, minute=2, timezone=_SEOUL_TZ),
        id="daily_batch",
        misfire_grace_time=3600,
    )
    scheduler.add_listener(_log_job_error, EVENT_JOB_ERROR)
    return scheduler
