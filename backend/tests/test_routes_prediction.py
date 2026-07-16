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
