from datetime import datetime

import fakeredis
import pytest

from app.seoul_api import CongestionReading


@pytest.fixture(autouse=True)
def fake_redis(monkeypatch):
    import app.cache as cache_module

    fake = fakeredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(cache_module, "r", fake)
    return fake


def test_set_and_get_latest():
    from app.cache import get_latest, set_latest

    reading = CongestionReading(
        observed_at=datetime(2026, 7, 15, 14, 30),
        congest_level="보통",
        population_min=1000,
        population_max=2000,
    )
    set_latest(reading)

    latest = get_latest()
    assert latest["congest_level"] == "보통"
    assert latest["population_avg"] == 1500.0


def test_get_latest_returns_none_when_empty():
    from app.cache import get_latest

    assert get_latest() is None


def test_set_and_get_prediction():
    from app.cache import get_prediction, set_prediction

    result = {"status": "ready", "baseline_mae": 120.0, "model_mae": 95.0, "curve": []}
    set_prediction(result)

    assert get_prediction() == result
