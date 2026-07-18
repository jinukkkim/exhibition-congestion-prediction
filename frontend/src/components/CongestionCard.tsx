import { useRef, useState, type MouseEvent } from "react";

import type { CurrentCongestion, DailyLogPoint } from "../api/congestion";
import { statusOf } from "../lib/status";

const SPARKLINE_WIDTH = 480;
const SPARKLINE_HEIGHT = 200;

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

function hourlyTicks(open: number, close: number): { minutes: number; label: string }[] {
  const ticks: number[] = [];
  for (let m = open; m < close; m += 60) ticks.push(m);
  ticks.push(close);
  return ticks.map((minutes) => ({ minutes, label: formatMinutes(minutes) }));
}

type Point = { minutes: number; value: number; isRaw?: boolean };

const BUCKET_MINUTES = 30; // 30 divides both business-hour spans (480min / 690min) evenly, so buckets never fall short

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

// A separate, locally-derived label — NOT Seoul's official 혼잡도 (that stays on
// the hero card/table as-is). Seoul's value is relative to each area's own 28-day
// baseline plus density/transit corrections, so it can legitimately disagree with
// our displayed population number. This one is defined purely as a quartile of
// today's own observed range, so it can never show a "worse" tier for a lower
// population than some other point on the same chart.
const PERCEIVED_LEVELS = ["여유", "보통", "약간 붐빔", "붐빔"];

function perceivedLevel(value: number, points: Point[]): string {
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const fraction = (value - min) / (max - min || 1);
  const idx = Math.min(Math.floor(fraction * PERCEIVED_LEVELS.length), PERCEIVED_LEVELS.length - 1);
  return PERCEIVED_LEVELS[idx];
}

function xOf(minutes: number, open: number, close: number): number {
  return ((minutes - open) / (close - open || 1)) * SPARKLINE_WIDTH;
}

type XY = { x: number; y: number };

function toXY(points: Point[], open: number, close: number): XY[] {
  const values = points.map((p) => p.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1; // ponytail: guards a flat/single-value window; a wider range never hits this

  return points.map(({ minutes, value }) => ({
    x: xOf(minutes, open, close),
    y: SPARKLINE_HEIGHT - ((value - min) / range) * SPARKLINE_HEIGHT,
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
}: {
  data: CurrentCongestion | null;
  daily: DailyLogPoint[] | null;
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

  const xy = points.length > 0 ? toXY(points, open, close) : [];
  const linePath = xy.length > 1 ? smoothPath(xy) : "";
  const areaD = xy.length > 1 ? areaPath(xy, linePath) : "";
  const lastPoint = xy[xy.length - 1];

  function handleHoverMove(event: MouseEvent<SVGRectElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * SPARKLINE_WIDTH;

    let nearest = 0;
    let nearestDist = Infinity;
    xy.forEach((p, i) => {
      const dist = Math.abs(p.x - svgX);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
    });
    setHoverIndex(nearest);
  }

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

        {daily && (
          <div className="relative mt-8">
            <svg
              ref={svgRef}
              data-testid="history-sparkline"
              viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
              className="w-full overflow-visible"
            >
              {xy.length > 0 && (
                <>
                  <defs>
                    <linearGradient id="sparkline-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={status.core} stopOpacity="0.24" />
                      <stop offset="100%" stopColor={status.core} stopOpacity="0" />
                    </linearGradient>
                    {isOpen && lastPoint && (
                      <radialGradient id="sparkline-glow">
                        <stop offset="0%" stopColor={status.core} stopOpacity="0.5" />
                        <stop offset="100%" stopColor={status.core} stopOpacity="0" />
                      </radialGradient>
                    )}
                  </defs>
                  {areaD && <path d={areaD} fill="url(#sparkline-fill)" />}
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
                      stroke={status.core}
                      strokeWidth={2.5}
                      strokeLinecap="round"
                    />
                  )}
                  {isOpen && lastPoint && (
                    <>
                      <circle cx={lastPoint.x} cy={lastPoint.y} r={14} fill="url(#sparkline-glow)" />
                      <circle cx={lastPoint.x} cy={lastPoint.y} r={4.5} fill="#FFFFFF" stroke={status.core} strokeWidth={2.5} />
                    </>
                  )}
                  {hoverIndex !== null && xy[hoverIndex] && (
                    <>
                      <line
                        x1={xy[hoverIndex].x}
                        y1={0}
                        x2={xy[hoverIndex].x}
                        y2={SPARKLINE_HEIGHT}
                        stroke="#D2D2D7"
                        strokeWidth={1}
                      />
                      <circle cx={xy[hoverIndex].x} cy={xy[hoverIndex].y} r={4} fill="#FFFFFF" stroke={status.core} strokeWidth={2} />
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
            {hoverIndex !== null && points[hoverIndex] && (
              <div
                className="pointer-events-none absolute -top-2 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-hairline/60 bg-white/95 px-2.5 py-1.5 text-[11px] shadow-apple backdrop-blur-xl"
                style={{
                  // Follows the dot's actual (possibly edge-snapped) x position
                  // rather than the bucket's true center, so it lines up with
                  // the guide line/dot; clamped so the box never overflows the
                  // card's clipped edges.
                  left: `${Math.min(Math.max((xy[hoverIndex].x / SPARKLINE_WIDTH) * 100, 14), 86)}%`,
                }}
              >
                <span className="font-mono tabular-nums text-ink-soft">
                  {points[hoverIndex].isRaw
                    ? formatMinutes(points[hoverIndex].minutes)
                    : bucketRange(points[hoverIndex].minutes, BUCKET_MINUTES)}
                </span>
                <span className="mx-1 text-ink-soft">·</span>
                <span className="font-mono font-semibold tabular-nums text-ink">
                  {Math.round(points[hoverIndex].value).toLocaleString()}
                </span>
                <span className="text-ink-soft">명</span>
                <span className="mx-1 text-ink-soft">·</span>
                <span className="text-ink-soft">체감</span>{" "}
                <span
                  className="font-semibold"
                  style={{ color: statusOf(perceivedLevel(points[hoverIndex].value, points)).text }}
                >
                  {perceivedLevel(points[hoverIndex].value, points)}
                </span>
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
