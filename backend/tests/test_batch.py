import math
from datetime import datetime, timedelta

import fakeredis
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app.models import RawCongestion


@pytest.fixture
def session_factory():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


@pytest.fixture(autouse=True)
def fake_redis(monkeypatch):
    import app.cache as cache_module

    monkeypatch.setattr(cache_module, "r", fakeredis.FakeRedis(decode_responses=True))


def _seed(session_factory, n_days):
    start = datetime(2026, 6, 1, 0, 0)
    with session_factory() as session:
        for day in range(n_days):
            for hour in range(24):
                ts = start + timedelta(days=day, hours=hour)
                avg = 2000.0 if hour in (11, 12, 13, 14) else 500.0
                session.add(
                    RawCongestion(
                        observed_at=ts,
                        congest_level="보통",
                        population_min=int(avg - 100),
                        population_max=int(avg + 100),
                    )
                )
        session.commit()


def test_run_daily_batch_reports_collecting_before_min_days(session_factory):
    from app.cache import get_prediction
    from app.prediction.batch import run_daily_batch

    _seed(session_factory, n_days=5)

    result = run_daily_batch(session_factory=session_factory)

    assert result["status"] == "collecting"
    assert result["days_collected"] == 4
    assert get_prediction() == result


def test_run_daily_batch_returns_ready_with_mae_and_curve(session_factory):
    from app.cache import get_prediction
    from app.prediction.batch import run_daily_batch

    _seed(session_factory, n_days=21)

    result = run_daily_batch(session_factory=session_factory)

    assert result["status"] == "ready"
    assert result["baseline_mae"] >= 0
    assert result["model_mae"] >= 0
    assert len(result["curve"]) == 24
    assert get_prediction() == result


def test_run_daily_batch_falls_back_to_overall_avg_for_untrained_bucket(session_factory):
    from app.prediction.batch import run_daily_batch

    # 15 days starting Monday 2026-06-01, full 24h rows, EXCEPT day 5 (Saturday)
    # hour 3 is skipped. With the chronological 80/20 split this yields 359
    # rows -> split at index 287 -> train = days 0-11 (Sat/day5 hour3 omitted,
    # and day5 is the only Saturday in the train range) and test = days 12-14
    # (day12 is also a Saturday, so its hour-3 row has no matching train
    # bucket). Verified by direct computation: predict_baseline(baseline, 5, 3)
    # returns None for exactly that one test row, exercising the
    # `baseline_pred = overall_avg` fallback in run_daily_batch.
    start = datetime(2026, 6, 1, 0, 0)
    with session_factory() as session:
        for day in range(15):
            for hour in range(24):
                if day == 5 and hour == 3:
                    continue
                ts = start + timedelta(days=day, hours=hour)
                avg = 2000.0 if hour in (11, 12, 13, 14) else 500.0
                session.add(
                    RawCongestion(
                        observed_at=ts,
                        congest_level="보통",
                        population_min=int(avg - 100),
                        population_max=int(avg + 100),
                    )
                )
        session.commit()

    result = run_daily_batch(session_factory=session_factory)

    assert result["status"] == "ready"
    assert math.isfinite(result["baseline_mae"])
