# Daily Congestion Log Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `DailyLogTable` below `CongestionCard` showing every 5-minute raw reading for a selected day (16 columns: time, congestion level, population, gender/age/resident-status ratios), navigable one day at a time, backed by a new `/congestion/daily` endpoint — and extend collection to actually capture the 12 population-breakdown fields the Seoul API already provides but the app currently discards.

**Architecture:** The Seoul API's `LIVE_PPLTN_STTS` response already contains all 16 fields; only 4 are parsed today. Extend the parse step (`seoul_api.py`), the storage step (`RawCongestion` + `collector.py`), and add one read endpoint (`GET /congestion/daily?date=`) that queries the existing table by calendar-day range. Frontend adds one API function and one new self-contained component. No new tables, no new infra, no new dependencies.

**Tech Stack:** FastAPI + SQLAlchemy (backend), React + TypeScript + Tailwind (frontend). No new packages.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-16-daily-congestion-log-design.md`
- Branch: `feat/daily-congestion-log` (already created, design doc already committed there — continue on it)
- This is a fast, throwaway-quality first pass by explicit user instruction ("배포 전에 다시 다듬을 예정") — do not add polish, responsive design, or column collapsing beyond what's specified below.
- The Seoul API returns every field as a JSON **string**, including the numeric ones (verified against a live response) — every new field needs explicit `float(...)` casting in `fetch_congestion`, matching the existing `int(...)` pattern for `population_min`/`population_max`.
- New `RawCongestion` columns MUST be nullable — existing rows collected since 7/15 don't have this data, and that 14-day collection history must not be lost. Do NOT drop/recreate the database.
- Field name mapping (Seoul API field → Python attribute, all new fields are `float | None`):
  `MALE_PPLTN_RATE`→`male_ppltn_rate`, `FEMALE_PPLTN_RATE`→`female_ppltn_rate`, `PPLTN_RATE_0`→`ppltn_rate_0`, `PPLTN_RATE_10`→`ppltn_rate_10`, `PPLTN_RATE_20`→`ppltn_rate_20`, `PPLTN_RATE_30`→`ppltn_rate_30`, `PPLTN_RATE_40`→`ppltn_rate_40`, `PPLTN_RATE_50`→`ppltn_rate_50`, `PPLTN_RATE_60`→`ppltn_rate_60`, `PPLTN_RATE_70`→`ppltn_rate_70`, `RESNT_PPLTN_RATE`→`resnt_ppltn_rate`, `NON_RESNT_PPLTN_RATE`→`non_resnt_ppltn_rate`.
  Existing fields (do not rename): `PPLTN_TIME`→`observed_at`, `AREA_CONGEST_LVL`→`congest_level`, `AREA_PPLTN_MIN`→`population_min`, `AREA_PPLTN_MAX`→`population_max`.
  Field order in `DailyLogPoint`/`CongestionReading`/`RawCongestion` additions and in the frontend `COLUMNS` array MUST be: `observed_at`, `congest_level`, `population_min`, `population_max`, `male_ppltn_rate`, `female_ppltn_rate`, `ppltn_rate_0`, `ppltn_rate_10`, `ppltn_rate_20`, `ppltn_rate_30`, `ppltn_rate_40`, `ppltn_rate_50`, `ppltn_rate_60`, `ppltn_rate_70`, `resnt_ppltn_rate`, `non_resnt_ppltn_rate` (16 fields, this exact order, in every task that touches them).
  Commit messages follow `CONTRIBUTING.md`: `type(scope): subject`.
- Backend tests: `cd backend && .venv/bin/pytest`. Frontend unit tests: `cd frontend && npx vitest run`. Frontend type check: `cd frontend && npm run type-check`. E2E: `cd frontend && npx playwright test`.

---

### Task 1: Backend — parse all 16 Seoul API fields

**Files:**
- Modify: `backend/app/seoul_api.py`
- Test: `backend/tests/test_seoul_api.py`

**Interfaces:**
- Consumes: nothing new
- Produces: `CongestionReading` dataclass with 12 new fields, each `float | None = None` (default lets existing call sites that don't care about them, like `test_collector.py`'s fixture construction, keep working unmodified); `fetch_congestion` populates all 16 from a real API response.

- [ ] **Step 1: Write the failing test**

Replace `backend/tests/test_seoul_api.py` with:

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
                "MALE_PPLTN_RATE": "51.8",
                "FEMALE_PPLTN_RATE": "48.2",
                "PPLTN_RATE_0": "3.9",
                "PPLTN_RATE_10": "17.8",
                "PPLTN_RATE_20": "9.3",
                "PPLTN_RATE_30": "12.3",
                "PPLTN_RATE_40": "15.7",
                "PPLTN_RATE_50": "18.2",
                "PPLTN_RATE_60": "13.2",
                "PPLTN_RATE_70": "9.8",
                "RESNT_PPLTN_RATE": "45.1",
                "NON_RESNT_PPLTN_RATE": "54.9",
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
    assert reading.male_ppltn_rate == 51.8
    assert reading.female_ppltn_rate == 48.2
    assert reading.ppltn_rate_0 == 3.9
    assert reading.ppltn_rate_10 == 17.8
    assert reading.ppltn_rate_20 == 9.3
    assert reading.ppltn_rate_30 == 12.3
    assert reading.ppltn_rate_40 == 15.7
    assert reading.ppltn_rate_50 == 18.2
    assert reading.ppltn_rate_60 == 13.2
    assert reading.ppltn_rate_70 == 9.8
    assert reading.resnt_ppltn_rate == 45.1
    assert reading.non_resnt_ppltn_rate == 54.9


def test_fetch_congestion_defaults_new_fields_when_absent():
    """A minimal legacy-shaped response (no breakdown fields) must not crash."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "CITYDATA": {
                    "LIVE_PPLTN_STTS": [
                        {
                            "AREA_CONGEST_LVL": "여유",
                            "AREA_PPLTN_MIN": "500",
                            "AREA_PPLTN_MAX": "700",
                            "PPLTN_TIME": "2026-07-15 09:00",
                        }
                    ]
                }
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    reading = fetch_congestion(client, "국립중앙박물관·용산가족공원", "test-key")

    assert reading.male_ppltn_rate is None
    assert reading.resnt_ppltn_rate is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_seoul_api.py -v`
