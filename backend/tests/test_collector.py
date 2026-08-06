import json
from datetime import datetime

import fakeredis
import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app.mmca_api import MmcaCongestionReading
from app.models import RawCongestion, RawMmcaCongestion
from app.seoul_api import CongestionReading


@pytest.fixture
def session_factory():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


@pytest.fixture(autouse=True)
def fake_redis(monkeypatch):
    import app.cache as cache_module

    monkeypatch.setattr(cache_module, "r", fakeredis.FakeRedis(decode_responses=True))


def test_collect_once_stores_and_caches(monkeypatch, session_factory):
    import app.collector as collector_module

    fake_reading = CongestionReading(
        observed_at=datetime(2026, 7, 15, 14, 30),
        congest_level="보통",
        population_min=1000,
        population_max=2000,
    )
    monkeypatch.setattr(collector_module, "fetch_congestion", lambda client, area, key: fake_reading)

    result = collector_module.collect_once(session_factory=session_factory)

    assert result == fake_reading
    with session_factory() as session:
        assert session.query(RawCongestion).count() == 1

    from app.cache import get_latest
    assert get_latest()["congest_level"] == "보통"


def test_collect_once_propagates_api_error(monkeypatch, session_factory):
    import app.collector as collector_module

    def raise_error(client, area, key):
        raise httpx.HTTPError("boom")

    monkeypatch.setattr(collector_module, "fetch_congestion", raise_error)

    with pytest.raises(httpx.HTTPError):
        collector_module.collect_once(session_factory=session_factory)

    with session_factory() as session:
        assert session.query(RawCongestion).count() == 0


def test_collect_once_stores_population_breakdown_fields(monkeypatch, session_factory):
    import app.collector as collector_module

    fake_reading = CongestionReading(
        observed_at=datetime(2026, 7, 15, 14, 30),
        congest_level="보통",
        population_min=1000,
        population_max=2000,
        male_ppltn_rate=51.8,
        resnt_ppltn_rate=45.1,
    )
    monkeypatch.setattr(collector_module, "fetch_congestion", lambda client, area, key: fake_reading)

    collector_module.collect_once(session_factory=session_factory)

    with session_factory() as session:
        stored = session.query(RawCongestion).one()
        assert stored.male_ppltn_rate == 51.8
        assert stored.resnt_ppltn_rate == 45.1


def test_collect_once_stores_raw_response(monkeypatch, session_factory):
    import app.collector as collector_module

    fake_reading = CongestionReading(
        observed_at=datetime(2026, 7, 15, 14, 30),
        congest_level="보통",
        population_min=1000,
        population_max=2000,
        raw_response='{"CITYDATA": {"AREA_NM": "test"}}',
    )
    monkeypatch.setattr(collector_module, "fetch_congestion", lambda client, area, key: fake_reading)

    collector_module.collect_once(session_factory=session_factory)

    with session_factory() as session:
        stored = session.query(RawCongestion).one()
        assert stored.raw_response == '{"CITYDATA": {"AREA_NM": "test"}}'


def test_is_venue_open_normal_day_within_hours():
    from app.collector import _is_venue_open

    # 2026-07-27 is a Monday
    # Collection starts 10 minutes after the real 10:00 opening time —
    # the 10:00 poll itself is deliberately skipped (see _COLLECTION_START).
    assert _is_venue_open("seoul", datetime(2026, 7, 27, 10, 0)) is False
    assert _is_venue_open("seoul", datetime(2026, 7, 27, 10, 9)) is False
    assert _is_venue_open("seoul", datetime(2026, 7, 27, 10, 10)) is True
    assert _is_venue_open("seoul", datetime(2026, 7, 27, 18, 0)) is True
    assert _is_venue_open("seoul", datetime(2026, 7, 27, 18, 1)) is False
    assert _is_venue_open("seoul", datetime(2026, 7, 27, 9, 59)) is False


def test_is_venue_open_tolerates_sub_minute_jitter_at_closing():
    from app.collector import _is_venue_open

    # The scheduler fires exactly at 18:00:00, but real execution always
    # lands a little after that instant. Comparing by minute (not exact
    # second) means the closing-time reading isn't silently dropped just
    # because the poll ran a few seconds late within the same minute.
    assert _is_venue_open("seoul", datetime(2026, 7, 27, 18, 0, 47)) is True
    assert _is_venue_open("seoul", datetime(2026, 7, 27, 18, 0, 59, 999999)) is True
    # A full minute late is still correctly treated as closed.
    assert _is_venue_open("seoul", datetime(2026, 7, 27, 18, 1, 0)) is False


