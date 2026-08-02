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
- Hover (`handleHoverMove` / tooltip): per hover position, find the nearest
  point independently in *each* series (this week, this-week's `isRaw`
  markers excluded as today) and compare which one is actually closer to
  the hovered x — not a single day-level "does this week have any data at
  all" switch. This matters once today is partway through: today's points
  cluster near the current time, so hovering further along the axis (a
  time slot today hasn't reached yet) is genuinely closer to last week's
  point there than to today's last real reading, and must show the
  standalone last-week tooltip rather than re-anchoring to today's most
  recent value. (A same-day-only, whole-chart-empty check was the first
  cut, but it made the standalone tooltip unreachable during the common
  case — today open, partially populated — so it was replaced with this
  per-position nearest-of-both-series comparison before implementation
  landed.)
  - Whichever series' nearest point wins becomes the tooltip's primary
    value. If this week wins, additionally look up the last-week point
    nearest that same minute (within one bucket width `BUCKET_MINUTES`);
    if one exists, append it in muted text: `1,200명 (지난주 980명)`. If
    none exists nearby, the tooltip renders the this-week value alone.
  - If last week wins, the tooltip shows just the last-week value on its
    own, labeled — e.g. `지난주 980명` — not the parenthetical form, since
    there's no relevant this-week number to attach it to.
  - Note for later: once a same-day prediction curve exists for the
    "now → close" portion of the chart, that will supersede this
    corner — hovering a future time slot will have a predicted this-week
    value to show instead of falling through to last week. Out of scope
    for this feature; noted so the two don't conflict later.

## `MmcaRoomChartCard`

- New prop `lastWeekDaily: MmcaDailyLogPoint[] | null`.
- Build `lastWeekPoints` the same way as the existing `points` (tier lookup
  by `space_code`), filtered to `{ open, close }`.
- y-scale here is already absolute (`yOf`: fixed tier 0–3 positions) — no
  scale change needed, just render the second series.
- Same grey-line styling as above (`#C7C7CC`, width 2, no fill/glow/dot).
- Hover: same per-position nearest-of-both-series comparison as
  `CongestionCard` (see above) — find the nearest point in each series
  independently and let whichever is actually closer to the hovered x win,
  rather than a day-level switch. If this week wins, look up the nearest
  last-week point to that minute and append its tier label to the existing
  tooltip in muted text, e.g. `보통 (지난주 여유)` — omitted if nothing
  nearby. If last week wins, show the last-week label alone (`지난주
  여유`).

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

## Post-implementation adjustments (after PR review)

Two details above are stale as written — corrected here rather than
rewritten in place, since a PR reviewer already read the original text
against the current code:

- **Grey line color and area fill.** "`smoothPath()` helper: stroke
  `#C7C7CC`, width 2 ... no area fill" (both `CongestionCard` and
  `MmcaRoomChartCard` sections) reflects the color chosen during initial
  brainstorming, before the user asked (in a later turn) to match a
  reference site's chart styling. The shipped values, sampled directly
  from that reference's rendered SVG: stroke `#D1D1D1`, and a filled area
  under the grey line — flat `#D9D9D9` at 20% opacity, painted *before*
  (i.e. beneath) the grey line and the blue area/line, so blue stays
  visually on top wherever the two overlap. Both constants live in
  `frontend/src/lib/chartColors.ts` as `LAST_WEEK_STROKE`/`LAST_WEEK_FILL`,
  shared by both chart components. A small date-labeled legend was also
  added above each chart ("8/2(일) 오늘" / "7/26(일) 지난주"), matching the
  same reference.
- **Match window is half a bucket, not a full one.** "within one bucket
  width `BUCKET_MINUTES`" (`CongestionCard` section) undersold the risk: since
  both series resample onto the identical bucket grid, a genuine same-time
  match is always distance 0, and the *next* bucket over is always exactly
  `BUCKET_MINUTES` away. A full-bucket-width window could therefore match
  the adjacent (different-time) bucket instead of correctly finding no
  match. Shipped as `BUCKET_MINUTES / 2`, which only ever admits distance 0.

## Out of scope

- No date picker / configurable comparison window — always exactly 7 days
  back.
- No change to `DailyLogTable` / `MmcaDailyLogTable` (table view unaffected).
- No change to `PredictionChart` (unrelated chart, not a congestion-history
  view).