Expected: `test_fetch_congestion_parses_response` FAILS with `AttributeError: 'CongestionReading' object has no attribute 'male_ppltn_rate'`. `test_fetch_congestion_defaults_new_fields_when_absent` fails the same way.

- [ ] **Step 3: Implement**

Replace `backend/app/seoul_api.py` with:

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
    male_ppltn_rate: float | None = None
    female_ppltn_rate: float | None = None
    ppltn_rate_0: float | None = None
    ppltn_rate_10: float | None = None
    ppltn_rate_20: float | None = None
    ppltn_rate_30: float | None = None
    ppltn_rate_40: float | None = None
    ppltn_rate_50: float | None = None
    ppltn_rate_60: float | None = None
    ppltn_rate_70: float | None = None
    resnt_ppltn_rate: float | None = None
    non_resnt_ppltn_rate: float | None = None


def _optional_float(live: dict, key: str) -> float | None:
    value = live.get(key)
    return float(value) if value is not None else None


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
        male_ppltn_rate=_optional_float(live, "MALE_PPLTN_RATE"),
        female_ppltn_rate=_optional_float(live, "FEMALE_PPLTN_RATE"),
        ppltn_rate_0=_optional_float(live, "PPLTN_RATE_0"),
        ppltn_rate_10=_optional_float(live, "PPLTN_RATE_10"),
        ppltn_rate_20=_optional_float(live, "PPLTN_RATE_20"),
        ppltn_rate_30=_optional_float(live, "PPLTN_RATE_30"),
        ppltn_rate_40=_optional_float(live, "PPLTN_RATE_40"),
        ppltn_rate_50=_optional_float(live, "PPLTN_RATE_50"),
        ppltn_rate_60=_optional_float(live, "PPLTN_RATE_60"),
        ppltn_rate_70=_optional_float(live, "PPLTN_RATE_70"),
        resnt_ppltn_rate=_optional_float(live, "RESNT_PPLTN_RATE"),
        non_resnt_ppltn_rate=_optional_float(live, "NON_RESNT_PPLTN_RATE"),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_seoul_api.py -v`
Expected: both tests PASS.

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && .venv/bin/pytest`
Expected: all tests pass (no regressions — `test_collector.py`'s `CongestionReading(...)` construction still works because the 12 new fields default to `None`).

- [ ] **Step 6: Commit**

```bash
git add backend/app/seoul_api.py backend/tests/test_seoul_api.py
git commit -m "feat(be): parse population breakdown fields from Seoul API"
```

---

### Task 2: Backend — store the new fields (model + migration + collector)

**Files:**
- Modify: `backend/app/models.py`
- Modify: `backend/app/collector.py`
- Create: `backend/scripts/migrate_add_population_fields.py`
- Test: `backend/tests/test_db_models.py`, `backend/tests/test_collector.py`

**Interfaces:**
- Consumes: `CongestionReading`'s 12 new fields (Task 1)
- Produces: `RawCongestion` with 12 new nullable float columns (same names as `CongestionReading`); `collect_once` persists them.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_db_models.py`:

```python
def test_raw_congestion_stores_population_breakdown():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    with Session() as session:
        row = RawCongestion(
            observed_at=datetime(2026, 7, 15, 14, 30),
            congest_level="보통",
            population_min=1000,
            population_max=2000,
            male_ppltn_rate=51.8,
            female_ppltn_rate=48.2,
            ppltn_rate_0=3.9,
            ppltn_rate_10=17.8,
            ppltn_rate_20=9.3,
            ppltn_rate_30=12.3,
            ppltn_rate_40=15.7,
            ppltn_rate_50=18.2,
            ppltn_rate_60=13.2,
            ppltn_rate_70=9.8,
            resnt_ppltn_rate=45.1,
            non_resnt_ppltn_rate=54.9,
        )
        session.add(row)
        session.commit()

        fetched = session.query(RawCongestion).one()
        assert fetched.male_ppltn_rate == 51.8
        assert fetched.resnt_ppltn_rate == 45.1


def test_raw_congestion_breakdown_fields_are_nullable():
    """Rows collected before this feature existed have no breakdown data."""
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
        assert fetched.male_ppltn_rate is None
```

Append to `backend/tests/test_collector.py`:

```python
def test_collect_once_stores_population_breakdown_fields(monkeypatch, session_factory):
    import app.collector as collector_module

    fake_reading = CongestionReading(
        observed_at=datetime(2026, 7, 15, 14, 30),
        congest_level="보통",
        population_min=1000,
        population_max=2000,
        male_ppltn_rate=51.8,
        resnt_ppltn_rate=45.1,
    )
    monkeypatch.setattr(collector_module, "fetch_congestion", lambda client, area, key: fake_reading)

    collector_module.collect_once(session_factory=session_factory)

    with session_factory() as session:
        stored = session.query(RawCongestion).one()
        assert stored.male_ppltn_rate == 51.8
        assert stored.resnt_ppltn_rate == 45.1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_db_models.py tests/test_collector.py -v`
Expected: the 3 new tests FAIL — `test_raw_congestion_stores_population_breakdown` and `test_collect_once_stores_population_breakdown_fields` with `TypeError: 'male_ppltn_rate' is an invalid keyword argument for RawCongestion`; `test_raw_congestion_breakdown_fields_are_nullable` fails on the `fetched.male_ppltn_rate` assertion (`AttributeError`). All pre-existing tests in both files still pass.

- [ ] **Step 3: Add the columns to the model**

Replace `backend/app/models.py` with:

```python
from datetime import datetime

from sqlalchemy import DateTime, Float, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class RawCongestion(Base):
    __tablename__ = "raw_congestion"

    id: Mapped[int] = mapped_column(primary_key=True)
    observed_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    congest_level: Mapped[str] = mapped_column(String)
    population_min: Mapped[int] = mapped_column(Integer)
    population_max: Mapped[int] = mapped_column(Integer)
    male_ppltn_rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    female_ppltn_rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    ppltn_rate_0: Mapped[float | None] = mapped_column(Float, nullable=True)
    ppltn_rate_10: Mapped[float | None] = mapped_column(Float, nullable=True)
    ppltn_rate_20: Mapped[float | None] = mapped_column(Float, nullable=True)
    ppltn_rate_30: Mapped[float | None] = mapped_column(Float, nullable=True)
    ppltn_rate_40: Mapped[float | None] = mapped_column(Float, nullable=True)
    ppltn_rate_50: Mapped[float | None] = mapped_column(Float, nullable=True)
    ppltn_rate_60: Mapped[float | None] = mapped_column(Float, nullable=True)
    ppltn_rate_70: Mapped[float | None] = mapped_column(Float, nullable=True)
    resnt_ppltn_rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    non_resnt_ppltn_rate: Mapped[float | None] = mapped_column(Float, nullable=True)

    @property
    def population_avg(self) -> float:
        return (self.population_min + self.population_max) / 2
```

- [ ] **Step 4: Store the new fields in the collector**

Replace `backend/app/collector.py` with:

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
                male_ppltn_rate=reading.male_ppltn_rate,
                female_ppltn_rate=reading.female_ppltn_rate,
                ppltn_rate_0=reading.ppltn_rate_0,
                ppltn_rate_10=reading.ppltn_rate_10,
                ppltn_rate_20=reading.ppltn_rate_20,
                ppltn_rate_30=reading.ppltn_rate_30,
                ppltn_rate_40=reading.ppltn_rate_40,
                ppltn_rate_50=reading.ppltn_rate_50,
                ppltn_rate_60=reading.ppltn_rate_60,
                ppltn_rate_70=reading.ppltn_rate_70,
                resnt_ppltn_rate=reading.resnt_ppltn_rate,
                non_resnt_ppltn_rate=reading.non_resnt_ppltn_rate,
            )
        )
        session.commit()

    set_latest(reading)
    return reading
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_db_models.py tests/test_collector.py -v`
Expected: all tests PASS (5 in test_db_models.py area's new+old, all of test_collector.py).

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && .venv/bin/pytest`
Expected: all tests pass.

- [ ] **Step 7: Write the one-time migration script for the existing local database**

Create `backend/scripts/migrate_add_population_fields.py`:

```python
"""One-time, idempotent migration: add the population-breakdown columns to
an existing local congestion.db without losing already-collected rows.

SQLite only — Base.metadata.create_all() creates missing tables but never
alters existing ones, so this fills that gap for local dev. Safe to re-run.
"""

import sqlite3

from app.config import settings

NEW_COLUMNS = [
    "male_ppltn_rate",
    "female_ppltn_rate",
    "ppltn_rate_0",
    "ppltn_rate_10",
    "ppltn_rate_20",
    "ppltn_rate_30",
    "ppltn_rate_40",
    "ppltn_rate_50",
    "ppltn_rate_60",
    "ppltn_rate_70",
    "resnt_ppltn_rate",
    "non_resnt_ppltn_rate",
]


def main() -> None:
    db_path = settings.database_url.removeprefix("sqlite:///")
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute("PRAGMA table_info(raw_congestion)")
        existing = {row[1] for row in cur.fetchall()}

        for column in NEW_COLUMNS:
            if column in existing:
                print(f"skip {column} (already present)")
                continue
            cur.execute(f"ALTER TABLE raw_congestion ADD COLUMN {column} FLOAT")
            print(f"added {column}")

        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 8: Run the migration against the real local database**

Run: `cd backend && .venv/bin/python scripts/migrate_add_population_fields.py`
Expected: prints `added <column>` for all 12 columns (first run) — confirms it ran against the actual `congestion.db`, not just the in-memory test databases.

- [ ] **Step 9: Verify existing data survived**

Run: `cd backend && .venv/bin/python -c "
from app.db import SessionLocal
from app.models import RawCongestion
with SessionLocal() as s:
    print('row count:', s.query(RawCongestion).count())
"`
Expected: the row count matches what it was before this task (check against the count from before Step 8 if unsure — it must NOT be 0 or reset).

- [ ] **Step 10: Commit**

```bash
git add backend/app/models.py backend/app/collector.py backend/scripts/migrate_add_population_fields.py backend/tests/test_db_models.py backend/tests/test_collector.py
git commit -m "feat(be): store population breakdown fields, add local migration script"
```

---

### Task 3: Backend — `GET /congestion/daily` endpoint

**Files:**
- Modify: `backend/app/schemas.py`
- Modify: `backend/app/routes/congestion.py`
- Test: `backend/tests/test_routes_congestion.py`

**Interfaces:**
- Consumes: `RawCongestion`'s new columns (Task 2)
- Produces: `DailyLogPoint` Pydantic model (16 fields, see Global Constraints for exact order); route `GET /congestion/daily?date=YYYY-MM-DD` (date optional, defaults to today) returning `list[DailyLogPoint]` for that calendar day, oldest→newest, empty list when no rows.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_routes_congestion.py`:

```python
def test_daily_returns_empty_list_when_no_data(client):
    test_client, _ = client
    response = test_client.get("/congestion/daily?date=2026-07-16")
    assert response.status_code == 200
    assert response.json() == []


def test_daily_returns_only_rows_within_the_given_day(client):
    test_client, session_factory = client

    from datetime import datetime

    with session_factory() as session:
        session.add_all(
            [
                RawCongestion(
                    observed_at=datetime(2026, 7, 16, 9, 0),
                    congest_level="여유",
                    population_min=800,
                    population_max=1000,
                    male_ppltn_rate=51.8,
                    resnt_ppltn_rate=45.1,
                ),
                RawCongestion(
                    observed_at=datetime(2026, 7, 16, 23, 55),
                    congest_level="보통",
                    population_min=1200,
                    population_max=1400,
                ),
                RawCongestion(
                    observed_at=datetime(2026, 7, 17, 0, 0),
                    congest_level="붐빔",
                    population_min=3000,
                    population_max=3200,
                ),
                RawCongestion(
                    observed_at=datetime(2026, 7, 15, 23, 59),
                    congest_level="붐빔",
                    population_min=3000,
                    population_max=3200,
                ),
            ]
        )
        session.commit()

    response = test_client.get("/congestion/daily?date=2026-07-16")
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 2
    assert body[0]["congest_level"] == "여유"
    assert body[0]["male_ppltn_rate"] == 51.8
    assert body[0]["resnt_ppltn_rate"] == 45.1
    assert body[1]["congest_level"] == "보통"
    assert body[1]["male_ppltn_rate"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_routes_congestion.py -v`
Expected: the two new tests FAIL (route doesn't exist — `404`). Pre-existing tests in this file still pass.

- [ ] **Step 3: Add the response schema**

In `backend/app/schemas.py`, add at the end:

```python
class DailyLogPoint(BaseModel):
    observed_at: str
    congest_level: str
    population_min: int
    population_max: int
    male_ppltn_rate: float | None = None
    female_ppltn_rate: float | None = None
    ppltn_rate_0: float | None = None
    ppltn_rate_10: float | None = None
    ppltn_rate_20: float | None = None
    ppltn_rate_30: float | None = None
    ppltn_rate_40: float | None = None
    ppltn_rate_50: float | None = None
    ppltn_rate_60: float | None = None
    ppltn_rate_70: float | None = None
    resnt_ppltn_rate: float | None = None
    non_resnt_ppltn_rate: float | None = None
```

- [ ] **Step 4: Add the route**

In `backend/app/routes/congestion.py`, change the `app.schemas` import line to also bring in `DailyLogPoint`, and append the new route at the end of the file:

```python
from app.schemas import CongestionHistoryPoint, CurrentCongestion, DailyLogPoint
```

```python
@router.get("/congestion/daily", response_model=list[DailyLogPoint])
def congestion_daily(date: str | None = Query(default=None)) -> list[DailyLogPoint]:
    day_start = (
        datetime.strptime(date, "%Y-%m-%d")
        if date
        else datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    )
    day_end = day_start + timedelta(days=1)

    with SessionLocal() as session:
        rows = (
            session.query(RawCongestion)
            .filter(RawCongestion.observed_at >= day_start, RawCongestion.observed_at < day_end)
            .order_by(RawCongestion.observed_at.asc())
            .all()
        )
    return [
        DailyLogPoint(
            observed_at=row.observed_at.isoformat(),
            congest_level=row.congest_level,
            population_min=row.population_min,
            population_max=row.population_max,
            male_ppltn_rate=row.male_ppltn_rate,
            female_ppltn_rate=row.female_ppltn_rate,
            ppltn_rate_0=row.ppltn_rate_0,
            ppltn_rate_10=row.ppltn_rate_10,
            ppltn_rate_20=row.ppltn_rate_20,
            ppltn_rate_30=row.ppltn_rate_30,
            ppltn_rate_40=row.ppltn_rate_40,
            ppltn_rate_50=row.ppltn_rate_50,
            ppltn_rate_60=row.ppltn_rate_60,
            ppltn_rate_70=row.ppltn_rate_70,
            resnt_ppltn_rate=row.resnt_ppltn_rate,
            non_resnt_ppltn_rate=row.non_resnt_ppltn_rate,
        )
        for row in rows
    ]
```

(`datetime` and `timedelta` are already imported at the top of this file from the `/congestion/history` task; `Query` is already imported too.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_routes_congestion.py -v`
Expected: all tests PASS.

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && .venv/bin/pytest`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add backend/app/schemas.py backend/app/routes/congestion.py backend/tests/test_routes_congestion.py
git commit -m "feat(be): add congestion daily log endpoint"
```

---

### Task 4: Frontend — `fetchDaily` API client

**Files:**
- Modify: `frontend/src/api/congestion.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `DailyLogPoint` type (16 fields, exact order from Global Constraints, new 12 typed `number | null`); `fetchDaily(date: string): Promise<DailyLogPoint[]>`

- [ ] **Step 1: Add the type and function**

Append to `frontend/src/api/congestion.ts`:

```typescript
export interface DailyLogPoint {
  observed_at: string;
  congest_level: string;
  population_min: number;
  population_max: number;
  male_ppltn_rate: number | null;
  female_ppltn_rate: number | null;
  ppltn_rate_0: number | null;
  ppltn_rate_10: number | null;
  ppltn_rate_20: number | null;
  ppltn_rate_30: number | null;
  ppltn_rate_40: number | null;
  ppltn_rate_50: number | null;
  ppltn_rate_60: number | null;
  ppltn_rate_70: number | null;
  resnt_ppltn_rate: number | null;
  non_resnt_ppltn_rate: number | null;
}

export async function fetchDaily(date: string): Promise<DailyLogPoint[]> {
  const res = await fetch(`/congestion/daily?date=${date}`);
  if (!res.ok) {
    throw new Error(`failed to fetch daily congestion log: ${res.status}`);
  }
  return res.json();
}
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npm run type-check`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/congestion.ts
git commit -m "feat(fe): add fetchDaily API client"
```

---

### Task 5: Frontend — `DailyLogTable` component

**Files:**
- Create: `frontend/src/components/DailyLogTable.tsx`
- Test: `frontend/tests/DailyLogTable.test.tsx`

**Interfaces:**
- Consumes: `fetchDaily`, `DailyLogPoint` from `../api/congestion` (Task 4)
- Produces: `DailyLogTable()` — a self-contained component with no props; it manages its own `selectedDate` state and fetches its own data (App.tsx only needs to render `<DailyLogTable />`).

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/DailyLogTable.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DailyLogTable } from "../src/components/DailyLogTable";
import * as api from "../src/api/congestion";

describe("DailyLogTable", () => {
  it("renders rows for the fetched day", async () => {
    vi.spyOn(api, "fetchDaily").mockResolvedValue([
      {
        observed_at: "2026-07-16T09:00:00",
        congest_level: "여유",
        population_min: 800,
        population_max: 1000,
        male_ppltn_rate: 51.8,
        female_ppltn_rate: 48.2,
        ppltn_rate_0: null,
        ppltn_rate_10: null,
        ppltn_rate_20: null,
        ppltn_rate_30: null,
        ppltn_rate_40: null,
        ppltn_rate_50: null,
        ppltn_rate_60: null,
        ppltn_rate_70: null,
        resnt_ppltn_rate: 45.1,
        non_resnt_ppltn_rate: 54.9,
      },
    ]);

    render(<DailyLogTable />);

    await waitFor(() => expect(screen.getByText("여유")).toBeInTheDocument());
    expect(screen.getByText("09:00")).toBeInTheDocument();
    expect(screen.getByText("51.8")).toBeInTheDocument();
  });

  it("shows an empty-state message when there is no data for the day", async () => {
    vi.spyOn(api, "fetchDaily").mockResolvedValue([]);

    render(<DailyLogTable />);

    await waitFor(() => expect(screen.getByText(/데이터 없음/)).toBeInTheDocument());
  });

  it("disables the next-day button when viewing today", async () => {
    vi.spyOn(api, "fetchDaily").mockResolvedValue([]);

    render(<DailyLogTable />);

    await waitFor(() => screen.getByText(/데이터 없음/));
    expect(screen.getByRole("button", { name: /다음 날짜/ })).toBeDisabled();
  });

  it("re-fetches for the previous day when the previous button is clicked", async () => {
    const fetchDailyMock = vi.spyOn(api, "fetchDaily").mockResolvedValue([]);

    render(<DailyLogTable />);
    await waitFor(() => expect(fetchDailyMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /이전 날짜/ }));

    await waitFor(() => expect(fetchDailyMock).toHaveBeenCalledTimes(2));
    const firstCallDate = fetchDailyMock.mock.calls[0][0];
    const secondCallDate = fetchDailyMock.mock.calls[1][0];
    expect(secondCallDate < firstCallDate).toBe(true);
  });
});
```

Uses `fireEvent` (already imported from `@testing-library/react` below, no new dependency needed).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/DailyLogTable.test.tsx`
Expected: FAIL — `frontend/src/components/DailyLogTable.tsx` doesn't exist yet (module not found).

- [ ] **Step 3: Implement the component**

Create `frontend/src/components/DailyLogTable.tsx`:

```tsx
import { useEffect, useState } from "react";

import { fetchDaily, type DailyLogPoint } from "../api/congestion";

const STATUS_COLOR: Record<string, string> = {
  여유: "#0ca30c",
  보통: "#fab219",
  약간붐빔: "#ec835a",
  붐빔: "#d03b3b",
};
const FALLBACK_COLOR = "#94a3b8";

type ColumnKey = keyof DailyLogPoint;

const COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: "observed_at", label: "시각" },
  { key: "congest_level", label: "혼잡도" },
  { key: "population_min", label: "최소 인구" },
  { key: "population_max", label: "최대 인구" },
  { key: "male_ppltn_rate", label: "남성 비율" },
  { key: "female_ppltn_rate", label: "여성 비율" },
  { key: "ppltn_rate_0", label: "10대 미만" },
  { key: "ppltn_rate_10", label: "10대" },
  { key: "ppltn_rate_20", label: "20대" },
  { key: "ppltn_rate_30", label: "30대" },
  { key: "ppltn_rate_40", label: "40대" },
  { key: "ppltn_rate_50", label: "50대" },
  { key: "ppltn_rate_60", label: "60대" },
  { key: "ppltn_rate_70", label: "70대 이상" },
  { key: "resnt_ppltn_rate", label: "상주인구" },
  { key: "non_resnt_ppltn_rate", label: "비상주인구" },
];

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function cellValue(row: DailyLogPoint, key: ColumnKey): string {
  if (key === "observed_at") return row.observed_at.slice(11, 16);
  const value = row[key];
  return value === null || value === undefined ? "" : String(value);
}

export function DailyLogTable() {
  const [selectedDate, setSelectedDate] = useState(todayString());
  const [rows, setRows] = useState<DailyLogPoint[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setRows(null);
    setError(false);
    fetchDaily(selectedDate)
      .then(setRows)
      .catch(() => setError(true));
  }, [selectedDate]);

  const isToday = selectedDate === todayString();

  return (
    <div className="rounded-lg border p-8">
      <div className="mb-4 flex items-center justify-between">
        <button
          className="text-sm text-gray-500"
          onClick={() => setSelectedDate((d) => shiftDate(d, -1))}
        >
          ← 이전 날짜
        </button>
        <span className="text-sm font-semibold">{selectedDate}</span>
        <button
          className="text-sm text-gray-500 disabled:opacity-30"
          disabled={isToday}
          onClick={() => setSelectedDate((d) => shiftDate(d, 1))}
        >
          다음 날짜 →
        </button>
      </div>

      {error && <p className="text-sm text-gray-500">불러오지 못했습니다.</p>}
      {!error && rows && rows.length === 0 && (
        <p className="text-sm text-gray-500">데이터 없음</p>
      )}
      {!error && rows && rows.length > 0 && (
        <div className="max-h-96 overflow-x-auto overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                {COLUMNS.map((col) => (
                  <th key={col.key} className="whitespace-nowrap px-2 py-1 text-gray-500">
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.observed_at}>
                  {COLUMNS.map((col) => (
                    <td
                      key={col.key}
                      className="whitespace-nowrap px-2 py-1"
                      style={
                        col.key === "congest_level"
                          ? { color: STATUS_COLOR[row.congest_level] ?? FALLBACK_COLOR }
                          : undefined
                      }
                    >
                      {cellValue(row, col.key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/DailyLogTable.test.tsx`
Expected: all 4 tests PASS.

- [ ] **Step 5: Type-check and run the full frontend unit suite**

Run: `cd frontend && npm run type-check && npx vitest run`
Expected: no type errors, all unit tests pass (including the pre-existing `CongestionCard`/`PredictionChart`/`useCongestionStream` suites — unaffected by this task).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/DailyLogTable.tsx frontend/tests/DailyLogTable.test.tsx
git commit -m "feat(fe): add DailyLogTable component"
```

---

### Task 6: Frontend — wire `DailyLogTable` into `App`

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/e2e/congestion.spec.ts`

**Interfaces:**
- Consumes: `DailyLogTable` (Task 5, no props needed)
- Produces: nothing new — final wiring step

- [ ] **Step 1: Render the table below the card**

In `frontend/src/App.tsx`, add the import and render it directly below `<CongestionCard ... />`:

```tsx
import { DailyLogTable } from "./components/DailyLogTable";
```

```tsx
      <CongestionCard data={current} history={history} />
      <DailyLogTable />
      <PredictionChart prediction={prediction} />
```

(Insert the `DailyLogTable` import alongside the other component imports, and the `<DailyLogTable />` line immediately after `<CongestionCard .../>` as shown — matches the design's "바로 아래에 배치".)

- [ ] **Step 2: Update the e2e test to mock the new endpoint**

In `frontend/e2e/congestion.spec.ts`, add a route mock for `/congestion/daily` and assert a row from it is visible. Add this route registration alongside the existing ones (order among `page.route` calls doesn't matter, but keep it grouped with the others before `page.goto("/")`):

```typescript
  await page.route("**/congestion/daily*", (route) =>
    route.fulfill({
      json: [
        {
          observed_at: "2026-07-16T09:00:00",
          congest_level: "여유",
          population_min: 800,
          population_max: 1000,
          male_ppltn_rate: 51.8,
          female_ppltn_rate: 48.2,
          ppltn_rate_0: null,
          ppltn_rate_10: null,
          ppltn_rate_20: null,
          ppltn_rate_30: null,
          ppltn_rate_40: null,
          ppltn_rate_50: null,
          ppltn_rate_60: null,
          ppltn_rate_70: null,
          resnt_ppltn_rate: 45.1,
          non_resnt_ppltn_rate: 54.9,
        },
      ],
    })
  );
```

And add this assertion after the existing ones at the end of the test:

```typescript
  await expect(page.getByText("09:00")).toBeVisible();
```

- [ ] **Step 3: Type-check and run unit tests**

Run: `cd frontend && npm run type-check && npx vitest run`
Expected: no type errors, all unit tests pass.

- [ ] **Step 4: Run the e2e test**

Run: `cd frontend && npx playwright test`
Expected: PASS, including the new row assertion.

- [ ] **Step 5: Manual check in the browser**

Start both servers if not already running (`cd backend && .venv/bin/uvicorn app.main:app --port 8000`, `cd frontend && npm run dev`) and open `http://localhost:5173`. Confirm:
- A table renders below the congestion card, with rows for today (may be few/none depending on how much new-schema data has been collected since Task 2's migration ran — that's expected, not a bug)
- Rows collected *before* Task 2's migration show blank cells for the 12 new columns, not errors
- Clicking "이전 날짜" moves to yesterday and the table updates; "다음 날짜" is disabled while viewing today

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.tsx frontend/e2e/congestion.spec.ts
git commit -m "feat(fe): wire DailyLogTable into App"
```
