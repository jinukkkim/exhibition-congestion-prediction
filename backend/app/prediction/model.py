from datetime import datetime

import holidays
import numpy as np
from sklearn.ensemble import GradientBoostingRegressor

_KR_HOLIDAYS = holidays.country_holidays("KR")


def _features(ts: datetime) -> list[float]:
    return [ts.weekday(), ts.hour, float(ts.date() in _KR_HOLIDAYS)]


def _build_features(rows) -> tuple[np.ndarray, np.ndarray]:
    X = np.array([_features(row.observed_at) for row in rows])
    y = np.array([row.population_avg for row in rows])
    return X, y


def train_model(rows) -> GradientBoostingRegressor:
    X, y = _build_features(rows)
    model = GradientBoostingRegressor(random_state=0)
    model.fit(X, y)
    return model


def predict_model(model: GradientBoostingRegressor, ts: datetime) -> float:
    return float(model.predict(np.array([_features(ts)]))[0])
