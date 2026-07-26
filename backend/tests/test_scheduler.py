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


def test_collect_mmca_job_is_cron_aligned_to_the_quarter_hour():
    from datetime import datetime

    from app.scheduler import build_scheduler

    scheduler = build_scheduler()
    job = scheduler.get_job("collect_mmca_congestion")

    fields = {f.name: str(f) for f in job.trigger.fields}
    assert fields["minute"] == "0,15,30,45"

    # Regardless of when the scheduler starts, the *second* fire (the first
    # one after the immediate startup poll) must land exactly on :00/:15/:30/:45.
    second_fire = job.trigger.get_next_fire_time(
        None, datetime(2026, 7, 26, 15, 37, 0).astimezone()
    )
    assert second_fire.minute in (0, 15, 30, 45)
    assert second_fire.second == 0


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
