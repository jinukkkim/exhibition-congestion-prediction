from datetime import datetime, timedelta

import fakeredis
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base
from app.models import RawCongestion, RawMmcaCongestion

# A Wednesday, comfortably inside opening hours (10:10-21:00 on 수/토).
OPEN_HOURS = datetime(2026, 8, 12, 15, 0)
# Same Wednesday before the first round of the day is due.
BEFORE_OPENING = datetime(2026, 8, 12, 9, 0)


@pytest.fixture(autouse=True)
def fake_redis(monkeypatch):
    import app.cache as cache_module

    monkeypatch.setattr(cache_module, "r", fakeredis.FakeRedis(decode_responses=True))


@pytest.fixture
def client(monkeypatch):
    import app.routes.health as health_routes
    from app.main import app

    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine)
    monkeypatch.setattr(health_routes, "SessionLocal", session_factory)

    return TestClient(app), session_factory, monkeypatch


def _freeze(monkeypatch, now: datetime):
    """Pin the endpoint's clock; freshness is meaningless against a live one."""
    import app.routes.health as health_routes

    class _Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return now.replace(tzinfo=tz) if tz else now

    monkeypatch.setattr(health_routes, "datetime", _Frozen)


def _add(session_factory, seoul: datetime | None = None, mmca: list[datetime] | None = None):
    with session_factory() as session:
        if seoul is not None:
            session.add(
                RawCongestion(
                    observed_at=seoul,
                    congest_level="보통",
                    population_min=1000,
                    population_max=2000,
                )
            )
        for index, observed_at in enumerate(mmca or []):
            session.add(
                RawMmcaCongestion(
                    observed_at=observed_at,
                    space_code=f"MMCA-SPACE-100{index}",
                    space_nm="테스트 전시실",
                    agnc_nm="국립현대미술관 서울관",
                    congestion_nm="보통",
                )
            )
        session.commit()


def test_liveness_stays_independent_of_freshness(client):
    """deploy.sh polls /health right after a restart, before any collection."""
    test_client, _, _ = client

    response = test_client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_reports_ok_while_both_sources_are_current(client):
    test_client, session_factory, monkeypatch = client
    _freeze(monkeypatch, OPEN_HOURS)
    _add(
        session_factory,
        seoul=OPEN_HOURS - timedelta(minutes=4),
        mmca=[OPEN_HOURS - timedelta(minutes=8)] * 3,
    )

    response = test_client.get("/health/collection")
    body = response.json()

    assert response.status_code == 200
    assert body["status"] == "ok"
    assert body["seoul"]["age_minutes"] == 4.0
    assert body["mmca"]["rooms_in_last_round"] == 3
    assert body["mmca"]["calls_today"] == 3


def test_reports_503_when_seoul_collection_stops(client):
    test_client, session_factory, monkeypatch = client
    _freeze(monkeypatch, OPEN_HOURS)
    _add(
        session_factory,
        seoul=OPEN_HOURS - timedelta(minutes=40),
        mmca=[OPEN_HOURS - timedelta(minutes=8)],
    )

    response = test_client.get("/health/collection")
    body = response.json()

    assert response.status_code == 503
    assert body["status"] == "stale"
    assert body["seoul"]["stale"] is True
    assert body["mmca"]["stale"] is False


def test_reports_503_when_mmca_stops_during_opening_hours(client):
    test_client, session_factory, monkeypatch = client
    _freeze(monkeypatch, OPEN_HOURS)
    _add(
        session_factory,
        seoul=OPEN_HOURS - timedelta(minutes=2),
        mmca=[OPEN_HOURS - timedelta(hours=3)],
    )

    response = test_client.get("/health/collection")

    assert response.status_code == 503
    assert response.json()["mmca"]["stale"] is True


def test_an_hours_old_mmca_round_is_fine_outside_opening_hours(client):
    """Nothing is collected overnight, so age alone can't mean failure."""
    test_client, session_factory, monkeypatch = client
    _freeze(monkeypatch, BEFORE_OPENING)
    _add(
        session_factory,
        seoul=BEFORE_OPENING - timedelta(minutes=3),
        mmca=[BEFORE_OPENING - timedelta(hours=14)],
    )

    response = test_client.get("/health/collection")

    assert response.status_code == 200
    assert response.json()["mmca"]["stale"] is False


def test_mmca_is_not_stale_in_the_first_minutes_after_opening(client):
    """The first round of the day hasn't run yet at 10:15."""
    test_client, session_factory, monkeypatch = client
    just_opened = datetime(2026, 8, 12, 10, 15)
    _freeze(monkeypatch, just_opened)
    _add(
        session_factory,
        seoul=just_opened - timedelta(minutes=3),
        mmca=[just_opened - timedelta(hours=13)],
    )

    response = test_client.get("/health/collection")

    assert response.status_code == 200
    assert response.json()["mmca"]["stale"] is False


def test_an_empty_database_reads_as_stale(client):
    test_client, _, monkeypatch = client
    _freeze(monkeypatch, OPEN_HOURS)

    response = test_client.get("/health/collection")
    body = response.json()

    assert response.status_code == 503
    assert body["seoul"]["last_observed_at"] is None
    assert body["seoul"]["stale"] is True
