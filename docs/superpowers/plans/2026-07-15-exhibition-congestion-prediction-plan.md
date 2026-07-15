# 실시간 전시 혼잡도 예측 시스템 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MVP that shows live congestion at the National Museum of Korea (국립중앙박물관) and predicts congestion hours ahead, using Seoul's open city-data API as the only data source.

**Architecture:** A FastAPI backend polls the Seoul Open Data API every 5 minutes, stores raw readings in Postgres, and caches the latest reading plus today's prediction curve in Redis. Clients get the current value over a REST endpoint and live updates over SSE. A daily batch job computes a weekday×hour statistical baseline and trains a scikit-learn regressor on the same data, comparing both by MAE. A React/Vite/TS frontend displays the current congestion and a 24-hour baseline-vs-model chart.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2.0, Postgres (pg8000 driver), Redis, httpx, APScheduler, scikit-learn, numpy — React 18, Vite, TypeScript, Tailwind CSS.

## Global Constraints

- Single venue only: 국립중앙박물관·용산가족공원 (Seoul city-data `AREA_NM`), hardcoded — no multi-venue support.
- Single data source: Seoul 실시간 도시데이터 API only — no weather/search-trend/SNS sources.
- Collection interval: 5 minutes, matching the API's own refresh rate.
- Real-time transport: SSE only — no WebSocket.
- No task queue (Celery/BullMQ) — an in-process APScheduler job is enough at this call volume.
- Prediction: statistical baseline (weekday×hour average) AND a scikit-learn model, compared by MAE — not baseline-only, not ML-only.
- Cold start: fewer than 14 days of collected data → endpoints report `status: "collecting"` instead of a prediction.
- No auth, no notifications, no deployment infra in this plan.

---

## File Structure

```
backend/
  pyproject.toml
  app/
    __init__.py
    config.py              # Settings (env vars)
    db.py                   # engine, session, init_db
    models.py                # RawCongestion ORM model
    seoul_api.py              # Seoul API client + parsing
    cache.py                   # Redis: latest reading, prediction, pub/sub
    collector.py                # fetch-and-store job
    scheduler.py                 # APScheduler wiring (collector + daily batch)
    main.py                       # FastAPI app, startup wiring, routers
    schemas.py                     # Pydantic response models
    prediction/
      __init__.py
      baseline.py                   # weekday x hour average
      model.py                       # scikit-learn train/predict
      batch.py                        # daily batch: baseline + model + MAE + cache
    routes/
      __init__.py
      congestion.py                    # GET /congestion/current
      stream.py                         # GET /congestion/stream (SSE)
      prediction.py                      # GET /congestion/prediction
  tests/
    conftest.py
    test_config.py
    test_db_models.py
    test_seoul_api.py
    test_cache.py
    test_collector.py
    test_baseline.py
    test_model.py
    test_batch.py
    test_routes_congestion.py
    test_routes_stream.py
    test_routes_prediction.py

frontend/
  package.json
  vite.config.ts
  tailwind.config.js
  src/
    main.tsx
    App.tsx
    api/
      congestion.ts                       # fetch + types
    hooks/
      useCongestionStream.ts                # SSE hook
    components/
      CongestionCard.tsx
      PredictionChart.tsx                    # hand-rolled SVG line chart
  tests/
    api.test.ts
    useCongestionStream.test.ts
    CongestionCard.test.tsx
    PredictionChart.test.tsx
  e2e/
    congestion.spec.ts                        # Playwright, mocked network
```

Each backend module has one job: `seoul_api.py` only talks to the external API, `cache.py` only talks to Redis, `collector.py` wires the two together, `prediction/*` only does statistics/ML, `routes/*` only exposes HTTP. Frontend mirrors this: `api/` fetches, `hooks/` manages live state, `components/` renders.

---

## Task 1: Backend project scaffold

**Files:**
- Create: `backend/pyproject.toml`
- Create: `backend/app/__init__.py`
- Create: `backend/app/config.py`
- Create: `backend/app/main.py`
- Test: `backend/tests/conftest.py`
- Test: `backend/tests/test_config.py`

**Interfaces:**
- Produces: `app.config.settings` (a `Settings` instance with `.seoul_api_key`, `.seoul_area_name`, `.database_url`, `.redis_url`); `app.main.app` (FastAPI instance) with `GET /health` returning `{"status": "ok"}`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_config.py`:
```python
import os

def test_settings_reads_env(monkeypatch):
    monkeypatch.setenv("SEOUL_API_KEY", "test-key")
    monkeypatch.setenv("DATABASE_URL", "sqlite:///:memory:")
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/1")

    from app.config import Settings
    settings = Settings()

    assert settings.seoul_api_key == "test-key"
    assert settings.seoul_area_name == "국립중앙박물관·용산가족공원"
    assert settings.database_url == "sqlite:///:memory:"
    assert settings.redis_url == "redis://localhost:6379/1"
```

`backend/tests/conftest.py`:
```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/test_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app'`

- [ ] **Step 3: Write minimal implementation**

`backend/pyproject.toml`:
```toml
[project]
name = "exhibition-congestion-prediction"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    "pydantic>=2.7",
    "pydantic-settings>=2.3",
    "sqlalchemy>=2.0",
    "pg8000>=1.31",
    "redis>=5.0",
    "httpx>=0.27",
    "apscheduler>=3.10",
    "scikit-learn>=1.5",
    "numpy>=1.26",
]

[dependency-groups]
dev = [
    "pytest>=8",
    "fakeredis>=2.23",
    "ruff>=0.6",
]

[tool.pytest.ini_options]
pythonpath = ["."]
```

`backend/app/__init__.py`: (empty file)

