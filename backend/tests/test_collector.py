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
    assert _is_venue_open("seoul", datetime(2026, 7, 27, 10, 0)) is True
    assert _is_venue_open("seoul", datetime(2026, 7, 27, 18, 0)) is True
    assert _is_venue_open("seoul", datetime(2026, 7, 27, 18, 1)) is False
    assert _is_venue_open("seoul", datetime(2026, 7, 27, 9, 59)) is False


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
    mid-round (room 1 fetched at :44:59, room 2 at :45:03) — without
    normalization those readings would land in different /mmca/daily minute
    buckets even though they belong to the same collection round."""
    import app.collector as collector_module

    def fake_fetch(client, space_code, api_key):
        drifted_time = {
            "MMCA-SPACE-2001": datetime(2026, 7, 27, 14, 44, 59),
            "MMCA-SPACE-2002": datetime(2026, 7, 27, 14, 45, 3),
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

    round_time = datetime(2026, 7, 27, 14, 45, 0)
    result = collector_module.collect_mmca_once(session_factory=session_factory, now=round_time)

    assert len(result) == 2
    assert all(reading.observed_at == round_time for reading in result)
    with session_factory() as session:
        stored_times = {row.observed_at for row in session.query(RawMmcaCongestion).all()}
    assert stored_times == {round_time}


def test_collect_mmca_once_snaps_observed_at_to_the_15_minute_grid(monkeypatch, session_factory):
    """The scheduler fires on a :00/:15/:30/:45 cron grid, but jitter or a
    misfire-grace-time catch-up run can land the actual invocation a few
    minutes off that mark (e.g. 11:31 instead of 11:30). Every reading must
    still be stamped with the grid mark, not the raw run time, so rounds are
    always exactly 15 minutes apart regardless of when they actually ran."""
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
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {
            "seoul": ["MMCA-SPACE-1001"],
            "deoksugung": ["MMCA-SPACE-4001"],
        },
    )

    # 2026-07-27 is a Monday: Seoul is open, Deoksugung is shut.
    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 14, 0)
    )

    assert len(result) == 1
    assert seen_codes == ["MMCA-SPACE-1001"]
