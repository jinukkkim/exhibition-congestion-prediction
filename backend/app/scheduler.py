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
        # Same reasoning as collect_congestion: cron-align to :00/:15/:30/:45
        # instead of free-running from server start.
        trigger=CronTrigger(minute="0,15,30,45"),
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
