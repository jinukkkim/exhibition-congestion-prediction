# Last-week comparison line on congestion charts

## Problem

`CongestionCard` (국립중앙박물관 홈) and `MmcaRoomChartCard` (MMCA venue
pages, one per room) each plot only today's readings. There's no way to see
whether today is busier or quieter than a typical day without cross-checking
the daily log table. Add a second, grey reference line showing the same
weekday last week, on both chart types, with its value surfaced on hover
alongside today's.

## Scope

- Both chart types: `CongestionCard` and `MmcaRoomChartCard`.
- Reference date is fixed at exactly 7 days ago (same weekday) — no picker,
  no configurability.
- When last week has no data near the hovered time (collection hadn't
  started yet, that day was closed, etc.), the grey line/tooltip line for
  that point is simply omitted. No "no data" messaging.
- When *this week* has no data yet (e.g. right after opening, before the
  first poll) but last week does, the grey line still draws on its own —
  the chart area is no longer gated on this-week having points. See "Chart
  visible with only last week" below.

## Data

No backend change. `/congestion/daily` and `/mmca/daily` already accept an
arbitrary `date` query param. Fetch last week's data with
`shiftDate(todayString(), -7)` (`frontend/src/lib/date.ts`, already used by
the daily log tables).

`NationalMuseumPage.tsx`: add `lastWeekDaily` state, fetched once on mount
via `fetchDaily(shiftDate(todayString(), -7))`, same null-on-error handling
as the existing `daily` fetch. Passed to `CongestionCard` as a new prop.

`MmcaPage.tsx`: add `lastWeekDaily` state, fetched once per `venue` change
via `fetchMmcaDaily(venue, shiftDate(todayString(), -7))`. This is
historical/static data, so it does **not** join the existing 60s poll
interval — one fetch per venue is enough. Passed to `MmcaRoomChartCard` as a
new prop (same array, every room reads its own room out of it, mirroring how
`daily` already works).

## `CongestionCard`

- New prop `lastWeekDaily: DailyLogPoint[] | null`.
- Build a `lastWeekPoints`/resampled series the exact same way as the
  existing `rawPoints`/`resampled` (reuse `resample()`), filtered to
  *today's* `{ open, close }` window — last week is the same weekday, so
  business hours normally match; if they don't, points outside today's
  window are simply dropped, same as any other out-of-range point.
- **Shared y-scale.** `toXY()` currently normalizes a series to its own
  min/max, which is fine for a single series but would make an overlaid
  grey line always span the full chart height regardless of its actual
  magnitude relative to this week — misleading for a comparison. Change
  `toXY()` to accept an externally-supplied `[min, max]` instead of deriving
  it from the passed points; compute one combined `[min, max]` from both
  series' values and pass it to both calls.
- Render the grey series as a second `<path>` using the existing
  `smoothPath()` helper: stroke `#C7C7CC`, width 2 (vs. the blue line's
  2.5), no area fill, no glow/end-dot (those affordances mean
  "live/primary", which this isn't).
- Hover (`handleHoverMove` / tooltip): keep hit-testing against this week's
  points as today. Additionally look up the last-week resampled point
  nearest the hovered bucket's minute; if one exists within one bucket
  width, append its value to the same tooltip box in muted/grey text, e.g.
  `1,200명 (지난주 980명)`. If none exists nearby, the tooltip renders
  exactly as it does today. If this week has no point at the hovered
  position but a last-week one exists (only-last-week case, see below),
  the tooltip shows just the last-week value on its own, labeled — e.g.
  `지난주 980명` — not the parenthetical form, since there's no this-week
  number to attach it to.

## `MmcaRoomChartCard`

- New prop `lastWeekDaily: MmcaDailyLogPoint[] | null`.
- Build `lastWeekPoints` the same way as the existing `points` (tier lookup
  by `space_code`), filtered to `{ open, close }`.
- y-scale here is already absolute (`yOf`: fixed tier 0–3 positions) — no
  scale change needed, just render the second series.
- Same grey-line styling as above (`#C7C7CC`, width 2, no fill/glow/dot).
- Hover: same pattern — look up the nearest last-week point to the hovered
  minute and append its tier label to the existing tooltip in muted text,
  e.g. `보통 (지난주 여유)`. Omitted if nothing nearby. If this week has no
  point at the hovered position but last week does, show the last-week
  label alone (`지난주 여유`), same as `CongestionCard`.

## Chart visible with only last week

Both charts currently gate the whole plotted area on this-week having
points (`CongestionCard`: `{daily && xy.length > 0 && (...)}`;
`MmcaRoomChartCard`: `{linePath && (...)}`, itself gated on
`renderPoints.length > 1`). That means right after opening, before the
first poll lands, the chart area is just empty — even though last week's
full curve is available and would be a useful reference for "here's what
today will probably look like."

Change the gate to "either series has points": render the chart area
(axes/ticks + whichever line(s) actually have data) as soon as this week
*or* last week has plottable points, not only when this week does. The
blue line/area/glow keep their existing this-week-only gating (no blue
line to draw if there's nothing to draw). The grey line draws whenever the
last-week series has points, independent of this week.

This also affects the shared y-scale in `CongestionCard`: `[min, max]` must
be computed from whichever series is non-empty (union of both values
arrays), guarding against `Math.min()/Math.max()` over an empty array
(`Infinity`/`-Infinity`) when one side has no points yet.

## Testing

Extend `frontend/tests/CongestionCard.test.tsx` and
`frontend/tests/MmcaRoomChartCard.test.tsx`:

- Grey line renders when `lastWeekDaily` has data in range.
- Grey line is absent when `lastWeekDaily` is `null` or empty (existing
  today-only behavior unchanged).
- Hovering surfaces both values in the tooltip when last-week data exists
  near that time; hovering where only this-week data exists shows the
  unchanged single-value tooltip.
- Grey line (and its ticks/axis) still renders when this week's `daily` is
  `null`/empty but `lastWeekDaily` has points; hovering that chart shows
  the last-week-only tooltip format.

## Out of scope

- No date picker / configurable comparison window — always exactly 7 days
  back.
- No change to `DailyLogTable` / `MmcaDailyLogTable` (table view unaffected).
- No change to `PredictionChart` (unrelated chart, not a congestion-history
  view).