def test_is_venue_open_gwacheon_tolerates_sub_minute_jitter_at_long_day_closing():
    from app.collector import _is_venue_open

    # The bug was originally found on Gwacheon specifically. The check is
    # shared across venues, but this pins the venue where it actually
    # mattered, on its long day (Wed/Sat, 21:00 close).
    # 2026-07-29 is a Wednesday.
    assert _is_venue_open("gwacheon", datetime(2026, 7, 29, 21, 0, 47)) is True
    assert _is_venue_open("gwacheon", datetime(2026, 7, 29, 21, 1, 0)) is False


def test_is_venue_open_long_day():
    from app.collector import _is_venue_open

    # 2026-07-29 is a Wednesday
    assert _is_venue_open("seoul", datetime(2026, 7, 29, 20, 0)) is True
    assert _is_venue_open("seoul", datetime(2026, 7, 29, 21, 0)) is True
    assert _is_venue_open("seoul", datetime(2026, 7, 29, 21, 1)) is False


def test_is_venue_open_deoksugung_closed_on_monday():
    from app.collector import _is_venue_open

    # 2026-07-27 is a Monday — within Seoul's hours, but Deoksugung is shut.
    assert _is_venue_open("deoksugung", datetime(2026, 7, 27, 14, 0)) is False
    # 2026-07-28 is a Tuesday — same hours as Seoul, open.
    assert _is_venue_open("deoksugung", datetime(2026, 7, 28, 14, 0)) is True


def test_collect_mmca_once_skips_api_call_when_closed(monkeypatch, session_factory):
    import app.collector as collector_module

    call_count = 0

    def fake_fetch(client, space_code, api_key):
        nonlocal call_count
        call_count += 1
        raise AssertionError("should not be called outside business hours")

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)

    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 8, 0)
    )

    assert result == []
    assert call_count == 0
    with session_factory() as session:
        assert session.query(RawMmcaCongestion).count() == 0


def test_collect_mmca_once_fetches_all_rooms_when_open(monkeypatch, session_factory):
    import app.collector as collector_module

    def fake_fetch(client, space_code, api_key):
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 27, 14, 0),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="국립현대미술관 서울관",
            congestion_nm="보통",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {"seoul": ["MMCA-SPACE-1001", "MMCA-SPACE-1002"]},
    )

    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 14, 0)
    )

    assert len(result) == 2
    with session_factory() as session:
        assert session.query(RawMmcaCongestion).count() == 2


def test_collect_mmca_once_continues_after_one_room_fails(monkeypatch, session_factory):
    import app.collector as collector_module

    def fake_fetch(client, space_code, api_key):
        if space_code == "MMCA-SPACE-1001":
            raise httpx.HTTPError("boom")
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 27, 14, 0),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="국립현대미술관 서울관",
            congestion_nm="여유",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {"seoul": ["MMCA-SPACE-1001", "MMCA-SPACE-1002"]},
    )

    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 14, 0)
    )

    assert len(result) == 1
    assert result[0].space_code == "MMCA-SPACE-1002"
    with session_factory() as session:
        assert session.query(RawMmcaCongestion).count() == 1


def test_collect_mmca_once_continues_after_one_room_returns_invalid_json(monkeypatch, session_factory):
    """data.go.kr sometimes returns a non-JSON (e.g. XML error) body with a 200
    status on key/quota errors. That must not crash the whole collection cycle."""
    import app.collector as collector_module

    def fake_fetch(client, space_code, api_key):
        if space_code == "MMCA-SPACE-1001":
            raise json.JSONDecodeError("bad json", "doc", 0)
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 27, 14, 0),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="국립현대미술관 서울관",
            congestion_nm="여유",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {"seoul": ["MMCA-SPACE-1001", "MMCA-SPACE-1002"]},
    )

    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 14, 0)
    )

    assert len(result) == 1
    assert result[0].space_code == "MMCA-SPACE-1002"
    with session_factory() as session:
        assert session.query(RawMmcaCongestion).count() == 1


def test_collect_mmca_once_normalizes_observed_at_across_the_round(monkeypatch, session_factory):
    """Rooms are polled sequentially, each via its own HTTP call that stamps
    its own wall-clock time. A slow batch can straddle a minute boundary
    mid-round (room 1 fetched at :39:59, room 2 at :40:03) — without
    normalization those readings would land in different /mmca/daily minute
    buckets even though they belong to the same collection round."""
    import app.collector as collector_module

    def fake_fetch(client, space_code, api_key):
        drifted_time = {
            "MMCA-SPACE-2001": datetime(2026, 7, 27, 14, 39, 59),
            "MMCA-SPACE-2002": datetime(2026, 7, 27, 14, 40, 3),
        }[space_code]
        return MmcaCongestionReading(
            observed_at=drifted_time,
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="국립현대미술관 과천관",
            congestion_nm="보통",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {"gwacheon": ["MMCA-SPACE-2001", "MMCA-SPACE-2002"]},
    )

    round_time = datetime(2026, 7, 27, 14, 40, 0)
    result = collector_module.collect_mmca_once(session_factory=session_factory, now=round_time)

    assert len(result) == 2
    assert all(reading.observed_at == round_time for reading in result)
    with session_factory() as session:
        stored_times = {row.observed_at for row in session.query(RawMmcaCongestion).all()}
    assert stored_times == {round_time}