`backend/app/config.py`:
```python
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    seoul_api_key: str
    seoul_area_name: str = "국립중앙박물관·용산가족공원"
    database_url: str = "sqlite:///./congestion.db"
    redis_url: str = "redis://localhost:6379/0"

    model_config = SettingsConfigDict(env_file=".env")


settings = Settings()
```

`backend/app/main.py`:
```python
from fastapi import FastAPI

app = FastAPI(title="Exhibition Congestion Prediction")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pytest tests/test_config.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/pyproject.toml backend/app/__init__.py backend/app/config.py backend/app/main.py backend/tests/conftest.py backend/tests/test_config.py
git commit -m "feat: scaffold backend with settings and health check"
```

---

## Task 2: Database model and connection

**Files:**
- Create: `backend/app/db.py`
- Create: `backend/app/models.py`
- Test: `backend/tests/test_db_models.py`

**Interfaces:**
- Consumes: `app.config.settings.database_url`
- Produces: `app.db.engine`, `app.db.SessionLocal`, `app.db.init_db()`; `app.models.RawCongestion` with fields `id`, `observed_at: datetime`, `congest_level: str`, `population_min: int`, `population_max: int`, and property `population_avg -> float`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_db_models.py`:
```python
from datetime import datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app.models import RawCongestion


def test_raw_congestion_round_trip():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    with Session() as session:
        row = RawCongestion(
            observed_at=datetime(2026, 7, 15, 14, 30),
            congest_level="보통",
            population_min=1000,
            population_max=2000,
        )
        session.add(row)
        session.commit()

        fetched = session.query(RawCongestion).one()
        assert fetched.congest_level == "보통"
        assert fetched.population_avg == 1500.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/test_db_models.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.db'`

- [ ] **Step 3: Write minimal implementation**

`backend/app/db.py`:
```python
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


engine = create_engine(settings.database_url)
SessionLocal = sessionmaker(bind=engine)


def init_db() -> None:
    Base.metadata.create_all(engine)
```

`backend/app/models.py`:
```python
from datetime import datetime

from sqlalchemy import DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class RawCongestion(Base):
    __tablename__ = "raw_congestion"

    id: Mapped[int] = mapped_column(primary_key=True)
    observed_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    congest_level: Mapped[str] = mapped_column(String)
    population_min: Mapped[int] = mapped_column(Integer)
    population_max: Mapped[int] = mapped_column(Integer)

    @property
    def population_avg(self) -> float:
        return (self.population_min + self.population_max) / 2
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pytest tests/test_db_models.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/db.py backend/app/models.py backend/tests/test_db_models.py
git commit -m "feat: add RawCongestion model and db session"
```

---

## Task 3: Seoul Open Data API client

**Files:**
- Create: `backend/app/seoul_api.py`
- Test: `backend/tests/test_seoul_api.py`

**Interfaces:**
- Produces: `app.seoul_api.CongestionReading` (dataclass: `observed_at: datetime`, `congest_level: str`, `population_min: int`, `population_max: int`); `app.seoul_api.fetch_congestion(client: httpx.Client, area_name: str, api_key: str) -> CongestionReading`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_seoul_api.py`:
```python
from datetime import datetime

import httpx

from app.seoul_api import fetch_congestion

FIXTURE = {
    "CITYDATA": {
        "AREA_NM": "국립중앙박물관·용산가족공원",
        "LIVE_PPLTN_STTS": [
            {
                "AREA_CONGEST_LVL": "보통",
                "AREA_PPLTN_MIN": "1000",
                "AREA_PPLTN_MAX": "2000",
                "PPLTN_TIME": "2026-07-15 14:30",
            }
        ],
    }
}


def test_fetch_congestion_parses_response():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=FIXTURE)

    client = httpx.Client(transport=httpx.MockTransport(handler))

    reading = fetch_congestion(client, "국립중앙박물관·용산가족공원", "test-key")

    assert reading.congest_level == "보통"
    assert reading.population_min == 1000
    assert reading.population_max == 2000
    assert reading.observed_at == datetime(2026, 7, 15, 14, 30)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/test_seoul_api.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.seoul_api'`

- [ ] **Step 3: Write minimal implementation**

`backend/app/seoul_api.py`:
```python
from dataclasses import dataclass
from datetime import datetime

import httpx

BASE_URL = "http://openapi.seoul.go.kr:8088"


@dataclass
class CongestionReading:
    observed_at: datetime
    congest_level: str
    population_min: int
    population_max: int


def fetch_congestion(client: httpx.Client, area_name: str, api_key: str) -> CongestionReading:
    url = f"{BASE_URL}/{api_key}/json/citydata/1/5/{area_name}"
    response = client.get(url, timeout=10.0)
    response.raise_for_status()
    live = response.json()["CITYDATA"]["LIVE_PPLTN_STTS"][0]

    return CongestionReading(
        observed_at=datetime.strptime(live["PPLTN_TIME"], "%Y-%m-%d %H:%M"),
        congest_level=live["AREA_CONGEST_LVL"],
        population_min=int(live["AREA_PPLTN_MIN"]),
        population_max=int(live["AREA_PPLTN_MAX"]),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pytest tests/test_seoul_api.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/seoul_api.py backend/tests/test_seoul_api.py
git commit -m "feat: add Seoul city-data API client"
```

**Note for implementer:** field names (`AREA_CONGEST_LVL`, `AREA_PPLTN_MIN/MAX`, `PPLTN_TIME`) come from the public 서울실시간도시데이터매뉴얼. Before pointing this at the real API, request one live response with your API key and diff it against `FIXTURE` above — fix field names here if they've drifted.

---

## Task 4: Redis cache (latest reading + pub/sub)

**Files:**
- Create: `backend/app/cache.py`
- Test: `backend/tests/test_cache.py`

