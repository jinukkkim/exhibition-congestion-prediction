# MMCA 과천관 추가 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MMCA 과천관 8개 전시실을 수집 파이프라인·API·프론트엔드에 추가해 서울관과 나란히 조회할 수 있게 한다.

**Architecture:** 백엔드 설정(`app/config.py`)에 관(venue)별 space_code 딕셔너리를 단일 소스로 두고, 수집기는 전체 관의 합집합을 폴링, `GET /mmca/rooms`는 `venue` 쿼리파라미터로 관별 필터링한다. 프론트엔드는 기존 `MmcaPage`를 `venue`/`title` prop을 받는 재사용 컴포넌트로 일반화하고, `App.tsx`에 라우트 하나(`/venues/mmca-gwacheon`)를 추가한다.

**Tech Stack:** 기존과 동일 — FastAPI, SQLAlchemy, pytest / React, Vite, TypeScript, Vitest, Playwright. 신규 의존성 없음.

## Global Constraints

- 과천관 8개 전시실만 추가한다 — 청주관·덕수궁관은 이번 범위 아님(사용자가 명시적으로 과천만 요청). **(→ 같은 PR 내 후속 작업으로 덕수궁관 1개실이 추가됨, 설계 문서 §7 참고)**
- 폴링 간격을 6분 → 12분으로 변경한다 — 16실(서울 8 + 과천 8)이 공공데이터포털 1,000건/일 한도를 넘지 않도록.
- 관별 space_code 목록은 `app/config.py`의 `mmca_venue_space_codes` 딕셔너리가 유일한 소스다 — 수집기·API 라우트 모두 이 값을 참조하고, 다른 곳에 하드코딩하지 않는다.
- `GET /mmca/rooms`는 `agnc_nm` DB 컬럼을 필터 기준으로 쓰지 않는다 — 전시가 없는 방은 `agnc_nm`이 `null`로 저장되어 관별 목록에서 누락되기 때문.
- 새 페이지 컴포넌트 파일은 만들지 않는다 — 기존 `MmcaPage.tsx`를 `venue`/`title` prop으로 파라미터화해서 서울·과천 둘 다 재사용한다.

---

## File Structure

```
backend/
  app/
    config.py           # Modify: mmca_space_codes(list) → mmca_venue_space_codes(dict)
    collector.py         # Modify: collect_mmca_once가 전체 관 코드 순회
    scheduler.py          # Modify: collect_mmca_congestion job interval 6→12분
    routes/mmca.py        # Modify: venue 쿼리파라미터로 필터링
  tests/
    test_config.py        # Modify
    test_collector.py      # Modify
    test_scheduler.py      # Modify
    test_routes_mmca.py    # Modify

frontend/
  src/
    api/mmca.ts            # Modify: fetchMmcaRooms(venue)
    pages/MmcaPage.tsx      # Modify: venue/title prop 수용
    venues.ts               # Modify: 과천 항목 추가, 서울 이름 disambiguate
    App.tsx                  # Modify: mmca-gwacheon 라우트 추가
  tests/
    MmcaPage.test.tsx        # Modify
    HomePage.test.tsx         # Modify
  e2e/
    congestion.spec.ts        # Modify
```

새로 생성하는 파일 없음 — 전부 기존 파일 수정.

---

### Task 1: 백엔드 설정 — 관별 space_code 딕셔너리

**Files:**
- Modify: `backend/app/config.py`
- Test: `backend/tests/test_config.py`

**Interfaces:**
- Produces: `settings.mmca_venue_space_codes: dict[str, list[str]]` — key는 `"seoul"`/`"gwacheon"`, value는 각 관의 `MMCA-SPACE-*` 코드 8개. 이후 모든 태스크가 이 이름/타입을 참조한다. 기존 `settings.mmca_space_codes`(list)는 이 태스크에서 삭제된다.

- [ ] **Step 1: 실패하는 테스트로 수정**

