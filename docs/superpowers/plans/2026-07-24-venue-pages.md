# 국중박·국현미 미술관별 페이지 분리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 홈 화면에서 미술관을 선택해 국립중앙박물관 또는 국립현대미술관(MMCA) 전용 페이지로 이동하는 구조를 만든다.

**Architecture:** 프론트엔드에 `react-router-dom`을 도입해 `/`(홈), `/venues/national-museum`, `/venues/mmca` 3개 라우트를 둔다. 기존 국중박 화면(`App.tsx`)은 로직 변경 없이 `pages/NationalMuseumPage.tsx`로 이동한다. 국현미는 백엔드에 신규 `GET /mmca/rooms` 엔드포인트(전시실별 최신 혼잡도, DB 직접 조회)를 추가하고, 프론트엔드에 60초 폴링하는 `pages/MmcaPage.tsx`를 신규로 만든다.

**Tech Stack:** 기존과 동일 (FastAPI, SQLAlchemy, pytest — React, Vite, TypeScript, Tailwind, Vitest, Playwright) + `react-router-dom` 신규 추가.

## Global Constraints

- 미술관 선택 UI는 홈 화면 카드 리스트 → 개별 라우트 (탭 방식 아님, URL 딥링크 가능해야 함)
- 라우트: `/`, `/venues/national-museum`, `/venues/mmca` — 슬러그는 백엔드 네이밍(`mmca`)과 맞춤
- 미술관 목록은 `frontend/src/venues.ts` 한 곳에서 관리 (다음 미술관 추가 시 항목 하나만 늘리면 됨)
- 국현미 페이지는 전시실별 현재 혼잡도 등급만 표시 — 예측/일별 로그/SSE는 이번 범위 아님(YAGNI, 데이터 형태가 인구수 아닌 등급 텍스트라 국중박과 같은 파이프라인을 못 씀)
- 국현미 실시간성은 60초 폴링 (SSE 아님 — 백엔드에 MMCA용 캐시/pub-sub 없음)
- `GET /mmca/rooms`는 캐시 없이 DB 직접 조회 (저빈도 데이터, 캐시 계층 추가는 과함), 데이터 없으면 503
- 국중박 기존 코드는 위치만 이동, 로직 변경 없음 (회귀 위험 최소화)

---

## File Structure

```
backend/
  app/
    routes/
      mmca.py          # 신규: GET /mmca/rooms
    schemas.py          # 수정: MmcaRoomStatus 추가
    main.py              # 수정: mmca 라우터 등록
  tests/
    test_routes_mmca.py  # 신규

frontend/
  src/
    venues.ts             # 신규: 미술관 레지스트리
    api/
      mmca.ts               # 신규: fetchMmcaRooms
    pages/
      HomePage.tsx            # 신규: 미술관 선택 카드
      NationalMuseumPage.tsx   # 신규: 기존 App.tsx 본문 이동
      MmcaPage.tsx               # 신규: 전시실별 혼잡도 카드, 60초 폴링
    components/
      RoomCongestionCard.tsx      # 신규
    App.tsx                        # 수정: 라우터 배선만 남김
  vite.config.ts                    # 수정: /mmca 프록시 추가
  package.json                       # 수정: react-router-dom 추가
  tests/
    HomePage.test.tsx                 # 신규
    RoomCongestionCard.test.tsx        # 신규
    MmcaPage.test.tsx                   # 신규
  e2e/
    congestion.spec.ts                   # 수정: 라우트 변경 반영 + venue 네비게이션 케이스 추가
```

---

## Task 1: 백엔드 — `GET /mmca/rooms` 엔드포인트

**Files:**
- Create: `backend/app/routes/mmca.py`
- Modify: `backend/app/schemas.py` (append `MmcaRoomStatus`)
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_routes_mmca.py`

**Interfaces:**
- Consumes: `app.models.RawMmcaCongestion` (기존, 필드 `space_code`, `space_nm`, `congestion_nm`, `observed_at`), `app.db.SessionLocal`
- Produces: `GET /mmca/rooms` → `list[MmcaRoomStatus]` (`space_code: str`, `space_nm: str | None`, `congestion_nm: str | None`, `observed_at: str`), `space_code`별 최신 1건만, 데이터 없으면 HTTP 503

- [ ] **Step 1: Write the failing test**

`backend/tests/test_routes_mmca.py`:
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
    response = test_client.get("/mmca/rooms")
    assert response.status_code == 503


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

    response = test_client.get("/mmca/rooms")
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 2

    room1 = next(r for r in body if r["space_code"] == "MMCA-SPACE-1001")
    assert room1["congestion_nm"] == "보통"
    assert room1["space_nm"] == "1전시실"

    room2 = next(r for r in body if r["space_code"] == "MMCA-SPACE-1002")
    assert room2["congestion_nm"] is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/test_routes_mmca.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.routes.mmca'`

