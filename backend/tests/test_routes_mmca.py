from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import fakeredis
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base
from app.models import RawMmcaCongestion

# Matches app/routes/mmca.py's _SEOUL_TZ — day_start there is KST-pinned, so
# "today" in these tests must be too, or a test run on a non-KST CI runner
# (e.g. UTC on GitHub Actions) can disagree with the route about which
# calendar day it is for ~9 hours out of every 24.
_SEOUL_TZ = ZoneInfo("Asia/Seoul")


@pytest.fixture(autouse=True)
def fake_redis(monkeypatch):
    import app.cache as cache_module

    monkeypatch.setattr(cache_module, "r", fakeredis.FakeRedis(decode_responses=True))


@pytest.fixture
def client(monkeypatch):
    from app.main import app
    import app.routes.mmca as mmca_routes

    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine)
    monkeypatch.setattr(mmca_routes, "SessionLocal", session_factory)

    return TestClient(app), session_factory


def test_mmca_rooms_returns_503_when_no_data(client):
    test_client, _ = client
    response = test_client.get("/mmca/rooms?venue=seoul")
    assert response.status_code == 503


def test_mmca_rooms_returns_placeholder_instead_of_503_when_venue_is_fully_disabled(client):
    test_client, _ = client

    # Deoksugung's only code (MMCA-SPACE-4001) is in MMCA_DISABLED_SPACE_CODES,
    # so collection will never backfill history for it — a fresh/empty DB
    # must not 503 forever, or the frontend falls through to a generic error
    # page instead of its "서비스 예정" placeholder UI.
    response = test_client.get("/mmca/rooms?venue=deoksugung")
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["space_code"] == "MMCA-SPACE-4001"
    assert body[0]["space_nm"] == "1전시실"
    assert body[0]["congestion_nm"] is None
    assert body[0]["observed_at"] is None


def test_mmca_rooms_returns_400_for_unknown_venue(client):
    test_client, _ = client
    response = test_client.get("/mmca/rooms?venue=busan")
    assert response.status_code == 400


def test_mmca_rooms_returns_latest_reading_per_room(client):
    test_client, session_factory = client
    today = datetime.now(_SEOUL_TZ).replace(tzinfo=None, hour=0, minute=0, second=0, microsecond=0)

    with session_factory() as session:
        session.add_all(
            [
                RawMmcaCongestion(
                    observed_at=today.replace(hour=10, minute=0),
                    space_code="MMCA-SPACE-1001",
                    space_nm="1전시실",
                    agnc_nm="국립현대미술관",
                    congestion_nm="여유",
                ),
                RawMmcaCongestion(
                    observed_at=today.replace(hour=10, minute=6),
                    space_code="MMCA-SPACE-1001",
                    space_nm="1전시실",
                    agnc_nm="국립현대미술관",
                    congestion_nm="보통",
                ),
                RawMmcaCongestion(
                    observed_at=today.replace(hour=10, minute=6),
                    space_code="MMCA-SPACE-1002",
                    space_nm="2전시실",
                    agnc_nm="국립현대미술관",
                    congestion_nm=None,
                ),
            ]
        )
        session.commit()

    response = test_client.get("/mmca/rooms?venue=seoul")
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 2

    room1 = next(r for r in body if r["space_code"] == "MMCA-SPACE-1001")
    assert room1["congestion_nm"] == "보통"
    assert room1["space_nm"] == "1전시실"

    room2 = next(r for r in body if r["space_code"] == "MMCA-SPACE-1002")
    assert room2["congestion_nm"] is None


def test_mmca_rooms_filters_by_venue(client):
    test_client, session_factory = client

    with session_factory() as session:
        session.add_all(
            [
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 25, 10, 0),
                    space_code="MMCA-SPACE-1001",
                    space_nm="1전시실",
                    agnc_nm="서울",
                    congestion_nm="여유",
                ),
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 25, 10, 0),
                    space_code="MMCA-SPACE-2001",
                    space_nm="1전시실",
                    agnc_nm="과천",
                    congestion_nm="보통",
                ),
            ]
        )
        session.commit()

    seoul_response = test_client.get("/mmca/rooms?venue=seoul")
    assert seoul_response.status_code == 200
    seoul_codes = {r["space_code"] for r in seoul_response.json()}
    assert seoul_codes == {"MMCA-SPACE-1001"}

    gwacheon_response = test_client.get("/mmca/rooms?venue=gwacheon")
    assert gwacheon_response.status_code == 200
    gwacheon_codes = {r["space_code"] for r in gwacheon_response.json()}
    assert gwacheon_codes == {"MMCA-SPACE-2001", "MMCA-SPACE-2008"}