`backend/tests/test_config.py`의 `test_settings_reads_mmca_env`를 다음으로 전체 교체:

```python
def test_settings_reads_mmca_env(monkeypatch):
    monkeypatch.setenv("SEOUL_API_KEY", "test-key")
    monkeypatch.setenv("MMCA_API_KEY", "mmca-test-key")
    monkeypatch.setenv("DATABASE_URL", "sqlite:///:memory:")
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/1")

    from app.config import Settings
    settings = Settings()

    assert settings.mmca_api_key == "mmca-test-key"
    assert settings.mmca_venue_space_codes == {
        "seoul": [
            "MMCA-SPACE-1001",
            "MMCA-SPACE-1002",
            "MMCA-SPACE-1003",
            "MMCA-SPACE-1004",
            "MMCA-SPACE-1005",
            "MMCA-SPACE-1006",
            "MMCA-SPACE-1007",
            "MMCA-SPACE-1008",
        ],
        "gwacheon": [
            "MMCA-SPACE-2001",
            "MMCA-SPACE-2002",
            "MMCA-SPACE-2003",
            "MMCA-SPACE-2004",
            "MMCA-SPACE-2005",
            "MMCA-SPACE-2006",
            "MMCA-SPACE-2007",
            "MMCA-SPACE-2008",
        ],
    }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && .venv/bin/pytest tests/test_config.py::test_settings_reads_mmca_env -v`
Expected: FAIL — `AttributeError: 'Settings' object has no attribute 'mmca_venue_space_codes'`

- [ ] **Step 3: 최소 구현**

`backend/app/config.py` 8번째 줄 교체:

```python
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    seoul_api_key: str
    seoul_area_name: str = "국립중앙박물관·용산가족공원"
    mmca_api_key: str
    mmca_venue_space_codes: dict[str, list[str]] = {
        "seoul": [f"MMCA-SPACE-100{i}" for i in range(1, 9)],
        "gwacheon": [f"MMCA-SPACE-200{i}" for i in range(1, 9)],
    }
    database_url: str = "sqlite:///./congestion.db"
    redis_url: str = "redis://localhost:6379/0"

    model_config = SettingsConfigDict(env_file=".env")


settings = Settings()
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && .venv/bin/pytest tests/test_config.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/config.py backend/tests/test_config.py
git commit -m "feat(be): add Gwacheon branch to MMCA venue space code config"
```

---

### Task 2: 백엔드 수집기 — 전체 관 코드 순회

**Files:**
- Modify: `backend/app/collector.py`
- Test: `backend/tests/test_collector.py`

**Interfaces:**
- Consumes: `settings.mmca_venue_space_codes: dict[str, list[str]]` (Task 1에서 정의)
- Produces: `collect_mmca_once`의 동작은 변경 없음(시그니처 동일) — 다만 이제 두 관 코드를 합쳐서 순회한다.

- [ ] **Step 1: 실패하는 테스트로 수정**

`backend/tests/test_collector.py`에서 기존 3개 테스트가 `monkeypatch.setattr(collector_module.settings, "mmca_space_codes", [...])`를 쓰고 있다. 이 3곳을 모두 다음처럼 교체(각 테스트 함수 내부, 동일한 자리):

```python
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {"seoul": ["MMCA-SPACE-1001", "MMCA-SPACE-1002"]},
    )
```

(`test_collect_mmca_once_fetches_all_rooms_when_open`, `test_collect_mmca_once_continues_after_one_room_fails`, `test_collect_mmca_once_continues_after_one_room_returns_invalid_json` 세 곳 모두 동일하게 교체.)

그리고 파일 끝에 새 테스트를 추가:

```python
def test_collect_mmca_once_fetches_rooms_from_every_venue(monkeypatch, session_factory):
    import app.collector as collector_module

    seen_codes = []

    def fake_fetch(client, space_code, api_key):
        seen_codes.append(space_code)
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 27, 14, 0),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="테스트관",
            congestion_nm="보통",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {
            "seoul": ["MMCA-SPACE-1001"],
            "gwacheon": ["MMCA-SPACE-2001"],
        },
    )

    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 14, 0)
    )

    assert len(result) == 2
    assert set(seen_codes) == {"MMCA-SPACE-1001", "MMCA-SPACE-2001"}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && .venv/bin/pytest tests/test_collector.py -k mmca -v`
Expected: FAIL — `AttributeError: 'Settings' object has no attribute 'mmca_venue_space_codes'` (기존 3개 테스트도 이 시점엔 함께 실패)

- [ ] **Step 3: 최소 구현**

`backend/app/collector.py`의 `collect_mmca_once` 함수(62~94번째 줄) 교체:

```python
def collect_mmca_once(session_factory=SessionLocal, now: datetime | None = None) -> list[MmcaCongestionReading]:
    # Server local time isn't guaranteed to be KST (e.g. a UTC container), so
    # pin explicitly to Asia/Seoul instead of a naive datetime.now().
    now = now or datetime.now(_SEOUL_TZ).replace(tzinfo=None)
    if not _is_seoul_branch_open(now):
        return []

    space_codes = [
        space_code
        for codes in settings.mmca_venue_space_codes.values()
        for space_code in codes
    ]

    readings: list[MmcaCongestionReading] = []
    with httpx.Client() as client:
        for space_code in space_codes:
            try:
                readings.append(fetch_mmca_congestion(client, space_code, settings.mmca_api_key))
            except (httpx.HTTPError, json.JSONDecodeError):
                # data.go.kr can return a non-JSON (e.g. XML error) body with a
                # 200 status on key/quota errors — response.json() then raises
                # JSONDecodeError, not HTTPError. Isolate it per-room the same way.
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

(함수 시작 전 `_is_seoul_branch_open` 등 나머지 코드는 그대로 둔다.)

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && .venv/bin/pytest tests/test_collector.py -v`
Expected: PASS (전체)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/collector.py backend/tests/test_collector.py
git commit -m "feat(be): poll every MMCA venue's rooms in collect_mmca_once"
```

---

### Task 3: 백엔드 라우트 — venue 쿼리파라미터 필터링

**Files:**
- Modify: `backend/app/routes/mmca.py`
- Test: `backend/tests/test_routes_mmca.py`

**Interfaces:**
- Consumes: `settings.mmca_venue_space_codes: dict[str, list[str]]` (Task 1)
- Produces: `GET /mmca/rooms?venue=<seoul|gwacheon>` — `venue` 필수 쿼리파라미터. 알 수 없는 값이면 400. 응답 스키마(`MmcaRoomStatus`)는 변경 없음.

- [ ] **Step 1: 실패하는 테스트로 수정**

`backend/tests/test_routes_mmca.py`를 다음으로 전체 교체:

```python
from datetime import datetime

import fakeredis
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base
from app.models import RawMmcaCongestion


@pytest.fixture(autouse=True)
def fake_redis(monkeypatch):
    import app.cache as cache_module

    monkeypatch.setattr(cache_module, "r", fakeredis.FakeRedis(decode_responses=True))


@pytest.fixture
def client(monkeypatch):
    from app.main import app
    import app.routes.mmca as mmca_routes

    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine)
    monkeypatch.setattr(mmca_routes, "SessionLocal", session_factory)

    return TestClient(app), session_factory


def test_mmca_rooms_returns_503_when_no_data(client):
    test_client, _ = client
    response = test_client.get("/mmca/rooms?venue=seoul")
    assert response.status_code == 503


def test_mmca_rooms_returns_400_for_unknown_venue(client):
    test_client, _ = client
    response = test_client.get("/mmca/rooms?venue=busan")
    assert response.status_code == 400