**Interfaces:**
- Consumes: `app.seoul_api.CongestionReading`
- Produces: `app.cache.set_latest(reading)`, `app.cache.get_latest() -> dict | None`, `app.cache.set_prediction(result: dict)`, `app.cache.get_prediction() -> dict | None`, module constant `app.cache.UPDATE_CHANNEL`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_cache.py`:
```python
from datetime import datetime

import fakeredis
import pytest

from app.seoul_api import CongestionReading


@pytest.fixture(autouse=True)
def fake_redis(monkeypatch):
    import app.cache as cache_module

    fake = fakeredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(cache_module, "r", fake)
    return fake


def test_set_and_get_latest():
    from app.cache import get_latest, set_latest

    reading = CongestionReading(
        observed_at=datetime(2026, 7, 15, 14, 30),
        congest_level="보통",
        population_min=1000,
        population_max=2000,
    )
    set_latest(reading)

    latest = get_latest()
    assert latest["congest_level"] == "보통"
    assert latest["population_avg"] == 1500.0


def test_get_latest_returns_none_when_empty():
    from app.cache import get_latest

    assert get_latest() is None


def test_set_and_get_prediction():
    from app.cache import get_prediction, set_prediction

    result = {"status": "ready", "baseline_mae": 120.0, "model_mae": 95.0, "curve": []}
    set_prediction(result)

    assert get_prediction() == result
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/test_cache.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.cache'`

- [ ] **Step 3: Write minimal implementation**

`backend/app/cache.py`:
```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pytest tests/test_cache.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/cache.py backend/tests/test_cache.py
git commit -m "feat: add Redis cache for latest reading and predictions"
```

---

## Task 5: Collector (fetch + store + cache)

**Files:**
- Create: `backend/app/collector.py`
- Test: `backend/tests/test_collector.py`

**Interfaces:**
- Consumes: `app.seoul_api.fetch_congestion`, `app.cache.set_latest`, `app.db.SessionLocal`, `app.models.RawCongestion`
- Produces: `app.collector.collect_once(session_factory=SessionLocal) -> CongestionReading`. On API failure, raises `httpx.HTTPError` and does **not** touch the DB or cache (last cached value keeps serving via its TTL).

- [ ] **Step 1: Write the failing test**

`backend/tests/test_collector.py`:
```python
from datetime import datetime

import fakeredis
import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app.seoul_api import CongestionReading


@pytest.fixture
def session_factory():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


@pytest.fixture(autouse=True)
def fake_redis(monkeypatch):
    import app.cache as cache_module

    monkeypatch.setattr(cache_module, "r", fakeredis.FakeRedis(decode_responses=True))


def test_collect_once_stores_and_caches(monkeypatch, session_factory):
    from app.models import RawCongestion
    import app.collector as collector_module

    fake_reading = CongestionReading(
        observed_at=datetime(2026, 7, 15, 14, 30),
        congest_level="보통",
        population_min=1000,
        population_max=2000,
    )
    monkeypatch.setattr(collector_module, "fetch_congestion", lambda client, area, key: fake_reading)

    result = collector_module.collect_once(session_factory=session_factory)

    assert result == fake_reading
    with session_factory() as session:
        assert session.query(RawCongestion).count() == 1

    from app.cache import get_latest
    assert get_latest()["congest_level"] == "보통"


def test_collect_once_propagates_api_error(monkeypatch, session_factory):
    import app.collector as collector_module

    def raise_error(client, area, key):
        raise httpx.HTTPError("boom")

    monkeypatch.setattr(collector_module, "fetch_congestion", raise_error)

    with pytest.raises(httpx.HTTPError):
        collector_module.collect_once(session_factory=session_factory)

    with session_factory() as session:
        from app.models import RawCongestion
        assert session.query(RawCongestion).count() == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/test_collector.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.collector'`

- [ ] **Step 3: Write minimal implementation**

`backend/app/collector.py`:
```python
import httpx

from app.cache import set_latest
from app.config import settings
from app.db import SessionLocal
from app.models import RawCongestion
from app.seoul_api import CongestionReading, fetch_congestion


def collect_once(session_factory=SessionLocal) -> CongestionReading:
    with httpx.Client() as client:
        reading = fetch_congestion(client, settings.seoul_area_name, settings.seoul_api_key)

    with session_factory() as session:
        session.add(
            RawCongestion(
                observed_at=reading.observed_at,
                congest_level=reading.congest_level,
                population_min=reading.population_min,
                population_max=reading.population_max,
            )
        )
        session.commit()

    set_latest(reading)
    return reading
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pytest tests/test_collector.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/collector.py backend/tests/test_collector.py
git commit -m "feat: add collector that fetches, stores, and caches a reading"
```

---

## Task 6: Statistical baseline

**Files:**
- Create: `backend/app/prediction/__init__.py`
- Create: `backend/app/prediction/baseline.py`
- Test: `backend/tests/test_baseline.py`

**Interfaces:**
- Consumes: `app.models.RawCongestion` (rows with `.observed_at`, `.population_avg`)
- Produces: `app.prediction.baseline.compute_baseline(rows: list[RawCongestion]) -> dict[tuple[int, int], float]` (key is `(weekday, hour)`), `app.prediction.baseline.predict_baseline(baseline: dict, weekday: int, hour: int) -> float | None`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_baseline.py`:
```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/test_baseline.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.prediction'`

- [ ] **Step 3: Write minimal implementation**

`backend/app/prediction/__init__.py`: (empty file)

