# Last-Week Comparison Line Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a grey reference line for "this weekday, last week" to `CongestionCard` and `MmcaRoomChartCard`, with its value surfaced on hover alongside this week's.

**Architecture:** No backend change — `/congestion/daily` and `/mmca/daily` already take an arbitrary `date`. Each page fetches a second dataset for `shiftDate(todayString(), -7)` and passes it to the chart component as a new optional prop. Each chart component builds a second point series from that prop using its existing point-building logic, renders it as a plain grey path, and extends its hover lookup to also report the nearest last-week point.

**Tech Stack:** React + TypeScript (Vite), Vitest + Testing Library for unit tests, Playwright for e2e (unchanged).

## Global Constraints

- Reference date is always exactly 7 days back — no picker, no configurability.
- Missing/out-of-range last-week data at a given time is omitted silently — never an explicit "no data" message.
- The chart area renders as soon as *either* series (this week or last week) has plottable points — not gated on this week alone.
- Grey line styling everywhere: stroke `#C7C7CC`, width `2`, no fill, no glow, no end-dot.
- Tooltip: when both series have a value near the hovered time, combine as `{value} (지난주 {value})`; when only last week has a value there, show `지난주 {value}` alone (no parenthetical, no this-week number).
- Spec: `docs/superpowers/specs/2026-08-02-last-week-comparison-line-design.md`

---

### Task 1: `CongestionCard` — shared-scale grey line + merged hover tooltip

**Files:**
- Modify: `frontend/src/components/CongestionCard.tsx`
- Test: `frontend/tests/CongestionCard.test.tsx`

