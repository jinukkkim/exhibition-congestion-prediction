# MMCA Today-Only Congestion + Inactive Room Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `GET /mmca/rooms` from returning yesterday's stale congestion when a room has no reading yet today, and render rooms that are currently open but have no data today (plus permanently-disabled rooms) as small cards grouped below the active-room grid.

**Architecture:** Backend: scope the "latest reading per room" query in `mmca_rooms()` to today's rows only, still surfacing every room that has *any* history (not just today's), with `congestion_nm=None` when today has no row. Frontend: `MmcaPage` partitions rooms into `activeRooms` (real chart card, existing 2-col grid) and `inactiveRooms` (new small card, 6-col grid) using the venue's shared `isOpen` state plus the existing `DISABLED_MMCA_SPACE_CODES` set; `MmcaRoomChartCard` drops its own disabled-room branch since `MmcaPage` now filters those out before they ever reach it.

**Tech Stack:** FastAPI + SQLAlchemy + pytest (backend), React + TypeScript + Vitest + Testing Library (frontend).

## Global Constraints

- Repo convention (CLAUDE.md): never commit on `main`/`develop`; this work happens on branch `fix/mmca-today-only-congestion` (already created off `develop`). Commit each task immediately after it's done and green. No `Co-Authored-By: Claude` trailer in any commit.
- Backend "today" boundary uses server-local `datetime.now()`, matching the existing pattern in `mmca_daily()` (`backend/app/routes/mmca.py:71-72`) — no timezone library needed.
- "Inactive today" scope is exactly: permanently-disabled rooms (`DISABLED_MMCA_SPACE_CODES`), OR rooms where the venue is currently open (`isOpen`) AND `congestion_nm` is null. Rooms that are simply before opening or closed for the day are **not** included — they keep the existing full-size card with "영업 시간이 아닙니다" / "휴관일입니다".
- Inactive-room grid classes: `grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6`.
- Backend test command: `cd backend && .venv/bin/pytest tests/test_routes_mmca.py -v`
- Frontend test command: `cd frontend && npx vitest run tests/<file>.test.tsx`

---

### Task 1: Backend — day-scope `/mmca/rooms`

**Files:**
- Modify: `backend/app/routes/mmca.py:15-62` (`mmca_rooms()`)
- Modify: `backend/app/schemas.py:34-40` (`MmcaRoomStatus` docstring comment)
- Test: `backend/tests/test_routes_mmca.py`

**Interfaces:**
- Consumes: `RawMmcaCongestion` model (`backend/app/models.py`), `MMCA_DISABLED_SPACE_CODES` / `MMCA_SPACE_NAMES` / `settings.mmca_venue_space_codes` (`backend/app/config.py`) — all unchanged.
- Produces: `GET /mmca/rooms?venue=<venue>` still returns `list[MmcaRoomStatus]`, one entry per space code that has ever had at least one `RawMmcaCongestion` row (same set of codes as before — no new/fewer codes appear). The only behavior change: `congestion_nm`/`observed_at` are `None` whenever there's no row for *today*, instead of falling back to the most recent row from any prior day.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/test_routes_mmca.py`, change the import on line 1 to include `timedelta`:

```python
from datetime import datetime, timedelta
```

Replace `test_mmca_rooms_returns_latest_reading_per_room` (currently uses the hardcoded past date `2026-07-24`, which the day-scoped query will now exclude) with a version that dates its rows relative to `datetime.now()`:

```python
def test_mmca_rooms_returns_latest_reading_per_room(client):
    test_client, session_factory = client
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)

    with session_factory() as session:
        session.add_all(
            [
                RawMmcaCongestion(
                    observed_at=today.replace(hour=10, minute=0),
                    space_code="MMCA-SPACE-1001",
                    space_nm="1전시실",
                    agnc_nm="국립현대미술관",
                    congestion_nm="여유",
                ),
                RawMmcaCongestion(
                    observed_at=today.replace(hour=10, minute=6),
                    space_code="MMCA-SPACE-1001",
                    space_nm="1전시실",
                    agnc_nm="국립현대미술관",
                    congestion_nm="보통",
                ),
                RawMmcaCongestion(
                    observed_at=today.replace(hour=10, minute=6),
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
```

