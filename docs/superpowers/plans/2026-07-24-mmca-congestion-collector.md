# MMCA 서울관 혼잡도 수집 파이프라인 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MMCA(국립현대미술관) 서울관 8개 전시실의 혼잡도를 6분 간격, 영업시간 중에만 수집해 DB에 적재하는 백엔드 파이프라인을 만든다.

**Architecture:** 기존 서울시 API 파이프라인(`app/seoul_api.py` → `app/collector.py` → `app/scheduler.py`)과 동일한 3계층 패턴을 새 파일/함수로 반복한다. 완전히 별도 API 클라이언트, 별도 DB 테이블, 별도 스케줄러 job으로 분리하고 기존 국립중앙박물관 경로는 건드리지 않는다. 프론트엔드/예측/캐싱은 이번 범위에 없음 — 데이터 축적만.

**Tech Stack:** 기존과 동일 (FastAPI, SQLAlchemy, APScheduler, httpx, pytest). 새 의존성 없음.

## Global Constraints

- Base URL: `https://apis.data.go.kr/1371033/mmcadensity`, 엔드포인트: `GET /congestion`, 파라미터: `serviceKey`, `spaceCode`
- 응답 스키마: `{ resultCode, resultMsg, totalCount, data: { congestionNm, agncNm, spaceNm } }` — `data`가 비어 있거나 필드가 없을 수 있음(전시 2개 미만일 때)
- API는 타임스탬프를 주지 않으므로 `observed_at`은 수집 시각(`datetime.now()`)으로 기록
- 폴링 대상: 서울관 8개 전시실 고정 — `MMCA-SPACE-1001` ~ `MMCA-SPACE-1008`
- 영업시간(서울관): 월·화·목·금·일 10:00–18:00, 수·토 10:00–21:00 (양 끝 포함)
- 폴링 주기: 6분 (요일 구분 없이 고정 상수) — 5분이면 수/토에 1,056건/일로 개발계정 한도(1,000건/일)를 넘김
- 영업시간이 아니면 API를 호출하지 않고 즉시 반환 (트래픽 미소모)
- 방 하나가 실패해도 나머지 방은 계속 수집 (개별 try/except, 전체를 막지 않음)
- 새 DB 테이블은 `Base.metadata.create_all()`이 앱 기동 시 자동 생성하므로 마이그레이션 스크립트 불필요 (기존 컬럼 추가와 다름 — 새 테이블이라 ALTER 불필요)

---

## File Structure

- Create: `backend/app/mmca_api.py` — API 클라이언트 (요청/응답 파싱)
- Create: `backend/tests/test_mmca_api.py`
- Modify: `backend/app/models.py` — `RawMmcaCongestion` 테이블 추가
- Modify: `backend/tests/test_db_models.py` — round-trip 테스트 추가
- Modify: `backend/app/config.py` — `mmca_api_key`, `mmca_space_codes` 설정 추가
- Modify: `backend/.env.example` — `MMCA_API_KEY` 예시 추가
- Modify: `backend/tests/test_config.py` — 새 설정값 테스트 추가
- Modify: `backend/app/collector.py` — 영업시간 게이트 + `collect_mmca_once()` 추가
- Modify: `backend/tests/test_collector.py` — 새 수집 함수 테스트 추가
- Modify: `backend/app/scheduler.py` — 새 job 등록
- Modify: `backend/tests/test_scheduler.py` — job_ids 집합에 새 job 반영

---

### Task 1: MMCA API 클라이언트

**Files:**
- Create: `backend/app/mmca_api.py`
- Test: `backend/tests/test_mmca_api.py`

**Interfaces:**
- Produces: `MmcaCongestionReading` dataclass (`observed_at: datetime`, `space_code: str`, `space_nm: str | None`, `agnc_nm: str | None`, `congestion_nm: str | None`, `raw_response: str | None`)
- Produces: `fetch_congestion(client: httpx.Client, space_code: str, api_key: str) -> MmcaCongestionReading`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_mmca_api.py
import json
from datetime import datetime

import httpx

from app.mmca_api import fetch_congestion


