from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.collector import collect_once
from app.prediction.batch import run_daily_batch


def build_scheduler() -> BackgroundScheduler:
    scheduler = BackgroundScheduler()
    scheduler.add_job(
        collect_once,
        trigger=IntervalTrigger(minutes=5),
        id="collect_congestion",
        misfire_grace_time=60,
    )
    scheduler.add_job(
        run_daily_batch,
        trigger=CronTrigger(hour=3, minute=0),
        id="daily_batch",
        misfire_grace_time=3600,
    )
    return scheduler