def test_collect_mmca_once_snaps_observed_at_to_the_10_minute_grid(monkeypatch, session_factory):
    """The scheduler fires on a 10-minute cron grid, but jitter or a
    misfire-grace-time catch-up run can land the actual invocation a few
    minutes off that mark (e.g. 11:31 instead of 11:30). Every reading must
    still be stamped with the grid mark, not the raw run time, so rounds are
    always exactly 10 minutes apart regardless of when they actually ran."""
    import app.collector as collector_module

    def fake_fetch(client, space_code, api_key):
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 27, 11, 31, 12),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="국립현대미술관 과천관",
            congestion_nm="보통",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {"gwacheon": ["MMCA-SPACE-2001"]},
    )

    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 11, 31, 4)
    )

    assert len(result) == 1
    assert result[0].observed_at == datetime(2026, 7, 27, 11, 30)
    with session_factory() as session:
        stored = session.query(RawMmcaCongestion).one()
    assert stored.observed_at == datetime(2026, 7, 27, 11, 30)


def test_collect_mmca_once_fetches_rooms_from_every_venue(monkeypatch, session_factory):
    import app.collector as collector_module

    seen_codes = []

    def fake_fetch(client, space_code, api_key):
        seen_codes.append(space_code)
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 27, 14, 0),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="테스트관",
            congestion_nm="보통",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {
            "seoul": ["MMCA-SPACE-1001"],
            "gwacheon": ["MMCA-SPACE-2001"],
        },
    )

    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 14, 0)
    )

    assert len(result) == 2
    assert set(seen_codes) == {"MMCA-SPACE-1001", "MMCA-SPACE-2001"}


def test_collect_mmca_once_skips_only_the_closed_venue(monkeypatch, session_factory):
    import app.collector as collector_module

    seen_codes = []

    def fake_fetch(client, space_code, api_key):
        seen_codes.append(space_code)
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 27, 14, 0),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="테스트관",
            congestion_nm="보통",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    # MMCA-SPACE-9001 stands in for a Monday-closed venue that isn't in
    # MMCA_DISABLED_SPACE_CODES — keeps this test isolated to the
    # business-hours gate, not the separate disabled-codes gate.
    monkeypatch.setattr(
        collector_module,
        "_VENUE_CLOSED_DAYS",
        {"deoksugung": {0}, "test-closed-venue": {0}},
    )
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {
            "seoul": ["MMCA-SPACE-1001"],
            "test-closed-venue": ["MMCA-SPACE-9001"],
        },
    )

    # 2026-07-27 is a Monday: Seoul is open, the test venue is shut.
    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 14, 0)
    )

    assert len(result) == 1
    assert seen_codes == ["MMCA-SPACE-1001"]


def test_collect_mmca_once_skips_room_confirmed_empty_all_first_hour(monkeypatch, session_factory):
    """A room with no ongoing exhibition rarely opens one mid-day, so once
    every reading in its first hour (10:xx-11:00) comes back with no
    congestion data, drop to the 2-hour recheck cadence instead of every
    10 minutes for the rest of the day."""
    import app.collector as collector_module

    with session_factory() as session:
        for minute in (10, 20, 30, 40, 50):
            session.add(
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 27, 10, minute),
                    space_code="MMCA-SPACE-1002",
                    congestion_nm=None,
                )
            )
        session.commit()

    seen_codes = []

    def fake_fetch(client, space_code, api_key):
        seen_codes.append(space_code)
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 27, 12, 0),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="테스트관",
            congestion_nm="보통",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {"seoul": ["MMCA-SPACE-1001", "MMCA-SPACE-1002"]},
    )

    # 12:00 is an off-cadence round (2-hour recheck grid is 11/13/15/17/19/21).
    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 12, 0)
    )

    assert seen_codes == ["MMCA-SPACE-1001"]
    assert len(result) == 1
    assert result[0].space_code == "MMCA-SPACE-1001"


