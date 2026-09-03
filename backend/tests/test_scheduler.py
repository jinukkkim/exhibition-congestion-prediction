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


def test_collect_mmca_job_is_cron_aligned_to_the_poll_grid():
    from datetime import datetime

    from app.collector import MMCA_POLL_MINUTES
    from app.scheduler import build_scheduler

    scheduler = build_scheduler()
    job = scheduler.get_job("collect_mmca_congestion")

    # The cron spacing must be exactly MMCA_POLL_MINUTES, because
    # collect_mmca_once floors its stamps to that same number. A cron finer
    # than the floor makes several rounds share one observed_at, which
    # /mmca/daily then collapses to a single reading per room.
    fields = {f.name: str(f) for f in job.trigger.fields}
    assert fields["minute"] == f"*/{MMCA_POLL_MINUTES}"

    # Regardless of when the scheduler starts, the next fire must land
    # exactly on the grid — no immediate off-grid poll.
    next_fire = job.trigger.get_next_fire_time(
        None, datetime(2026, 7, 26, 15, 37, 0).astimezone()
    )
    assert next_fire.minute % MMCA_POLL_MINUTES == 0
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
    from app.collector import MMCA_POLL_MINUTES
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
        #
        # Both halves carry weight again now that MMCA_POLL_MINUTES is 2 —
        # while it was 1 the modulus was vacuous (every minute sits on the
        # grid) and the sub-second pair was the whole test. That pair is
        # still the part that catches an override pinned to "now": such an
        # instant keeps the wall clock's seconds and microseconds, while a
        # cron-computed fire time is zero in both.
        mmca_job = scheduler.get_job("collect_mmca_congestion")
        assert mmca_job.next_run_time.minute % MMCA_POLL_MINUTES == 0
        assert (mmca_job.next_run_time.second, mmca_job.next_run_time.microsecond) == (0, 0)

        congestion_job = scheduler.get_job("collect_congestion")
        assert congestion_job.next_run_time.minute % 5 == 0
        assert (congestion_job.next_run_time.second, congestion_job.next_run_time.microsecond) == (
            0,
            0,
        )
    finally:
        scheduler.shutdown(wait=False)


def test_daily_batch_fires_just_after_midnight_seoul_not_server_time():
    """Production runs on Etc/UTC, where an unpinned cron put this at noon KST.

    Asserted through the trigger's own resolution rather than the configured
    timezone, so it still holds if the jobs ever move to per-trigger zones.

    00:02 rather than midnight: the Seoul collector runs on */5, so every
    multiple-of-five minute fires a full-table-scan batch alongside an insert.
    MMCA is on */2, so an even minute like :02 does sit on its grid — but at
    midnight it returns from _is_venue_open without a request or a row, which
    is what made the collision irrelevant while the grid was every minute too.
    """
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo

    from app.scheduler import build_scheduler

    seoul = ZoneInfo("Asia/Seoul")
    scheduler = build_scheduler()
    trigger = {job.id: job.trigger for job in scheduler.get_jobs()}["daily_batch"]

    # Midnight KST on a fixed date, expressed in UTC so the host's own zone
    # can't leak into the fixture.
    previous = datetime(2026, 8, 12, 15, 0, tzinfo=timezone.utc)
    fire = trigger.get_next_fire_time(None, previous)

    assert fire.astimezone(seoul).hour == 0
    assert fire.astimezone(seoul).minute == 2
    assert fire.astimezone(timezone.utc).hour == 15  # 00:02 KST == 15:02 UTC


def test_daily_batch_does_not_collide_with_the_collector_grid():
    """서울시 수집기가 */5 라 5의 배수 분은 동시 발사된다. MMCA 는 */2 라 짝수 분인
    :02 가 그 격자 위에 있지만, 자정에는 영업시간 게이트에 걸려 아무것도 하지 않는다."""
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo

    from app.scheduler import build_scheduler

    seoul = ZoneInfo("Asia/Seoul")
    trigger = {job.id: job.trigger for job in build_scheduler().get_jobs()}["daily_batch"]

    previous = datetime(2026, 8, 12, 15, 0, tzinfo=timezone.utc)
    fire = trigger.get_next_fire_time(None, previous)

    assert fire.astimezone(seoul).minute % 5 != 0
