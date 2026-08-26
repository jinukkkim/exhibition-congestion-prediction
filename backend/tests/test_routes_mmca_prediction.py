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
    # 첫 점은 마지막 실측점(15:20 여유)이어야 한다 — 실선과의 이음매.
    assert room["points"][0]["observed_at"].endswith("T15:20:00")
    assert room["points"][0]["tier"] == 0.0
