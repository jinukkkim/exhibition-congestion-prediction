from datetime import datetime, timedelta

import fakeredis
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base
from app.models import RawMmcaCongestion

# 2026-08-24 월 / 08-25 화 / 08-26 수(서울관 야간개장) / 08-29 토.
# 서울관 1전시실·3전시실, 과천관 1전시실.
SEOUL_A = "MMCA-SPACE-1001"
SEOUL_B = "MMCA-SPACE-1003"
GWACHEON = "MMCA-SPACE-2001"


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


def _reading(session, stamp: datetime, space_code: str, level: str | None) -> None:
    session.add(
        RawMmcaCongestion(observed_at=stamp, space_code=space_code, congestion_nm=level)
    )


def _days(session, code: str, base: datetime, level: str | None, n: int = 3) -> None:
    """같은 요일 n주치. MIN_SAMPLE_DAYS(3) 를 넘기려면 서로 다른 날이어야 한다."""
    for week in range(n):
        _reading(session, base + timedelta(weeks=week), code, level)


def test_unknown_venue_is_rejected(client):
    test_client, _ = client
    assert test_client.get("/mmca/weekly-profile?venue=nowhere").status_code == 400


def test_reports_collecting_when_every_reading_lacks_a_level(client):
    """덕수궁관이 실제로 이 상태다 — 판독은 쌓이지만 혼잡도가 전부 비어 있다."""
    test_client, session_factory = client
    with session_factory() as session:
        _days(session, "MMCA-SPACE-4001", datetime(2026, 8, 25, 14, 5), None)
        session.commit()

    body = test_client.get("/mmca/weekly-profile?venue=deoksugung").json()

    assert body["status"] == "collecting"
    assert body["cells"] == []
    assert body["rooms"] == []


def test_drops_the_weekday_the_venue_is_closed(client):
    """과천관 월요일 판독은 공휴일에 문을 연 하루뿐이고, 그날은 평소보다 붐빈다.

    그 하루를 "월요일" 로 세우면 평소 문을 닫는 요일이 가장 붐비는 시각으로
    뽑힌다 — 행이 아예 없어야 한다.
    """
    test_client, session_factory = client
    with session_factory() as session:
        # 월요일(2026-08-17, 광복절 대체) 하루, 붐빔.
        _reading(session, datetime(2026, 8, 17, 15, 5), GWACHEON, "붐빔")
        _days(session, GWACHEON, datetime(2026, 8, 25, 14, 5), "여유")
        session.commit()

    body = test_client.get("/mmca/weekly-profile?venue=gwacheon").json()

    assert [cell["weekday"] for cell in body["cells"]] == [1]  # 화요일만
    assert all(cell["hour"] != 15 for cell in body["cells"])


def test_keeps_only_hours_wholly_inside_opening_times(client):
    """과천관은 18시 폐관이라 17시가 마지막 온전한 시간. 서울관은 수·토 21시까지."""
    test_client, session_factory = client
    with session_factory() as session:
        _days(session, GWACHEON, datetime(2026, 8, 25, 17, 5), "보통")   # 화 17시 — 남음
        _days(session, GWACHEON, datetime(2026, 8, 25, 18, 5), "여유")   # 화 18시 — 폐관 정각, 빠짐
        session.commit()

    body = test_client.get("/mmca/weekly-profile?venue=gwacheon").json()
    assert [(c["weekday"], c["hour"]) for c in body["cells"]] == [(1, 17)]

    with session_factory() as session:
        _days(session, SEOUL_A, datetime(2026, 8, 26, 20, 5), "보통")    # 수 20시 — 야간개장, 남음
        _days(session, SEOUL_A, datetime(2026, 8, 25, 20, 5), "붐빔")    # 화 20시 — 18시 폐관, 빠짐
        session.commit()

    body = test_client.get("/mmca/weekly-profile?venue=seoul").json()
    assert [(c["weekday"], c["hour"]) for c in body["cells"]] == [(2, 20)]


def test_venue_cell_averages_rooms_not_readings(client):
    """판독이 많은 방이 관 평균을 끌고 가면 안 된다 — 방마다 값 하나씩이다."""
    test_client, session_factory = client
    with session_factory() as session:
        _days(session, SEOUL_A, datetime(2026, 8, 25, 14, 5), "여유")  # 방 A: 0.0, 판독 3건
        _days(session, SEOUL_B, datetime(2026, 8, 25, 14, 5), "붐빔")  # 방 B: 3.0, 판독 3건
        # 방 A 에만 같은 칸의 판독을 잔뜩 더한다. 관 평균은 움직이면 안 된다.
        for minute in range(10, 55, 5):
            _reading(session, datetime(2026, 8, 25, 14, minute), SEOUL_A, "여유")
        session.commit()

    body = test_client.get("/mmca/weekly-profile?venue=seoul").json()

    assert body["cells"] == [{"weekday": 1, "hour": 14, "rank": 1.5}]
    assert [room["space_nm"] for room in body["rooms"]] == ["1전시실", "3전시실"]


def test_drops_rooms_with_too_little_history(client):
    """전시가 없어 혼잡도를 주지 않는 방이 상시로 있다 — 예측과 같은 게이트."""
    test_client, session_factory = client
    with session_factory() as session:
        _days(session, SEOUL_A, datetime(2026, 8, 25, 14, 5), "보통")           # 3일 — 남음
        _days(session, SEOUL_B, datetime(2026, 8, 25, 14, 5), "붐빔", n=2)      # 2일 — 빠짐
        session.commit()

    body = test_client.get("/mmca/weekly-profile?venue=seoul").json()

    assert [room["space_code"] for room in body["rooms"]] == [SEOUL_A]
    assert body["cells"] == [{"weekday": 1, "hour": 14, "rank": 1.0}]


def test_serves_the_cached_payload_unchanged(client):
    test_client, session_factory = client
    with session_factory() as session:
        _days(session, SEOUL_A, datetime(2026, 8, 25, 14, 5), "보통")
        session.commit()

    first = test_client.get("/mmca/weekly-profile?venue=seoul").json()

    with session_factory() as session:
        _days(session, SEOUL_B, datetime(2026, 8, 25, 15, 5), "붐빔")
        session.commit()

    assert test_client.get("/mmca/weekly-profile?venue=seoul").json() == first
    # 캐시는 관마다 따로다 — 다른 관 요청이 이 페이로드를 받으면 안 된다.
    assert test_client.get("/mmca/weekly-profile?venue=gwacheon").json()["cells"] == []


def test_a_cache_written_by_an_older_model_is_treated_as_a_miss(client):
    """모델에 필드가 하나 느는 배포 직후를 흉내 낸다.

    캐시는 버려도 되는 값이다. 그대로 생성자에 넣으면 TTL 이 다 될 때까지
    여섯 시간 동안 모든 요청이 500 이 된다.
    """
    from app.cache import set_mmca_weekly_profile

    test_client, session_factory = client
    with session_factory() as session:
        _days(session, SEOUL_A, datetime(2026, 8, 25, 14, 5), "보통")
        session.commit()

    # 지금 모델이 요구하는 cells/rooms 가 없는, 이전 배포가 남긴 모양.
    set_mmca_weekly_profile("seoul", {"status": "ready", "samples": 1})

    response = test_client.get("/mmca/weekly-profile?venue=seoul")

    assert response.status_code == 200
    assert response.json()["cells"] == [{"weekday": 1, "hour": 14, "rank": 1.0}]