def test_mmca_rooms_always_includes_disabled_room_even_without_its_own_history(client):
    test_client, session_factory = client
    today = datetime.now(_SEOUL_TZ).replace(tzinfo=None, hour=0, minute=0, second=0, microsecond=0)

    with session_factory() as session:
        # Only the non-disabled Gwacheon room has any history; MMCA-SPACE-2008
        # (the disabled children's museum) has zero rows in this DB.
        session.add(
            RawMmcaCongestion(
                observed_at=today.replace(hour=10, minute=0),
                space_code="MMCA-SPACE-2001",
                space_nm="1전시실",
                congestion_nm="여유",
            )
        )
        session.commit()

    response = test_client.get("/mmca/rooms?venue=gwacheon")
    assert response.status_code == 200
    disabled_room = next(r for r in response.json() if r["space_code"] == "MMCA-SPACE-2008")
    assert disabled_room["congestion_nm"] is None
    assert disabled_room["space_nm"] == "1층 어린이미술관"


def test_mmca_daily_returns_400_for_unknown_venue(client):
    test_client, _ = client
    response = test_client.get("/mmca/daily?venue=busan")
    assert response.status_code == 400


def test_mmca_daily_returns_400_for_malformed_date(client):
    test_client, _ = client
    response = test_client.get("/mmca/daily?venue=seoul&date=not-a-date")
    assert response.status_code == 400


def test_mmca_daily_returns_empty_list_when_no_data(client):
    test_client, _ = client
    response = test_client.get("/mmca/daily?venue=seoul&date=2026-07-16")
    assert response.status_code == 200
    assert response.json() == []


def test_mmca_daily_pivots_rooms_from_one_poll_into_one_row(client):
    test_client, session_factory = client

    with session_factory() as session:
        session.add_all(
            [
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 25, 15, 0, 3),
                    space_code="MMCA-SPACE-1001",
                    space_nm="1전시실",
                    congestion_nm="여유",
                ),
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 25, 15, 0, 7),
                    space_code="MMCA-SPACE-1002",
                    space_nm="2전시실",
                    congestion_nm="보통",
                ),
            ]
        )
        session.commit()

    response = test_client.get("/mmca/daily?venue=seoul&date=2026-07-25")
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["observed_at"] == "2026-07-25T15:00:00"
    assert len(body[0]["rooms"]) == 8  # seoul has 8 space codes

    rooms = {r["space_code"]: r for r in body[0]["rooms"]}
    assert rooms["MMCA-SPACE-1001"]["congestion_nm"] == "여유"
    assert rooms["MMCA-SPACE-1002"]["congestion_nm"] == "보통"


def test_mmca_daily_fills_null_for_rooms_missing_from_a_poll(client):
    test_client, session_factory = client

    with session_factory() as session:
        session.add(
            RawMmcaCongestion(
                observed_at=datetime(2026, 7, 25, 15, 0, 3),
                space_code="MMCA-SPACE-1001",
                space_nm="1전시실",
                congestion_nm="여유",
            )
        )
        session.commit()

    response = test_client.get("/mmca/daily?venue=seoul&date=2026-07-25")
    body = response.json()
    # MMCA-SPACE-1002 has no poll that day — congestion_nm (a measurement)
    # correctly stays None, but space_nm (a label) still resolves from the
    # static MMCA_SPACE_NAMES map.
    missing = next(r for r in body[0]["rooms"] if r["space_code"] == "MMCA-SPACE-1002")
    assert missing["congestion_nm"] is None
    assert missing["space_nm"] == "2전시실"


def test_mmca_daily_separates_different_poll_times_into_separate_rows(client):
    test_client, session_factory = client

    with session_factory() as session:
        session.add_all(
            [
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 25, 15, 0, 3),
                    space_code="MMCA-SPACE-1001",
                    congestion_nm="여유",
                ),
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 25, 15, 15, 5),
                    space_code="MMCA-SPACE-1001",
                    congestion_nm="보통",
                ),
            ]
        )
        session.commit()

    response = test_client.get("/mmca/daily?venue=seoul&date=2026-07-25")
    body = response.json()
    assert len(body) == 2
    assert body[0]["observed_at"] == "2026-07-25T15:00:00"
    assert body[1]["observed_at"] == "2026-07-25T15:15:00"