- [ ] **Step 3: Write minimal implementation**

Append to `backend/app/schemas.py`:
```python


class MmcaRoomStatus(BaseModel):
    space_code: str
    space_nm: str | None
    congestion_nm: str | None
    observed_at: str
```

`backend/app/routes/mmca.py`:
```python
from fastapi import APIRouter, HTTPException
from sqlalchemy import func

from app.db import SessionLocal
from app.models import RawMmcaCongestion
from app.schemas import MmcaRoomStatus

router = APIRouter()


@router.get("/mmca/rooms", response_model=list[MmcaRoomStatus])
def mmca_rooms() -> list[MmcaRoomStatus]:
    with SessionLocal() as session:
        latest_ids = [
            row[0]
            for row in session.query(func.max(RawMmcaCongestion.id))
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

Modify `backend/app/main.py` (add import near the other route imports, and `include_router` call near the others):
```python
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.db import init_db
from app.routes.congestion import router as congestion_router
from app.routes.mmca import router as mmca_router
from app.routes.prediction import router as prediction_router
from app.routes.stream import router as stream_router
from app.scheduler import build_scheduler


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    scheduler = build_scheduler()
    scheduler.start()
    yield
    scheduler.shutdown()


app = FastAPI(title="Exhibition Congestion Prediction", lifespan=lifespan)
app.include_router(congestion_router)
app.include_router(mmca_router)
app.include_router(prediction_router)
app.include_router(stream_router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pytest tests/test_routes_mmca.py -v`
Expected: PASS

- [ ] **Step 5: Run the full backend test suite**

Run: `cd backend && pytest -q`
Expected: all tests pass (49 passed)

- [ ] **Step 6: Commit**

```bash
git add backend/app/routes/mmca.py backend/app/schemas.py backend/app/main.py backend/tests/test_routes_mmca.py
git commit -m "feat(be): add GET /mmca/rooms endpoint"
```

---

## Task 2: 프론트엔드 — 라우팅 스캐폴드 (홈 + 국중박 페이지 이동)

**Files:**
- Modify: `frontend/package.json` (add `react-router-dom`)
- Create: `frontend/src/venues.ts`
- Create: `frontend/src/pages/HomePage.tsx`
- Create: `frontend/src/pages/NationalMuseumPage.tsx`
- Modify: `frontend/src/App.tsx` (replace full contents)
- Modify: `frontend/e2e/congestion.spec.ts` (fix broken route)
- Test: `frontend/tests/HomePage.test.tsx`

**Interfaces:**
- Produces: `venues.ts` exports `interface Venue { id: string; name: string; path: string }` and `VENUES: Venue[]`; `pages/HomePage.tsx` exports `HomePage()`; `pages/NationalMuseumPage.tsx` exports `NationalMuseumPage()` (기존 `App` 컴포넌트와 동일한 내용, 국중박 관련 로직 무변경)
- Consumes: `api/congestion.ts`, `components/CongestionCard.tsx`, `components/DailyLogTable.tsx`, `components/PredictionChart.tsx`, `hooks/useCongestionStream.ts` (모두 기존, 무변경)

- [ ] **Step 1: Add react-router-dom**

Modify `frontend/package.json` line 14-15 (dependencies):
```json
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.2"
  },
```

Run: `cd frontend && npm install`

- [ ] **Step 2: Write the failing test**

`frontend/tests/HomePage.test.tsx`:
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

    expect(screen.getByRole("link", { name: /국립중앙박물관/ })).toHaveAttribute(
      "href",
      "/venues/national-museum"
    );
    expect(screen.getByRole("link", { name: /국립현대미술관/ })).toHaveAttribute(
      "href",
      "/venues/mmca"
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/HomePage.test.tsx`
Expected: FAIL with a module-not-found error for `../src/pages/HomePage`

- [ ] **Step 4: Write minimal implementation**

`frontend/src/venues.ts`:
```ts
export interface Venue {
  id: string;
  name: string;
  path: string;
}

export const VENUES: Venue[] = [
  { id: "national-museum", name: "국립중앙박물관", path: "/venues/national-museum" },
  { id: "mmca", name: "국립현대미술관", path: "/venues/mmca" },
];
```