def test_collect_mmca_once_rechecks_confirmed_empty_room_every_two_hours(monkeypatch, session_factory):
    """The confirmed-empty room isn't silenced forever — every 2 hours from
    the confirmation cutoff (11, 13, 15, ...) it still gets polled, so a
    same-day reopening is caught within 2 hours instead of not at all."""
    import app.collector as collector_module

    with session_factory() as session:
        for minute in (10, 20, 30, 40, 50):
            session.add(
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 27, 10, minute),
                    space_code="MMCA-SPACE-1002",
                    congestion_nm=None,
                )
            )
        session.commit()

    seen_codes = []

    def fake_fetch(client, space_code, api_key):
        seen_codes.append(space_code)
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 27, 13, 0),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="테스트관",
            congestion_nm="보통",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {"seoul": ["MMCA-SPACE-1001", "MMCA-SPACE-1002"]},
    )

    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 13, 0)
    )

    assert set(seen_codes) == {"MMCA-SPACE-1001", "MMCA-SPACE-1002"}
    assert len(result) == 2


def test_collect_mmca_once_resumes_normal_polling_after_reopening_detected_by_recheck(
    monkeypatch, session_factory
):
    """Once a 2-hour recheck detects a real reading (the room reopened), the
    room must go straight back to normal 10-minute polling for the rest of
    the day — it must not stay stuck on the empty-room cadence just because
    the first hour was empty."""
    import app.collector as collector_module

    with session_factory() as session:
        for minute in (10, 20, 30, 40, 50):
            session.add(
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 27, 10, minute),
                    space_code="MMCA-SPACE-1002",
                    congestion_nm=None,
                )
            )
        session.commit()

    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {"seoul": ["MMCA-SPACE-1002"]},
    )

    # 13:00 is a recheck round — the room gets polled and comes back real.
    monkeypatch.setattr(
        collector_module,
        "fetch_mmca_congestion",
        lambda client, space_code, api_key: MmcaCongestionReading(
            observed_at=datetime(2026, 7, 27, 13, 0),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="테스트관",
            congestion_nm="보통",
        ),
    )
    collector_module.collect_mmca_once(session_factory=session_factory, now=datetime(2026, 7, 27, 13, 0))

    # 13:10 is an ordinary off-grid round. If the room were still treated as
    # confirmed-empty, it would be skipped here.
    seen_codes = []

    def fake_fetch(client, space_code, api_key):
        seen_codes.append(space_code)
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 27, 13, 10),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="테스트관",
            congestion_nm="약간 붐빔",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    result = collector_module.collect_mmca_once(session_factory=session_factory, now=datetime(2026, 7, 27, 13, 10))

    assert seen_codes == ["MMCA-SPACE-1002"]
    assert len(result) == 1


def test_collect_mmca_once_still_polls_room_with_data_in_first_hour(monkeypatch, session_factory):
    import app.collector as collector_module

    with session_factory() as session:
        # Mixed first-hour readings: one real, one empty. Any real reading
        # this early rules out "confirmed empty" outright.
        session.add(
            RawMmcaCongestion(
                observed_at=datetime(2026, 7, 27, 10, 20),
                space_code="MMCA-SPACE-1001",
                congestion_nm=None,
            )
        )
        session.add(
            RawMmcaCongestion(
                observed_at=datetime(2026, 7, 27, 10, 30),
                space_code="MMCA-SPACE-1001",
                congestion_nm="여유",
            )
        )
        session.commit()

    seen_codes = []

    def fake_fetch(client, space_code, api_key):
        seen_codes.append(space_code)
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 27, 11, 10),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="테스트관",
            congestion_nm="보통",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {"seoul": ["MMCA-SPACE-1001"]},
    )

    # 11:10 is off the 2-hour recheck grid (11/13/15/...), so the
    # confirmed-empty filter actually runs this round instead of being
    # bypassed by the recheck gate.
    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 11, 10)
    )

    assert seen_codes == ["MMCA-SPACE-1001"]
    assert len(result) == 1


def test_collect_mmca_once_polls_normally_within_first_hour_before_any_history(
    monkeypatch, session_factory
):
    import app.collector as collector_module

    seen_codes = []

    def fake_fetch(client, space_code, api_key):
        seen_codes.append(space_code)
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 27, 10, 20),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="테스트관",
            congestion_nm=None,
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {"seoul": ["MMCA-SPACE-1002"]},
    )

    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 10, 20)
    )

    assert seen_codes == ["MMCA-SPACE-1002"]
    assert len(result) == 1


def test_collect_mmca_once_excludes_disabled_space_codes(monkeypatch, session_factory):
    import app.collector as collector_module

    seen_codes = []

    def fake_fetch(client, space_code, api_key):
        seen_codes.append(space_code)
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 27, 14, 0),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="테스트관",
            congestion_nm="보통",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {"gwacheon": ["MMCA-SPACE-2001", "MMCA-SPACE-2008"]},
    )

    # 2026-07-27 is a Monday, but the disabled-codes filter applies every
    # day regardless of business hours — MMCA-SPACE-2008 (children's
    # museum) must never be fetched even though Gwacheon itself is open.
    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 14, 0)
    )

    assert len(result) == 1
    assert seen_codes == ["MMCA-SPACE-2001"]
