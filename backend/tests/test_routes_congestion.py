from datetime import datetime

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


# 2026-08-24 월 / 2026-08-26 수(야간개장) / 2026-08-29 토(야간개장).
def _reading(session, stamp: datetime, population: int) -> None:
    session.add(
        RawCongestion(
            observed_at=stamp,
            congest_level="보통",
            population_min=population,
            population_max=population,
        )
    )


def test_weekly_profile_reports_collecting_when_no_readings(client):
    test_client, _ = client
    response = test_client.get("/congestion/weekly-profile")

    assert response.status_code == 200
    assert response.json() == {
        "status": "collecting",
        "since": None,
        "until": None,
        "samples": 0,
        "cells": [],
    }


def test_weekly_profile_keeps_only_hours_wholly_inside_opening_times(client):
    """반 시간치만 담긴 칸은 평균이 낮게 깔려 "가장 한산한 시각"을 훔쳐 간다.

    개관 09:30·평일 폐관 17:30 이라 월요일의 9시·17시 칸이 그렇고, 21:00 정각에
    닫는 수요일의 21시 칸도 판독 한둘뿐이다. 반대로 수요일 20시는 야간개장이라
    온전한 한 시간이며, 같은 시각이 월요일에는 아예 없다.
    """
    test_client, session_factory = client
    with session_factory() as session:
        _reading(session, datetime(2026, 8, 24, 9, 35), 100)   # 월 09:30 개관 직후
        _reading(session, datetime(2026, 8, 24, 10, 30), 200)  # 월 온전한 한 시간
        _reading(session, datetime(2026, 8, 24, 17, 10), 300)  # 월 17:30 폐관 직전
        _reading(session, datetime(2026, 8, 26, 20, 30), 400)  # 수 야간개장
        _reading(session, datetime(2026, 8, 26, 21, 0), 500)   # 수 21:00 폐관 정각
        session.commit()

    body = test_client.get("/congestion/weekly-profile").json()

    assert body["status"] == "ready"
    assert [(cell["weekday"], cell["hour"]) for cell in body["cells"]] == [(0, 10), (2, 20)]


def test_weekly_profile_averages_each_cell_and_reports_its_span(client):
    test_client, session_factory = client
    with session_factory() as session:
        _reading(session, datetime(2026, 8, 24, 10, 5), 1000)
        _reading(session, datetime(2026, 8, 24, 10, 55), 2000)
        # 다른 주의 같은 요일·시각은 같은 칸에 들어간다 — 요일 프로파일의 요점.
        _reading(session, datetime(2026, 8, 31, 10, 5), 3000)
        _reading(session, datetime(2026, 8, 29, 14, 5), 900)
        session.commit()

    body = test_client.get("/congestion/weekly-profile").json()

    assert body["since"] == "2026-08-24"
    assert body["until"] == "2026-08-31"
    # 칸이 아니라 판독을 센다 — 네 판독이 두 칸으로 묶인다.
    assert body["samples"] == 4
    assert body["cells"] == [
        {"weekday": 0, "hour": 10, "population_avg": 2000.0},
        {"weekday": 5, "hour": 14, "population_avg": 900.0},
    ]


def test_weekly_profile_serves_the_cached_payload_unchanged(client):
    """전체 이력 스캔이라 캐시가 본 경로다 — 두 번째 요청이 같은 몸통이어야 한다."""
    test_client, session_factory = client
    with session_factory() as session:
        _reading(session, datetime(2026, 8, 24, 10, 5), 1000)
        session.commit()

    first = test_client.get("/congestion/weekly-profile").json()

    # 캐시를 읽는지 확인하려면 DB 가 달라져도 응답이 그대로여야 한다.
    with session_factory() as session:
        _reading(session, datetime(2026, 8, 25, 11, 5), 9999)
        session.commit()

    assert test_client.get("/congestion/weekly-profile").json() == first


def test_weekly_profile_treats_a_cache_written_by_an_older_model_as_a_miss(client):
    """형제 엔드포인트(/mmca/weekly-profile)와 같은 이유의 같은 보호다."""
    from app.cache import set_weekly_profile

    test_client, session_factory = client
    with session_factory() as session:
        _reading(session, datetime(2026, 8, 24, 10, 5), 1000)
        session.commit()

    set_weekly_profile({"status": "ready", "samples": 1})

    response = test_client.get("/congestion/weekly-profile")

    assert response.status_code == 200
    assert response.json()["cells"] == [{"weekday": 0, "hour": 10, "population_avg": 1000.0}]
