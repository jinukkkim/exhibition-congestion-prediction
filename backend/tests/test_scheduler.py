def test_build_scheduler_registers_expected_jobs():
    from app.scheduler import build_scheduler

    scheduler = build_scheduler()
    job_ids = {job.id for job in scheduler.get_jobs()}

    assert job_ids == {"collect_congestion", "collect_mmca_congestion", "daily_batch"}


def test_job_error_listener_logs_failure(caplog):
    from datetime import datetime, timezone

    from apscheduler.events import JobExecutionEvent, EVENT_JOB_ERROR

    from app.scheduler import build_scheduler

    scheduler = build_scheduler()
    error_listeners = [
        callback
        for callback, mask in scheduler._listeners
        if mask & EVENT_JOB_ERROR
    ]
    assert error_listeners, "no listener registered for EVENT_JOB_ERROR"

    event = JobExecutionEvent(
        code=EVENT_JOB_ERROR,
        job_id="collect_congestion",
        jobstore="default",
        scheduled_run_time=datetime.now(timezone.utc),
        exception=RuntimeError("boom"),
    )

    with caplog.at_level("ERROR"):
        for callback in error_listeners:
            callback(event)

    assert "collect_congestion" in caplog.text
    assert "RuntimeError" in caplog.text


def test_job_error_listener_does_not_leak_exception_message(caplog):
    from datetime import datetime, timezone

    from apscheduler.events import JobExecutionEvent, EVENT_JOB_ERROR

    from app.scheduler import build_scheduler

    scheduler = build_scheduler()
    error_listeners = [
        callback
        for callback, mask in scheduler._listeners
        if mask & EVENT_JOB_ERROR
    ]

    event = JobExecutionEvent(
        code=EVENT_JOB_ERROR,
        job_id="collect_congestion",
        jobstore="default",
        scheduled_run_time=datetime.now(timezone.utc),
        exception=RuntimeError("http://x/SECRET123/json/citydata/1/5/area"),
    )

    with caplog.at_level("ERROR"):
        for callback in error_listeners:
            callback(event)

    assert "collect_congestion" in caplog.text
    assert "SECRET123" not in caplog.text


def test_collect_mmca_job_runs_every_15_minutes():
    from datetime import timedelta

    from app.scheduler import build_scheduler

    scheduler = build_scheduler()
    job = scheduler.get_job("collect_mmca_congestion")

    assert job.trigger.interval == timedelta(minutes=15)


def test_collect_mmca_job_runs_immediately_on_startup():
    from datetime import datetime, timedelta

    from app.scheduler import build_scheduler

    before = datetime.now().astimezone()
    scheduler = build_scheduler()
    job = scheduler.get_job("collect_mmca_congestion")

    # Without an explicit next_run_time, IntervalTrigger waits a full
    # interval before the first run — this asserts the job is instead
    # scheduled to run right away (within a few seconds of "now"), not
    # ~15 minutes out.
    assert job.next_run_time - before < timedelta(seconds=5)


def test_collect_congestion_job_runs_immediately_on_startup():
    from datetime import datetime, timedelta

    from app.scheduler import build_scheduler

    before = datetime.now().astimezone()
    scheduler = build_scheduler()
    job = scheduler.get_job("collect_congestion")

    assert job.next_run_time - before < timedelta(seconds=5)