`backend/app/prediction/baseline.py`:
```python
from collections import defaultdict
from statistics import mean


def compute_baseline(rows) -> dict[tuple[int, int], float]:
    buckets: dict[tuple[int, int], list[float]] = defaultdict(list)
    for row in rows:
        key = (row.observed_at.weekday(), row.observed_at.hour)
        buckets[key].append(row.population_avg)
    return {key: mean(values) for key, values in buckets.items()}


def predict_baseline(baseline: dict[tuple[int, int], float], weekday: int, hour: int) -> float | None:
    return baseline.get((weekday, hour))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pytest tests/test_baseline.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/prediction/__init__.py backend/app/prediction/baseline.py backend/tests/test_baseline.py
git commit -m "feat: add weekday-hour statistical baseline"
```

---

## Task 7: scikit-learn model

**Files:**
- Create: `backend/app/prediction/model.py`
- Test: `backend/tests/test_model.py`

**Interfaces:**
- Consumes: rows with `.observed_at`, `.population_avg` (same shape as Task 6)
- Produces: `app.prediction.model.train_model(rows) -> GradientBoostingRegressor`, `app.prediction.model.predict_model(model, weekday: int, hour: int) -> float`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_model.py`:
```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/test_model.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.prediction.model'`

- [ ] **Step 3: Write minimal implementation**

`backend/app/prediction/model.py`:
```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pytest tests/test_model.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/prediction/model.py backend/tests/test_model.py
git commit -m "feat: add scikit-learn congestion model"
```

---

## Task 8: Daily batch (baseline + model + MAE + cache)

**Files:**
- Create: `backend/app/prediction/batch.py`
- Test: `backend/tests/test_batch.py`

**Interfaces:**
- Consumes: `app.prediction.baseline.compute_baseline/predict_baseline`, `app.prediction.model.train_model/predict_model`, `app.cache.set_prediction`, `app.db.SessionLocal`, `app.models.RawCongestion`
- Produces: `app.prediction.batch.MIN_DAYS_REQUIRED = 14`, `app.prediction.batch.run_daily_batch(session_factory=SessionLocal) -> dict` returning either `{"status": "collecting", "days_collected": int}` or `{"status": "ready", "baseline_mae": float, "model_mae": float, "curve": list[dict]}` where each curve point is `{"hour": int, "baseline": float | None, "model": float}`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_batch.py`:
```python
from datetime import datetime, timedelta

import fakeredis
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app.models import RawCongestion


@pytest.fixture
def session_factory():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


@pytest.fixture(autouse=True)
def fake_redis(monkeypatch):
    import app.cache as cache_module

    monkeypatch.setattr(cache_module, "r", fakeredis.FakeRedis(decode_responses=True))


def _seed(session_factory, n_days):
    start = datetime(2026, 6, 1, 0, 0)
    with session_factory() as session:
        for day in range(n_days):
            for hour in range(24):
                ts = start + timedelta(days=day, hours=hour)
                avg = 2000.0 if hour in (11, 12, 13, 14) else 500.0
                session.add(
                    RawCongestion(
                        observed_at=ts,
                        congest_level="보통",
                        population_min=int(avg - 100),
                        population_max=int(avg + 100),
                    )
                )
        session.commit()


def test_run_daily_batch_reports_collecting_before_min_days(session_factory):
    from app.prediction.batch import run_daily_batch

    _seed(session_factory, n_days=5)

    result = run_daily_batch(session_factory=session_factory)

    assert result["status"] == "collecting"
    assert result["days_collected"] == 4


def test_run_daily_batch_returns_ready_with_mae_and_curve(session_factory):
    from app.cache import get_prediction
    from app.prediction.batch import run_daily_batch

    _seed(session_factory, n_days=21)

    result = run_daily_batch(session_factory=session_factory)

    assert result["status"] == "ready"
    assert result["baseline_mae"] >= 0
    assert result["model_mae"] >= 0
    assert len(result["curve"]) == 24
    assert get_prediction() == result
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/test_batch.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.prediction.batch'`

- [ ] **Step 3: Write minimal implementation**

`backend/app/prediction/batch.py`:
```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pytest tests/test_batch.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/prediction/batch.py backend/tests/test_batch.py
git commit -m "feat: add daily batch computing baseline vs model MAE"
```

---

## Task 9: Scheduler wiring

**Files:**
- Create: `backend/app/scheduler.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_scheduler.py`

**Interfaces:**
- Consumes: `app.collector.collect_once`, `app.prediction.batch.run_daily_batch`
- Produces: `app.scheduler.build_scheduler() -> BackgroundScheduler` with two registered jobs: `"collect_congestion"` (interval, 5 minutes) and `"daily_batch"` (cron, 03:00).

- [ ] **Step 1: Write the failing test**

`backend/tests/test_scheduler.py`:
```python
def test_build_scheduler_registers_expected_jobs():
    from app.scheduler import build_scheduler

    scheduler = build_scheduler()
    job_ids = {job.id for job in scheduler.get_jobs()}

    assert job_ids == {"collect_congestion", "daily_batch"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/test_scheduler.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.scheduler'`

- [ ] **Step 3: Write minimal implementation**

`backend/app/scheduler.py`:
```python
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.collector import collect_once
from app.prediction.batch import run_daily_batch


def build_scheduler() -> BackgroundScheduler:
    scheduler = BackgroundScheduler()
    scheduler.add_job(
        collect_once,
        trigger=IntervalTrigger(minutes=5),
        id="collect_congestion",
        misfire_grace_time=60,
    )
    scheduler.add_job(
        run_daily_batch,
        trigger=CronTrigger(hour=3, minute=0),
        id="daily_batch",
        misfire_grace_time=3600,
    )
    return scheduler
```