`frontend/src/pages/HomePage.tsx`:
```tsx
import { Link } from "react-router-dom";

import { VENUES } from "../venues";

export function HomePage() {
  return (
    <div className="min-h-screen bg-canvas">
      <main className="mx-auto max-w-[1400px] px-6 py-16 sm:px-10 lg:px-16">
        <header className="mb-12 border-b border-hairline/70 pb-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-soft">
            Exhibition · Seoul
          </p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            전시 혼잡도 예측
          </h1>
        </header>

        <section className="grid gap-6 sm:grid-cols-2">
          {VENUES.map((venue) => (
            <Link
              key={venue.id}
              to={venue.path}
              className="rounded-apple border border-hairline/60 bg-white/70 p-8 shadow-apple backdrop-blur-xl transition hover:border-accent/50"
            >
              <span className="text-xl font-semibold text-ink">{venue.name}</span>
            </Link>
          ))}
        </section>
      </main>
    </div>
  );
}
```

`frontend/src/pages/NationalMuseumPage.tsx` (기존 `App.tsx` 본문을 옮기고, 홈으로 돌아가는 링크만 추가):
```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  fetchCurrent,
  fetchDaily,
  fetchPrediction,
  type CurrentCongestion,
  type DailyLogPoint,
  type PredictionResult,
} from "../api/congestion";
import { CongestionCard } from "../components/CongestionCard";
import { DailyLogTable, todayString } from "../components/DailyLogTable";
import { PredictionChart } from "../components/PredictionChart";
import { useCongestionStream } from "../hooks/useCongestionStream";

export function NationalMuseumPage() {
  const [initial, setInitial] = useState<CurrentCongestion | null>(null);
  const [prediction, setPrediction] = useState<PredictionResult | null>(null);
  const [daily, setDaily] = useState<DailyLogPoint[] | null>(null);

  useEffect(() => {
    fetchCurrent().then(setInitial).catch(() => setInitial(null));
    fetchPrediction().then(setPrediction).catch(() => setPrediction(null));
    fetchDaily(todayString()).then(setDaily).catch(() => setDaily(null));
  }, []);

  const current = useCongestionStream(initial);

  return (
    <div className="min-h-screen bg-canvas">
      <main className="mx-auto max-w-[1400px] px-6 py-16 sm:px-10 lg:px-16">
        <header className="mb-12 flex items-end justify-between gap-6 border-b border-hairline/70 pb-8">
          <div>
            <Link
              to="/"
              className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-soft hover:text-accent"
            >
              ← 미술관 선택
            </Link>
            <p className="mt-2 text-xs font-semibold uppercase tracking-[0.2em] text-ink-soft">
              Exhibition · Seoul
            </p>
            <h1 className="mt-2 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
              전시 혼잡도 예측
            </h1>
          </div>
          <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-ink-soft">
            <span className="h-2 w-2 rounded-full bg-[#34C759] motion-safe:animate-pulse-live" />
            Live
          </span>
        </header>

        <section className="grid gap-6 lg:grid-cols-2">
          <CongestionCard data={current} daily={daily} />
          <PredictionChart prediction={prediction} />
        </section>

        <section className="mt-6">
          <DailyLogTable />
        </section>
      </main>
    </div>
  );
}
```

Replace `frontend/src/App.tsx` in full:
```tsx
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { HomePage } from "./pages/HomePage";
import { NationalMuseumPage } from "./pages/NationalMuseumPage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/venues/national-museum" element={<NationalMuseumPage />} />
      </Routes>
    </BrowserRouter>
  );
}
```

(MMCA 라우트는 Task 4에서 `MmcaPage`가 생긴 뒤 추가한다 — 지금 추가하면 존재하지 않는 모듈을 import하게 됨.)

Modify `frontend/e2e/congestion.spec.ts`: 첫 줄의 `await page.goto("/");`를 국중박 라우트로 변경 (홈은 이제 선택 화면이라 혼잡도 콘텐츠가 바로 안 보임):
```ts
  await page.goto("/venues/national-museum");
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/HomePage.test.tsx`
Expected: PASS

- [ ] **Step 6: Run the full frontend unit test suite**

Run: `cd frontend && npm test`
Expected: all existing tests (CongestionCard, PredictionChart, DailyLogTable, useCongestionStream) still pass unchanged, plus new HomePage test — since none of those components' own logic or import paths changed.

