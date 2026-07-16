# Congestion Card Visual Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign `CongestionCard` in the Minimal visual style with status-colored text and a 6-hour trend sparkline, backed by a new `/congestion/history` endpoint, and tone-match `PredictionChart`'s spacing to it.

**Architecture:** One new read-only backend endpoint queries the existing `raw_congestion` table by time window (no new tables, no new infra). The frontend adds one API client function and reworks `CongestionCard`'s markup/styling; `PredictionChart` gets a two-class spacing tweak. No new dependencies on either side — the sparkline reuses the same hand-rolled SVG polyline approach `PredictionChart` already uses.

**Tech Stack:** FastAPI + SQLAlchemy (backend), React + TypeScript + Tailwind (frontend). No new packages.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-15-congestion-card-visual-refresh-design.md`
- Branch: `feat/congestion-card-visual-refresh` (already created, design doc already committed there — continue on it)
- Status color mapping (exact hex, from the dataviz skill's validated status palette): 여유 `#0ca30c`, 보통 `#fab219`, 약간붐빔 `#ec835a`, 붐빔 `#d03b3b`; unknown level falls back to `#94a3b8`. Never rely on color alone — the level text label is always shown alongside.
- History window: backend endpoint defaults to `hours=6`, accepts `1..24`; frontend always calls it with `6`. No live/SSE updates for the sparkline — fetched once on page load.
- No new npm or pip dependencies.
- Commit messages follow `CONTRIBUTING.md`: `type(scope): subject`.
- Backend tests: `cd backend && .venv/bin/pytest`. Frontend unit tests: `cd frontend && npx vitest run`. Frontend type check: `cd frontend && npm run type-check`. E2E: `cd frontend && npx playwright test`.

---

### Task 1: Backend — `GET /congestion/history` endpoint

**Files:**
- Modify: `backend/app/schemas.py`
- Modify: `backend/app/routes/congestion.py`
- Test: `backend/tests/test_routes_congestion.py`

**Interfaces:**
- Consumes: `app.db.SessionLocal`, `app.models.RawCongestion` (existing — same pattern as `current_congestion`)
- Produces: `CongestionHistoryPoint` Pydantic model (`observed_at: str`, `population_avg: float`); route `GET /congestion/history?hours=<int>` returning `list[CongestionHistoryPoint]` as JSON, ordered oldest→newest, empty list when no rows in the window.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_routes_congestion.py`:

```python
def test_history_returns_empty_list_when_no_data(client):
    test_client, _ = client
    response = test_client.get("/congestion/history")
    assert response.status_code == 200
    assert response.json() == []


def test_history_returns_points_within_window(client):
    test_client, session_factory = client

    from datetime import datetime, timedelta

    now = datetime.now()
    with session_factory() as session:
        session.add_all(
            [
                RawCongestion(
                    observed_at=now - timedelta(hours=2),
                    congest_level="여유",
                    population_min=800,
                    population_max=1000,
                ),
                RawCongestion(
                    observed_at=now - timedelta(hours=10),
                    congest_level="붐빔",
                    population_min=3000,
                    population_max=3200,
                ),
            ]
        )
        session.commit()

    response = test_client.get("/congestion/history?hours=6")
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["population_avg"] == 900.0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_routes_congestion.py -v`
Expected: the two new tests FAIL with `404` (route doesn't exist yet) or `AttributeError`/import error if you also added the schema import ahead of time — either way, both new tests fail and the two pre-existing tests in this file still pass.

- [ ] **Step 3: Add the response schema**

In `backend/app/schemas.py`, add below `CurrentCongestion`:

```python
class CongestionHistoryPoint(BaseModel):
    observed_at: str
    population_avg: float
```

- [ ] **Step 4: Add the route**

In `backend/app/routes/congestion.py`, replace the file with:

```python
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Query

from app.cache import get_latest
from app.db import SessionLocal
from app.models import RawCongestion
from app.schemas import CongestionHistoryPoint, CurrentCongestion

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


@router.get("/congestion/history", response_model=list[CongestionHistoryPoint])
def congestion_history(
    hours: int = Query(default=6, ge=1, le=24)
) -> list[CongestionHistoryPoint]:
    cutoff = datetime.now() - timedelta(hours=hours)
    with SessionLocal() as session:
        rows = (
            session.query(RawCongestion)
            .filter(RawCongestion.observed_at >= cutoff)
            .order_by(RawCongestion.observed_at.asc())
            .all()
        )
    return [
        CongestionHistoryPoint(
            observed_at=row.observed_at.isoformat(),
            population_avg=row.population_avg,
        )
        for row in rows
    ]
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_routes_congestion.py -v`
Expected: all 4 tests PASS (2 pre-existing + 2 new).

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && .venv/bin/pytest`
Expected: all tests pass (no regressions elsewhere).

- [ ] **Step 7: Commit**