def test_mmca_daily_filters_by_venue(client):
    test_client, session_factory = client

    with session_factory() as session:
        session.add_all(
            [
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 25, 15, 0, 3),
                    space_code="MMCA-SPACE-1001",
                    congestion_nm="여유",
                ),
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 25, 15, 0, 3),
                    space_code="MMCA-SPACE-2001",
                    congestion_nm="보통",
                ),
            ]
        )
        session.commit()

    # deoksugung's only code is MMCA-SPACE-4001 — neither seoul nor
    # gwacheon rows should leak into its result.
    response = test_client.get("/mmca/daily?venue=deoksugung&date=2026-07-25")
    assert response.json() == []


def test_mmca_rooms_falls_back_to_static_room_name_when_latest_poll_has_none(client):
    test_client, session_factory = client
    today = datetime.now(_SEOUL_TZ).replace(tzinfo=None, hour=0, minute=0, second=0, microsecond=0)

    with session_factory() as session:
        session.add(
            RawMmcaCongestion(
                observed_at=today.replace(hour=10, minute=15),
                space_code="MMCA-SPACE-1001",
                space_nm=None,
                congestion_nm="보통",
            )
        )
        session.commit()

    response = test_client.get("/mmca/rooms?venue=seoul")
    assert response.status_code == 200
    room = next(r for r in response.json() if r["space_code"] == "MMCA-SPACE-1001")
    assert room["space_nm"] == "1전시실"
    assert room["congestion_nm"] == "보통"


def test_mmca_rooms_hides_stale_reading_when_no_data_collected_today(client):
    test_client, session_factory = client
    yesterday = datetime.now(_SEOUL_TZ).replace(
        tzinfo=None, hour=17, minute=50, second=0, microsecond=0
    ) - timedelta(days=1)

    with session_factory() as session:
        session.add(
            RawMmcaCongestion(
                observed_at=yesterday,
                space_code="MMCA-SPACE-1001",
                space_nm="1전시실",
                congestion_nm="붐빔",
            )
        )
        session.commit()

    response = test_client.get("/mmca/rooms?venue=seoul")
    assert response.status_code == 200
    room = next(r for r in response.json() if r["space_code"] == "MMCA-SPACE-1001")
    # Business hours may have started today, but nothing has been collected
    # yet — must not silently show yesterday's last real reading.
    assert room["congestion_nm"] is None
    assert room["observed_at"] is None
    assert room["space_nm"] == "1전시실"


def test_mmca_daily_falls_back_to_static_room_name_when_poll_row_has_none(client):
    test_client, session_factory = client

    with session_factory() as session:
        session.add(
            RawMmcaCongestion(
                observed_at=datetime(2026, 7, 25, 15, 0, 3),
                space_code="MMCA-SPACE-1001",
                space_nm=None,
                congestion_nm="보통",
            )
        )
        session.commit()

    response = test_client.get("/mmca/daily?venue=seoul&date=2026-07-25")
    body = response.json()
    bucket = next(b for b in body if b["observed_at"] == "2026-07-25T15:00:00")
    room = next(r for r in bucket["rooms"] if r["space_code"] == "MMCA-SPACE-1001")
    assert room["space_nm"] == "1전시실"
    assert room["congestion_nm"] == "보통"


def test_mmca_daily_falls_back_to_static_room_name_when_room_missing_from_bucket(client):
    test_client, session_factory = client

    with session_factory() as session:
        session.add(
            RawMmcaCongestion(
                observed_at=datetime(2026, 7, 25, 15, 0, 3),
                space_code="MMCA-SPACE-1001",
                space_nm="1전시실",
                congestion_nm="보통",
            )
        )
        session.commit()

    response = test_client.get("/mmca/daily?venue=seoul&date=2026-07-25")
    body = response.json()
    bucket = next(b for b in body if b["observed_at"] == "2026-07-25T15:00:00")
    room = next(r for r in bucket["rooms"] if r["space_code"] == "MMCA-SPACE-1002")
    assert room["space_nm"] == "2전시실"
    assert room["congestion_nm"] is None
