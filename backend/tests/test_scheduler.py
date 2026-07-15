def test_build_scheduler_registers_expected_jobs():
    from app.scheduler import build_scheduler

    scheduler = build_scheduler()
    job_ids = {job.id for job in scheduler.get_jobs()}

    assert job_ids == {"collect_congestion", "daily_batch"}


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
    assert "boom" in caplog.text