```bash
git add backend/app/schemas.py backend/app/routes/congestion.py backend/tests/test_routes_congestion.py
git commit -m "feat(be): add congestion history endpoint"
```

---

### Task 2: Frontend — `fetchHistory` API client

**Files:**
- Modify: `frontend/src/api/congestion.ts`

**Interfaces:**
- Consumes: nothing new (same `fetch` pattern as `fetchCurrent`/`fetchPrediction`)
- Produces: `CongestionHistoryPoint` type (`observed_at: string`, `population_avg: number`); `fetchHistory(hours: number): Promise<CongestionHistoryPoint[]>`

- [ ] **Step 1: Add the type and function**

Append to `frontend/src/api/congestion.ts`:

```typescript
export interface CongestionHistoryPoint {
  observed_at: string;
  population_avg: number;
}

export async function fetchHistory(hours: number): Promise<CongestionHistoryPoint[]> {
  const res = await fetch(`/congestion/history?hours=${hours}`);
  if (!res.ok) {
    throw new Error(`failed to fetch congestion history: ${res.status}`);
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
git commit -m "feat(fe): add fetchHistory API client"
```

---

### Task 3: Frontend — Redesign `CongestionCard` (Minimal style, status colors, sparkline)

**Files:**
- Modify: `frontend/src/components/CongestionCard.tsx`
- Test: `frontend/tests/CongestionCard.test.tsx`

**Interfaces:**
- Consumes: `CurrentCongestion`, `CongestionHistoryPoint` from `../api/congestion` (Task 2)
- Produces: `CongestionCard({ data, history }: { data: CurrentCongestion | null; history: CongestionHistoryPoint[] | null })` — the `history` prop is now required (App.tsx, updated in Task 5, always passes it)

- [ ] **Step 1: Write the failing tests**

