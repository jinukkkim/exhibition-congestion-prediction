import logging

from apscheduler.events import EVENT_JOB_ERROR
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from app.collector import collect_mmca_once, collect_once
from app.prediction.batch import run_daily_batch

logger = logging.getLogger(__name__)


def _log_job_error(event):
    logger.error(
        "Scheduled job %s failed: %s",
        event.job_id,
        type(event.exception).__name__,
    )


def build_scheduler() -> BackgroundScheduler:
    scheduler = BackgroundScheduler()
    scheduler.add_job(
        collect_once,
        # Cron-aligned to :00/:05/:10/... so collection always lands on a
        # fixed grid regardless of when the server restarts, instead of
        # free-running from server start.
        trigger=CronTrigger(minute="*/5"),
        id="collect_congestion",
        misfire_grace_time=60,
    )
    scheduler.add_job(
        collect_mmca_once,
        # Same reasoning as collect_congestion: cron-align to a fixed
        # 10-minute grid instead of free-running from server start.
        # Deoksugung + Gwacheon's children's museum are excluded from
        # collection (see MMCA_DISABLED_SPACE_CODES) specifically so the
        # remaining 15 rooms can poll this often and stay under the MMCA
        # API's 1,000-call/day cap even on extended-hours days.
        trigger=CronTrigger(minute="*/10"),
        id="collect_mmca_congestion",
        misfire_grace_time=60,
    )
    scheduler.add_job(
        run_daily_batch,
        trigger=CronTrigger(hour=3, minute=0),
        id="daily_batch",
        misfire_grace_time=3600,
    )
    scheduler.add_listener(_log_job_error, EVENT_JOB_ERROR)
    return scheduler