def test_mmca_rooms_returns_latest_reading_per_room(client):
    test_client, session_factory = client

    with session_factory() as session:
        session.add_all(
            [
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 24, 10, 0),
                    space_code="MMCA-SPACE-1001",
                    space_nm="1전시실",
                    agnc_nm="국립현대미술관",
                    congestion_nm="여유",
                ),
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 24, 10, 6),
                    space_code="MMCA-SPACE-1001",
                    space_nm="1전시실",
                    agnc_nm="국립현대미술관",
                    congestion_nm="보통",
                ),
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 24, 10, 6),
                    space_code="MMCA-SPACE-1002",
                    space_nm="2전시실",
                    agnc_nm="국립현대미술관",
                    congestion_nm=None,
                ),
            ]
        )
        session.commit()

    response = test_client.get("/mmca/rooms?venue=seoul")
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 2

    room1 = next(r for r in body if r["space_code"] == "MMCA-SPACE-1001")
    assert room1["congestion_nm"] == "보통"
    assert room1["space_nm"] == "1전시실"

    room2 = next(r for r in body if r["space_code"] == "MMCA-SPACE-1002")
    assert room2["congestion_nm"] is None


def test_mmca_rooms_filters_by_venue(client):
    test_client, session_factory = client

    with session_factory() as session:
        session.add_all(
            [
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 25, 10, 0),
                    space_code="MMCA-SPACE-1001",
                    space_nm="1전시실",
                    agnc_nm="서울",
                    congestion_nm="여유",
                ),
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 25, 10, 0),
                    space_code="MMCA-SPACE-2001",
                    space_nm="1전시실",
                    agnc_nm="과천",
                    congestion_nm="보통",
                ),
            ]
        )
        session.commit()

    seoul_response = test_client.get("/mmca/rooms?venue=seoul")
    assert seoul_response.status_code == 200
    seoul_codes = {r["space_code"] for r in seoul_response.json()}
    assert seoul_codes == {"MMCA-SPACE-1001"}

    gwacheon_response = test_client.get("/mmca/rooms?venue=gwacheon")
    assert gwacheon_response.status_code == 200
    gwacheon_codes = {r["space_code"] for r in gwacheon_response.json()}
    assert gwacheon_codes == {"MMCA-SPACE-2001"}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && .venv/bin/pytest tests/test_routes_mmca.py -v`
Expected: FAIL — 기존 라우트는 `venue` 파라미터를 받지 않으므로 `test_mmca_rooms_returns_400_for_unknown_venue`, `test_mmca_rooms_filters_by_venue`가 실패(400 대신 200/503, 관 구분 없이 전체 반환)

- [ ] **Step 3: 최소 구현**

`backend/app/routes/mmca.py` 전체 교체:

```python
from fastapi import APIRouter, HTTPException
from sqlalchemy import func

from app.config import settings
from app.db import SessionLocal
from app.models import RawMmcaCongestion
from app.schemas import MmcaRoomStatus

router = APIRouter()


@router.get("/mmca/rooms", response_model=list[MmcaRoomStatus])
def mmca_rooms(venue: str) -> list[MmcaRoomStatus]:
    codes = settings.mmca_venue_space_codes.get(venue)
    if codes is None:
        raise HTTPException(status_code=400, detail=f"unknown venue: {venue}")

    with SessionLocal() as session:
        latest_ids = [
            row[0]
            for row in session.query(func.max(RawMmcaCongestion.id))
            .filter(RawMmcaCongestion.space_code.in_(codes))
            .group_by(RawMmcaCongestion.space_code)
            .all()
        ]
        rows = (
            session.query(RawMmcaCongestion)
            .filter(RawMmcaCongestion.id.in_(latest_ids))
            .order_by(RawMmcaCongestion.space_code)
            .all()
        )

    if not rows:
        raise HTTPException(status_code=503, detail="no MMCA congestion data yet")

    return [
        MmcaRoomStatus(
            space_code=row.space_code,
            space_nm=row.space_nm,
            congestion_nm=row.congestion_nm,
            observed_at=row.observed_at.isoformat(),
        )
        for row in rows
    ]
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && .venv/bin/pytest tests/test_routes_mmca.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: 전체 백엔드 테스트 스위트 실행**

