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
    from zoneinfo import ZoneInfo

    # observed_at holds the Open API's KST wall-clock, so the fixture has to
    # be stamped the same way the collector stamps it. A host-local now() only
    # matched the route's window while the host happened to be on KST.
    now = datetime.now(ZoneInfo("Asia/Seoul")).replace(tzinfo=None)
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


def test_daily_raw_returns_empty_list_when_no_data(client):
    test_client, _ = client
    response = test_client.get("/congestion/daily/raw?date=2026-07-16")
    assert response.status_code == 200
    assert response.json() == []


def test_daily_raw_returns_400_for_malformed_date(client):
    test_client, _ = client
    response = test_client.get("/congestion/daily/raw?date=not-a-date")
    assert response.status_code == 400


def test_daily_raw_falls_back_to_parsed_columns_without_an_archived_body(client):
    """Readings from before raw_response existed (2026-07-15..17) still fill
    the table, under the same API key names the archived body would use."""
    test_client, session_factory = client

    from datetime import datetime

    with session_factory() as session:
        session.add(
            RawCongestion(
                observed_at=datetime(2026, 7, 16, 9, 0),
                congest_level="여유",
                population_min=800,
                population_max=1000,
                male_ppltn_rate=51.8,
                ppltn_rate_20=22.4,
            )
        )
        session.commit()

    response = test_client.get("/congestion/daily/raw?date=2026-07-16")
    assert response.status_code == 200
    fields = response.json()[0]["fields"]
    assert fields["AREA_CONGEST_LVL"] == "여유"
    assert fields["AREA_PPLTN_MIN"] == 800
    assert fields["AREA_PPLTN_MAX"] == 1000
    assert fields["MALE_PPLTN_RATE"] == 51.8
    assert fields["PPLTN_RATE_20"] == 22.4
    assert fields["FEMALE_PPLTN_RATE"] is None


def test_daily_raw_adds_the_fields_we_never_parsed_into_columns(client):
    """The point of this endpoint: weather and any other scalar the archived
    body carries show up without being named anywhere in our code."""
    test_client, session_factory = client

    import json
    from datetime import datetime

    with session_factory() as session:
        session.add(
            RawCongestion(
                observed_at=datetime(2026, 7, 20, 9, 0),
                congest_level="보통",
                population_min=1200,
                population_max=1400,
                raw_response=json.dumps(
                    {
                        "LIVE_PPLTN_STTS": [
                            {
                                "PPLTN_TIME": "2026-07-20 09:00",
                                "AREA_CONGEST_LVL": "보통",
                                "AREA_CONGEST_MSG": "사람이 몰려 있을 수 있습니다.",
                                "FCST_PPLTN": [{"FCST_TIME": "2026-07-20 10:00"}],
                            }
                        ],
                        "WEATHER_STTS": [
                            {"TEMP": "30.2", "HUMIDITY": "61", "PM10": "24"}
                        ],
                        "LIVE_SUB_PPLTN": [{"SUB_STN_NM": "이촌"}],
                    }
                ),
            )
        )
        session.commit()

    response = test_client.get("/congestion/daily/raw?date=2026-07-20")
    assert response.status_code == 200
    fields = response.json()[0]["fields"]
    # Never named in our models or schemas — carried through from the body.
    assert fields["TEMP"] == "30.2"
    assert fields["HUMIDITY"] == "61"
    assert fields["PM10"] == "24"
    assert fields["AREA_CONGEST_MSG"] == "사람이 몰려 있을 수 있습니다."
    # Nested blocks aren't flat table cells — the forecast revisions have their
    # own tables and the station lists are step (3), row expansion.
    assert "FCST_PPLTN" not in fields
    assert "LIVE_SUB_PPLTN" not in fields
    # Redundant with the row's own observed_at, which is already a column.
    assert "PPLTN_TIME" not in fields