def test_fetch_congestion_parses_response():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["spaceCode"] == "MMCA-SPACE-1001"
        assert request.url.params["serviceKey"] == "test-key"
        return httpx.Response(
            200,
            json={
                "resultCode": "00",
                "resultMsg": "NORMAL SERVICE",
                "totalCount": 1,
                "data": {
                    "congestionNm": "보통",
                    "agncNm": "국립현대미술관 서울관",
                    "spaceNm": "1전시실",
                },
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    before = datetime.now()

    reading = fetch_congestion(client, "MMCA-SPACE-1001", "test-key")

    assert reading.space_code == "MMCA-SPACE-1001"
    assert reading.congestion_nm == "보통"
    assert reading.agnc_nm == "국립현대미술관 서울관"
    assert reading.space_nm == "1전시실"
    assert before <= reading.observed_at <= datetime.now()
    assert json.loads(reading.raw_response)["data"]["congestionNm"] == "보통"


def test_fetch_congestion_handles_empty_data():
    """Fewer than 2 concurrent exhibitions: data comes back empty, not an error."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"resultCode": "00", "resultMsg": "NORMAL SERVICE", "totalCount": 0, "data": {}},
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))

    reading = fetch_congestion(client, "MMCA-SPACE-1003", "test-key")

    assert reading.congestion_nm is None
    assert reading.space_nm is None
    assert reading.agnc_nm is None


def test_fetch_congestion_handles_null_data():
    """Some data.go.kr responses use null instead of {} for an empty result."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"resultCode": "00", "resultMsg": "NORMAL SERVICE", "totalCount": 0, "data": None},
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))

    reading = fetch_congestion(client, "MMCA-SPACE-1003", "test-key")

    assert reading.congestion_nm is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_mmca_api.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.mmca_api'`

- [ ] **Step 3: Write the implementation**

```python
# backend/app/mmca_api.py
from dataclasses import dataclass
from datetime import datetime

import httpx

BASE_URL = "https://apis.data.go.kr/1371033/mmcadensity"


@dataclass
class MmcaCongestionReading:
    observed_at: datetime
    space_code: str
    space_nm: str | None
    agnc_nm: str | None
    congestion_nm: str | None
    # Full /congestion response body, verbatim, same rationale as
    # CongestionReading.raw_response in seoul_api.py.
    raw_response: str | None = None


def fetch_congestion(client: httpx.Client, space_code: str, api_key: str) -> MmcaCongestionReading:
    # ponytail: passing the key through httpx's `params` (which percent-encodes
    # it) assumes the "decoding" form of the data.go.kr service key. If real
    # calls 401 once a live key is wired in, try passing the already-encoded
    # key directly in the URL instead — known data.go.kr gotcha.
    response = client.get(
        f"{BASE_URL}/congestion",
        params={"serviceKey": api_key, "spaceCode": space_code},
        timeout=10.0,
    )
    response.raise_for_status()
    body = response.json()
    data = body.get("data") or {}

    return MmcaCongestionReading(
        observed_at=datetime.now(),
        space_code=space_code,
        space_nm=data.get("spaceNm"),
        agnc_nm=data.get("agncNm"),
        congestion_nm=data.get("congestionNm"),
        raw_response=response.text,
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_mmca_api.py -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
cd backend && git add app/mmca_api.py tests/test_mmca_api.py
git commit -m "feat(be): add MMCA congestion API client"
```

---

### Task 2: DB 모델

**Files:**
- Modify: `backend/app/models.py`
- Modify: `backend/tests/test_db_models.py`

