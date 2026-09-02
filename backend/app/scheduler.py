import logging
from zoneinfo import ZoneInfo

from apscheduler.events import EVENT_JOB_ERROR
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from app.collector import collect_mmca_once, collect_once
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
        # Same reasoning as collect_congestion: cron-align to a fixed
        # 10-minute grid instead of free-running from server start.
        # 17 rooms on this grid cost about 1,100 calls on an extended-hours
        # day, against a 100,000/day MMCA API cap — the grid is free to get
        # finer, but that changes how dense every chart is and is worth doing
        # at a day boundary.
        trigger=CronTrigger(minute="*/10", timezone=_SEOUL_TZ),
        id="collect_mmca_congestion",
        misfire_grace_time=60,
    )
    scheduler.add_job(
        run_daily_batch,
        # 자정 직후 — 배치가 만드는 것이 "오늘부터 7일의 커브"이므로 하루가
        # 시작될 때 도는 것이 맞다. 03:00 이던 동안에는 자정~03:00 에 들어온
        # 사람에게 목록의 첫 항목이 어제였다. 정각이 아닌 이유는 수집기가
        # */5, MMCA 가 */10 이라 5의 배수 분에 동시 발사되기 때문이다.
        trigger=CronTrigger(hour=0, minute=2, timezone=_SEOUL_TZ),
        id="daily_batch",
        misfire_grace_time=3600,
    )
    scheduler.add_listener(_log_job_error, EVENT_JOB_ERROR)
    return scheduler
