import fakeredis
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base
from app.models import RawCongestion


@pytest.fixture(autouse=True)
def fake_redis(monkeypatch):
    import app.cache as cache_module

    monkeypatch.setattr(cache_module, "r", fakeredis.FakeRedis(decode_responses=True))


@pytest.fixture
def client(monkeypatch):
    from app.main import app
    import app.routes.congestion as congestion_routes

    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine)
    monkeypatch.setattr(congestion_routes, "SessionLocal", session_factory)

    return TestClient(app), session_factory


def test_current_returns_503_when_no_data(client):
    test_client, _ = client
    response = test_client.get("/congestion/current")
    assert response.status_code == 503


def test_current_falls_back_to_db_when_cache_empty(client):
    test_client, session_factory = client

    from datetime import datetime

    with session_factory() as session:
        session.add(
            RawCongestion(
                observed_at=datetime(2026, 7, 15, 14, 30),
                congest_level="보통",
                population_min=1000,
                population_max=2000,
            )
        )
        session.commit()

    response = test_client.get("/congestion/current")
    assert response.status_code == 200
    body = response.json()
    assert body["congest_level"] == "보통"
    assert body["population_avg"] == 1500.0


def test_history_returns_empty_list_when_no_data(client):
    test_client, _ = client
    response = test_client.get("/congestion/history")
    assert response.status_code == 200
    assert response.json() == []


def test_history_returns_points_within_window(client):
    test_client, session_factory = client

    from datetime import datetime, timedelta

    now = datetime.now()
    with session_factory() as session:
        session.add_all(
            [
                RawCongestion(
                    observed_at=now - timedelta(hours=2),
                    congest_level="여유",
                    population_min=800,
                    population_max=1000,
                ),
                RawCongestion(
                    observed_at=now - timedelta(hours=10),
                    congest_level="붐빔",
                    population_min=3000,
                    population_max=3200,
                ),
            ]
        )
        session.commit()

    response = test_client.get("/congestion/history?hours=6")
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["population_avg"] == 900.0


def test_daily_returns_empty_list_when_no_data(client):
    test_client, _ = client
    response = test_client.get("/congestion/daily?date=2026-07-16")
    assert response.status_code == 200
    assert response.json() == []


def test_daily_returns_400_for_malformed_date(client):
    test_client, _ = client
    response = test_client.get("/congestion/daily?date=not-a-date")
    assert response.status_code == 400


def test_daily_returns_only_rows_within_the_given_day(client):
    test_client, session_factory = client

    from datetime import datetime

    with session_factory() as session:
        session.add_all(
            [
                RawCongestion(
                    observed_at=datetime(2026, 7, 16, 9, 0),
                    congest_level="여유",
                    population_min=800,
                    population_max=1000,
                    male_ppltn_rate=51.8,
                    resnt_ppltn_rate=45.1,
                ),
                RawCongestion(
                    observed_at=datetime(2026, 7, 16, 23, 55),
                    congest_level="보통",
                    population_min=1200,
                    population_max=1400,
                ),
                RawCongestion(
                    observed_at=datetime(2026, 7, 17, 0, 0),
                    congest_level="붐빔",
                    population_min=3000,
                    population_max=3200,
                ),
                RawCongestion(
                    observed_at=datetime(2026, 7, 15, 23, 59),
                    congest_level="붐빔",
                    population_min=3000,
                    population_max=3200,
                ),
            ]
        )
        session.commit()

    response = test_client.get("/congestion/daily?date=2026-07-16")
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 2
    assert body[0]["congest_level"] == "여유"
    assert body[0]["male_ppltn_rate"] == 51.8
    assert body[0]["resnt_ppltn_rate"] == 45.1
    assert body[1]["congest_level"] == "보통"
    assert body[1]["male_ppltn_rate"] is None