Replace `test_mmca_rooms_falls_back_to_static_room_name_when_latest_poll_has_none` (same stale-date problem) with:

```python
def test_mmca_rooms_falls_back_to_static_room_name_when_latest_poll_has_none(client):
    test_client, session_factory = client
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)

    with session_factory() as session:
        session.add(
            RawMmcaCongestion(
                observed_at=today.replace(hour=10, minute=15),
                space_code="MMCA-SPACE-1001",
                space_nm=None,
                congestion_nm="보통",
            )
        )
        session.commit()

    response = test_client.get("/mmca/rooms?venue=seoul")
    assert response.status_code == 200
    room = next(r for r in response.json() if r["space_code"] == "MMCA-SPACE-1001")
    assert room["space_nm"] == "1전시실"
    assert room["congestion_nm"] == "보통"
```

Add a new regression test for the actual bug, right after
`test_mmca_rooms_falls_back_to_static_room_name_when_latest_poll_has_none`:

```python
def test_mmca_rooms_hides_stale_reading_when_no_data_collected_today(client):
    test_client, session_factory = client
    yesterday = datetime.now().replace(hour=17, minute=50, second=0, microsecond=0) - timedelta(days=1)

    with session_factory() as session:
        session.add(
            RawMmcaCongestion(
                observed_at=yesterday,
                space_code="MMCA-SPACE-1001",
                space_nm="1전시실",
                congestion_nm="붐빔",
            )
        )
        session.commit()

    response = test_client.get("/mmca/rooms?venue=seoul")
    assert response.status_code == 200
    room = next(r for r in response.json() if r["space_code"] == "MMCA-SPACE-1001")
    # Business hours may have started today, but nothing has been collected
    # yet — must not silently show yesterday's last real reading.
    assert room["congestion_nm"] is None
    assert room["observed_at"] is None
    assert room["space_nm"] == "1전시실"
```