**Interfaces:**
- Consumes: `DailyLogPoint` from `frontend/src/api/congestion.ts` (unchanged).
- Produces: `CongestionCard` gains an optional prop `lastWeekDaily?: DailyLogPoint[] | null` (defaults to `null`). All other exports/props unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/tests/CongestionCard.test.tsx` (inside the existing `describe("CongestionCard", ...)` block, after the last existing `it`):

```tsx
  it("renders a grey last-week line alongside this week's when both have data", () => {
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={[dailyPoint("2026-07-15T10:00:00", 800), dailyPoint("2026-07-15T14:30:00", 1500)]}
        lastWeekDaily={[dailyPoint("2026-07-08T10:00:00", 600), dailyPoint("2026-07-08T14:30:00", 900)]}
      />
    );

    expect(screen.getByTestId("sparkline-line")).toBeInTheDocument();
    expect(screen.getByTestId("sparkline-last-week-line")).toBeInTheDocument();
  });

  it("omits the last-week line when lastWeekDaily is null or empty", () => {
    const { rerender } = render(
      <CongestionCard
        data={{ observed_at: "2026-07-15T14:30:00", congest_level: "보통", population_avg: 1500 }}
        daily={[dailyPoint("2026-07-15T10:00:00", 800), dailyPoint("2026-07-15T14:30:00", 1500)]}
        lastWeekDaily={null}
      />
    );
    expect(screen.queryByTestId("sparkline-last-week-line")).not.toBeInTheDocument();

    rerender(
      <CongestionCard
        data={{ observed_at: "2026-07-15T14:30:00", congest_level: "보통", population_avg: 1500 }}
        daily={[dailyPoint("2026-07-15T10:00:00", 800), dailyPoint("2026-07-15T14:30:00", 1500)]}
        lastWeekDaily={[]}
      />
    );
    expect(screen.queryByTestId("sparkline-last-week-line")).not.toBeInTheDocument();
  });

  it("shows the grey line on its own when this week has no data yet but last week does", () => {
    render(
      <CongestionCard
        data={{ observed_at: "2026-07-15T14:30:00", congest_level: "보통", population_avg: 1500 }}
        daily={[]}
        lastWeekDaily={[dailyPoint("2026-07-08T10:00:00", 600), dailyPoint("2026-07-08T14:30:00", 900)]}
      />
    );

    expect(screen.getByTestId("history-sparkline")).toBeInTheDocument();
    expect(screen.getByTestId("sparkline-last-week-line")).toBeInTheDocument();
    expect(screen.queryByTestId("sparkline-line")).not.toBeInTheDocument();
  });

  it("shows both values in the tooltip when hovering a time both weeks have data near", () => {
    const { container } = render(
      <CongestionCard
        data={{ observed_at: "2026-07-15T14:30:00", congest_level: "보통", population_avg: 1500 }}
        daily={[dailyPoint("2026-07-15T10:00:00", 800), dailyPoint("2026-07-15T10:15:00", 1000)]}
        lastWeekDaily={[dailyPoint("2026-07-08T10:00:00", 600), dailyPoint("2026-07-08T10:15:00", 700)]}
      />
    );

    const svg = screen.getByTestId("history-sparkline");
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 480, height: 200, right: 480, bottom: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const hoverTarget = container.querySelector('rect[fill="transparent"]') as SVGRectElement;

    fireEvent.mouseMove(hoverTarget, { clientX: 0, clientY: 0 });

    expect(screen.getByText(/지난주/)).toBeInTheDocument();
  });

  it("shows the standalone '지난주' tooltip when hovering with only last-week data", () => {
    const { container } = render(
      <CongestionCard
        data={{ observed_at: "2026-07-15T14:30:00", congest_level: "보통", population_avg: 1500 }}
        daily={[]}
        lastWeekDaily={[dailyPoint("2026-07-08T10:00:00", 600), dailyPoint("2026-07-08T10:15:00", 700)]}
      />
    );

    const svg = screen.getByTestId("history-sparkline");
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 480, height: 200, right: 480, bottom: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const hoverTarget = container.querySelector('rect[fill="transparent"]') as SVGRectElement;

    fireEvent.mouseMove(hoverTarget, { clientX: 0, clientY: 0 });

    expect(screen.getByText(/지난주/)).toBeInTheDocument();
    expect(screen.queryByText(/\(지난주/)).not.toBeInTheDocument();
  });
```

Add `fireEvent` to the existing `import { render, screen } from "@testing-library/react";` line, making it `import { fireEvent, render, screen } from "@testing-library/react";`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run tests/CongestionCard.test.tsx`
Expected: FAIL — `lastWeekDaily` prop doesn't exist yet / `sparkline-last-week-line` testid not found.

- [ ] **Step 3: Implement**

Replace the full contents of `frontend/src/components/CongestionCard.tsx` with:

```tsx
import { useRef, useState, type MouseEvent } from "react";

import type { CurrentCongestion, DailyLogPoint } from "../api/congestion";
import { CHART_BLUE, CHART_SKY } from "../lib/chartColors";
import { statusOf } from "../lib/status";

const SPARKLINE_WIDTH = 480;
const SPARKLINE_HEIGHT = 200;
const LAST_WEEK_STROKE = "#C7C7CC";

const OPEN_MINUTES = 9 * 60 + 30; // 09:30, every day
const LONG_CLOSE_DAYS = new Set([3, 6]); // Wed, Sat: 21:00 close; other days: 17:30

function businessHours(date: Date): { open: number; close: number } {
  const close = LONG_CLOSE_DAYS.has(date.getDay()) ? 21 * 60 : 17 * 60 + 30;
  return { open: OPEN_MINUTES, close };
}

function minutesOfDay(isoString: string): number {
  return Number(isoString.slice(11, 13)) * 60 + Number(isoString.slice(14, 16));
}

function formatMinutes(minutes: number): string {
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

// A round hour (e.g. close=21:00 on Wed/Sat) gets the bare-number treatment
// too, same as the in-between ticks — only a genuinely half-hour time (09:30,
// or close=17:30 on other days) needs the full HH:MM.
function tickLabel(minutes: number): string {
  return minutes % 60 === 0 ? String(minutes / 60) : formatMinutes(minutes);
}

// Open/close are kept as exact bookend ticks even though they're not always
// on the hour, since that's where the line actually starts/ends. Everything
// in between is a clean round hour, shown as a bare hour number ("10", "11")
// rather than "10:00" — short enough to sit next to most neighbors, but open
// is always exactly 30min from the next hour, too little gap for any label
// (measured: labels a fraction of a pixel apart, reads as touching) — so a
// round hour within MIN_GAP_MINUTES of a bookend is dropped instead of
// rendered on top of it.
const MIN_GAP_MINUTES = 35;

function hourlyTicks(open: number, close: number): { minutes: number; label: string }[] {
  const ticks: number[] = [];
  const firstRoundHour = Math.ceil(open / 60) * 60;
  for (let m = firstRoundHour; m < close; m += 60) {
    if (m - open < MIN_GAP_MINUTES || close - m < MIN_GAP_MINUTES) continue;
    ticks.push(m);
  }

  return [
    { minutes: open, label: tickLabel(open) },
    ...ticks.map((minutes) => ({ minutes, label: tickLabel(minutes) })),
    { minutes: close, label: tickLabel(close) },
  ];
}

type Point = { minutes: number; value: number; isRaw?: boolean };

const BUCKET_MINUTES = 30; // 30 divides both business-hour spans (480min / 690min) evenly, so buckets never fall short
const LAST_WEEK_MATCH_MINUTES = BUCKET_MINUTES; // how close a last-week bucket must be to the hovered time to surface in the tooltip

function resample(points: Point[], open: number, bucketMinutes: number): Point[] {
  const buckets = new Map<number, Point[]>();
  for (const point of points) {
    const idx = Math.floor((point.minutes - open) / bucketMinutes);
    const bucket = buckets.get(idx);
    if (bucket) bucket.push(point);
    else buckets.set(idx, [point]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([idx, bucketPoints]) => ({
      minutes: open + idx * bucketMinutes + bucketMinutes / 2,
      value: bucketPoints.reduce((sum, p) => sum + p.value, 0) / bucketPoints.length,
    }));
}

function nearestWithin(points: Point[], minutes: number, maxDistance: number): Point | undefined {
  let nearest: Point | undefined;
  let nearestDist = Infinity;
  for (const p of points) {
    const dist = Math.abs(p.minutes - minutes);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = p;
    }
  }
  return nearest && nearestDist <= maxDistance ? nearest : undefined;
}

function xOf(minutes: number, open: number, close: number): number {
  return ((minutes - open) / (close - open || 1)) * SPARKLINE_WIDTH;
}

type XY = { x: number; y: number };
type Range = { min: number; max: number };

function toXY(points: Point[], open: number, close: number, range: Range): XY[] {
  const span = range.max - range.min || 1; // ponytail: guards a flat/single-value range; a wider range never hits this
  return points.map(({ minutes, value }) => ({
    x: xOf(minutes, open, close),
    y: SPARKLINE_HEIGHT - ((value - range.min) / span) * SPARKLINE_HEIGHT,
  }));
}

// Centripetal Catmull-Rom -> cubic Bezier. Unlike the uniform variant (which
// weights every neighbor equally regardless of how close it is), this
// parametrizes each segment by sqrt(distance), so a point sitting unusually
// close to its neighbor (e.g. the 09:30 raw reading, ~15min from the first
// 30min bucket while every other point is a full bucket apart) contributes
// proportionally less to the tangent instead of bending the curve.
function smoothPath(xy: XY[]): string {
  const dist = (a: XY, b: XY) => Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)) || 1e-6;
  let d = `M ${xy[0].x} ${xy[0].y}`;
  for (let i = 0; i < xy.length - 1; i++) {
    const p0 = xy[i - 1] ?? xy[i];
    const p1 = xy[i];
    const p2 = xy[i + 1];
    const p3 = xy[i + 2] ?? p2;

    const t0 = 0;
    const t1 = t0 + dist(p0, p1);
    const t2 = t1 + dist(p1, p2);
    const t3 = t2 + dist(p2, p3);

    const m1x = (t2 - t1) * ((p1.x - p0.x) / (t1 - t0) - (p2.x - p0.x) / (t2 - t0) + (p2.x - p1.x) / (t2 - t1));
    const m1y = (t2 - t1) * ((p1.y - p0.y) / (t1 - t0) - (p2.y - p0.y) / (t2 - t0) + (p2.y - p1.y) / (t2 - t1));
    const m2x = (t2 - t1) * ((p2.x - p1.x) / (t2 - t1) - (p3.x - p1.x) / (t3 - t1) + (p3.x - p2.x) / (t3 - t2));
    const m2y = (t2 - t1) * ((p2.y - p1.y) / (t2 - t1) - (p3.y - p1.y) / (t3 - t1) + (p3.y - p2.y) / (t3 - t2));

    const cp1x = p1.x + m1x / 3;
    const cp1y = p1.y + m1y / 3;
    const cp2x = p2.x - m2x / 3;
    const cp2y = p2.y - m2y / 3;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function areaPath(xy: XY[], linePath: string): string {
  const first = xy[0];
  const last = xy[xy.length - 1];
  return `M ${first.x} ${SPARKLINE_HEIGHT} L ${first.x} ${first.y} ${linePath.slice(linePath.indexOf("C"))} L ${last.x} ${SPARKLINE_HEIGHT} Z`;
}

function bucketRange(centerMinutes: number, bucketMinutes: number): string {
  return `${formatMinutes(centerMinutes - bucketMinutes / 2)}–${formatMinutes(centerMinutes + bucketMinutes / 2)}`;
}

export function CongestionCard({
  data,
  daily = null,
  lastWeekDaily = null,
}: {
  data: CurrentCongestion | null;
  daily: DailyLogPoint[] | null;
  lastWeekDaily?: DailyLogPoint[] | null;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (!data) {
    return (
      <div className="flex min-h-[420px] items-center justify-center rounded-apple border border-hairline/60 bg-white/70 text-sm text-ink-soft shadow-apple backdrop-blur-xl motion-safe:animate-rise-in">
        불러오는 중...
      </div>
    );
  }

  const status = statusOf(data.congest_level);
  const now = new Date();
  const { open, close } = businessHours(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const isOpen = nowMinutes >= open && nowMinutes <= close;
  const openBadge = isOpen ? "실시간" : nowMinutes < open ? "영업 전" : "영업 종료";
  const rawPoints: Point[] = (daily ?? [])
    .map((row) => ({
      minutes: minutesOfDay(row.observed_at),
      value: (row.population_min + row.population_max) / 2,
    }))
    .filter((p) => p.minutes >= open && p.minutes <= close);
  const resampled = resample(rawPoints, open, BUCKET_MINUTES);
  const ticks = hourlyTicks(open, close);

  // Add one real point at the literal 09:30 reading (not a bucket average)
  // so the line reaches the opening mark using an actually-observed value.
  // Symmetric for closing time once business hours are over — while still
  // open, closing time hasn't happened yet, so no trailing point is added.
  // These are raw single readings, not bucket averages, so they're flagged
  // (`isRaw`) to show a single time in the tooltip instead of a range.
  const leadRaw: Point | null =
    rawPoints[0] && (resampled.length === 0 || rawPoints[0].minutes < resampled[0].minutes)
      ? { ...rawPoints[0], isRaw: true }
      : null;
  const trailRaw: Point | null =
    !isOpen && rawPoints.length > 0 && resampled.length > 0 && rawPoints[rawPoints.length - 1].minutes > resampled[resampled.length - 1].minutes
      ? { ...rawPoints[rawPoints.length - 1], isRaw: true }
      : null;
  const points: Point[] = [...(leadRaw ? [leadRaw] : []), ...resampled, ...(trailRaw ? [trailRaw] : [])];

  // Last week is always a fully-elapsed day, so it only ever needs the plain
  // bucketed series — none of the "reaches the live/closing moment" raw
  // endpoints above apply to a day that's already over.
  const lastWeekRawPoints: Point[] = (lastWeekDaily ?? [])
    .map((row) => ({
      minutes: minutesOfDay(row.observed_at),
      value: (row.population_min + row.population_max) / 2,
    }))
    .filter((p) => p.minutes >= open && p.minutes <= close);
  const lastWeekPoints = resample(lastWeekRawPoints, open, BUCKET_MINUTES);

  const hasThisWeek = points.length > 0;
  const allValues = [...points, ...lastWeekPoints].map((p) => p.value);
  const range: Range = allValues.length > 0 ? { min: Math.min(...allValues), max: Math.max(...allValues) } : { min: 0, max: 1 };

  const xy = hasThisWeek ? toXY(points, open, close, range) : [];
  const lastWeekXy = lastWeekPoints.length > 0 ? toXY(lastWeekPoints, open, close, range) : [];
  const linePath = xy.length > 1 ? smoothPath(xy) : "";
  const lastWeekLinePath = lastWeekXy.length > 1 ? smoothPath(lastWeekXy) : "";
  const areaD = xy.length > 1 ? areaPath(xy, linePath) : "";
  const lastPoint = xy[xy.length - 1];

  // Hover hit-tests against whichever series is actually on screen: this
  // week's points when present, otherwise last week's (only-last-week case).
  const hoverSeries = hasThisWeek ? xy : lastWeekXy;
  const hoverSeriesPoints = hasThisWeek ? points : lastWeekPoints;

  function handleHoverMove(event: MouseEvent<SVGRectElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * SPARKLINE_WIDTH;

    let nearest: number | null = null;
    let nearestDist = Infinity;
    hoverSeries.forEach((p, i) => {
      if (hoverSeriesPoints[i].isRaw) return; // 09:30/closing-time points don't show hover info
      const dist = Math.abs(p.x - svgX);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
    });
    setHoverIndex(nearest);
  }

  const hoverPoint = hoverIndex !== null ? hoverSeriesPoints[hoverIndex] : undefined;
  const hoverLastWeekMatch =
    hasThisWeek && hoverPoint ? nearestWithin(lastWeekPoints, hoverPoint.minutes, LAST_WEEK_MATCH_MINUTES) : undefined;

  return (
    <div className="relative overflow-hidden rounded-apple border border-hairline/60 bg-white/70 p-8 shadow-apple backdrop-blur-xl motion-safe:animate-rise-in sm:p-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(120% 100% at 12% 0%, ${isOpen ? status.wash : "rgba(142,142,147,0.1)"}, transparent 60%)`,
        }}
      />

      <div className="relative">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-soft">
              국립중앙박물관 · 현재 혼잡도
            </p>
            <p className="mt-1 text-[11px] text-ink-soft/70">
              오늘 영업시간 {formatMinutes(open)}–{formatMinutes(close)}
            </p>
          </div>
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-ink-soft">
            <span
              className={`h-1.5 w-1.5 rounded-full ${isOpen ? "motion-safe:animate-pulse-live" : ""}`}
              style={{ backgroundColor: isOpen ? status.core : "#C7C7CC" }}
            />
            {openBadge}
          </span>
        </div>

        <div className="mt-4">
          {isOpen ? (
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="text-7xl font-bold tracking-tight text-ink">{data.congest_level}</span>
              <span className="text-base text-ink-soft">
                <span className="font-mono tabular-nums">{Math.round(data.population_avg).toLocaleString()}</span>명 ·{" "}
                {data.observed_at.slice(11, 16)} 기준
              </span>
            </div>
          ) : (
            <span className="text-2xl font-semibold text-ink-soft">영업 시간이 아닙니다</span>
          )}
        </div>

        {(daily || lastWeekDaily) && (
          <div className="relative mt-8">
            <svg
              ref={svgRef}
              data-testid="history-sparkline"
              viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
              className="w-full overflow-visible"
            >
              {(xy.length > 0 || lastWeekXy.length > 0) && (
                <>
                  <defs>
                    <linearGradient id="sparkline-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART_SKY} stopOpacity="0.32" />
                      <stop offset="100%" stopColor={CHART_BLUE} stopOpacity="0" />
                    </linearGradient>
                    {isOpen && lastPoint && (
                      <radialGradient id="sparkline-glow">
                        <stop offset="0%" stopColor={CHART_BLUE} stopOpacity="0.5" />
                        <stop offset="100%" stopColor={CHART_BLUE} stopOpacity="0" />
                      </radialGradient>
                    )}
                  </defs>
                  {areaD && <path d={areaD} fill="url(#sparkline-fill)" />}
                  {lastWeekLinePath && (
                    <path
                      data-testid="sparkline-last-week-line"
                      d={lastWeekLinePath}
                      fill="none"
                      stroke={LAST_WEEK_STROKE}
                      strokeWidth={2}
                      strokeLinecap="round"
                    />
                  )}
                  {isOpen && lastPoint && (
                    <line
                      x1={lastPoint.x}
                      y1={lastPoint.y}
                      x2={lastPoint.x}
                      y2={SPARKLINE_HEIGHT}
                      stroke="#D2D2D7"
                      strokeWidth={1}
                      strokeDasharray="3 4"
                    />
                  )}
                  {linePath && (
                    <path
                      data-testid="sparkline-line"
                      d={linePath}
                      fill="none"
                      stroke={CHART_BLUE}
                      strokeWidth={2.5}
                      strokeLinecap="round"
                    />
                  )}
                  {isOpen && lastPoint && (
                    <>
                      <circle cx={lastPoint.x} cy={lastPoint.y} r={14} fill="url(#sparkline-glow)" />
                      <circle cx={lastPoint.x} cy={lastPoint.y} r={4.5} fill="#FFFFFF" stroke={CHART_BLUE} strokeWidth={2.5} />
                    </>
                  )}
                  {hoverIndex !== null && hoverSeries[hoverIndex] && (
                    <>
                      <line
                        x1={hoverSeries[hoverIndex].x}
                        y1={0}
                        x2={hoverSeries[hoverIndex].x}
                        y2={SPARKLINE_HEIGHT}
                        stroke="#D2D2D7"
                        strokeWidth={1}
                      />
                      <circle
                        cx={hoverSeries[hoverIndex].x}
                        cy={hoverSeries[hoverIndex].y}
                        r={4}
                        fill="#FFFFFF"
                        stroke={hasThisWeek ? CHART_BLUE : LAST_WEEK_STROKE}
                        strokeWidth={2}
                      />
                    </>
                  )}
                  <rect
                    x={0}
                    y={0}
                    width={SPARKLINE_WIDTH}
                    height={SPARKLINE_HEIGHT}
                    fill="transparent"
                    onMouseMove={handleHoverMove}
                    onMouseLeave={() => setHoverIndex(null)}
                  />
                </>
              )}
            </svg>
            {hoverIndex !== null && hoverPoint && (
              <div
                className="pointer-events-none absolute -top-2 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-hairline/60 bg-white/95 px-2.5 py-1.5 text-[11px] shadow-apple backdrop-blur-xl"
                style={{
                  // Follows the dot's actual (possibly edge-snapped) x position
                  // rather than the bucket's true center, so it lines up with
                  // the guide line/dot; clamped so the box never overflows the
                  // card's clipped edges.
                  left: `${Math.min(Math.max((hoverSeries[hoverIndex].x / SPARKLINE_WIDTH) * 100, 14), 86)}%`,
                }}
              >
                <span className="font-mono tabular-nums text-ink-soft">
                  {hoverPoint.isRaw ? formatMinutes(hoverPoint.minutes) : bucketRange(hoverPoint.minutes, BUCKET_MINUTES)}
                </span>
                <span className="mx-1 text-ink-soft">·</span>
                {hasThisWeek ? (
                  <>
                    <span className="font-mono font-semibold tabular-nums text-ink">
                      {Math.round(hoverPoint.value).toLocaleString()}
                    </span>
                    <span className="text-ink-soft">명</span>
                    {hoverLastWeekMatch && (
                      <span className="ml-1 text-ink-soft">
                        (지난주 <span className="font-mono tabular-nums">{Math.round(hoverLastWeekMatch.value).toLocaleString()}</span>명)
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-ink-soft">
                    지난주{" "}
                    <span className="font-mono font-semibold tabular-nums text-ink">
                      {Math.round(hoverPoint.value).toLocaleString()}
                    </span>
                    명
                  </span>
                )}
              </div>
            )}
            <div className="relative mt-2 h-4 text-[11px] font-mono text-ink-soft/70">
              {ticks.map((tick) => (
                <span
                  key={tick.minutes}
                  className="absolute -translate-x-1/2 tabular-nums"
                  style={{ left: `${((tick.minutes - open) / (close - open)) * 100}%` }}
                >
                  {tick.label}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/CongestionCard.test.tsx`
Expected: PASS, all tests including the 5 new ones.

- [ ] **Step 5: Run the full frontend test suite and type-check to confirm no regressions**

Run: `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/CongestionCard.tsx frontend/tests/CongestionCard.test.tsx
git commit -m "feat(fe): add last-week grey comparison line to CongestionCard"
```

---

### Task 2: `MmcaRoomChartCard` — grey line + merged hover tooltip

**Files:**
- Modify: `frontend/src/components/MmcaRoomChartCard.tsx`
- Test: `frontend/tests/MmcaRoomChartCard.test.tsx`

**Interfaces:**
- Consumes: `MmcaDailyLogPoint`, `MmcaRoomStatus` from `frontend/src/api/mmca.ts` (unchanged).
- Produces: `MmcaRoomChartCard` gains an optional prop `lastWeekDaily?: MmcaDailyLogPoint[] | null` (defaults to `null`). All other exports/props unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/tests/MmcaRoomChartCard.test.tsx` (inside the existing `describe("MmcaRoomChartCard", ...)` block, after the last existing `it`). Note: the chart area (and its hover-capture rect) only renders when at least one series has **2 or more** points — `smoothPath`/the path-drawing gate need that minimum, same as the pre-existing this-week-only behavior — so every fixture below gives at least one series 2 points:

```tsx
  it("renders a grey last-week line alongside this week's when both have data", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[
          dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유" }),
          dailyPoint("2026-07-15T10:15:00", { "MMCA-SPACE-2001": "보통" }),
        ]}
        lastWeekDaily={[
          dailyPoint("2026-07-08T10:00:00", { "MMCA-SPACE-2001": "붐빔" }),
          dailyPoint("2026-07-08T10:15:00", { "MMCA-SPACE-2001": "약간 붐빔" }),
        ]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        isOpenToday
      />
    );

    expect(screen.getByTestId("mmca-room-chart-line")).toBeInTheDocument();
    expect(screen.getByTestId("mmca-room-chart-last-week-line")).toBeInTheDocument();
  });

  it("omits the last-week line when lastWeekDaily is null or empty", () => {
    const dailyThisWeek = [
      dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유" }),
      dailyPoint("2026-07-15T10:15:00", { "MMCA-SPACE-2001": "보통" }),
    ];
    const { rerender } = render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={dailyThisWeek}
        lastWeekDaily={null}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        isOpenToday
      />
    );
    expect(screen.getByTestId("mmca-room-chart-line")).toBeInTheDocument();
    expect(screen.queryByTestId("mmca-room-chart-last-week-line")).not.toBeInTheDocument();

    rerender(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={dailyThisWeek}
        lastWeekDaily={[]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        isOpenToday
      />
    );
    expect(screen.queryByTestId("mmca-room-chart-last-week-line")).not.toBeInTheDocument();
  });

  it("shows the grey line on its own when this week has no data yet but last week does", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom({ congestion_nm: null, observed_at: null })}
        daily={[]}
        lastWeekDaily={[
          dailyPoint("2026-07-08T10:00:00", { "MMCA-SPACE-2001": "여유" }),
          dailyPoint("2026-07-08T10:30:00", { "MMCA-SPACE-2001": "보통" }),
        ]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        isOpenToday
      />
    );

    expect(screen.getByTestId("mmca-room-chart-last-week-line")).toBeInTheDocument();
    expect(screen.queryByTestId("mmca-room-chart-line")).not.toBeInTheDocument();
  });

  it("shows both labels in the tooltip when hovering a time both weeks have data near", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[
          dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유" }),
          dailyPoint("2026-07-15T10:15:00", { "MMCA-SPACE-2001": "보통" }),
        ]}
        lastWeekDaily={[dailyPoint("2026-07-08T10:00:00", { "MMCA-SPACE-2001": "붐빔" })]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        isOpenToday
      />
    );

    const svg = screen.getByTestId("mmca-room-chart");
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 480, height: 200, right: 480, bottom: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const hoverTarget = svg.querySelector('rect[fill="transparent"]') as SVGRectElement;

    // Left edge — nearest point is the 10:00 reading, which has a last-week
    // match at the same minute (10:00).
    fireEvent.mouseMove(hoverTarget, { clientX: 0, clientY: 0 });

    expect(screen.getByText(/지난주/)).toBeInTheDocument();
  });

  it("shows the standalone '지난주' tooltip when hovering with only last-week data", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom({ congestion_nm: null, observed_at: null })}
        daily={[]}
        lastWeekDaily={[
          dailyPoint("2026-07-08T10:00:00", { "MMCA-SPACE-2001": "여유" }),
          dailyPoint("2026-07-08T10:30:00", { "MMCA-SPACE-2001": "보통" }),
        ]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        isOpenToday
      />
    );

    const svg = screen.getByTestId("mmca-room-chart");
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 480, height: 200, right: 480, bottom: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const hoverTarget = svg.querySelector('rect[fill="transparent"]') as SVGRectElement;

    fireEvent.mouseMove(hoverTarget, { clientX: 0, clientY: 0 });

    expect(screen.getByText(/지난주/)).toBeInTheDocument();
    expect(screen.queryByText(/\(지난주/)).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run tests/MmcaRoomChartCard.test.tsx`
Expected: FAIL — `lastWeekDaily` prop doesn't exist yet / `mmca-room-chart-last-week-line` testid not found.

- [ ] **Step 3: Implement**

Replace the full contents of `frontend/src/components/MmcaRoomChartCard.tsx` with:

```tsx
import { useRef, useState, type MouseEvent } from "react";

import type { MmcaDailyLogPoint, MmcaRoomStatus } from "../api/mmca";
import { CHART_BLUE, CHART_SKY } from "../lib/chartColors";
import { statusOf } from "../lib/status";

const CHART_WIDTH = 480;
const CHART_HEIGHT = 200;
const TIERS = ["여유", "보통", "약간 붐빔", "붐빔"];
const LAST_WEEK_STROKE = "#C7C7CC";
const LAST_WEEK_MATCH_MINUTES = 30; // how close a last-week reading must be to the hovered time to surface in the tooltip

// Several helpers here (tick math, xOf, chart dimensions, most of the JSX
// shell) are duplicated from CongestionCard.tsx rather than shared — they're
// pure and value-free so sharing wouldn't add venue-specific conditionals,
// but extracting them touches a file this task didn't otherwise need to
// touch. Revisit if a third consumer appears.
const MIN_GAP_MINUTES = 35;

function minutesOfDay(isoString: string): number {
  return Number(isoString.slice(11, 13)) * 60 + Number(isoString.slice(14, 16));
}

function formatMinutes(minutes: number): string {
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function tickLabel(minutes: number): string {
  return minutes % 60 === 0 ? String(minutes / 60) : formatMinutes(minutes);
}

function hourlyTicks(open: number, close: number): { minutes: number; label: string }[] {
  const ticks: number[] = [];
  const firstRoundHour = Math.ceil(open / 60) * 60;
  for (let m = firstRoundHour; m < close; m += 60) {
    if (m - open < MIN_GAP_MINUTES || close - m < MIN_GAP_MINUTES) continue;
    ticks.push(m);
  }
  return [
    { minutes: open, label: tickLabel(open) },
    ...ticks.map((minutes) => ({ minutes, label: tickLabel(minutes) })),
    { minutes: close, label: tickLabel(close) },
  ];
}

type Point = { minutes: number; tier: number; label: string };
type XY = { x: number; y: number };

function xOf(minutes: number, open: number, close: number): number {
  return ((minutes - open) / (close - open || 1)) * CHART_WIDTH;
}

function yOf(tier: number): number {
  return CHART_HEIGHT - 24 - (tier / (TIERS.length - 1)) * (CHART_HEIGHT - 48);
}

function toXY(points: Point[], open: number, close: number): XY[] {
  return points.map((p) => ({ x: xOf(p.minutes, open, close), y: yOf(p.tier) }));
}

function nearestWithin(points: Point[], minutes: number, maxDistance: number): Point | undefined {
  let nearest: Point | undefined;
  let nearestDist = Infinity;
  for (const p of points) {
    const dist = Math.abs(p.minutes - minutes);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = p;
    }
  }
  return nearest && nearestDist <= maxDistance ? nearest : undefined;
}

// Centripetal Catmull-Rom -> cubic Bezier, ported from CongestionCard.tsx.
function smoothPath(xy: XY[]): string {
  const dist = (a: XY, b: XY) => Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)) || 1e-6;
  let d = `M ${xy[0].x} ${xy[0].y}`;
  for (let i = 0; i < xy.length - 1; i++) {
    const p0 = xy[i - 1] ?? xy[i];
    const p1 = xy[i];
    const p2 = xy[i + 1];
    const p3 = xy[i + 2] ?? p2;

    const t0 = 0;
    const t1 = t0 + dist(p0, p1);
    const t2 = t1 + dist(p1, p2);
    const t3 = t2 + dist(p2, p3);

    const m1x = (t2 - t1) * ((p1.x - p0.x) / (t1 - t0) - (p2.x - p0.x) / (t2 - t0) + (p2.x - p1.x) / (t2 - t1));
    const m1y = (t2 - t1) * ((p1.y - p0.y) / (t1 - t0) - (p2.y - p0.y) / (t2 - t0) + (p2.y - p1.y) / (t2 - t1));
    const m2x = (t2 - t1) * ((p2.x - p1.x) / (t2 - t1) - (p3.x - p1.x) / (t3 - t1) + (p3.x - p2.x) / (t3 - t2));
    const m2y = (t2 - t1) * ((p2.y - p1.y) / (t2 - t1) - (p3.y - p1.y) / (t3 - t1) + (p3.y - p2.y) / (t3 - t2));

    const cp1x = p1.x + m1x / 3;
    const cp1y = p1.y + m1y / 3;
    const cp2x = p2.x - m2x / 3;
    const cp2y = p2.y - m2y / 3;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function areaPath(xy: XY[], linePath: string): string {
  const first = xy[0];
  const last = xy[xy.length - 1];
  return `M ${first.x} ${CHART_HEIGHT} L ${first.x} ${first.y} ${linePath.slice(linePath.indexOf("C"))} L ${last.x} ${CHART_HEIGHT} Z`;
}

function roomPoints(daily: MmcaDailyLogPoint[] | null, spaceCode: string, open: number, close: number): Point[] {
  return (daily ?? [])
    .flatMap((row): Point[] => {
      const value = row.rooms.find((r) => r.space_code === spaceCode)?.congestion_nm;
      if (value == null) return [];
      const tier = TIERS.indexOf(value);
      if (tier === -1) return [];
      return [{ minutes: minutesOfDay(row.observed_at), tier, label: value }];
    })
    .filter((p) => p.minutes >= open && p.minutes <= close);
}

export function MmcaRoomChartCard({
  room,
  daily,
  lastWeekDaily = null,
  open,
  close,
  nowMinutes,
  isOpenToday,
}: {
  room: MmcaRoomStatus;
  daily: MmcaDailyLogPoint[] | null;
  lastWeekDaily?: MmcaDailyLogPoint[] | null;
  open: number;
  close: number;
  nowMinutes: number;
  isOpenToday: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const spaceCode = room.space_code;
  const title = room.space_nm ?? spaceCode;

  const isOpen = isOpenToday && nowMinutes >= open && nowMinutes <= close;

  const points = roomPoints(daily, spaceCode, open, close);
  // Last week is always a fully-elapsed day, so it just uses the plain
  // per-room series — no synthetic-opening-point treatment (that's about
  // masking today's known 10:00-poll gap, not relevant to a past day).
  const lastWeekPoints = roomPoints(lastWeekDaily, spaceCode, open, close);

  const ticks = hourlyTicks(open, close);
  // The backend skips the 10:00 poll (opening congestion is reliably 여유,
  // see collector.py's _COLLECTION_START comment), so the real data never has
  // a point there. Draw one anyway purely so the line starts from 여유 at
  // open instead of from the first real reading — but only when that first
  // reading actually landed at :10, and keep it out of `points` (used for
  // hover) so it can never surface as an interactive "10:00 여유" tooltip.
  const hasOpeningReading = points.length > 0 && points[0].minutes === open + 10;
  const renderPoints: Point[] = hasOpeningReading
    ? [{ minutes: open, tier: 0, label: "여유" }, ...points]
    : points;
  const hasThisWeek = points.length > 0;
  const xy = renderPoints.length > 0 ? toXY(renderPoints, open, close) : [];
  const lastWeekXy = lastWeekPoints.length > 0 ? toXY(lastWeekPoints, open, close) : [];
  const linePath = renderPoints.length > 1 ? smoothPath(xy) : "";
  const lastWeekLinePath = lastWeekPoints.length > 1 ? smoothPath(lastWeekXy) : "";
  const areaD = renderPoints.length > 1 ? areaPath(xy, linePath) : "";
  const lastPoint = points[points.length - 1];

  const currentLabel = room.congestion_nm;
  const currentStatus = statusOf(currentLabel ?? "");
  const openBadge = !isOpenToday
    ? "휴관일"
    : isOpen
      ? "실시간"
      : nowMinutes < open
        ? "영업 전"
        : "영업 종료";

  // Hover hit-tests against whichever series is actually on screen: this
  // week's points when present, otherwise last week's (only-last-week case).
  const hoverSeriesPoints = hasThisWeek ? points : lastWeekPoints;

  function handleHoverMove(event: MouseEvent<SVGRectElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * CHART_WIDTH;

    let nearest: number | null = null;
    let nearestDist = Infinity;
    hoverSeriesPoints.forEach((p, i) => {
      const dist = Math.abs(xOf(p.minutes, open, close) - svgX);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
    });
    setHoverIndex(nearest);
  }

  const hoverPoint = hoverIndex !== null ? hoverSeriesPoints[hoverIndex] : undefined;
  const hoverLastWeekMatch =
    hasThisWeek && hoverPoint ? nearestWithin(lastWeekPoints, hoverPoint.minutes, LAST_WEEK_MATCH_MINUTES) : undefined;

  return (
    <div className="relative overflow-hidden rounded-apple border border-hairline/60 bg-white/70 p-8 shadow-apple backdrop-blur-xl motion-safe:animate-rise-in sm:p-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(120% 100% at 12% 0%, ${isOpen ? currentStatus.wash : "rgba(142,142,147,0.1)"}, transparent 60%)`,
        }}
      />

      <div className="relative">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-soft">{title}</p>
            <p className="mt-1 text-[11px] text-ink-soft/70">
              {isOpenToday ? `오늘 영업시간 ${formatMinutes(open)}–${formatMinutes(close)}` : "오늘은 휴관일입니다"}
            </p>
          </div>
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-ink-soft">
            <span
              className={`h-1.5 w-1.5 rounded-full ${isOpen ? "motion-safe:animate-pulse-live" : ""}`}
              style={{ backgroundColor: isOpen ? currentStatus.core : "#C7C7CC" }}
            />
            {openBadge}
          </span>
        </div>

        <div className="mt-4">
          {isOpen ? (
            currentLabel ? (
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="text-7xl font-bold tracking-tight text-ink">{currentLabel}</span>
                <span className="text-base text-ink-soft">{room.observed_at?.slice(11, 16)} 기준</span>
              </div>
            ) : (
              <span className="text-2xl font-semibold text-ink-soft">정보 없음</span>
            )
          ) : (
            <span className="text-2xl font-semibold text-ink-soft">
              {isOpenToday ? "영업 시간이 아닙니다" : "휴관일입니다"}
            </span>
          )}
        </div>

        <div className="relative mt-8">
          <svg
            ref={svgRef}
            data-testid="mmca-room-chart"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            className="w-full overflow-visible"
          >
            {(linePath || lastWeekLinePath) && (
              <>
                <defs>
                  <linearGradient id={`fill-${spaceCode}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART_SKY} stopOpacity="0.32" />
                    <stop offset="100%" stopColor={CHART_BLUE} stopOpacity="0" />
                  </linearGradient>
                  {isOpen && (
                    <radialGradient id={`glow-${spaceCode}`}>
                      <stop offset="0%" stopColor={CHART_BLUE} stopOpacity="0.5" />
                      <stop offset="100%" stopColor={CHART_BLUE} stopOpacity="0" />
                    </radialGradient>
                  )}
                </defs>
                {areaD && <path d={areaD} fill={`url(#fill-${spaceCode})`} />}
                {lastWeekLinePath && (
                  <path
                    data-testid="mmca-room-chart-last-week-line"
                    d={lastWeekLinePath}
                    fill="none"
                    stroke={LAST_WEEK_STROKE}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                )}
                {linePath && (
                  <path
                    data-testid="mmca-room-chart-line"
                    d={linePath}
                    fill="none"
                    stroke={CHART_BLUE}
                    strokeWidth={2.5}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                )}
                {isOpen && lastPoint && (
                  <>
                    <line
                      x1={xOf(lastPoint.minutes, open, close)}
                      y1={yOf(lastPoint.tier)}
                      x2={xOf(lastPoint.minutes, open, close)}
                      y2={CHART_HEIGHT}
                      stroke="#D2D2D7"
                      strokeWidth={1}
                      strokeDasharray="3 4"
                    />
                    <circle
                      cx={xOf(lastPoint.minutes, open, close)}
                      cy={yOf(lastPoint.tier)}
                      r={14}
                      fill={`url(#glow-${spaceCode})`}
                    />
                    <circle
                      cx={xOf(lastPoint.minutes, open, close)}
                      cy={yOf(lastPoint.tier)}
                      r={4.5}
                      fill="#FFFFFF"
                      stroke={CHART_BLUE}
                      strokeWidth={2.5}
                    />
                  </>
                )}
                {hoverPoint && (
                  <>
                    <line
                      x1={xOf(hoverPoint.minutes, open, close)}
                      y1={0}
                      x2={xOf(hoverPoint.minutes, open, close)}
                      y2={CHART_HEIGHT}
                      stroke="#D2D2D7"
                      strokeWidth={1}
                    />
                    <circle
                      cx={xOf(hoverPoint.minutes, open, close)}
                      cy={yOf(hoverPoint.tier)}
                      r={4}
                      fill="#FFFFFF"
                      stroke={hasThisWeek ? CHART_BLUE : LAST_WEEK_STROKE}
                      strokeWidth={2}
                    />
                  </>
                )}
                <rect
                  x={0}
                  y={0}
                  width={CHART_WIDTH}
                  height={CHART_HEIGHT}
                  fill="transparent"
                  onMouseMove={handleHoverMove}
                  onMouseLeave={() => setHoverIndex(null)}
                />
              </>
            )}
          </svg>
          {hoverPoint && (
            <div
              className="pointer-events-none absolute -top-2 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-hairline/60 bg-white/95 px-2.5 py-1.5 text-[11px] shadow-apple backdrop-blur-xl"
              style={{
                left: `${Math.min(Math.max((xOf(hoverPoint.minutes, open, close) / CHART_WIDTH) * 100, 14), 86)}%`,
              }}
            >
              <span className="font-mono tabular-nums text-ink-soft">{formatMinutes(hoverPoint.minutes)}</span>
              <span className="mx-1 text-ink-soft">·</span>
              {hasThisWeek ? (
                <>
                  <span className="font-semibold" style={{ color: statusOf(hoverPoint.label).text }}>
                    {hoverPoint.label}
                  </span>
                  {hoverLastWeekMatch && (
                    <span className="ml-1 text-ink-soft">(지난주 {hoverLastWeekMatch.label})</span>
                  )}
                </>
              ) : (
                <span className="text-ink-soft">
                  지난주{" "}
                  <span className="font-semibold" style={{ color: statusOf(hoverPoint.label).text }}>
                    {hoverPoint.label}
                  </span>
                </span>
              )}
            </div>
          )}
          <div className="relative mt-2 h-4 text-[11px] font-mono text-ink-soft/70">
            {ticks.map((tick) => (
              <span
                key={tick.minutes}
                className="absolute -translate-x-1/2 tabular-nums"
                style={{ left: `${((tick.minutes - open) / (close - open)) * 100}%` }}
              >
                {tick.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/MmcaRoomChartCard.test.tsx`
Expected: PASS, all tests including the 5 new ones.

- [ ] **Step 5: Run the full frontend test suite and type-check to confirm no regressions**

Run: `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/MmcaRoomChartCard.tsx frontend/tests/MmcaRoomChartCard.test.tsx
git commit -m "feat(fe): add last-week grey comparison line to MmcaRoomChartCard"
```

---

### Task 3: `NationalMuseumPage` — fetch and wire `lastWeekDaily`

**Files:**
- Modify: `frontend/src/pages/NationalMuseumPage.tsx`

**Interfaces:**
- Consumes: `fetchDaily(date: string): Promise<DailyLogPoint[]>` from `frontend/src/api/congestion.ts` (unchanged), `shiftDate(date: string, days: number): string` and `todayString(): string` from `frontend/src/lib/date.ts` (unchanged, already used elsewhere), `CongestionCard`'s new `lastWeekDaily?: DailyLogPoint[] | null` prop from Task 1.
- Produces: no new exports — internal wiring only.

- [ ] **Step 1: Implement**

Edit `frontend/src/pages/NationalMuseumPage.tsx`. Change the import line:

```tsx
import { todayString } from "../lib/date";
```

to:

```tsx
import { shiftDate, todayString } from "../lib/date";
```

Add a new state variable after the existing `daily` state:

```tsx
  const [daily, setDaily] = useState<DailyLogPoint[] | null>(null);
  const [lastWeekDaily, setLastWeekDaily] = useState<DailyLogPoint[] | null>(null);
```

Add a fetch call inside the existing `useEffect`:

```tsx
  useEffect(() => {
    fetchCurrent().then(setInitial).catch(() => setInitial(null));
    fetchPrediction().then(setPrediction).catch(() => setPrediction(null));
    fetchDaily(todayString()).then(setDaily).catch(() => setDaily(null));
    fetchDaily(shiftDate(todayString(), -7)).then(setLastWeekDaily).catch(() => setLastWeekDaily(null));
  }, []);
```

Pass the new prop to `CongestionCard`:

```tsx
          <CongestionCard data={current} daily={daily} lastWeekDaily={lastWeekDaily} />
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Run the existing e2e test that exercises this page**

Run: `cd frontend && npx playwright test congestion.spec.ts -g "renders current congestion and prediction chart from the API"`
Expected: PASS — the test's `**/congestion/daily*` route mock matches both the today and last-week requests (it doesn't filter on the `date` query param), so no test changes are needed; this confirms the new fetch doesn't break the page.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/NationalMuseumPage.tsx
git commit -m "feat(fe): fetch and wire last-week data into NationalMuseumPage"
```

---

### Task 4: `MmcaPage` — fetch and wire `lastWeekDaily`

**Files:**
- Modify: `frontend/src/pages/MmcaPage.tsx`
- Test: `frontend/tests/MmcaPage.test.tsx`

**Interfaces:**
- Consumes: `fetchMmcaDaily(venue: MmcaVenue, date: string): Promise<MmcaDailyLogPoint[]>` from `frontend/src/api/mmca.ts` (unchanged), `shiftDate`/`todayString` from `frontend/src/lib/date.ts` (unchanged), `MmcaRoomChartCard`'s new `lastWeekDaily?: MmcaDailyLogPoint[] | null` prop from Task 2.
- Produces: no new exports — internal wiring only.

- [ ] **Step 1: Write the failing test**

Add `shiftDate, todayString` to `frontend/tests/MmcaPage.test.tsx`'s imports — change:

```tsx
import { MmcaPage } from "../src/pages/MmcaPage";
import * as api from "../src/api/mmca";
import type { MmcaRoomStatus } from "../src/api/mmca";
```

to:

```tsx
import { MmcaPage } from "../src/pages/MmcaPage";
import * as api from "../src/api/mmca";
import type { MmcaRoomStatus } from "../src/api/mmca";
import { shiftDate, todayString } from "../src/lib/date";
```

Add to `frontend/tests/MmcaPage.test.tsx` (inside the existing `describe("MmcaPage", ...)` block, after the last existing `it`). Note: `MmcaPage`'s existing "today" daily effect already re-polls on the 60s interval (`POLL_INTERVAL_MS` in `frontend/src/pages/MmcaPage.tsx`) — this test only asserts that the *last-week* fetch does not join that interval, not that `fetchMmcaDaily` overall stays flat:

```tsx
  it("fetches last week's daily data once per venue, separate from the 60s poll", async () => {
    const fetchMmcaDaily = vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    const today = todayString();
    const lastWeek = shiftDate(today, -7);

    await waitFor(() => expect(fetchMmcaDaily).toHaveBeenCalledWith("seoul", lastWeek));
    // MmcaPage's own today fetch + MmcaPage's own last-week fetch +
    // MmcaDailyLogTable's independent today fetch = 3, fixed regardless of
    // room count (see the "fetches daily data exactly once" test below).
    expect(fetchMmcaDaily).toHaveBeenCalledTimes(3);
    expect(fetchMmcaDaily.mock.calls.filter(([, date]) => date === lastWeek)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);

    // The page's own "today" effect re-polls on the interval (pre-existing
    // behavior, unchanged by this task) — but the last-week fetch must not
    // join it.
    expect(fetchMmcaDaily.mock.calls.filter(([, date]) => date === lastWeek)).toHaveLength(1);
  });
```

Update the existing `"stops polling and ignores in-flight responses after unmount"` test — change:

```tsx
    // 2, not 1: MmcaPage's own daily fetch plus MmcaDailyLogTable's
    // independent daily fetch for its date-navigable log view.
    await waitFor(() => expect(fetchMmcaDaily).toHaveBeenCalledTimes(2));

    unmount();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMmcaRooms).toHaveBeenCalledTimes(1);
    expect(fetchMmcaDaily).toHaveBeenCalledTimes(2);
```

to:

```tsx
    // 3, not 1: MmcaPage's own today + last-week daily fetches, plus
    // MmcaDailyLogTable's independent daily fetch for its date-navigable
    // log view.
    await waitFor(() => expect(fetchMmcaDaily).toHaveBeenCalledTimes(3));

    unmount();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMmcaRooms).toHaveBeenCalledTimes(1);
    expect(fetchMmcaDaily).toHaveBeenCalledTimes(3);
```

Update the existing `"fetches daily data exactly once regardless of how many rooms there are"` test — change:

```tsx
    await waitFor(() => expect(screen.getAllByTestId("mmca-room-chart")).toHaveLength(3));
    // 3 chart cards, but only one page-level fetch (plus the independent
    // fetch always made by MmcaDailyLogTable's own log view, fixed at 2
    // total) — this is the fix for the pre-expansion N-cards-N-requests
    // problem: the count does not scale with the number of rooms.
    expect(fetchMmcaDaily).toHaveBeenCalledTimes(2);
```

to:

```tsx
    await waitFor(() => expect(screen.getAllByTestId("mmca-room-chart")).toHaveLength(3));
    // 3 chart cards, but only two page-level fetches — today + last week —
    // plus the independent fetch always made by MmcaDailyLogTable's own log
    // view, fixed at 3 total — this is the fix for the pre-expansion
    // N-cards-N-requests problem: the count does not scale with the number
    // of rooms.
    expect(fetchMmcaDaily).toHaveBeenCalledTimes(3);
```

- [ ] **Step 2: Run tests to verify the new/updated ones fail**

Run: `cd frontend && npx vitest run tests/MmcaPage.test.tsx`
Expected: FAIL — call counts still 2 (no last-week fetch wired yet).

- [ ] **Step 3: Implement**

Edit `frontend/src/pages/MmcaPage.tsx`. Change the import line:

```tsx
import { todayString } from "../lib/date";
```

to:

```tsx
import { shiftDate, todayString } from "../lib/date";
```

Add a new state variable after the existing `daily` state:

```tsx
  const [daily, setDaily] = useState<MmcaDailyLogPoint[] | null>(null);
  const [lastWeekDaily, setLastWeekDaily] = useState<MmcaDailyLogPoint[] | null>(null);
```

Add a new effect after the existing `daily`-fetching `useEffect` (the one with `POLL_INTERVAL_MS`), fetching once per `venue` change with no interval:

```tsx
  useEffect(() => {
    let ignore = false;

    fetchMmcaDaily(venue, shiftDate(todayString(), -7))
      .then((data) => {
        if (!ignore) setLastWeekDaily(data);
      })
      .catch(() => {
        if (!ignore) setLastWeekDaily(null);
      });

    return () => {
      ignore = true;
    };
  }, [venue]);
```

Pass the new prop to `MmcaRoomChartCard`:

```tsx
              <MmcaRoomChartCard
                key={room.space_code}
                room={room}
                daily={daily}
                lastWeekDaily={lastWeekDaily}
                open={open}
                close={close}
                nowMinutes={nowMinutes}
                isOpenToday={isOpenToday}
              />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/MmcaPage.test.tsx`
Expected: PASS, including the updated call-count assertions and the new test.

- [ ] **Step 5: Run the full frontend test suite and type-check to confirm no regressions**

Run: `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Run the existing e2e tests that exercise this page**

Run: `cd frontend && npx playwright test congestion.spec.ts`
Expected: PASS — the `**/mmca/daily*` route mocks don't filter on `date`, so no e2e test changes are needed.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/MmcaPage.tsx frontend/tests/MmcaPage.test.tsx
git commit -m "feat(fe): fetch and wire last-week data into MmcaPage"
```

---

## Self-Review Notes

- **Spec coverage:** shared y-scale (Task 1), grey line styling (Tasks 1–2), merged/standalone tooltip text (Tasks 1–2), chart-visible-with-only-last-week gating (Tasks 1–2), data fetching via existing endpoints (Tasks 3–4), no backend change (confirmed — no backend task exists), out-of-scope items (`DailyLogTable`, `MmcaDailyLogTable`, `PredictionChart`) untouched by any task. All spec sections have a corresponding task.
- **Existing-test breakage:** confirmed `MmcaPage.test.tsx` hardcodes `fetchMmcaDaily` call counts of `2` in two tests — both updated to `3` in Task 4 with corrected comments, since the new last-week fetch reuses the same `fetchMmcaDaily` function.
- **Type consistency:** `lastWeekDaily` prop name, type, and default (`null`) match between `CongestionCard`/`NationalMuseumPage` (Tasks 1, 3) and between `MmcaRoomChartCard`/`MmcaPage` (Tasks 2, 4). Test-id names (`sparkline-last-week-line`, `mmca-room-chart-last-week-line`) are consistent between implementation and tests within each task.
- **Test fixture check (traced by hand before dispatch):** `MmcaRoomChartCard`'s chart area is gated on `(linePath || lastWeekLinePath)`, both of which require ≥2 points on that series (`smoothPath` needs at least 2 points) — unlike `CongestionCard`, whose gate (`xy.length > 0 || lastWeekXy.length > 0`) only needs 1. An earlier draft of Task 2's tests used single-point fixtures that left both empty, which would've hidden the hover rect entirely and broken `fireEvent.mouseMove`. Fixed: every Task 2 fixture now gives at least one series 2 points. Also caught: `MmcaPage`'s existing "today" daily effect already re-polls on the 60s interval (pre-existing, not something this plan changes) — Task 4's new test was corrected to assert only that the *last-week* fetch stays flat across a poll tick, not that `fetchMmcaDaily` overall does.
