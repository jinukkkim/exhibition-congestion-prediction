from datetime import datetime, timedelta
from types import SimpleNamespace

import holidays

from app.prediction.model import predict_model, train_model

KR_HOLIDAYS = holidays.country_holidays("KR", years=2026)


def _synthetic_rows(n_days: int) -> list:
    rows = []
    start = datetime(2026, 6, 1, 0, 0)
    for day in range(n_days):
        for hour in range(24):
            ts = start + timedelta(days=day, hours=hour)
            avg = 2000.0 if hour in (11, 12, 13, 14) else 500.0
            rows.append(SimpleNamespace(observed_at=ts, population_avg=avg))
    return rows


def _holiday_rows() -> list:
    """A year of opening-hour readings where holidays draw triple the crowd."""
    rows = []
    ts = datetime(2026, 1, 1, 10, 0)
    while ts.year == 2026:
        if 10 <= ts.hour <= 17:
            avg = 3000.0 if ts.date() in KR_HOLIDAYS else 1000.0
            rows.append(SimpleNamespace(observed_at=ts, population_avg=avg))
        ts += timedelta(hours=1)
    return rows


def test_train_and_predict_model_learns_hourly_pattern():
    rows = _synthetic_rows(n_days=21)

    model = train_model(rows)

    midday_pred = predict_model(model, datetime(2026, 6, 3, 12))
    midnight_pred = predict_model(model, datetime(2026, 6, 3, 0))

    assert midday_pred > midnight_pred


def test_model_learns_holiday_effect():
    model = train_model(_holiday_rows())

    # Chuseok 2026-09-25 vs. the ordinary Friday a week later: same weekday, same hour.
    holiday_pred = predict_model(model, datetime(2026, 9, 25, 14))
    workday_pred = predict_model(model, datetime(2026, 10, 2, 14))

    assert holiday_pred > workday_pred * 1.5
