# MMCA: today-only congestion + grouped inactive room cards

## Problem

`GET /mmca/rooms` picks the latest reading per room via a global `MAX(id)`
with no date filter (`backend/app/routes/mmca.py:15-62`). If a room has zero
rows for *today* yet — e.g. the venue's business hours have started but the
collector's first daily poll (10:10) hasn't run — the endpoint silently
returns yesterday's last real reading. Rooms show a congestion level that is
no longer true.

Separately, once a room genuinely has no data today (upstream MMCA API
returned `resultCode` `0002`, no ongoing exhibition — stored as
`congestion_nm = NULL`), its card still renders full-size in the same
`lg:grid-cols-2` grid as rooms with real data, wasting space and drawing the
same visual attention as an active room.

## Scope

- Applies to all three MMCA venues (seoul, gwacheon, deoksugung).
- "Inactive today" grouping applies only when the venue is currently open
  (`isOpen`) and the room has no `congestion_nm` for today. Rooms that are
  simply before opening or closed for the day keep their existing full-size
  card with the current "영업 시간이 아닙니다" / "휴관일입니다" text —
  unchanged.
  - **Superseded 2026-08-06**: the `isOpen` gate is gone. A room now gets a
    full-size card only if it has a curve to show — before opening and on
    closed days that means last week's same-weekday data, and from opening
    onward (including after close) today's data. See `MmcaPage.tsx`'s
    `beforeOpen` / `loadedWithNoReading`.
- Permanently-disabled rooms (`DISABLED_MMCA_SPACE_CODES`) are folded into
  the same "inactive" small-card treatment instead of keeping their own
  separate card style, since they're already a subset of "no usable data."

## Backend change

`backend/app/routes/mmca.py` — `mmca_rooms()`:

1. Split the existing "no rows" 503-vs-placeholder check from the
   "latest per room" lookup. The 503 check (has this venue *ever* collected
   any data) stays scoped to all history, so it keeps returning 503 only for
   a genuinely empty/fresh DB — not for a normal room that simply hasn't
   been polled yet today.
2. Scope the "latest per room" query (`func.max(RawMmcaCongestion.id)`) to
   `observed_at >= day_start` (today's midnight, same boundary pattern
   `/mmca/daily` already uses).
3. Every code in the venue's space-code list appears in the response. A code
   with no row today gets `congestion_nm=None, observed_at=None` (same shape
   already used for permanently-disabled rooms) instead of falling back to
   an older row.

No new response field is needed — the frontend already special-cases
permanently-disabled rooms via a static set before it ever looks at
`congestion_nm`, and does the same for "no data today" per the frontend
change below.

Update the `MmcaRoomStatus.observed_at` docstring comment
(`backend/app/schemas.py:38-39`), since `None` will no longer mean only
"permanently disabled" — it also means "no data yet today."

### Tests

`backend/tests/test_routes_mmca.py`'s existing "latest reading" tests
hardcode a fixed past date (`datetime(2026, 7, 24, ...)`) as a stand-in for
"today." Once the query is day-scoped, these need to use dates relative to
`datetime.now()` (or an equivalent helper) so they don't start failing
against the real wall clock. Add a new test asserting that a room with only
a stale (yesterday-or-earlier) row returns `congestion_nm=None` today
instead of the stale value.

## Frontend change

`frontend/src/pages/MmcaPage.tsx`:

- Partition `rooms` into `activeRooms` and `inactiveRooms`:
  - inactive = `DISABLED_MMCA_SPACE_CODES.has(room.space_code)` OR
    (`isOpen && room.congestion_nm == null`)
  - active = everything else
- Render `activeRooms` in the existing grid
  (`grid gap-6 lg:grid-cols-2` when more than one room).
- Render `inactiveRooms` below it in a new, denser grid:
  `grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6`.

New component `frontend/src/components/MmcaRoomInactiveCard.tsx`:
- Small card: room title + one short status line.
  - Disabled room → "서비스 예정" (unchanged copy)
  - Open, no data today → "오늘 정보 없음"
- `MmcaPage.tsx` picks the label per room and passes it in.

`frontend/src/components/MmcaRoomChartCard.tsx`:
- Remove the inline disabled-room early return (lines 118-125) and the
  `DISABLED_MMCA_SPACE_CODES` import — this component now only ever
  receives rooms that have (or may still get) real chart data today.

## Out of scope

- No change to `/mmca/daily` (already day-scoped correctly).
- No change to the before-opening / closed-for-the-day full-size card text.
- No change to the empty-room recheck cadence in `collector.py`.
