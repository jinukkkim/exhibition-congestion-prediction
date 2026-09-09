import json

import redis
from pydantic import BaseModel, ValidationError

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


# 전시 목록은 하루 단위로도 거의 안 바뀐다. 외부 API 를 3페이지씩 부르거나
# (MMCA) 누리집 HTML 을 한 장 받아 파싱하는(국중박) 호출이라 방문마다 나가지
# 않게 넉넉히 잡는다 — 새 전시 개막이 반나절 늦게 보이는 것은 감수할 만하다.
EXHIBITIONS_TTL_SECONDS = 21600


def set_mmca_exhibitions(venue: str, payload: list[dict]) -> None:
    r.set(
        f"mmca:exhibitions:{venue}",
        json.dumps(payload),
        ex=EXHIBITIONS_TTL_SECONDS,
    )


def get_mmca_exhibitions(venue: str) -> list[dict] | None:
    raw = r.get(f"mmca:exhibitions:{venue}")
    return json.loads(raw) if raw else None


# 국중박은 관이 하나라 키에 관 구분이 없다.
NATIONAL_MUSEUM_EXHIBITIONS_KEY = "national-museum:exhibitions"


def set_national_museum_exhibitions(payload: list[dict]) -> None:
    r.set(
        NATIONAL_MUSEUM_EXHIBITIONS_KEY,
        json.dumps(payload),
        ex=EXHIBITIONS_TTL_SECONDS,
    )


def get_national_museum_exhibitions() -> list[dict] | None:
    raw = r.get(NATIONAL_MUSEUM_EXHIBITIONS_KEY)
    return json.loads(raw) if raw else None


def revive[T: BaseModel](cached: dict | list[dict] | None, model: type[T]) -> T | list[T] | None:
    """캐시에 남은 payload 를 응답 모델로 되살린다.

    배포로 모델에 필드가 하나 늘면 직전 버전이 써 둔 값은 되살릴 수 없다.
    그때 None(=캐시 미스)을 돌려 새로 채우게 한다 — 그러지 않으면 TTL 이
    다 될 때까지(전시 목록은 6시간) 모든 요청이 500 이다. 캐시는 언제든
    버려도 되는 값이므로, 못 읽는 값은 없는 값으로 친다.
    """
    if cached is None:
        return None
    try:
        if isinstance(cached, list):
            return [model(**row) for row in cached]
        return model(**cached)
    except ValidationError:
        return None


# 방문 집계는 로그 창 전체를 다시 훑는 일이다. 지금 로그(5.6MB)로는 0.02초지만
# 그것이 근거가 아니다 — 보관 상한(roll_keep 20 x 20MiB)에서 압축비 21.9배면
# 원본 8.8GB 이고 같은 속도로 약 35초다. 개발자 한 사람이 보는 화면이고, 10분 전
# 숫자로 답해도 판단은 같다.
ANALYTICS_TTL_SECONDS = 600


def set_analytics(days: int, payload: dict) -> None:
    r.set(f"analytics:visits:{days}", json.dumps(payload), ex=ANALYTICS_TTL_SECONDS)


def get_analytics(days: int) -> dict | None:
    raw = r.get(f"analytics:visits:{days}")
    return json.loads(raw) if raw else None