Modify `backend/app/main.py` (replace full contents):
```python
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.db import init_db
from app.scheduler import build_scheduler


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    scheduler = build_scheduler()
    scheduler.start()
    yield
    scheduler.shutdown()


app = FastAPI(title="Exhibition Congestion Prediction", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pytest tests/test_scheduler.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/scheduler.py backend/app/main.py backend/tests/test_scheduler.py
git commit -m "feat: wire APScheduler jobs into app lifespan"
```

---

## Task 10: Current congestion endpoint

**Files:**
- Create: `backend/app/schemas.py`
- Create: `backend/app/routes/__init__.py`
- Create: `backend/app/routes/congestion.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_routes_congestion.py`

**Interfaces:**
- Consumes: `app.cache.get_latest`, `app.db.SessionLocal`, `app.models.RawCongestion`
- Produces: `GET /congestion/current` → `CurrentCongestion` JSON (`observed_at: str`, `congest_level: str`, `population_avg: float`), reading from cache first, falling back to the latest DB row, returning HTTP 503 if neither exists.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_routes_congestion.py`:
```python
import fakeredis
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app.models import RawCongestion


@pytest.fixture(autouse=True)
def fake_redis(monkeypatch):
    import app.cache as cache_module

    monkeypatch.setattr(cache_module, "r", fakeredis.FakeRedis(decode_responses=True))


@pytest.fixture
def client(monkeypatch):
    from app.main import app
    import app.routes.congestion as congestion_routes

    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine)
    monkeypatch.setattr(congestion_routes, "SessionLocal", session_factory)

    return TestClient(app), session_factory


def test_current_returns_503_when_no_data(client):
    test_client, _ = client
    response = test_client.get("/congestion/current")
    assert response.status_code == 503


def test_current_falls_back_to_db_when_cache_empty(client):
    test_client, session_factory = client

    from datetime import datetime

    with session_factory() as session:
        session.add(
            RawCongestion(
                observed_at=datetime(2026, 7, 15, 14, 30),
                congest_level="보통",
                population_min=1000,
                population_max=2000,
            )
        )
        session.commit()

    response = test_client.get("/congestion/current")
    assert response.status_code == 200
    body = response.json()
    assert body["congest_level"] == "보통"
    assert body["population_avg"] == 1500.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/test_routes_congestion.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.routes'`

- [ ] **Step 3: Write minimal implementation**

`backend/app/schemas.py`:
```python
from pydantic import BaseModel


class CurrentCongestion(BaseModel):
    observed_at: str
    congest_level: str
    population_avg: float
```

`backend/app/routes/__init__.py`: (empty file)

`backend/app/routes/congestion.py`:
```python
from fastapi import APIRouter, HTTPException

from app.cache import get_latest
from app.db import SessionLocal
from app.models import RawCongestion
from app.schemas import CurrentCongestion

router = APIRouter()


@router.get("/congestion/current", response_model=CurrentCongestion)
def current_congestion() -> CurrentCongestion:
    cached = get_latest()
    if cached is not None:
        return CurrentCongestion(**cached)

    with SessionLocal() as session:
        row = (
            session.query(RawCongestion)
            .order_by(RawCongestion.observed_at.desc())
            .first()
        )
    if row is None:
        raise HTTPException(status_code=503, detail="no congestion data yet")

    return CurrentCongestion(
        observed_at=row.observed_at.isoformat(),
        congest_level=row.congest_level,
        population_avg=row.population_avg,
    )
```

