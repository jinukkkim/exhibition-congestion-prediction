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


def test_collect_mmca_job_is_cron_aligned_to_ten_minutes():
    from datetime import datetime

    from app.scheduler import build_scheduler

    scheduler = build_scheduler()
    job = scheduler.get_job("collect_mmca_congestion")

    fields = {f.name: str(f) for f in job.trigger.fields}
    assert fields["minute"] == "*/10"

    # Regardless of when the scheduler starts, the next fire must land
    # exactly on the 10-minute grid — no immediate off-grid poll.
    next_fire = job.trigger.get_next_fire_time(
        None, datetime(2026, 7, 26, 15, 37, 0).astimezone()
    )
    assert next_fire.minute % 10 == 0
    assert next_fire.second == 0


def test_collect_congestion_job_is_cron_aligned_to_five_minutes():
    from datetime import datetime

    from app.scheduler import build_scheduler

    scheduler = build_scheduler()
    job = scheduler.get_job("collect_congestion")

    fields = {f.name: str(f) for f in job.trigger.fields}
    assert fields["minute"] == "*/5"

    next_fire = job.trigger.get_next_fire_time(
        None, datetime(2026, 7, 26, 15, 37, 0).astimezone()
    )
    assert next_fire.minute % 5 == 0
    assert next_fire.second == 0


def test_scheduler_jobs_have_no_immediate_off_grid_startup_poll():
    from app.scheduler import build_scheduler

    scheduler = build_scheduler()
    # next_run_time isn't computed until the scheduler actually starts —
    # start it just long enough to read the computed schedule, then stop
    # without letting anything actually fire.
    scheduler.start(paused=True)
    try:
        # Neither collection job should carry an explicit next_run_time
        # override — that would force an immediate off-grid poll on every
        # restart, which is exactly what cron-alignment is meant to avoid.
        # Whatever moment the test runs, the computed next_run_time must
        # already land on each job's own grid.
        mmca_job = scheduler.get_job("collect_mmca_congestion")
        assert mmca_job.next_run_time.minute % 10 == 0
        assert mmca_job.next_run_time.second == 0

        congestion_job = scheduler.get_job("collect_congestion")
        assert congestion_job.next_run_time.minute % 5 == 0
        assert congestion_job.next_run_time.second == 0
    finally:
        scheduler.shutdown(wait=False)
