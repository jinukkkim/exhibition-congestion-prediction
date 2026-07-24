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


def test_is_seoul_branch_open_normal_day_within_hours():
    from app.collector import _is_seoul_branch_open

    # 2026-07-27 is a Monday
    assert _is_seoul_branch_open(datetime(2026, 7, 27, 10, 0)) is True
    assert _is_seoul_branch_open(datetime(2026, 7, 27, 18, 0)) is True
    assert _is_seoul_branch_open(datetime(2026, 7, 27, 18, 1)) is False
    assert _is_seoul_branch_open(datetime(2026, 7, 27, 9, 59)) is False


def test_is_seoul_branch_open_long_day():
    from app.collector import _is_seoul_branch_open

    # 2026-07-29 is a Wednesday
    assert _is_seoul_branch_open(datetime(2026, 7, 29, 20, 0)) is True
    assert _is_seoul_branch_open(datetime(2026, 7, 29, 21, 0)) is True
    assert _is_seoul_branch_open(datetime(2026, 7, 29, 21, 1)) is False


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
        collector_module.settings, "mmca_space_codes", ["MMCA-SPACE-1001", "MMCA-SPACE-1002"]
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
        collector_module.settings, "mmca_space_codes", ["MMCA-SPACE-1001", "MMCA-SPACE-1002"]
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
        collector_module.settings, "mmca_space_codes", ["MMCA-SPACE-1001", "MMCA-SPACE-1002"]
    )

    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 14, 0)
    )

    assert len(result) == 1
    assert result[0].space_code == "MMCA-SPACE-1002"
    with session_factory() as session:
        assert session.query(RawMmcaCongestion).count() == 1