Modify `backend/app/main.py` (add router registration, keep the rest as-is):
```python
from app.routes.congestion import router as congestion_router

app.include_router(congestion_router)
```
(Insert this import near the top with the other `app.*` imports, and the `include_router` call right after `app = FastAPI(...)`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pytest tests/test_routes_congestion.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/schemas.py backend/app/routes/__init__.py backend/app/routes/congestion.py backend/app/main.py backend/tests/test_routes_congestion.py
git commit -m "feat: add GET /congestion/current with DB fallback"
```

---

## Task 11: SSE stream endpoint

**Files:**
- Create: `backend/app/routes/stream.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_routes_stream.py`

**Interfaces:**
- Consumes: `app.cache.r`, `app.cache.UPDATE_CHANNEL`
- Produces: `GET /congestion/stream` — `text/event-stream` response; each Redis publish on `UPDATE_CHANNEL` becomes one `data: <json>\n\n` chunk.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_routes_stream.py`:
```python
import fakeredis
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def fake_redis(monkeypatch):
    import app.cache as cache_module

    fake = fakeredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(cache_module, "r", fake)
    return fake


def test_stream_emits_published_message(fake_redis):
    from app.main import app

    fake_redis.publish("congestion:updates", '{"congest_level": "보통"}')

    client = TestClient(app)
    with client.stream("GET", "/congestion/stream") as response:
        assert response.status_code == 200
        chunk = next(response.iter_lines())
        assert "보통" in chunk
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/test_routes_stream.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.routes.stream'`

- [ ] **Step 3: Write minimal implementation**

`backend/app/routes/stream.py`:
```python
from collections.abc import Generator

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from app.cache import UPDATE_CHANNEL, r

router = APIRouter()


def _event_source() -> Generator[str, None, None]:
    pubsub = r.pubsub()
    pubsub.subscribe(UPDATE_CHANNEL)
    for message in pubsub.listen():
        if message["type"] != "message":
            continue
        yield f"data: {message['data']}\n\n"


@router.get("/congestion/stream")
def stream_congestion() -> StreamingResponse:
    return StreamingResponse(_event_source(), media_type="text/event-stream")
```

Modify `backend/app/main.py` (add alongside the congestion router):
```python
from app.routes.stream import router as stream_router

app.include_router(stream_router)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pytest tests/test_routes_stream.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/routes/stream.py backend/app/main.py backend/tests/test_routes_stream.py
git commit -m "feat: add SSE endpoint for live congestion updates"
```

---

## Task 12: Prediction endpoint

**Files:**
- Create: `backend/app/routes/prediction.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_routes_prediction.py`

**Interfaces:**
- Consumes: `app.cache.get_prediction`
- Produces: `GET /congestion/prediction` → the cached batch result (Task 8 shape) verbatim, or `{"status": "collecting", "days_collected": 0}` if the batch has never run.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_routes_prediction.py`:
```python
import fakeredis
import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def fake_redis(monkeypatch):
    import app.cache as cache_module

    monkeypatch.setattr(cache_module, "r", fakeredis.FakeRedis(decode_responses=True))


def test_prediction_returns_collecting_when_never_run():
    from app.main import app

    client = TestClient(app)
    response = client.get("/congestion/prediction")

    assert response.status_code == 200
    assert response.json() == {"status": "collecting", "days_collected": 0}


def test_prediction_returns_cached_result():
    from app.cache import set_prediction
    from app.main import app

    cached = {"status": "ready", "baseline_mae": 100.0, "model_mae": 80.0, "curve": []}
    set_prediction(cached)

    client = TestClient(app)
    response = client.get("/congestion/prediction")

    assert response.json() == cached
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/test_routes_prediction.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.routes.prediction'`

- [ ] **Step 3: Write minimal implementation**

`backend/app/routes/prediction.py`:
```python
from fastapi import APIRouter

from app.cache import get_prediction

router = APIRouter()


@router.get("/congestion/prediction")
def prediction() -> dict:
    cached = get_prediction()
    if cached is not None:
        return cached
    return {"status": "collecting", "days_collected": 0}
```

Modify `backend/app/main.py` (add alongside the other routers):
```python
from app.routes.prediction import router as prediction_router

app.include_router(prediction_router)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pytest tests/test_routes_prediction.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/routes/prediction.py backend/app/main.py backend/tests/test_routes_prediction.py
git commit -m "feat: add GET /congestion/prediction"
```

---

## Task 13: Frontend scaffold + current congestion display

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/tailwind.config.js`
- Create: `frontend/postcss.config.js`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/index.css`
- Create: `frontend/src/api/congestion.ts`
- Create: `frontend/src/components/CongestionCard.tsx`
- Test: `frontend/tests/CongestionCard.test.tsx`
- Test: `frontend/vitest.setup.ts`

**Interfaces:**
- Produces: `api/congestion.ts` exports `interface CurrentCongestion { observed_at: string; congest_level: string; population_avg: number }` and `fetchCurrent(): Promise<CurrentCongestion>`; `components/CongestionCard.tsx` exports `CongestionCard({ data }: { data: CurrentCongestion | null })`.

- [ ] **Step 1: Write the failing test**

`frontend/tests/CongestionCard.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CongestionCard } from "../src/components/CongestionCard";

describe("CongestionCard", () => {
  it("renders the congestion level and population estimate", () => {
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
      />
    );

    expect(screen.getByText("보통")).toBeInTheDocument();
    expect(screen.getByText(/1,500/)).toBeInTheDocument();
  });

  it("renders a loading state when data is null", () => {
    render(<CongestionCard data={null} />);
    expect(screen.getByText(/불러오는 중/)).toBeInTheDocument();
  });
});
```

`frontend/vitest.setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm install && npx vitest run tests/CongestionCard.test.tsx`
Expected: FAIL with a module-not-found error for `../src/components/CongestionCard`

- [ ] **Step 3: Write minimal implementation**

`frontend/package.json`:
```json
{
  "name": "exhibition-congestion-prediction-frontend",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@playwright/test": "^1.47.0",
    "@testing-library/jest-dom": "^6.5.0",
    "@testing-library/react": "^16.0.1",
    "@types/react": "^18.3.5",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.20",
    "jsdom": "^25.0.0",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.10",
    "typescript": "^5.5.4",
    "vite": "^5.4.2",
    "vitest": "^2.0.5"
  }
}
```

`frontend/vite.config.ts`:
```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/congestion": "http://localhost:8000",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./vitest.setup.ts",
  },
});
```

`frontend/tailwind.config.js`:
```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
};
```

`frontend/postcss.config.js`:
```js
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
```

`frontend/src/index.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

`frontend/src/api/congestion.ts`:
```ts
export interface CurrentCongestion {
  observed_at: string;
  congest_level: string;
  population_avg: number;
}

export async function fetchCurrent(): Promise<CurrentCongestion> {
  const res = await fetch("/congestion/current");
  if (!res.ok) {
    throw new Error(`failed to fetch current congestion: ${res.status}`);
  }
  return res.json();
}

export interface PredictionCurvePoint {
  hour: number;
  baseline: number | null;
  model: number;
}

export interface PredictionResult {
  status: "collecting" | "ready";
  days_collected?: number;
  baseline_mae?: number;
  model_mae?: number;
  curve?: PredictionCurvePoint[];
}

export async function fetchPrediction(): Promise<PredictionResult> {
  const res = await fetch("/congestion/prediction");
  if (!res.ok) {
    throw new Error(`failed to fetch prediction: ${res.status}`);
  }
  return res.json();
}
```

`frontend/src/components/CongestionCard.tsx`:
```tsx
import type { CurrentCongestion } from "../api/congestion";

export function CongestionCard({ data }: { data: CurrentCongestion | null }) {
  if (!data) {
    return <div className="rounded-lg border p-4">불러오는 중...</div>;
  }

  return (
    <div className="rounded-lg border p-4">
      <p className="text-sm text-gray-500">국립중앙박물관 현재 혼잡도</p>
      <p className="text-2xl font-bold">{data.congest_level}</p>
      <p className="text-sm text-gray-500">
        예상 인원: {Math.round(data.population_avg).toLocaleString()}명
      </p>
    </div>
  );
}
```

`frontend/src/App.tsx`:
```tsx
import { useEffect, useState } from "react";

import { fetchCurrent, type CurrentCongestion } from "./api/congestion";
import { CongestionCard } from "./components/CongestionCard";

export default function App() {
  const [current, setCurrent] = useState<CurrentCongestion | null>(null);

  useEffect(() => {
    fetchCurrent().then(setCurrent).catch(() => setCurrent(null));
  }, []);

  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="mb-4 text-xl font-semibold">전시 혼잡도 예측</h1>
      <CongestionCard data={current} />
    </main>
  );
}
```

`frontend/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/CongestionCard.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/vite.config.ts frontend/tailwind.config.js frontend/postcss.config.js frontend/src frontend/tests/CongestionCard.test.tsx frontend/vitest.setup.ts
git commit -m "feat: scaffold frontend and current-congestion display"
```

---

## Task 14: Live updates via SSE

**Files:**
- Create: `frontend/src/hooks/useCongestionStream.ts`
- Modify: `frontend/src/App.tsx`
- Test: `frontend/tests/useCongestionStream.test.ts`

**Interfaces:**
- Consumes: `CurrentCongestion` type from `api/congestion.ts`
- Produces: `useCongestionStream(initial: CurrentCongestion | null): CurrentCongestion | null` — opens an `EventSource` to `/congestion/stream` and replaces state on each message.

- [ ] **Step 1: Write the failing test**

`frontend/tests/useCongestionStream.test.ts`:
```ts
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCongestionStream } from "../src/hooks/useCongestionStream";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {}

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useCongestionStream", () => {
  it("updates state when a message arrives", () => {
    const { result } = renderHook(() => useCongestionStream(null));

    expect(result.current).toBeNull();

    const source = FakeEventSource.instances[0];
    act(() => {
      source.emit({
        observed_at: "2026-07-15T15:00:00",
        congest_level: "붐빔",
        population_avg: 3000,
      });
    });

    expect(result.current?.congest_level).toBe("붐빔");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/useCongestionStream.test.ts`
Expected: FAIL with a module-not-found error for `../src/hooks/useCongestionStream`

- [ ] **Step 3: Write minimal implementation**

`frontend/src/hooks/useCongestionStream.ts`:
```ts
import { useEffect, useState } from "react";

import type { CurrentCongestion } from "../api/congestion";

export function useCongestionStream(
  initial: CurrentCongestion | null
): CurrentCongestion | null {
  const [current, setCurrent] = useState<CurrentCongestion | null>(initial);

  useEffect(() => {
    const source = new EventSource("/congestion/stream");
    source.onmessage = (event: MessageEvent) => {
      setCurrent(JSON.parse(event.data));
    };
    return () => source.close();
  }, []);

  return current;
}
```

Modify `frontend/src/App.tsx` (replace the `current` state wiring):
```tsx
import { useEffect, useState } from "react";

import { fetchCurrent, type CurrentCongestion } from "./api/congestion";
import { CongestionCard } from "./components/CongestionCard";
import { useCongestionStream } from "./hooks/useCongestionStream";

export default function App() {
  const [initial, setInitial] = useState<CurrentCongestion | null>(null);

  useEffect(() => {
    fetchCurrent().then(setInitial).catch(() => setInitial(null));
  }, []);

  const current = useCongestionStream(initial);

  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="mb-4 text-xl font-semibold">전시 혼잡도 예측</h1>
      <CongestionCard data={current} />
    </main>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/useCongestionStream.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useCongestionStream.ts frontend/src/App.tsx frontend/tests/useCongestionStream.test.ts
git commit -m "feat: live-update congestion display over SSE"
```

---

## Task 15: Prediction chart

**Files:**
- Create: `frontend/src/components/PredictionChart.tsx`
- Modify: `frontend/src/App.tsx`
- Test: `frontend/tests/PredictionChart.test.tsx`

**Interfaces:**
- Consumes: `PredictionResult`, `PredictionCurvePoint` from `api/congestion.ts`
- Produces: `PredictionChart({ prediction }: { prediction: PredictionResult | null })` — hand-rolled SVG line chart (no charting library, per YAGNI: one 24-point polyline doesn't need a dependency), showing a "수집 중" message while `status === "collecting"`.

- [ ] **Step 1: Write the failing test**

`frontend/tests/PredictionChart.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PredictionChart } from "../src/components/PredictionChart";

describe("PredictionChart", () => {
  it("shows a collecting message before enough data exists", () => {
    render(
      <PredictionChart prediction={{ status: "collecting", days_collected: 5 }} />
    );
    expect(screen.getByText(/수집 중/)).toBeInTheDocument();
  });

  it("renders an svg chart with baseline and model MAE once ready", () => {
    const curve = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      baseline: 1000 + hour,
      model: 1050 + hour,
    }));

    render(
      <PredictionChart
        prediction={{
          status: "ready",
          baseline_mae: 120.5,
          model_mae: 95.2,
          curve,
        }}
      />
    );

    expect(screen.getByTestId("prediction-svg")).toBeInTheDocument();
    expect(screen.getByText(/95\.2/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/PredictionChart.test.tsx`
Expected: FAIL with a module-not-found error for `../src/components/PredictionChart`

- [ ] **Step 3: Write minimal implementation**

`frontend/src/components/PredictionChart.tsx`:
```tsx
import type { PredictionResult } from "../api/congestion";

const WIDTH = 480;
const HEIGHT = 160;

function toPoints(values: number[], maxValue: number): string {
  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * WIDTH;
      const y = HEIGHT - (value / maxValue) * HEIGHT;
      return `${x},${y}`;
    })
    .join(" ");
}

export function PredictionChart({ prediction }: { prediction: PredictionResult | null }) {
  if (!prediction || prediction.status === "collecting") {
    const days = prediction?.days_collected ?? 0;
    return (
      <div className="rounded-lg border p-4">
        데이터 수집 중 ({days}/14일) — 예측을 위해 조금 더 기다려주세요.
      </div>
    );
  }

  const curve = prediction.curve ?? [];
  const baselineValues = curve.map((point) => point.baseline ?? point.model);
  const modelValues = curve.map((point) => point.model);
  const maxValue = Math.max(...baselineValues, ...modelValues, 1);

  return (
    <div className="rounded-lg border p-4">
      <p className="mb-2 text-sm text-gray-500">
        베이스라인 MAE {prediction.baseline_mae?.toFixed(1)} · 모델 MAE{" "}
        {prediction.model_mae?.toFixed(1)}
      </p>
      <svg
        data-testid="prediction-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
      >
        <polyline points={toPoints(baselineValues, maxValue)} fill="none" stroke="#94a3b8" strokeWidth={2} />
        <polyline points={toPoints(modelValues, maxValue)} fill="none" stroke="#2563eb" strokeWidth={2} />
      </svg>
    </div>
  );
}
```

Modify `frontend/src/App.tsx` (add prediction fetch + chart):
```tsx
import { useEffect, useState } from "react";

import { fetchCurrent, fetchPrediction, type CurrentCongestion, type PredictionResult } from "./api/congestion";
import { CongestionCard } from "./components/CongestionCard";
import { PredictionChart } from "./components/PredictionChart";
import { useCongestionStream } from "./hooks/useCongestionStream";

export default function App() {
  const [initial, setInitial] = useState<CurrentCongestion | null>(null);
  const [prediction, setPrediction] = useState<PredictionResult | null>(null);

  useEffect(() => {
    fetchCurrent().then(setInitial).catch(() => setInitial(null));
    fetchPrediction().then(setPrediction).catch(() => setPrediction(null));
  }, []);

  const current = useCongestionStream(initial);

  return (
    <main className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">전시 혼잡도 예측</h1>
      <CongestionCard data={current} />
      <PredictionChart prediction={prediction} />
    </main>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/PredictionChart.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PredictionChart.tsx frontend/src/App.tsx frontend/tests/PredictionChart.test.tsx
git commit -m "feat: add baseline-vs-model prediction chart"
```

---

## Task 16: End-to-end smoke test

**Files:**
- Create: `frontend/playwright.config.ts`
- Create: `frontend/e2e/congestion.spec.ts`

**Interfaces:**
- Consumes: the built frontend served by Vite preview; network calls to `/congestion/current` and `/congestion/prediction` are mocked via Playwright route interception (no backend process required).

- [ ] **Step 1: Write the failing test**

`frontend/e2e/congestion.spec.ts`:
```ts
import { expect, test } from "@playwright/test";

test("renders current congestion and prediction chart from the API", async ({ page }) => {
  await page.route("**/congestion/current", (route) =>
    route.fulfill({
      json: {
        observed_at: "2026-07-15T14:30:00",
        congest_level: "보통",
        population_avg: 1500,
      },
    })
  );

  await page.route("**/congestion/prediction", (route) =>
    route.fulfill({
      json: {
        status: "ready",
        baseline_mae: 120.5,
        model_mae: 95.2,
        curve: Array.from({ length: 24 }, (_, hour) => ({
          hour,
          baseline: 1000 + hour,
          model: 1050 + hour,
        })),
      },
    })
  );

  await page.route("**/congestion/stream", (route) => route.abort());

  await page.goto("/");

  await expect(page.getByText("보통")).toBeVisible();
  await expect(page.getByTestId("prediction-svg")).toBeVisible();
});
```

`frontend/playwright.config.ts`:
```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: "npm run dev",
    port: 5173,
    reuseExistingServer: true,
  },
  use: {
    baseURL: "http://localhost:5173",
  },
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx playwright install --with-deps chromium && npx playwright test`
Expected: FAIL (no `playwright.config.ts` / `e2e` directory wired up yet, or the app not rendering matching text if run before Task 15)

- [ ] **Step 3: Write minimal implementation**

No app code changes needed — Tasks 13–15 already produce the markup this test asserts on. This step only adds the config and spec files above.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx playwright test`
Expected: PASS (1 passed)

- [ ] **Step 5: Commit**

```bash
git add frontend/playwright.config.ts frontend/e2e/congestion.spec.ts
git commit -m "test: add e2e smoke test for congestion display and chart"
```

---

## Self-Review Notes

- **Spec coverage:** 5-minute collection (Task 5+9) · Redis caching (Task 4) · SSE not WebSocket (Task 11, 14) · baseline + ML comparison via MAE (Task 6–8) · cold-start "collecting" status (Task 8, 12, 15) · fallback on API failure (Task 5's TTL + Task 10's DB fallback) · FastAPI/Postgres/Redis/React-Vite-TS stack (Tasks 1–16) · 국립중앙박물관 hardcoded single venue (`config.py` default) — every spec section maps to at least one task.
- **Placeholder scan:** no TBD/TODO; every step has runnable code.
- **Type consistency:** `CongestionReading` (Task 3) flows unchanged into `cache.py` (Task 4) and `collector.py` (Task 5); baseline/model both consume plain rows with `.observed_at`/`.population_avg` (Tasks 6–8); frontend `CurrentCongestion`/`PredictionResult` types (Task 13) are reused as-is through Tasks 14–16.
- **Scope:** this plan only covers the single-venue MVP from the spec — multi-venue, extra data sources, auth, and deployment are explicitly out of scope and not tasked here.