Run: `cd backend && .venv/bin/pytest -q`
Expected: 전체 PASS

- [ ] **Step 6: 커밋**

```bash
git add backend/app/routes/mmca.py backend/tests/test_routes_mmca.py
git commit -m "feat(be): filter GET /mmca/rooms by venue query param"
```

---

### Task 4: 백엔드 스케줄러 — 폴링 간격 12분

**Files:**
- Modify: `backend/app/scheduler.py`
- Test: `backend/tests/test_scheduler.py`

**Interfaces:**
- Produces: `collect_mmca_congestion` job이 `IntervalTrigger(minutes=12)`로 등록됨. 다른 job(`collect_congestion`, `daily_batch`)은 변경 없음.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_scheduler.py` 파일 끝에 추가:

```python
def test_collect_mmca_job_runs_every_12_minutes():
    from datetime import timedelta

    from app.scheduler import build_scheduler

    scheduler = build_scheduler()
    job = scheduler.get_job("collect_mmca_congestion")

    assert job.trigger.interval == timedelta(minutes=12)
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && .venv/bin/pytest tests/test_scheduler.py::test_collect_mmca_job_runs_every_12_minutes -v`
Expected: FAIL — `assert timedelta(minutes=6) == timedelta(minutes=12)`

- [ ] **Step 3: 최소 구현**

`backend/app/scheduler.py`의 `collect_mmca_congestion` job 등록부(30~35번째 줄) 교체:

```python
    scheduler.add_job(
        collect_mmca_once,
        trigger=IntervalTrigger(minutes=12),
        id="collect_mmca_congestion",
        misfire_grace_time=60,
    )
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && .venv/bin/pytest tests/test_scheduler.py -v`
Expected: PASS (전체)

- [ ] **Step 5: 전체 백엔드 테스트 스위트 실행**

Run: `cd backend && .venv/bin/pytest -q`
Expected: 전체 PASS

- [ ] **Step 6: 커밋**

```bash
git add backend/app/scheduler.py backend/tests/test_scheduler.py
git commit -m "fix(be): slow MMCA polling to 12 minutes for 16-room API quota"
```

---

### Task 5: 프론트엔드 — MmcaPage를 venue/title로 파라미터화

**Files:**
- Modify: `frontend/src/api/mmca.ts`
- Modify: `frontend/src/pages/MmcaPage.tsx`
- Test: `frontend/tests/MmcaPage.test.tsx`

**Interfaces:**
- Produces: `fetchMmcaRooms(venue: string): Promise<MmcaRoomStatus[]>` (기존엔 인자 없었음, breaking change) — `GET /mmca/rooms?venue=${venue}` 호출.
- Produces: `MmcaPage({ venue, title }: { venue: string; title: string })` — 기존엔 prop 없이 `<MmcaPage />`로 렌더링했음(Task 6에서 호출부를 고침).

- [ ] **Step 1: 실패하는 테스트로 수정**

`frontend/tests/MmcaPage.test.tsx` 전체 교체:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MmcaPage } from "../src/pages/MmcaPage";
import * as api from "../src/api/mmca";
import type { MmcaRoomStatus } from "../src/api/mmca";

function makeRoom(overrides: Partial<MmcaRoomStatus> = {}): MmcaRoomStatus {
  return {
    space_code: "MMCA-SPACE-1001",
    space_nm: "1전시실",
    congestion_nm: "여유",
    observed_at: "2026-07-24T10:00:00",
    ...overrides,
  };
}

describe("MmcaPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders a card per room after loading", async () => {
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([
      makeRoom(),
      makeRoom({ space_code: "MMCA-SPACE-1002", space_nm: "2전시실", congestion_nm: "보통" }),
    ]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("1전시실")).toBeInTheDocument());
    expect(screen.getByText("2전시실")).toBeInTheDocument();
  });

  it("shows an error message when the fetch fails before anything loads", async () => {
    vi.spyOn(api, "fetchMmcaRooms").mockRejectedValue(new Error("network error"));

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("불러오지 못했습니다.")).toBeInTheDocument());
  });

  it("polls again after 60 seconds", async () => {
    const fetchMmcaRooms = vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(fetchMmcaRooms).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMmcaRooms).toHaveBeenCalledTimes(2);
  });

  it("keeps showing stale data when a poll fails after an initial success", async () => {
    const fetchMmcaRooms = vi
      .spyOn(api, "fetchMmcaRooms")
      .mockResolvedValueOnce([makeRoom()])
      .mockRejectedValueOnce(new Error("network error"));

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("1전시실")).toBeInTheDocument());

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMmcaRooms).toHaveBeenCalledTimes(2);
    expect(screen.getByText("1전시실")).toBeInTheDocument();
    expect(screen.queryByText("불러오지 못했습니다.")).not.toBeInTheDocument();
  });

  it("stops polling and ignores in-flight responses after unmount", async () => {
    const fetchMmcaRooms = vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(fetchMmcaRooms).toHaveBeenCalledTimes(1));

    unmount();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMmcaRooms).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("fetches rooms for the venue prop and shows the title prop as heading", async () => {
    const fetchMmcaRooms = vi
      .spyOn(api, "fetchMmcaRooms")
      .mockResolvedValue([makeRoom({ space_code: "MMCA-SPACE-2001" })]);

    render(
      <MemoryRouter>
        <MmcaPage venue="gwacheon" title="국립현대미술관 과천관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(fetchMmcaRooms).toHaveBeenCalledWith("gwacheon"));
    expect(
      screen.getByRole("heading", { name: "국립현대미술관 과천관 혼잡도" })
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run tests/MmcaPage.test.tsx`
Expected: FAIL — TypeScript 에러(`venue`/`title`는 존재하지 않는 prop) 또는 런타임에서 `fetchMmcaRooms`가 인자 없이 호출됨

