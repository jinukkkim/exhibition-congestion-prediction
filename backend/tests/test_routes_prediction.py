import fakeredis
import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def fake_redis(monkeypatch):
    import app.cache as cache_module

    monkeypatch.setattr(cache_module, "r", fakeredis.FakeRedis(decode_responses=True))


def test_prediction_returns_collecting_when_never_run():
    from app.main import app

    client = TestClient(app)
    response = client.get("/congestion/prediction")

    assert response.status_code == 200
    assert response.json() == {"status": "collecting", "days_collected": 0}


def test_prediction_returns_cached_result():
    from app.cache import set_prediction
    from app.main import app

    cached = {"status": "ready", "baseline_mae": 100.0, "model_mae": 80.0, "curve": []}
    set_prediction(cached)

    client = TestClient(app)
    response = client.get("/congestion/prediction")

    assert response.json() == cached


def test_prediction_drops_days_that_are_already_past(monkeypatch):
    """배치는 하루 한 번 돈다. 실행에 실패하거나 자정 직후 창에서는 저장된 첫
    항목이 어제가 되므로, 응답에서 걸러낸다."""
    from datetime import date

    import app.routes.prediction as route_module
    from app.cache import set_prediction
    from app.main import app

    monkeypatch.setattr(route_module, "_today_seoul", lambda: date(2026, 8, 24))

    set_prediction(
        {
            "status": "ready",
            "baseline_mae": 100.0,
            "model_mae": 80.0,
            "curve": [{"hour": 0, "baseline": 1.0, "model": 1.0}],
            "days": [
                {
                    "date": "2026-08-23",
                    "is_holiday": False,
                    "curve": [{"hour": 0, "baseline": 1.0, "model": 1.0}],
                },
                {
                    "date": "2026-08-24",
                    "is_holiday": False,
                    "curve": [{"hour": 0, "baseline": 2.0, "model": 2.0}],
                },
            ],
        }
    )

    body = TestClient(app).get("/congestion/prediction").json()

    assert [day["date"] for day in body["days"]] == ["2026-08-24"]
    # 하위 호환 필드도 남은 첫 항목에 맞춰야 한다 — 구 프론트가 어제 커브를
    # 오늘로 그리게 되기 때문이다.
    assert body["curve"] == [{"hour": 0, "baseline": 2.0, "model": 2.0}]


def test_prediction_leaves_a_payload_without_days_untouched():
    """days 를 담기 전 배치가 남긴 캐시가 TTL 안에 남아 있을 수 있다."""
    from app.cache import set_prediction
    from app.main import app

    cached = {"status": "ready", "baseline_mae": 100.0, "model_mae": 80.0, "curve": []}
    set_prediction(cached)

    body = TestClient(app).get("/congestion/prediction").json()

    assert body == cached
