from datetime import datetime, timedelta
from types import SimpleNamespace

from app.prediction.model import predict_model, train_model


def _synthetic_rows(n_days: int) -> list:
    rows = []
    start = datetime(2026, 6, 1, 0, 0)
    for day in range(n_days):
        for hour in range(24):
            ts = start + timedelta(days=day, hours=hour)
            avg = 2000.0 if hour in (11, 12, 13, 14) else 500.0
            rows.append(SimpleNamespace(observed_at=ts, population_avg=avg))
    return rows


def test_train_and_predict_model_learns_hourly_pattern():
    rows = _synthetic_rows(n_days=21)

    model = train_model(rows)

    midday_pred = predict_model(model, weekday=2, hour=12)
    midnight_pred = predict_model(model, weekday=2, hour=0)

    assert midday_pred > midnight_pred
