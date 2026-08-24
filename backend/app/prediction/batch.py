from datetime import date, datetime, time, timedelta
from statistics import mean
from zoneinfo import ZoneInfo

from app.cache import set_prediction
from app.db import SessionLocal
from app.models import RawCongestion
from app.prediction.baseline import compute_baseline, predict_baseline
from app.prediction.model import _KR_HOLIDAYS, predict_model, train_model

MIN_DAYS_REQUIRED = 14

_SEOUL_TZ = ZoneInfo("Asia/Seoul")


def run_daily_batch(session_factory=SessionLocal, today: date | None = None) -> dict:
    with session_factory() as session:
        rows = session.query(RawCongestion).order_by(RawCongestion.observed_at).all()

    if not rows:
        result = {"status": "collecting", "days_collected": 0}
        set_prediction(result)
        return result

    days_collected = (rows[-1].observed_at - rows[0].observed_at).days
    if days_collected < MIN_DAYS_REQUIRED:
        result = {"status": "collecting", "days_collected": days_collected}
        set_prediction(result)
        return result

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
        model_pred = predict_model(model, row.observed_at)

        baseline_errors.append(abs(baseline_pred - row.population_avg))
        model_errors.append(abs(model_pred - row.population_avg))

    # This is where the 7-day window starts, and weekday() picks which day's
    # baseline each curve is built from. observed_at is KST wall-clock, so this
    # has to be too — production runs on Etc/UTC, where a naive now() lands on
    # the previous day for the whole KST morning.
    first_day = today or datetime.now(_SEOUL_TZ).date()

    def day_curve(day: date) -> list[dict]:
        return [
            {
                "hour": hour,
                "baseline": predict_baseline(baseline, day.weekday(), hour),
                "model": predict_model(model, datetime.combine(day, time(hour=hour))),
            }
            for hour in range(24)
        ]

    # 오늘 + 6일. 피처가 (weekday, hour, is_holiday) 뿐이라 8일째부터는 곡선이
    # 그대로 반복되므로 7일이 중복 없는 최대치다.
    days = []
    for offset in range(7):
        day = first_day + timedelta(days=offset)
        days.append(
            {
                "date": day.isoformat(),
                "is_holiday": day in _KR_HOLIDAYS,
                "curve": day_curve(day),
            }
        )

    result = {
        "status": "ready",
        "baseline_mae": mean(baseline_errors),
        "model_mae": mean(model_errors),
        # 배포 중 "구 프론트 + 신 백엔드" 구간이 이 필드를 읽는다. days[0] 과 같은
        # 리스트이며, 프론트가 days 를 쓰게 된 뒤에도 지우지 않는다.
        "curve": days[0]["curve"],
        "days": days,
    }
    set_prediction(result)
    return result
