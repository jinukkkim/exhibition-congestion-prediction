from datetime import datetime
from types import SimpleNamespace

from app.prediction.baseline import compute_baseline, predict_baseline


def _row(observed_at, avg):
    return SimpleNamespace(observed_at=observed_at, population_avg=avg)


def test_compute_baseline_averages_by_weekday_and_hour():
    rows = [
        _row(datetime(2026, 7, 6, 14, 0), 1000.0),   # Monday 14:00
        _row(datetime(2026, 7, 13, 14, 0), 2000.0),  # Monday 14:00
        _row(datetime(2026, 7, 6, 9, 0), 500.0),     # Monday 09:00
    ]

    baseline = compute_baseline(rows)

    assert baseline[(0, 14)] == 1500.0
    assert baseline[(0, 9)] == 500.0


def test_predict_baseline_returns_none_for_unseen_bucket():
    assert predict_baseline({}, weekday=2, hour=3) is None