- [ ] **Step 3: 최소 구현**

`frontend/src/api/mmca.ts` 전체 교체:

```ts
export interface MmcaRoomStatus {
  space_code: string;
  space_nm: string | null;
  congestion_nm: string | null;
  observed_at: string;
}

export async function fetchMmcaRooms(venue: string): Promise<MmcaRoomStatus[]> {
  const res = await fetch(`/mmca/rooms?venue=${venue}`);
  if (!res.ok) {
    throw new Error(`failed to fetch MMCA rooms: ${res.status}`);
  }
  return res.json();
}
```

`frontend/src/pages/MmcaPage.tsx` 전체 교체:

```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { fetchMmcaRooms, type MmcaRoomStatus } from "../api/mmca";
import { RoomCongestionCard } from "../components/RoomCongestionCard";

const POLL_INTERVAL_MS = 60_000;

export function MmcaPage({ venue, title }: { venue: string; title: string }) {
  const [rooms, setRooms] = useState<MmcaRoomStatus[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let ignore = false;

    function load() {
      fetchMmcaRooms(venue)
        .then((data) => {
          if (ignore) return;
          setRooms(data);
          setError(false);
        })
        .catch(() => {
          if (!ignore) setError(true);
        });
    }

    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      ignore = true;
      clearInterval(timer);
    };
  }, [venue]);

  return (
    <div className="min-h-screen bg-canvas">
      <main className="mx-auto max-w-[1400px] px-6 py-16 sm:px-10 lg:px-16">
        <header className="mb-12 border-b border-hairline/70 pb-8">
          <Link
            to="/"
            className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-soft hover:text-accent"
          >
            ← 미술관 선택
          </Link>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            {title}
          </h1>
        </header>

        {rooms === null && !error && <p className="text-sm text-ink-soft">불러오는 중...</p>}
        {error && rooms === null && (
          <p className="text-sm text-ink-soft">불러오지 못했습니다.</p>
        )}
        {rooms && (
          <section className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {rooms.map((room) => (
              <RoomCongestionCard key={room.space_code} room={room} />
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run tests/MmcaPage.test.tsx`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/api/mmca.ts frontend/src/pages/MmcaPage.tsx frontend/tests/MmcaPage.test.tsx
git commit -m "feat(fe): parameterize MmcaPage by venue and title"
```

`npx tsc --noEmit`은 이 태스크에서 실행하지 않는다 — `App.tsx`가 아직 `<MmcaPage />`를 prop 없이 호출하고 있어(Task 6에서 고침) 타입체크가 이 시점엔 정상적으로 실패한다. 전체 타입체크는 Task 6 Step 5에서 한다.

---

### Task 6: 프론트엔드 — 과천 라우트·홈 화면 항목 추가

**Files:**
- Modify: `frontend/src/venues.ts`
- Modify: `frontend/src/App.tsx`
- Test: `frontend/tests/HomePage.test.tsx`

**Interfaces:**
- Consumes: `MmcaPage({ venue, title })` (Task 5에서 정의)
- Produces: 라우트 `/venues/mmca-gwacheon` 신설. `VENUES` 배열에 `{ id: "mmca-gwacheon", name: "국립현대미술관 과천관", path: "/venues/mmca-gwacheon" }` 추가. 기존 `mmca` 항목 이름이 `"국립현대미술관"` → `"국립현대미술관 서울관"`으로 바뀜(과천과 이름이 겹치지 않도록).

- [ ] **Step 1: 실패하는 테스트로 수정**

`frontend/tests/HomePage.test.tsx` 전체 교체:

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { HomePage } from "../src/pages/HomePage";

describe("HomePage", () => {
  it("renders a link to each venue page", () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: "국립중앙박물관" })).toHaveAttribute(
      "href",
      "/venues/national-museum"
    );
    expect(screen.getByRole("link", { name: "국립현대미술관 서울관" })).toHaveAttribute(
      "href",
      "/venues/mmca"
    );
    expect(screen.getByRole("link", { name: "국립현대미술관 과천관" })).toHaveAttribute(
      "href",
      "/venues/mmca-gwacheon"
    );
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run tests/HomePage.test.tsx`
Expected: FAIL — `국립현대미술관 서울관`, `국립현대미술관 과천관` 이름의 링크를 찾지 못함

