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


def test_mmca_exhibitions_rejects_an_unknown_venue(client):
    test_client, _ = client
    assert test_client.get("/mmca/exhibitions?venue=nowhere").status_code == 400


def test_mmca_exhibitions_serves_the_venue_and_caches_every_venue(client, monkeypatch):
    # 누리집 한 번에 세 관이 다 온다. 다른 관 페이지가 같은 호출을 반복하지
    # 않도록 전시가 없는 관까지 캐시에 들어가야 한다.
    test_client, _ = client
    import app.routes.mmca as mmca_routes

    calls = []

    def fake_fetch(_client):
        calls.append(1)
        return [
            {
                "exhTitle": "서울 전시",
                "exhPlaNm": "서울",
                "exhPlaDtl": "지하1층 6, 7전시실",
                "exhStDt": "2026-06-19",
                "exhEdDt": "2026-10-11",
            },
            {
                "exhTitle": "과천 전시",
                "exhPlaNm": "과천",
                "exhPlaDtl": "1층, 1원형전시실",
                "exhStDt": "2025-10-02",
                "exhEdDt": "2027-01-03",
            },
        ]

    monkeypatch.setattr(mmca_routes, "fetch_exhibitions", fake_fetch)

    assert test_client.get("/mmca/exhibitions?venue=seoul").json() == [
        {
            "title": "서울 전시",
            "start_date": "2026-06-19",
            "end_date": "2026-10-11",
            "space_codes": ["MMCA-SPACE-1006", "MMCA-SPACE-1007"],
        }
    ]

    # 덕수궁은 진행중 전시가 없지만, 빈 목록이 캐시돼 있어 다시 부르지 않는다.
    assert test_client.get("/mmca/exhibitions?venue=deoksugung").json() == []
    assert test_client.get("/mmca/exhibitions?venue=gwacheon").json()[0]["space_codes"] == [
        "MMCA-SPACE-2007"
    ]
    assert len(calls) == 1


def test_mmca_exhibitions_refetches_when_the_cache_holds_an_older_payload_shape(
    client, monkeypatch
):
    # 배포로 응답에 필드가 하나 늘면, 직전 버전이 써 둔 캐시는 새 스키마로
    # 되살릴 수 없다. 그걸 캐시 미스로 보지 않으면 TTL(6시간)이 다 될 때까지
    # 모든 요청이 500 이다.
    test_client, _ = client
    import app.routes.mmca as mmca_routes
    from app.cache import set_mmca_exhibitions

    set_mmca_exhibitions(
        "seoul",
        [{"title": "옛 형태", "start_date": "2026-01-01", "end_date": "2026-12-31"}],
    )

    monkeypatch.setattr(
        mmca_routes,
        "fetch_exhibitions",
        lambda _client: [
            {
                "exhTitle": "새로 받은 전시",
                "exhPlaNm": "서울",
                "exhPlaDtl": "지하1층 6, 7전시실",
                "exhStDt": "2026-06-19",
                "exhEdDt": "2026-10-11",
            }
        ],
    )

    response = test_client.get("/mmca/exhibitions?venue=seoul")
    assert response.status_code == 200
    assert [e["title"] for e in response.json()] == ["새로 받은 전시"]