**Interfaces:**
- Consumes: nothing from Task 1 directly (models stay decoupled from the API client's dataclass)
- Produces: `RawMmcaCongestion` ORM model (`id`, `observed_at`, `space_code`, `space_nm`, `agnc_nm`, `congestion_nm`, `raw_response`) mapped to table `raw_mmca_congestion`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_db_models.py`:

```python
from app.models import RawMmcaCongestion


def test_raw_mmca_congestion_round_trip():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    with Session() as session:
        row = RawMmcaCongestion(
            observed_at=datetime(2026, 7, 25, 14, 30),
            space_code="MMCA-SPACE-1001",
            space_nm="1전시실",
            agnc_nm="국립현대미술관 서울관",
            congestion_nm="보통",
            raw_response='{"data": {"congestionNm": "보통"}}',
        )
        session.add(row)
        session.commit()

        fetched = session.query(RawMmcaCongestion).one()
        assert fetched.space_code == "MMCA-SPACE-1001"
        assert fetched.congestion_nm == "보통"


def test_raw_mmca_congestion_allows_null_congestion():
    """Fewer than 2 concurrent exhibitions: congestion_nm is legitimately absent."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    with Session() as session:
        row = RawMmcaCongestion(
            observed_at=datetime(2026, 7, 24, 14, 30),
            space_code="MMCA-SPACE-1003",
            space_nm=None,
            agnc_nm=None,
            congestion_nm=None,
        )
        session.add(row)
        session.commit()

        fetched = session.query(RawMmcaCongestion).one()
        assert fetched.congestion_nm is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_db_models.py -v -k mmca`
Expected: FAIL with `ImportError: cannot import name 'RawMmcaCongestion'`

- [ ] **Step 3: Write the implementation**

Append to `backend/app/models.py`:

```python
class RawMmcaCongestion(Base):
    __tablename__ = "raw_mmca_congestion"

    id: Mapped[int] = mapped_column(primary_key=True)
    observed_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    space_code: Mapped[str] = mapped_column(String, index=True)
    space_nm: Mapped[str | None] = mapped_column(String, nullable=True)
    agnc_nm: Mapped[str | None] = mapped_column(String, nullable=True)
    congestion_nm: Mapped[str | None] = mapped_column(String, nullable=True)
    # Full /congestion response body, verbatim — same deferred-load rationale
    # as RawCongestion.raw_response.
    raw_response: Mapped[str | None] = mapped_column(Text, nullable=True, deferred=True)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_db_models.py -v`
Expected: all passed (existing `RawCongestion` tests + 2 new ones)

- [ ] **Step 5: Commit**

```bash
cd backend && git add app/models.py tests/test_db_models.py
git commit -m "feat(be): add raw_mmca_congestion table"
```

---

### Task 3: 설정값

**Files:**
- Modify: `backend/app/config.py`
- Modify: `backend/.env.example`
- Modify: `backend/tests/test_config.py`

**Interfaces:**
- Produces: `settings.mmca_api_key: str`, `settings.mmca_space_codes: list[str]` (default: the 8 서울관 codes)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_config.py`:

```python
def test_settings_reads_mmca_env(monkeypatch):
    monkeypatch.setenv("SEOUL_API_KEY", "test-key")
    monkeypatch.setenv("MMCA_API_KEY", "mmca-test-key")
    monkeypatch.setenv("DATABASE_URL", "sqlite:///:memory:")
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/1")

    from app.config import Settings
    settings = Settings()

    assert settings.mmca_api_key == "mmca-test-key"
    assert settings.mmca_space_codes == [
        "MMCA-SPACE-1001",
        "MMCA-SPACE-1002",
        "MMCA-SPACE-1003",
        "MMCA-SPACE-1004",
        "MMCA-SPACE-1005",
        "MMCA-SPACE-1006",
        "MMCA-SPACE-1007",
        "MMCA-SPACE-1008",
    ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_config.py -v -k mmca`
Expected: FAIL — `pydantic_core.ValidationError` (missing required field `mmca_api_key`)

- [ ] **Step 3: Write the implementation**

Edit `backend/app/config.py`:

```python
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    seoul_api_key: str
    seoul_area_name: str = "국립중앙박물관·용산가족공원"
    mmca_api_key: str
    mmca_space_codes: list[str] = [f"MMCA-SPACE-100{i}" for i in range(1, 9)]
    database_url: str = "sqlite:///./congestion.db"
    redis_url: str = "redis://localhost:6379/0"

    model_config = SettingsConfigDict(env_file=".env")


settings = Settings()
```

Edit `backend/.env.example`:

```
SEOUL_API_KEY=your-seoul-open-data-api-key
MMCA_API_KEY=your-data-go-kr-mmca-congestion-api-key
DATABASE_URL=sqlite:///./congestion.db
REDIS_URL=redis://localhost:6379/0
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_config.py -v`
Expected: all passed

Note: this makes `mmca_api_key` a required setting, so `backend/.env` (the real local env file, not `.env.example`) needs a value too — even a placeholder — or every other test/app startup that constructs `Settings()` from the real `.env` will now fail. Add a placeholder line to `backend/.env` if one isn't already there (this file is gitignored, not committed).

- [ ] **Step 5: Commit**

```bash
cd backend && git add app/config.py .env.example tests/test_config.py
git commit -m "feat(be): add MMCA API key and space code settings"
```

---

### Task 4: 수집기 (영업시간 게이트 + collect_mmca_once)

**Files:**
- Modify: `backend/app/collector.py`
- Modify: `backend/tests/test_collector.py`

**Interfaces:**
- Consumes: `MmcaCongestionReading`, `fetch_congestion` from `app.mmca_api` (Task 1); `RawMmcaCongestion` from `app.models` (Task 2); `settings.mmca_api_key`, `settings.mmca_space_codes` from `app.config` (Task 3)
- Produces: `_is_seoul_branch_open(now: datetime) -> bool`; `collect_mmca_once(session_factory=SessionLocal, now: datetime | None = None) -> list[MmcaCongestionReading]`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_collector.py`:

```python
from datetime import datetime

from app.mmca_api import MmcaCongestionReading
from app.models import RawMmcaCongestion


def test_is_seoul_branch_open_normal_day_within_hours():
    from app.collector import _is_seoul_branch_open

    # 2026-07-27 is a Monday
    assert _is_seoul_branch_open(datetime(2026, 7, 27, 10, 0)) is True
    assert _is_seoul_branch_open(datetime(2026, 7, 27, 18, 0)) is True
    assert _is_seoul_branch_open(datetime(2026, 7, 27, 18, 1)) is False
    assert _is_seoul_branch_open(datetime(2026, 7, 27, 9, 59)) is False


def test_is_seoul_branch_open_long_day():
    from app.collector import _is_seoul_branch_open

    # 2026-07-29 is a Wednesday
    assert _is_seoul_branch_open(datetime(2026, 7, 29, 20, 0)) is True
    assert _is_seoul_branch_open(datetime(2026, 7, 29, 21, 0)) is True
    assert _is_seoul_branch_open(datetime(2026, 7, 29, 21, 1)) is False


def test_collect_mmca_once_skips_api_call_when_closed(monkeypatch, session_factory):
    import app.collector as collector_module

    call_count = 0

    def fake_fetch(client, space_code, api_key):
        nonlocal call_count
        call_count += 1
        raise AssertionError("should not be called outside business hours")

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)

    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 8, 0)
    )

    assert result == []
    assert call_count == 0
    with session_factory() as session:
        assert session.query(RawMmcaCongestion).count() == 0


def test_collect_mmca_once_fetches_all_rooms_when_open(monkeypatch, session_factory):
    import app.collector as collector_module

    def fake_fetch(client, space_code, api_key):
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 27, 14, 0),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="국립현대미술관 서울관",
            congestion_nm="보통",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings, "mmca_space_codes", ["MMCA-SPACE-1001", "MMCA-SPACE-1002"]
    )

    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 14, 0)
    )

    assert len(result) == 2
    with session_factory() as session:
        assert session.query(RawMmcaCongestion).count() == 2


def test_collect_mmca_once_continues_after_one_room_fails(monkeypatch, session_factory):
    import app.collector as collector_module

    def fake_fetch(client, space_code, api_key):
        if space_code == "MMCA-SPACE-1001":
            raise httpx.HTTPError("boom")
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 27, 14, 0),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="국립현대미술관 서울관",
            congestion_nm="여유",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings, "mmca_space_codes", ["MMCA-SPACE-1001", "MMCA-SPACE-1002"]
    )

    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 14, 0)
    )

    assert len(result) == 1
    assert result[0].space_code == "MMCA-SPACE-1002"
    with session_factory() as session:
        assert session.query(RawMmcaCongestion).count() == 1
```

`httpx` is already imported at the top of `test_collector.py` from the existing Seoul-API tests.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_collector.py -v -k mmca`
Expected: FAIL with `ImportError` / `AttributeError: module 'app.collector' has no attribute '_is_seoul_branch_open'`

- [ ] **Step 3: Write the implementation**

Append to `backend/app/collector.py` (add these imports to the existing import block at the top, and the new code below the existing `collect_once`):

```python
import logging
from datetime import datetime, time

from app.mmca_api import MmcaCongestionReading, fetch_congestion as fetch_mmca_congestion
from app.models import RawMmcaCongestion

logger = logging.getLogger(__name__)

_SEOUL_BRANCH_OPEN = time(10, 0)
_SEOUL_BRANCH_NORMAL_CLOSE = time(18, 0)
_SEOUL_BRANCH_LONG_CLOSE = time(21, 0)
_LONG_DAYS = {2, 5}  # datetime.weekday(): Mon=0 ... 수=2, 토=5


def _is_seoul_branch_open(now: datetime) -> bool:
    close = _SEOUL_BRANCH_LONG_CLOSE if now.weekday() in _LONG_DAYS else _SEOUL_BRANCH_NORMAL_CLOSE
    return _SEOUL_BRANCH_OPEN <= now.time() <= close


def collect_mmca_once(session_factory=SessionLocal, now: datetime | None = None) -> list[MmcaCongestionReading]:
    now = now or datetime.now()
    if not _is_seoul_branch_open(now):
        return []

    readings: list[MmcaCongestionReading] = []
    with httpx.Client() as client:
        for space_code in settings.mmca_space_codes:
            try:
                readings.append(fetch_mmca_congestion(client, space_code, settings.mmca_api_key))
            except httpx.HTTPError:
                logger.warning("MMCA fetch failed for %s", space_code)

    with session_factory() as session:
        for reading in readings:
            session.add(
                RawMmcaCongestion(
                    observed_at=reading.observed_at,
                    space_code=reading.space_code,
                    space_nm=reading.space_nm,
                    agnc_nm=reading.agnc_nm,
                    congestion_nm=reading.congestion_nm,
                    raw_response=reading.raw_response,
                )
            )
        session.commit()

    return readings
```

Note: `httpx` and `SessionLocal` are already imported at the top of `collector.py` from the existing Seoul-API collector — don't duplicate those imports, only add the ones shown above that are new (`logging`, `datetime`/`time`, `settings`, the MMCA API/model imports).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_collector.py -v`
Expected: all passed (existing Seoul-API collector tests + 5 new MMCA ones)

- [ ] **Step 5: Commit**

```bash
cd backend && git add app/collector.py tests/test_collector.py
git commit -m "feat(be): collect MMCA congestion during Seoul-branch business hours"
```

---

### Task 5: 스케줄러 등록

**Files:**
- Modify: `backend/app/scheduler.py`
- Modify: `backend/tests/test_scheduler.py`

**Interfaces:**
- Consumes: `collect_mmca_once` from `app.collector` (Task 4)
- Produces: scheduler job `id="collect_mmca_congestion"`, `IntervalTrigger(minutes=6)`

- [ ] **Step 1: Write the failing test**

Edit `backend/tests/test_scheduler.py`:

```python
def test_build_scheduler_registers_expected_jobs():
    from app.scheduler import build_scheduler

    scheduler = build_scheduler()
    job_ids = {job.id for job in scheduler.get_jobs()}

    assert job_ids == {"collect_congestion", "collect_mmca_congestion", "daily_batch"}
```

(This replaces the existing assertion in that test — same test name, updated expected set.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_scheduler.py -v -k registers_expected_jobs`
Expected: FAIL — `assert {'collect_congestion', 'daily_batch'} == {'collect_congestion', 'collect_mmca_congestion', 'daily_batch'}`

- [ ] **Step 3: Write the implementation**

Edit `backend/app/scheduler.py`:

```python
from app.collector import collect_once, collect_mmca_once
from app.prediction.batch import run_daily_batch

# ... (keep existing imports/logger/_log_job_error as-is)

def build_scheduler() -> BackgroundScheduler:
    scheduler = BackgroundScheduler()
    scheduler.add_job(
        collect_once,
        trigger=IntervalTrigger(minutes=5),
        id="collect_congestion",
        misfire_grace_time=60,
    )
    scheduler.add_job(
        collect_mmca_once,
        trigger=IntervalTrigger(minutes=6),
        id="collect_mmca_congestion",
        misfire_grace_time=60,
    )
    scheduler.add_job(
        run_daily_batch,
        trigger=CronTrigger(hour=3, minute=0),
        id="daily_batch",
        misfire_grace_time=3600,
    )
    scheduler.add_listener(_log_job_error, EVENT_JOB_ERROR)
    return scheduler
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_scheduler.py -v`
Expected: all passed

- [ ] **Step 5: Run the full backend test suite**

Run: `cd backend && .venv/bin/pytest -v`
Expected: all passed, no regressions in the existing Seoul-API/prediction/route tests

- [ ] **Step 6: Commit**

```bash
cd backend && git add app/scheduler.py tests/test_scheduler.py
git commit -m "feat(be): schedule MMCA congestion collection every 6 minutes"
```

---

## Post-plan note (not a task — informational)

`deploy/deploy.sh` does not need a new migration line for this feature: `raw_mmca_congestion` is a brand-new table, and `init_db()` (called from `app/main.py` on every startup) already runs `Base.metadata.create_all()`, which creates missing tables automatically. The existing migration scripts (`migrate_add_raw_response.py`, `migrate_add_population_fields.py`) exist only because SQLite's `create_all()` can't add columns to a table that already exists — that problem doesn't apply here.

Production's real `MMCA_API_KEY` still needs to be added to the server's `.env` before deploying this branch, or `Settings()` will fail to construct at startup (it's a required field, same as `SEOUL_API_KEY`).
