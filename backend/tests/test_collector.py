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