Leave every other test in the file untouched — `test_mmca_rooms_returns_503_when_no_data`,
`test_mmca_rooms_returns_placeholder_instead_of_503_when_venue_is_fully_disabled`,
`test_mmca_rooms_returns_400_for_unknown_venue`, and `test_mmca_rooms_filters_by_venue`
are all unaffected: none of them depend on "latest row is today's row" behavior
(`test_mmca_rooms_filters_by_venue`'s rows are historical, but its assertions only check
which space codes appear in the response, not their `congestion_nm` values, and the
day-scoping doesn't change which codes appear — see Step 3).

- [ ] **Step 2: Run tests to verify the new/changed ones fail**

Run: `cd backend && .venv/bin/pytest tests/test_routes_mmca.py -v`
Expected: `test_mmca_rooms_returns_latest_reading_per_room`,
`test_mmca_rooms_falls_back_to_static_room_name_when_latest_poll_has_none`, and
`test_mmca_rooms_hides_stale_reading_when_no_data_collected_today` all FAIL (the
first two now date their rows as "today," which the *old*, unscoped endpoint still
handles correctly by coincidence — so re-run and confirm specifically that
`test_mmca_rooms_hides_stale_reading_when_no_data_collected_today` FAILS, since that's the
one the old code cannot pass: it will assert `congestion_nm == "붐빔"`... no — it asserts
`is None`, so the *old* code fails this by returning `"붐빔"` instead of `None`).

- [ ] **Step 3: Rewrite `mmca_rooms()`**

Replace the full body of `mmca_rooms()` in `backend/app/routes/mmca.py:15-62` with:

```python
@router.get("/mmca/rooms", response_model=list[MmcaRoomStatus])
def mmca_rooms(venue: str) -> list[MmcaRoomStatus]:
    codes = settings.mmca_venue_space_codes.get(venue)
    if codes is None:
        raise HTTPException(status_code=400, detail=f"unknown venue: {venue}")

    with SessionLocal() as session:
        codes_with_history = {
            row[0]
            for row in session.query(RawMmcaCongestion.space_code)
            .filter(RawMmcaCongestion.space_code.in_(codes))
            .distinct()
            .all()
        }

        if not codes_with_history:
            if all(code in MMCA_DISABLED_SPACE_CODES for code in codes):
                # Every room this venue has is permanently disabled (e.g.
                # Deoksugung's only code, MMCA-SPACE-4001) — collection will
                # never backfill history for it, so a fresh/empty DB must not
                # 503 forever. Placeholder rows let the frontend's "서비스 예정"
                # UI render instead of falling through to a generic error page.
                return [
                    MmcaRoomStatus(
                        space_code=code,
                        space_nm=MMCA_SPACE_NAMES.get(code),
                        congestion_nm=None,
                        observed_at=None,
                    )
                    for code in codes
                ]
            raise HTTPException(status_code=503, detail="no MMCA congestion data yet")

        # A room can have history from earlier days but nothing yet today
        # (e.g. business hours just started, before the collector's first
        # poll) — only ever surface a *today* reading, never fall back to a
        # stale prior-day value.
        day_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        latest_ids = [
            row[0]
            for row in session.query(func.max(RawMmcaCongestion.id))
            .filter(
                RawMmcaCongestion.space_code.in_(codes_with_history),
                RawMmcaCongestion.observed_at >= day_start,
            )
            .group_by(RawMmcaCongestion.space_code)
            .all()
        ]
        rows = session.query(RawMmcaCongestion).filter(RawMmcaCongestion.id.in_(latest_ids)).all()

    rows_by_code = {row.space_code: row for row in rows}
    return [
        MmcaRoomStatus(
            space_code=code,
            space_nm=(rows_by_code[code].space_nm if code in rows_by_code else None)
            or MMCA_SPACE_NAMES.get(code),
            congestion_nm=rows_by_code[code].congestion_nm if code in rows_by_code else None,
            observed_at=rows_by_code[code].observed_at.isoformat() if code in rows_by_code else None,
        )
        for code in sorted(codes_with_history)
    ]
```

This keeps `codes_with_history` (any-day) for deciding *which* codes appear at all —
identical to the old behavior — and only scopes the "which row is latest" question to
today, which is the actual fix.

- [ ] **Step 4: Update the `MmcaRoomStatus` schema comment**

In `backend/app/schemas.py:34-40`, replace the `observed_at` comment:

```python
class MmcaRoomStatus(BaseModel):
    space_code: str
    space_nm: str | None
    congestion_nm: str | None
    # None when there's no reading yet today — either a permanently-disabled
    # room with no collection history at all (see MMCA_DISABLED_SPACE_CODES),
    # or a normal room that just hasn't had its first poll of the day yet.
    observed_at: str | None
```

- [ ] **Step 5: Run the full test file to verify everything passes**

Run: `cd backend && .venv/bin/pytest tests/test_routes_mmca.py -v`
Expected: all tests PASS, including the 3 from Step 1 and every pre-existing test.

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && .venv/bin/pytest`
Expected: PASS (no other route touches `mmca_rooms`, but this confirms nothing
else regressed).

- [ ] **Step 7: Commit**

```bash
git add backend/app/routes/mmca.py backend/app/schemas.py backend/tests/test_routes_mmca.py
git commit -m "fix(be): stop /mmca/rooms falling back to a stale prior-day reading"
```

---

### Task 2: Frontend — `MmcaRoomInactiveCard` component

**Files:**
- Create: `frontend/src/components/MmcaRoomInactiveCard.tsx`
- Test: `frontend/tests/MmcaRoomInactiveCard.test.tsx`

**Interfaces:**
- Consumes: `MmcaRoomStatus` type from `frontend/src/api/mmca.ts` (unchanged).
- Produces: `MmcaRoomInactiveCard({ room, reason }: { room: MmcaRoomStatus; reason: string })` — a
  small card showing the room's title (falls back to `space_code` when `space_nm` is null,
  same rule as `MmcaRoomChartCard`) and a one-line `reason` string. Task 3 renders one of
  these per room in `MmcaPage`'s `inactiveRooms` array, passing `"서비스 예정"` for
  permanently-disabled rooms and `"오늘 정보 없음"` for open rooms with no data today.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/MmcaRoomInactiveCard.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MmcaRoomInactiveCard } from "../src/components/MmcaRoomInactiveCard";
import type { MmcaRoomStatus } from "../src/api/mmca";

function makeRoom(overrides: Partial<MmcaRoomStatus> = {}): MmcaRoomStatus {
  return {
    space_code: "MMCA-SPACE-2008",
    space_nm: "1층 어린이미술관",
    congestion_nm: null,
    observed_at: null,
    ...overrides,
  };
}

describe("MmcaRoomInactiveCard", () => {
  it("renders the room title and the given reason", () => {
    render(<MmcaRoomInactiveCard room={makeRoom()} reason="서비스 예정" />);

    expect(screen.getByText("1층 어린이미술관")).toBeInTheDocument();
    expect(screen.getByText("서비스 예정")).toBeInTheDocument();
  });

  it("falls back to the space code as the title when the room has no name yet", () => {
    render(<MmcaRoomInactiveCard room={makeRoom({ space_nm: null })} reason="오늘 정보 없음" />);

    expect(screen.getByText("MMCA-SPACE-2008")).toBeInTheDocument();
    expect(screen.getByText("오늘 정보 없음")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/MmcaRoomInactiveCard.test.tsx`
Expected: FAIL — `Cannot find module '../src/components/MmcaRoomInactiveCard'`

- [ ] **Step 3: Write the component**

Create `frontend/src/components/MmcaRoomInactiveCard.tsx`:

```tsx
import type { MmcaRoomStatus } from "../api/mmca";

export function MmcaRoomInactiveCard({ room, reason }: { room: MmcaRoomStatus; reason: string }) {
  const title = room.space_nm ?? room.space_code;

  return (
    <div className="relative overflow-hidden rounded-apple border border-hairline/60 bg-white/70 p-4 shadow-apple backdrop-blur-xl">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-soft">{title}</p>
      <p className="mt-2 text-sm font-semibold text-ink-soft">{reason}</p>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run tests/MmcaRoomInactiveCard.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/MmcaRoomInactiveCard.tsx frontend/tests/MmcaRoomInactiveCard.test.tsx
git commit -m "feat(fe): add small card component for inactive MMCA rooms"
```

---

### Task 3: Frontend — group inactive rooms in `MmcaPage`

**Files:**
- Modify: `frontend/src/pages/MmcaPage.tsx`
- Modify: `frontend/src/components/MmcaRoomChartCard.tsx:1-6,118-125`
- Modify: `frontend/src/api/mmca.ts:7-8` (doc comment only)
- Modify: `frontend/tests/MmcaRoomChartCard.test.tsx` (remove the disabled-room test, now covered via `MmcaPage`)
- Test: `frontend/tests/MmcaPage.test.tsx` (add 3 new tests)

**Interfaces:**
- Consumes: `MmcaRoomInactiveCard` from Task 2, `DISABLED_MMCA_SPACE_CODES` from
  `frontend/src/lib/mmcaDisabledRooms.ts` (unchanged), `MmcaRoomStatus` type.
- Produces: `MmcaPage` renders two grids — `activeRooms` (unchanged `MmcaRoomChartCard`
  grid) and `inactiveRooms` (new `MmcaRoomInactiveCard` grid, classes
  `grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6`). `MmcaRoomChartCard` no longer
  special-cases disabled rooms — callers must not pass it a disabled room's status.

- [ ] **Step 1: Write the failing tests**

In `frontend/tests/MmcaRoomChartCard.test.tsx`, delete the test
`"shows '서비스 예정' instead of the chart for a disabled room, keeping the title"`
(lines 101-117) — this behavior is moving to `MmcaPage` + `MmcaRoomInactiveCard`.

In `frontend/tests/MmcaPage.test.tsx`, add these 3 tests at the end of the
`describe("MmcaPage", ...)` block, before the final closing `});`:

```tsx
  it("groups permanently-disabled rooms into small inactive cards below the active grid", async () => {
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([
      makeRoom({ space_code: "MMCA-SPACE-2001" }),
      makeRoom({
        space_code: "MMCA-SPACE-2008",
        space_nm: "1층 어린이미술관",
        congestion_nm: null,
        observed_at: null,
      }),
    ]);

    const { container } = render(
      <MemoryRouter>
        <MmcaPage venue="gwacheon" title="국립현대미술관 과천관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByTestId("mmca-room-chart")).toHaveLength(1));
    expect(screen.getByText("서비스 예정")).toBeInTheDocument();
    expect(screen.getByText("1층 어린이미술관")).toBeInTheDocument();

    const sections = container.querySelectorAll("section");
    const inactiveSection = Array.from(sections).find((s) => s.textContent?.includes("서비스 예정"));
    expect(inactiveSection?.className).toMatch(/lg:grid-cols-6/);
  });

  it("groups open rooms with no data collected today into small inactive cards", async () => {
    vi.setSystemTime(new Date("2026-07-28T11:00:00")); // Tuesday, within 10:00-18:00
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([
      makeRoom(),
      makeRoom({
        space_code: "MMCA-SPACE-1002",
        space_nm: "2전시실",
        congestion_nm: null,
        observed_at: null,
      }),
    ]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByTestId("mmca-room-chart")).toHaveLength(1));
    expect(screen.getByText("오늘 정보 없음")).toBeInTheDocument();
    expect(screen.getByText("2전시실")).toBeInTheDocument();
  });

  it("keeps a full-size card for a no-data room when the venue isn't open yet", async () => {
    vi.setSystemTime(new Date("2026-07-28T09:00:00")); // Tuesday, before 10:00 open
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom({ congestion_nm: null, observed_at: null })]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByTestId("mmca-room-chart")).toBeInTheDocument());
    expect(screen.queryByText("오늘 정보 없음")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run tests/MmcaPage.test.tsx tests/MmcaRoomChartCard.test.tsx`
Expected: the 3 new `MmcaPage` tests FAIL (no partitioning/inactive grid exists yet);
existing `MmcaRoomChartCard` tests PASS as before (the deleted test is simply gone).

- [ ] **Step 3: Remove the disabled-room branch from `MmcaRoomChartCard`**

In `frontend/src/components/MmcaRoomChartCard.tsx`, delete line 5:

```tsx
import { DISABLED_MMCA_SPACE_CODES } from "../lib/mmcaDisabledRooms";
```

and delete the early-return block at lines 118-125:

```tsx
  if (DISABLED_MMCA_SPACE_CODES.has(spaceCode)) {
    return (
      <div className="relative overflow-hidden rounded-apple border border-hairline/60 bg-white/70 p-8 shadow-apple backdrop-blur-xl motion-safe:animate-rise-in sm:p-10">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-soft">{title}</p>
        <p className="mt-6 text-2xl font-semibold text-ink-soft">서비스 예정</p>
      </div>
    );
  }
```

- [ ] **Step 4: Wire up partitioning in `MmcaPage`**

In `frontend/src/pages/MmcaPage.tsx`, add imports (alongside the existing ones):

```tsx
import { MmcaRoomInactiveCard } from "../components/MmcaRoomInactiveCard";
import { DISABLED_MMCA_SPACE_CODES } from "../lib/mmcaDisabledRooms";
```

Replace lines 68-70:

```tsx
  const now = new Date();
  const { open, close, isOpenToday } = mmcaBusinessHours(venue, now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
```

with:

```tsx
  const now = new Date();
  const { open, close, isOpenToday } = mmcaBusinessHours(venue, now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  // Mirrors MmcaRoomChartCard's own isOpen formula — needed here too since
  // partitioning happens a level above that component.
  const isOpen = isOpenToday && nowMinutes >= open && nowMinutes <= close;

  const isRoomInactiveToday = (room: MmcaRoomStatus) =>
    DISABLED_MMCA_SPACE_CODES.has(room.space_code) || (isOpen && room.congestion_nm == null);

  const activeRooms = rooms?.filter((room) => !isRoomInactiveToday(room)) ?? [];
  const inactiveRooms = rooms?.filter(isRoomInactiveToday) ?? [];
```

Replace the rendering block at lines 91-105:

```tsx
        {rooms && (
          <section className={`grid gap-6${rooms.length > 1 ? " lg:grid-cols-2" : ""}`}>
            {rooms.map((room) => (
              <MmcaRoomChartCard
                key={room.space_code}
                room={room}
                daily={daily}
                open={open}
                close={close}
                nowMinutes={nowMinutes}
                isOpenToday={isOpenToday}
              />
            ))}
          </section>
        )}
```

with:

```tsx
        {activeRooms.length > 0 && (
          <section className={`grid gap-6${activeRooms.length > 1 ? " lg:grid-cols-2" : ""}`}>
            {activeRooms.map((room) => (
              <MmcaRoomChartCard
                key={room.space_code}
                room={room}
                daily={daily}
                open={open}
                close={close}
                nowMinutes={nowMinutes}
                isOpenToday={isOpenToday}
              />
            ))}
          </section>
        )}
        {inactiveRooms.length > 0 && (
          <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {inactiveRooms.map((room) => (
              <MmcaRoomInactiveCard
                key={room.space_code}
                room={room}
                reason={DISABLED_MMCA_SPACE_CODES.has(room.space_code) ? "서비스 예정" : "오늘 정보 없음"}
              />
            ))}
          </section>
        )}
```

- [ ] **Step 5: Update the `api/mmca.ts` doc comment**

In `frontend/src/api/mmca.ts:7-8`, replace:

```tsx
  // null only for a permanently-disabled room with no collection history
  // yet (see DISABLED_MMCA_SPACE_CODES); every real reading has one.
```

with:

```tsx
  // null when there's no reading yet today — either a permanently-disabled
  // room with no collection history at all (see DISABLED_MMCA_SPACE_CODES),
  // or a normal room that just hasn't had its first poll of the day yet.
```

- [ ] **Step 6: Run the frontend tests to verify they pass**

Run: `cd frontend && npx vitest run tests/MmcaPage.test.tsx tests/MmcaRoomChartCard.test.tsx tests/MmcaRoomInactiveCard.test.tsx`
Expected: all PASS.

- [ ] **Step 7: Run the full frontend suite and type-check**

Run: `cd frontend && npm run test && npm run type-check`
Expected: both PASS (confirms `DISABLED_MMCA_SPACE_CODES` removal from
`MmcaRoomChartCard.tsx` didn't leave anything else depending on it there, and no
other test relied on the removed disabled-room branch).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/MmcaPage.tsx frontend/src/components/MmcaRoomChartCard.tsx frontend/src/api/mmca.ts frontend/tests/MmcaPage.test.tsx frontend/tests/MmcaRoomChartCard.test.tsx
git commit -m "feat(fe): group inactive MMCA rooms into a small-card grid below active rooms"
```

---

## Manual verification (after all tasks)

- [ ] Run `./dev.sh` (or the project's normal dev startup) and open an MMCA venue page during business hours. Confirm rooms with real data render as before, and any room that legitimately has no data today (0002) renders as a small card in a row of up to 6, below the active-room grid.
- [ ] Confirm a permanently-disabled room (Gwacheon's children's museum, MMCA-SPACE-2008) still shows "서비스 예정" but now inside the small-card grid rather than a full-size card.
- [ ] Confirm a venue with zero active rooms right now (all inactive) doesn't render an empty full-size grid section (the `activeRooms.length > 0` guard should hide it).