- [ ] **Step 7: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/venues.ts frontend/src/pages/HomePage.tsx frontend/src/pages/NationalMuseumPage.tsx frontend/src/App.tsx frontend/e2e/congestion.spec.ts frontend/tests/HomePage.test.tsx
git commit -m "feat(fe): split home and national museum into routed pages"
```

---

## Task 3: 프론트엔드 — MMCA API 클라이언트 + 전시실 카드 컴포넌트

**Files:**
- Create: `frontend/src/api/mmca.ts`
- Create: `frontend/src/components/RoomCongestionCard.tsx`
- Test: `frontend/tests/RoomCongestionCard.test.tsx`

**Interfaces:**
- Produces: `api/mmca.ts` exports `interface MmcaRoomStatus { space_code: string; space_nm: string | null; congestion_nm: string | null; observed_at: string }` and `fetchMmcaRooms(): Promise<MmcaRoomStatus[]>`; `components/RoomCongestionCard.tsx` exports `RoomCongestionCard({ room }: { room: MmcaRoomStatus })`
- Consumes: `lib/status.ts` (기존 `statusOf`, 국중박 혼잡도 등급 색상 매핑 재사용)

- [ ] **Step 1: Write the failing test**

`frontend/tests/RoomCongestionCard.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RoomCongestionCard } from "../src/components/RoomCongestionCard";
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

