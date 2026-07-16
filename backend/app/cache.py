import json

import redis

from app.config import settings
from app.seoul_api import CongestionReading

r = redis.from_url(settings.redis_url, decode_responses=True)

LATEST_KEY = "congestion:latest"
PREDICTION_KEY = "congestion:prediction"
UPDATE_CHANNEL = "congestion:updates"

LATEST_TTL_SECONDS = 900  # survives up to 2 missed 5-minute collection cycles
PREDICTION_TTL_SECONDS = 86400


def _reading_to_dict(reading: CongestionReading) -> dict:
    return {
        "observed_at": reading.observed_at.isoformat(),
        "congest_level": reading.congest_level,
        "population_avg": (reading.population_min + reading.population_max) / 2,
    }


def set_latest(reading: CongestionReading) -> None:
    payload = json.dumps(_reading_to_dict(reading))
    r.set(LATEST_KEY, payload, ex=LATEST_TTL_SECONDS)
    r.publish(UPDATE_CHANNEL, payload)


def get_latest() -> dict | None:
    raw = r.get(LATEST_KEY)
    return json.loads(raw) if raw else None


def set_prediction(result: dict) -> None:
    r.set(PREDICTION_KEY, json.dumps(result), ex=PREDICTION_TTL_SECONDS)


def get_prediction() -> dict | None:
    raw = r.get(PREDICTION_KEY)
    return json.loads(raw) if raw else None