- [ ] **Step 3: 최소 구현**

`frontend/src/venues.ts` 전체 교체:

```ts
export interface Venue {
  id: string;
  name: string;
  path: string;
}

export const VENUES: Venue[] = [
  { id: "national-museum", name: "국립중앙박물관", path: "/venues/national-museum" },
  { id: "mmca", name: "국립현대미술관 서울관", path: "/venues/mmca" },
  { id: "mmca-gwacheon", name: "국립현대미술관 과천관", path: "/venues/mmca-gwacheon" },
];
```

`frontend/src/App.tsx` 전체 교체:

```tsx
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { HomePage } from "./pages/HomePage";
import { MmcaPage } from "./pages/MmcaPage";
import { NationalMuseumPage } from "./pages/NationalMuseumPage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/venues/national-museum" element={<NationalMuseumPage />} />
        <Route
          path="/venues/mmca"
          element={<MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />}
        />
        <Route
          path="/venues/mmca-gwacheon"
          element={<MmcaPage venue="gwacheon" title="국립현대미술관 과천관 혼잡도" />}
        />
      </Routes>
    </BrowserRouter>
  );
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run tests/HomePage.test.tsx`
Expected: PASS

- [ ] **Step 5: 타입체크 + 전체 프론트엔드 유닛 테스트**

