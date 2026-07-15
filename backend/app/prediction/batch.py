from datetime import datetime
from statistics import mean

from app.cache import set_prediction
from app.db import SessionLocal
from app.models import RawCongestion
from app.prediction.baseline import compute_baseline, predict_baseline
from app.prediction.model import predict_model, train_model

MIN_DAYS_REQUIRED = 14


def run_daily_batch(session_factory=SessionLocal) -> dict:
    with session_factory() as session:
        rows = session.query(RawCongestion).order_by(RawCongestion.observed_at).all()

    if not rows:
        return {"status": "collecting", "days_collected": 0}

    days_collected = (rows[-1].observed_at - rows[0].observed_at).days
    if days_collected < MIN_DAYS_REQUIRED:
        return {"status": "collecting", "days_collected": days_collected}

    split = int(len(rows) * 0.8)
    train_rows, test_rows = rows[:split], rows[split:]

    baseline = compute_baseline(train_rows)
    model = train_model(train_rows)
    overall_avg = mean(row.population_avg for row in train_rows)

    baseline_errors, model_errors = [], []
    for row in test_rows:
        weekday, hour = row.observed_at.weekday(), row.observed_at.hour
        baseline_pred = predict_baseline(baseline, weekday, hour)
        if baseline_pred is None:
            baseline_pred = overall_avg
        model_pred = predict_model(model, weekday, hour)

        baseline_errors.append(abs(baseline_pred - row.population_avg))
        model_errors.append(abs(model_pred - row.population_avg))

    today_weekday = datetime.now().weekday()
    curve = [
        {
            "hour": hour,
            "baseline": predict_baseline(baseline, today_weekday, hour),
            "model": predict_model(model, today_weekday, hour),
        }
        for hour in range(24)
    ]

    result = {
        "status": "ready",
        "baseline_mae": mean(baseline_errors),
        "model_mae": mean(model_errors),
        "curve": curve,
    }
    set_prediction(result)
    return result