describe("RoomCongestionCard", () => {
  it("renders the room name, congestion level, and last-updated time", () => {
    render(<RoomCongestionCard room={makeRoom()} />);

    expect(screen.getByText("1전시실")).toBeInTheDocument();
    expect(screen.getByText("여유")).toBeInTheDocument();
    expect(screen.getByText(/10:00/)).toBeInTheDocument();
  });

  it("shows a fallback when congestion_nm is missing", () => {
    render(<RoomCongestionCard room={makeRoom({ congestion_nm: null })} />);

    expect(screen.getByText("정보 없음")).toBeInTheDocument();
  });

  it("falls back to the space code when space_nm is missing", () => {
    render(<RoomCongestionCard room={makeRoom({ space_nm: null })} />);

    expect(screen.getByText("MMCA-SPACE-1001")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/RoomCongestionCard.test.tsx`
Expected: FAIL with a module-not-found error for `../src/components/RoomCongestionCard`

- [ ] **Step 3: Write minimal implementation**

`frontend/src/api/mmca.ts`:
```ts
export interface MmcaRoomStatus {
  space_code: string;
  space_nm: string | null;
  congestion_nm: string | null;
  observed_at: string;
}

export async function fetchMmcaRooms(): Promise<MmcaRoomStatus[]> {
  const res = await fetch("/mmca/rooms");
  if (!res.ok) {
    throw new Error(`failed to fetch MMCA rooms: ${res.status}`);
  }
  return res.json();
}
```

`frontend/src/components/RoomCongestionCard.tsx`:
```tsx
import type { MmcaRoomStatus } from "../api/mmca";
import { statusOf } from "../lib/status";

export function RoomCongestionCard({ room }: { room: MmcaRoomStatus }) {
  const status = statusOf(room.congestion_nm ?? "");

  return (
    <div className="rounded-apple border border-hairline/60 bg-white/70 p-6 shadow-apple backdrop-blur-xl">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-soft">
        {room.space_nm ?? room.space_code}
      </p>
      <p className="mt-2 text-2xl font-bold" style={{ color: status.text }}>
        {room.congestion_nm ?? "정보 없음"}
      </p>
      <p className="mt-1 text-[11px] text-ink-soft/70">
        마지막 갱신 {room.observed_at.slice(11, 16)}
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/RoomCongestionCard.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/mmca.ts frontend/src/components/RoomCongestionCard.tsx frontend/tests/RoomCongestionCard.test.tsx
git commit -m "feat(fe): add MMCA room API client and congestion card"
```

---

## Task 4: 프론트엔드 — MmcaPage (60초 폴링) + 라우트 연결

**Files:**
- Create: `frontend/src/pages/MmcaPage.tsx`
- Modify: `frontend/src/App.tsx` (add MMCA route)
- Modify: `frontend/vite.config.ts` (proxy `/mmca`)
- Test: `frontend/tests/MmcaPage.test.tsx`

**Interfaces:**
- Consumes: `api/mmca.ts` (`fetchMmcaRooms`, `MmcaRoomStatus`), `components/RoomCongestionCard.tsx`
- Produces: `pages/MmcaPage.tsx` exports `MmcaPage()` — 마운트 시 즉시 조회 + 60초마다 재조회, 언마운트 시 polling 정리

- [ ] **Step 1: Write the failing test**

`frontend/tests/MmcaPage.test.tsx`:
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
        <MmcaPage />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("1전시실")).toBeInTheDocument());
    expect(screen.getByText("2전시실")).toBeInTheDocument();
  });

  it("shows an error message when the fetch fails before anything loads", async () => {
    vi.spyOn(api, "fetchMmcaRooms").mockRejectedValue(new Error("network error"));

    render(
      <MemoryRouter>
        <MmcaPage />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("불러오지 못했습니다.")).toBeInTheDocument());
  });

  it("polls again after 60 seconds", async () => {
    const fetchMmcaRooms = vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);

    render(
      <MemoryRouter>
        <MmcaPage />
      </MemoryRouter>
    );

    await waitFor(() => expect(fetchMmcaRooms).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMmcaRooms).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/MmcaPage.test.tsx`
Expected: FAIL with a module-not-found error for `../src/pages/MmcaPage`

- [ ] **Step 3: Write minimal implementation**

`frontend/src/pages/MmcaPage.tsx`:
```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { fetchMmcaRooms, type MmcaRoomStatus } from "../api/mmca";
import { RoomCongestionCard } from "../components/RoomCongestionCard";

const POLL_INTERVAL_MS = 60_000;

export function MmcaPage() {
  const [rooms, setRooms] = useState<MmcaRoomStatus[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let ignore = false;

    function load() {
      fetchMmcaRooms()
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
  }, []);

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
            국립현대미술관 서울관 혼잡도
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

Modify `frontend/src/App.tsx` in full (add the MMCA route):
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
        <Route path="/venues/mmca" element={<MmcaPage />} />
      </Routes>
    </BrowserRouter>
  );
}
```

Modify `frontend/vite.config.ts` line 7-9 (add `/mmca` proxy alongside `/congestion`):
```ts
  server: {
    proxy: {
      "/congestion": "http://localhost:8000",
      "/mmca": "http://localhost:8000",
    },
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/MmcaPage.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/MmcaPage.tsx frontend/src/App.tsx frontend/vite.config.ts frontend/tests/MmcaPage.test.tsx
git commit -m "feat(fe): add MMCA congestion page with 60s polling"
```

---

## Task 5: E2E 커버리지 + 전체 테스트 확인

**Files:**
- Modify: `frontend/e2e/congestion.spec.ts` (add venue navigation coverage)

**Interfaces:**
- Consumes: 전체 앱 (`App.tsx`, `HomePage`, `NationalMuseumPage`, `MmcaPage`)

- [ ] **Step 1: Write the failing test**

Append to `frontend/e2e/congestion.spec.ts` (같은 파일 안에 새 `test` 블록 추가, 기존 `test(...)` 옆에 나란히):
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
  await page.route("**/mmca/rooms", (route) =>
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
  await expect(page.getByRole("link", { name: "국립현대미술관" })).toBeVisible();

  await page.getByRole("link", { name: "국립현대미술관" }).click();
  await expect(page).toHaveURL(/\/venues\/mmca$/);
  await expect(page.getByText("1전시실")).toBeVisible();

  await page.getByRole("link", { name: "← 미술관 선택" }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.getByRole("link", { name: "국립중앙박물관" }).click();
  await expect(page).toHaveURL(/\/venues\/national-museum$/);
  await expect(page.getByText("보통")).toBeVisible();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx playwright test -g "navigates from the home picker"`
Expected: FAIL (route not wired, or selectors mismatch) before Task 2/4 landed — since those are already done by this point, this step should mostly confirm the test runs; if it fails, check the selector text matches the actual rendered link names.

- [ ] **Step 3: Confirm implementation (no new app code — already built in Tasks 2 & 4)**

No implementation changes needed here; this task is pure verification that the routing built across Tasks 2 and 4 works end-to-end via Playwright.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx playwright test -g "navigates from the home picker"`
Expected: PASS

- [ ] **Step 5: Run every test suite in the repo**

Run:
```bash
cd backend && pytest -q
cd frontend && npm test
cd frontend && npx tsc --noEmit
cd frontend && npx playwright test
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add frontend/e2e/congestion.spec.ts
git commit -m "test(fe): cover venue picker navigation end-to-end"
```
