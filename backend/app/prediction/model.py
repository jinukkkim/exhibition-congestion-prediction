import numpy as np
from sklearn.ensemble import GradientBoostingRegressor


def _build_features(rows) -> tuple[np.ndarray, np.ndarray]:
    X = np.array([[row.observed_at.weekday(), row.observed_at.hour] for row in rows])
    y = np.array([row.population_avg for row in rows])
    return X, y


def train_model(rows) -> GradientBoostingRegressor:
    X, y = _build_features(rows)
    model = GradientBoostingRegressor(random_state=0)
    model.fit(X, y)
    return model


def predict_model(model: GradientBoostingRegressor, weekday: int, hour: int) -> float:
    return float(model.predict(np.array([[weekday, hour]]))[0])
