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


# 오늘 곡선은 최근 120분 실측에 매달려 있어 판독마다 바뀐다. 프론트가 60초로
# 폴링하므로(MmcaPage 의 POLL_INTERVAL_MS) TTL 도 60초로 맞춘다 — 수집 주기인
# 600초로 잡으면 새 판독이 들어와도 최대 10분간 곡선이 안 움직인다.
MMCA_PREDICTION_TTL_TODAY_SECONDS = 60
# 미래 날짜는 편차가 없어 하루 안에서 정적이다.
MMCA_PREDICTION_TTL_FUTURE_SECONDS = 3600


def set_mmca_prediction(venue: str, day: str, payload: list[dict], ttl: int) -> None:
    r.set(f"mmca:prediction:{venue}:{day}", json.dumps(payload), ex=ttl)


def get_mmca_prediction(venue: str, day: str) -> list[dict] | None:
    raw = r.get(f"mmca:prediction:{venue}:{day}")
    return json.loads(raw) if raw else None
