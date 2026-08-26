from datetime import datetime, timedelta

import fakeredis
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base
from app.models import RawMmcaCongestion

# 시각을 고정한다. 오늘 곡선은 "최근 120분"에 매달려 있어, 실제 벽시계로
# 돌리면 심어 둔 15시 판독이 앵커 창 밖으로 나가는 시간대가 생긴다 —
# anchored 가 테스트 실행 시각에 따라 흔들린다. 2026-08-15 는 토요일.
_FROZEN_NOW = datetime(2026, 8, 15, 15, 25)


@pytest.fixture
def client(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    import app.cache
    import app.routes.mmca

    monkeypatch.setattr(app.cache, "r", fakeredis.FakeRedis(decode_responses=True))
    monkeypatch.setattr(app.routes.mmca, "SessionLocal", Session)
    monkeypatch.setattr(app.routes.mmca, "_now_seoul", lambda: _FROZEN_NOW)

    from app.main import app as fastapi_app

    yield TestClient(fastapi_app), Session


def _seed(Session, *, space_code="MMCA-SPACE-2001", days=14, hour=15, level="붐빔"):
    """_FROZEN_NOW 이전 `days` 일 동안 매일 같은 시각에 같은 등급을 심는다."""
    today = _FROZEN_NOW.date()
    with Session() as session:
        for offset in range(1, days + 1):
            day = today - timedelta(days=offset)
            for minute in (0, 10, 20):
                session.add(
                    RawMmcaCongestion(
                        observed_at=datetime.combine(day, datetime.min.time()).replace(
                            hour=hour, minute=minute
                        ),
                        space_code=space_code,
                        space_nm="1전시실",
                        congestion_nm=level,
                    )
                )
        session.commit()
    return today


def test_unknown_venue_is_rejected(client):
    api, _ = client

    response = api.get("/mmca/prediction?venue=nowhere")

    assert response.status_code == 400


def test_no_data_returns_an_empty_list_not_an_error(client):
    api, _ = client

    response = api.get("/mmca/prediction?venue=gwacheon")

    # 예측할 데이터가 없는 것은 오류가 아니다 — /mmca/rooms 처럼 503 을 내면
    # 프론트가 차트 전체를 에러로 바꾼다.
    assert response.status_code == 200
    assert response.json() == []


def test_rooms_below_the_sample_day_gate_are_omitted(client):
    api, Session = client
    _seed(Session, days=2)

    response = api.get("/mmca/prediction?venue=gwacheon")

    assert response.status_code == 200
    assert response.json() == []


def test_future_date_returns_the_unanchored_profile(client):
    api, Session = client
    today = _seed(Session, days=14, hour=15, level="붐빔")
    target = today + timedelta(days=1)

    response = api.get(f"/mmca/prediction?venue=gwacheon&date={target.isoformat()}")

    body = response.json()
    assert len(body) == 1
    room = body[0]
    assert room["space_code"] == "MMCA-SPACE-2001"
    assert room["anchored"] is False
    assert room["sample_days"] == 14
    # 14일 내내 붐빔이었으니 프로파일은 3.0
    point = next(p for p in room["points"] if p["observed_at"].endswith("T15:00:00"))
    assert point["tier"] == 3.0
    assert point["label"] == "붐빔"


def test_todays_curve_is_anchored_to_todays_readings(client):
    api, Session = client
    today = _seed(Session, days=14, hour=15, level="붐빔")
    # 오늘 같은 시각에 여유가 3개 — 프로파일(3.0)보다 훨씬 한산하다.
    with Session() as session:
        for minute in (0, 10, 20):
            session.add(
                RawMmcaCongestion(
                    observed_at=datetime.combine(today, datetime.min.time()).replace(
                        hour=15, minute=minute
                    ),
                    space_code="MMCA-SPACE-2001",
                    space_nm="1전시실",
                    congestion_nm="여유",
                )
            )
        session.commit()

    response = api.get(f"/mmca/prediction?venue=gwacheon&date={today.isoformat()}")

    room = response.json()[0]
    assert room["anchored"] is True
    # 프로파일은 오늘을 뺀 직전 14일로만 만든다 (라우트의 `< day_start`).
    # 오늘 판독이 프로파일 쿼리로 새면 15가 된다.
    assert room["sample_days"] == 14
    # 첫 점은 마지막 실측점(15:20 여유)이어야 한다 — 실선과의 이음매.
    assert room["points"][0]["observed_at"].endswith("T15:20:00")
    assert room["points"][0]["tier"] == 0.0


def test_past_date_returns_an_empty_list(client):
    api, Session = client
    today = _seed(Session, days=14)
    past = today - timedelta(days=3)

    response = api.get(f"/mmca/prediction?venue=gwacheon&date={past.isoformat()}")

    # 프로파일 창이 "오늘 −14일"이라 과거 타깃에는 그 날짜 이후 데이터가
    # 섞인다 — look-ahead 곡선을 내보내는 대신 아무것도 내보내지 않는다.
    assert response.status_code == 200
    assert response.json() == []

    # 가드는 캐시 앞에 있어야 한다 — 과거 날짜는 캐시를 읽지도 쓰지도 않는다.
    import app.cache

    assert app.cache.r.keys("mmca:prediction:*") == []


def test_stale_last_reading_is_not_used_as_a_seam(client):
    api, Session = client
    today = _seed(Session, days=14)
    # 오후 늦은 시각에도 프로파일 셀이 있어야 검증할 점이 남는다 — 오늘 곡선은
    # 지금(15:25) 이후 시각만 내므로 15시 셀 하나뿐이면 방이 통째로 빠진다.
    _seed(Session, days=14, hour=17, level="보통")
    # 수집기가 11시에 멈춘 상황. _FROZEN_NOW 는 15:25 이다.
    with Session() as session:
        for minute in (0, 10, 20):
            session.add(
                RawMmcaCongestion(
                    observed_at=datetime.combine(today, datetime.min.time()).replace(
                        hour=11, minute=minute
                    ),
                    space_code="MMCA-SPACE-2001",
                    space_nm="1전시실",
                    congestion_nm="여유",
                )
            )
        session.commit()

    response = api.get(f"/mmca/prediction?venue=gwacheon&date={today.isoformat()}")

    room = response.json()[0]
    assert room["anchored"] is False
    # 11시 판독을 이음매로 쓰면 안 되고, 지나간 시각(12~15시)에도 점을 내면 안 된다.
    minutes = [
        int(p["observed_at"][11:13]) * 60 + int(p["observed_at"][14:16]) for p in room["points"]
    ]
    assert min(minutes) >= 15 * 60 + 25


def test_second_request_is_served_from_the_cache(client):
    api, Session = client
    today = _seed(Session, days=14)
    target = today + timedelta(days=1)

    first = api.get(f"/mmca/prediction?venue=gwacheon&date={target.isoformat()}")
    assert first.status_code == 200
    assert first.json() != []

    import app.cache

    assert app.cache.r.keys(f"mmca:prediction:gwacheon:{target.isoformat()}")

    # 두 번째 요청은 MmcaRoomPrediction(**room) 재수화 경로를 탄다 — 이 경로가
    # 깨져도 한 번만 GET 하는 테스트는 전부 통과한다.
    second = api.get(f"/mmca/prediction?venue=gwacheon&date={target.isoformat()}")
    assert second.status_code == 200
    assert second.json() == first.json()