Replace `frontend/tests/CongestionCard.test.tsx` with:

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
        history={null}
      />
    );

    expect(screen.getByText("보통")).toBeInTheDocument();
    expect(screen.getByText(/1,500/)).toBeInTheDocument();
  });

  it("renders a loading state when data is null", () => {
    render(<CongestionCard data={null} history={null} />);
    expect(screen.getByText(/불러오는 중/)).toBeInTheDocument();
  });

  it("renders a sparkline when history has more than one point", () => {
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        history={[
          { observed_at: "2026-07-15T08:30:00", population_avg: 800 },
          { observed_at: "2026-07-15T14:30:00", population_avg: 1500 },
        ]}
      />
    );

    expect(screen.getByTestId("history-sparkline")).toBeInTheDocument();
  });

  it("omits the sparkline when history is empty", () => {
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        history={[]}
      />
    );

    expect(screen.queryByTestId("history-sparkline")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run tests/CongestionCard.test.tsx`
Expected: FAIL — `history` prop doesn't exist on the current component (type error) and `history-sparkline` test id doesn't exist.

- [ ] **Step 3: Implement the redesigned component**

Replace `frontend/src/components/CongestionCard.tsx` with:

```tsx
import type { CongestionHistoryPoint, CurrentCongestion } from "../api/congestion";

const STATUS_COLOR: Record<string, string> = {
  여유: "#0ca30c",
  보통: "#fab219",
  약간붐빔: "#ec835a",
  붐빔: "#d03b3b",
};
const FALLBACK_COLOR = "#94a3b8";

const SPARKLINE_WIDTH = 200;
const SPARKLINE_HEIGHT = 40;

function sparklinePoints(history: CongestionHistoryPoint[]): string {
  const values = history.map((point) => point.population_avg);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1; // ponytail: guards a flat/single-value window; a wider range never hits this
  const denominator = values.length - 1;

  return values
    .map((value, index) => {
      const x = (index / denominator) * SPARKLINE_WIDTH;
      const y = SPARKLINE_HEIGHT - ((value - min) / range) * SPARKLINE_HEIGHT;
      return `${x},${y}`;
    })
    .join(" ");
}

export function CongestionCard({
  data,
  history,
}: {
  data: CurrentCongestion | null;
  history: CongestionHistoryPoint[] | null;
}) {
  if (!data) {
    return <div className="rounded-lg border p-8">불러오는 중...</div>;
  }

  const color = STATUS_COLOR[data.congest_level] ?? FALLBACK_COLOR;

  return (
    <div className="rounded-lg border p-8">
      <p className="text-xs text-gray-500">국립중앙박물관 현재 혼잡도</p>
      <div className="mt-2 flex items-baseline gap-3">
        <span className="text-4xl font-bold" style={{ color }}>
          {data.congest_level}
        </span>
        <span className="text-sm text-gray-500">
          {Math.round(data.population_avg).toLocaleString()}명 ·{" "}
          {data.observed_at.slice(11, 16)} 기준
        </span>
      </div>
      {history && history.length > 1 && (
        <svg
          data-testid="history-sparkline"
          viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
          className="mt-4 h-10 w-full"
        >
          <polyline
            points={sparklinePoints(history)}
            fill="none"
            stroke={color}
            strokeWidth={2}
          />
        </svg>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/CongestionCard.test.tsx`
Expected: all 4 tests PASS.

- [ ] **Step 5: Type-check**

Run: `cd frontend && npm run type-check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/CongestionCard.tsx frontend/tests/CongestionCard.test.tsx
git commit -m "feat(fe): redesign CongestionCard with status colors and sparkline"
```

---

### Task 4: Frontend — Match `PredictionChart` spacing to the new card

**Files:**
- Modify: `frontend/src/components/PredictionChart.tsx`

**Interfaces:**
- Consumes: nothing new
- Produces: nothing new (pure styling change, same props/behavior)

- [ ] **Step 1: Update spacing/typography classes**

In `frontend/src/components/PredictionChart.tsx`, change both occurrences of `className="rounded-lg border p-4"` to `className="rounded-lg border p-8"`, and change `className="mb-2 text-sm text-gray-500"` to `className="mb-2 text-xs text-gray-500"`. No other lines change — the chart logic, `toPoints`, colors, and test IDs stay exactly as they are.

- [ ] **Step 2: Run existing tests to verify no regression**

Run: `cd frontend && npx vitest run tests/PredictionChart.test.tsx`
Expected: both existing tests still PASS unchanged (they don't assert on spacing classes).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/PredictionChart.tsx
git commit -m "style(fe): match PredictionChart spacing to CongestionCard"
```

---

### Task 5: Frontend — Wire history into `App`

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/e2e/congestion.spec.ts`

**Interfaces:**
- Consumes: `fetchHistory` (Task 2), `CongestionCard`'s `history` prop (Task 3)
- Produces: nothing new — this is the final wiring step

- [ ] **Step 1: Update the e2e test to mock the new endpoint**

In `frontend/e2e/congestion.spec.ts`, add a route mock for history and assert the sparkline renders. Replace the file with:

```typescript
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

  await page.route("**/congestion/history*", (route) =>
    route.fulfill({
      json: [
        { observed_at: "2026-07-15T08:30:00", population_avg: 800 },
        { observed_at: "2026-07-15T14:30:00", population_avg: 1500 },
      ],
    })
  );

  await page.route("**/congestion/stream", (route) => route.abort());

  await page.goto("/");

  await expect(page.getByText("보통")).toBeVisible();
  await expect(page.getByTestId("prediction-svg")).toBeVisible();
  await expect(page.getByTestId("history-sparkline")).toBeVisible();
});
```

- [ ] **Step 2: Wire `fetchHistory` into `App.tsx`**

Replace `frontend/src/App.tsx` with:

```tsx
import { useEffect, useState } from "react";

import {
  fetchCurrent,
  fetchHistory,
  fetchPrediction,
  type CongestionHistoryPoint,
  type CurrentCongestion,
  type PredictionResult,
} from "./api/congestion";
import { CongestionCard } from "./components/CongestionCard";
import { PredictionChart } from "./components/PredictionChart";
import { useCongestionStream } from "./hooks/useCongestionStream";

const HISTORY_HOURS = 6;

export default function App() {
  const [initial, setInitial] = useState<CurrentCongestion | null>(null);
  const [prediction, setPrediction] = useState<PredictionResult | null>(null);
  const [history, setHistory] = useState<CongestionHistoryPoint[] | null>(null);

  useEffect(() => {
    fetchCurrent().then(setInitial).catch(() => setInitial(null));
    fetchPrediction().then(setPrediction).catch(() => setPrediction(null));
    fetchHistory(HISTORY_HOURS).then(setHistory).catch(() => setHistory(null));
  }, []);

  const current = useCongestionStream(initial);

  return (
    <main className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">전시 혼잡도 예측</h1>
      <CongestionCard data={current} history={history} />
      <PredictionChart prediction={prediction} />
    </main>
  );
}
```

- [ ] **Step 3: Type-check and run unit tests**

Run: `cd frontend && npm run type-check && npx vitest run`
Expected: no type errors, all unit tests pass.

- [ ] **Step 4: Run the e2e test**

Run: `cd frontend && npx playwright test`
Expected: PASS, including the new sparkline assertion.

- [ ] **Step 5: Manual check in the browser**

Start both servers (`cd backend && .venv/bin/uvicorn app.main:app --port 8000`, `cd frontend && npm run dev`) and open `http://localhost:5173`. Confirm the card shows the Minimal layout with a status-colored level, and a sparkline once at least 2 history points exist (may be empty on a fresh DB — that's expected per the design's error handling, not a bug).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.tsx frontend/e2e/congestion.spec.ts
git commit -m "feat(fe): wire congestion history into App"
```