Run:
```bash
cd frontend && npx tsc --noEmit
cd frontend && npx vitest run
```
Expected: 둘 다 에러 없음, 전체 PASS

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/venues.ts frontend/src/App.tsx frontend/tests/HomePage.test.tsx
git commit -m "feat(fe): add Gwacheon branch venue and route"
```

---

### Task 7: e2e — 홈에서 과천 페이지로 이동

**Files:**
- Modify: `frontend/e2e/congestion.spec.ts`

**Interfaces:**
- Consumes: `/venues/mmca-gwacheon` 라우트, `VENUES`의 `"국립현대미술관 서울관"`/`"국립현대미술관 과천관"` 링크 이름 (Task 6)

- [ ] **Step 1: 실패하는 테스트로 수정**

`frontend/e2e/congestion.spec.ts`에서 `test("navigates from the home picker to each venue page", ...)` 블록 전체(기존 파일의 `**/mmca/rooms` 라우트 등록부터 마지막 `expect(page.getByText("보통")).toBeVisible();`까지)를 다음으로 교체:

```ts
test("navigates from the home picker to each venue page", async ({ page }) => {
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
    route.fulfill({ json: { status: "collecting", days_collected: 0 } })
  );
  await page.route("**/congestion/history*", (route) => route.fulfill({ json: [] }));
  await page.route("**/congestion/daily*", (route) => route.fulfill({ json: [] }));
  await page.route("**/congestion/stream", (route) => route.abort());
  await page.route("**/mmca/rooms*", (route) =>
    route.fulfill({
      json: [
        {
          space_code: "MMCA-SPACE-1001",
          space_nm: "1전시실",
          congestion_nm: "여유",
          observed_at: "2026-07-24T10:00:00",
        },
      ],
    })
  );

  await page.goto("/");
  await expect(page.getByRole("link", { name: "국립중앙박물관" })).toBeVisible();
  await expect(page.getByRole("link", { name: "국립현대미술관 서울관" })).toBeVisible();
  await expect(page.getByRole("link", { name: "국립현대미술관 과천관" })).toBeVisible();

  await page.getByRole("link", { name: "국립현대미술관 서울관" }).click();
  await expect(page).toHaveURL(/\/venues\/mmca$/);
  await expect(page.getByText("1전시실")).toBeVisible();

  await page.getByRole("link", { name: "← 미술관 선택" }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.getByRole("link", { name: "국립현대미술관 과천관" }).click();
  await expect(page).toHaveURL(/\/venues\/mmca-gwacheon$/);
  await expect(page.getByText("1전시실")).toBeVisible();

  await page.getByRole("link", { name: "← 미술관 선택" }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.getByRole("link", { name: "국립중앙박물관" }).click();
  await expect(page).toHaveURL(/\/venues\/national-museum$/);
  await expect(page.getByText("보통")).toBeVisible();
});
```

(`**/mmca/rooms` → `**/mmca/rooms*`로 바뀐 점 주의 — `?venue=seoul`/`?venue=gwacheon` 쿼리스트링이 붙으므로 와일드카드가 필요하다.)

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx playwright test -g "navigates from the home picker"`
Expected: FAIL — Task 6까지 완료된 상태라면 실제로는 이미 통과할 수도 있음. 만약 PASS라면 이 단계는 "코드가 이미 구현되어 있어 시작부터 그린"임을 확인하는 용도로 취급하고 다음 단계로 진행.

- [ ] **Step 3: 구현 확인 (신규 앱 코드 없음 — Task 5·6에서 이미 완료)**

이 태스크는 새 구현이 없다. Task 5·6에서 만든 라우팅·컴포넌트가 실제로 브라우저에서 끝까지 동작하는지 Playwright로 검증만 한다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx playwright test -g "navigates from the home picker"`
Expected: PASS

- [ ] **Step 5: 전체 테스트 스위트 실행**

Run:
```bash
cd backend && .venv/bin/pytest -q
cd frontend && npx vitest run
cd frontend && npx tsc --noEmit
cd frontend && npx playwright test
```
Expected: 전부 PASS

- [ ] **Step 6: 커밋**

```bash
git add frontend/e2e/congestion.spec.ts
git commit -m "test(e2e): cover navigation to the Gwacheon MMCA page"
```
