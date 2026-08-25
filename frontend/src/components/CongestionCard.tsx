import { useRef, useState, type MouseEvent } from "react";

import type { CurrentCongestion, DailyLogPoint } from "../api/congestion";
import { CHART_BLUE, CHART_SKY, LAST_WEEK_FILL, LAST_WEEK_STROKE } from "../lib/chartColors";
import { monthDayWeekday, shiftDate, todayString } from "../lib/date";
import { SEOUL_STALE_MINUTES, isStale } from "../lib/freshness";
import { nationalMuseumBusinessHours } from "../lib/nationalMuseumBusinessHours";
import { statusOf } from "../lib/status";

const SPARKLINE_WIDTH = 480;
const SPARKLINE_HEIGHT = 200;

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
// Both series resample onto the same bucket grid (same `open` origin, same
// BUCKET_MINUTES), so a genuine same-bucket match is always distance 0 and
// the next bucket over is always exactly BUCKET_MINUTES away — a full
// BUCKET_MINUTES window would let that adjacent (different-time) bucket
// match instead of correctly finding nothing. Half a bucket only admits 0.
const LAST_WEEK_MATCH_MINUTES = BUCKET_MINUTES / 2;

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
  error = false,
  chartError = false,
  viewDate,
}: {
  data: CurrentCongestion | null;
  daily: DailyLogPoint[] | null;
  lastWeekDaily?: DailyLogPoint[] | null;
  // 차트가 그리는 날짜. 생략하면 오늘. 오늘이 아니면 이 카드는 지나간 날의
  // 기록만 그리므로 실시간 헤드라인·신선도 배지를 그리지 않는다 — 지나간
  // 곡선 옆의 "실시간"은 무엇을 보는지 알 수 없게 만든다.
  viewDate?: string;
  error?: boolean;
  // 추이 데이터만 실패한 경우. 현재 혼잡도는 정상이라 카드 전체를 에러로
  // 바꾸지 않고, 차트 자리에만 안내를 남긴다.
  chartError?: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ isLastWeek: boolean; index: number } | null>(null);

  const chartDate = viewDate ?? todayString();
  const isTodayView = chartDate === todayString();
  // 미래 탭의 곡선은 그 날짜의 실제가 아니라 지난주 같은 요일의 대리값이다 —
  // 오늘 차트의 회색 비교선과 같은 뜻이므로 색도 같게 둔다. 파란색은 "묻고 있는
  // 그 날의 실제"에만 쓴다.
  const lineStroke = isTodayView ? CHART_BLUE : LAST_WEEK_STROKE;

  // 지나간 날의 차트는 실시간 값에 의존하지 않는다 — current fetch 가 실패해도
  // 그 날의 곡선은 그릴 수 있어야 한다.
  if (!data && isTodayView) {
    // 영업시간 밖이라는 사실은 판독 없이도 확정된다 — 데이터를 기다렸다가
    // 답하면 페이지를 열 때마다 "불러오는 중"이 한 번 스쳐 지나간다.
    const placeholderNow = new Date();
    const { open: placeholderOpen, close: placeholderClose } =
      nationalMuseumBusinessHours(placeholderNow);
    const placeholderMinutes = placeholderNow.getHours() * 60 + placeholderNow.getMinutes();
    const outsideHours =
      placeholderMinutes < placeholderOpen || placeholderMinutes > placeholderClose;

    return (
      <div className="flex min-h-[420px] flex-col items-center justify-center gap-1 rounded-apple border border-hairline/60 bg-white/70 text-sm text-ink-soft shadow-apple backdrop-blur-xl motion-safe:animate-rise-in">
        {outsideHours ? (
          <span className="text-lg font-semibold text-ink-soft">영업 시간이 아닙니다</span>
        ) : error ? (
          <>
            <span>불러오지 못했습니다.</span>
            <span className="text-xs text-ink-soft/70">재시도 중...</span>
          </>
        ) : (
          <span>불러오는 중...</span>
        )}
      </div>
    );
  }

  const status = statusOf(data?.congest_level ?? "");
  const now = new Date();
  // 축은 그리는 날짜의 영업시간을 쓴다 — 수·토는 21:00, 그 외는 17:30 폐관이라
  // 요일에 따라 축의 오른쪽 끝이 달라진다.
  const { open, close } = nationalMuseumBusinessHours(
    isTodayView ? now : new Date(`${chartDate}T00:00:00`)
  );
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const isOpen = isTodayView && nowMinutes >= open && nowMinutes <= close;
  // 영업시간만 보고 "실시간"이라 적으면 수집기나 상류가 죽어도 초록 점이
  // 계속 뛴다. 표시 중인 판독 자체의 나이로 판정한다.
  const stale = isStale(data?.observed_at ?? null, now, SEOUL_STALE_MINUTES);
  const isLive = isOpen && !stale;
  const openBadge = isOpen
    ? stale
      ? "갱신 지연"
      : "실시간"
    : nowMinutes < open
      ? "영업 전"
      : "영업 종료";
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
  const lastWeekAreaD = lastWeekXy.length > 1 ? areaPath(lastWeekXy, lastWeekLinePath) : "";
  const lastPoint = xy[xy.length - 1];

  function handleHoverMove(event: MouseEvent<SVGRectElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * SPARKLINE_WIDTH;

    let thisWeekIndex: number | null = null;
    let thisWeekDist = Infinity;
    xy.forEach((p, i) => {
      if (points[i].isRaw) return; // 09:30/closing-time points don't show hover info
      const dist = Math.abs(p.x - svgX);
      if (dist < thisWeekDist) {
        thisWeekDist = dist;
        thisWeekIndex = i;
      }
    });

    let lastWeekIndex: number | null = null;
    let lastWeekDist = Infinity;
    lastWeekXy.forEach((p, i) => {
      const dist = Math.abs(p.x - svgX);
      if (dist < lastWeekDist) {
        lastWeekDist = dist;
        lastWeekIndex = i;
      }
    });

    // Whichever series has an actual point closer to the hovered x wins —
    // not a fixed "does this week have any data at all" switch. Today's
    // points cluster near the current time, so a hover further along the
    // axis (a time slot today hasn't reached yet) is genuinely closer to
    // last week's point there than to today's last real reading, and must
    // show the standalone last-week tooltip instead of re-anchoring to
    // today's most recent value.
    if (thisWeekIndex !== null && (lastWeekIndex === null || thisWeekDist <= lastWeekDist)) {
      setHover({ isLastWeek: false, index: thisWeekIndex });
    } else if (lastWeekIndex !== null) {
      setHover({ isLastWeek: true, index: lastWeekIndex });
    } else {
      setHover(null);
    }
  }

  const hoverSeriesXY = hover ? (hover.isLastWeek ? lastWeekXy : xy) : undefined;
  const hoverSeriesPoints = hover ? (hover.isLastWeek ? lastWeekPoints : points) : undefined;
  const hoverPoint = hover && hoverSeriesPoints ? hoverSeriesPoints[hover.index] : undefined;
  const hoverXY = hover && hoverSeriesXY ? hoverSeriesXY[hover.index] : undefined;
  const hoverIsThisWeek = hover ? !hover.isLastWeek : false;
  const hoverLastWeekMatch =
    hoverIsThisWeek && hoverPoint ? nearestWithin(lastWeekPoints, hoverPoint.minutes, LAST_WEEK_MATCH_MINUTES) : undefined;

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
              {isTodayView
                ? "국립중앙박물관·용산가족공원 · 현재 혼잡도"
                : "국립중앙박물관·용산가족공원"}
            </p>
            {/* 기준 시각이 현재보다 한참 이전인 것이 정상이라는 사실을 옆에
                적어 둔다 — 이게 없으면 지연을 장애로 읽게 된다. 지나간 날의
                기록에는 해당하지 않는다. */}
            {isTodayView && (
              <p className="mt-1 text-[11px] text-ink-soft/70">30분 지연됨</p>
            )}
          </div>
          {isTodayView && (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-ink-soft">
              <span
                className={`h-1.5 w-1.5 rounded-full ${isLive ? "motion-safe:animate-pulse-live" : ""}`}
                style={{ backgroundColor: isLive ? status.core : "#C7C7CC" }}
              />
              {openBadge}
            </span>
          )}
        </div>

        {isTodayView && (
        <div className="mt-4">
          {isOpen && data ? (
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
        )}

        {/* 배열의 null 여부가 아니라 그릴 점이 있는지로 판단한다 — 한쪽이
            [] 로 정상 도착해도(자정~그날 첫 판독) 다른 쪽 실패는 여전히
            알려야 한다. */}
        {chartError && !daily?.length && !lastWeekDaily?.length && (
          <p className="mt-8 text-xs text-ink-soft/70">
            추이를 불러오지 못했습니다. 재시도 중...
          </p>
        )}

        {(daily || lastWeekDaily) && (
          <div className="relative mt-8">
            {(xy.length > 0 || lastWeekXy.length > 0) && (
              // 범례는 그리는 날짜를 따라간다 — todayString() 에 고정하면 지나간
              // 날의 곡선 옆에 오늘 날짜가 적힌다. 비교선은 데이터가 있을 때만.
              <div className="mb-2 flex justify-end gap-3 text-[11px] text-ink-soft">
                <span className="flex items-center gap-1.5">
                  <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: lineStroke }} />
                  {monthDayWeekday(chartDate)}
                  {isTodayView ? " 오늘" : ""}
                </span>
                {lastWeekXy.length > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: LAST_WEEK_STROKE }} />
                    {monthDayWeekday(shiftDate(chartDate, -7))} 지난주
                  </span>
                )}
              </div>
            )}
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
                  {lastWeekAreaD && (
                    <path data-testid="sparkline-last-week-area" d={lastWeekAreaD} fill={LAST_WEEK_FILL} opacity={0.2} />
                  )}
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
                  {areaD &&
                    (isTodayView ? (
                      <path d={areaD} fill="url(#sparkline-fill)" />
                    ) : (
                      <path d={areaD} fill={LAST_WEEK_FILL} opacity={0.2} />
                    ))}
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
                      stroke={lineStroke}
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
                  {hoverXY && (
                    <>
                      <line
                        x1={hoverXY.x}
                        y1={0}
                        x2={hoverXY.x}
                        y2={SPARKLINE_HEIGHT}
                        stroke="#D2D2D7"
                        strokeWidth={1}
                      />
                      <circle
                        cx={hoverXY.x}
                        cy={hoverXY.y}
                        r={4}
                        fill="#FFFFFF"
                        stroke={hoverIsThisWeek ? lineStroke : LAST_WEEK_STROKE}
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
                    onMouseLeave={() => setHover(null)}
                  />
                </>
              )}
            </svg>
            {hoverPoint && hoverXY && (
              <div
                data-testid="sparkline-tooltip"
                className="pointer-events-none absolute -top-2 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-hairline/60 bg-white/95 px-2.5 py-1.5 text-[11px] shadow-apple backdrop-blur-xl"
                style={{
                  // Follows the dot's actual (possibly edge-snapped) x position
                  // rather than the bucket's true center, so it lines up with
                  // the guide line/dot; clamped so the box never overflows the
                  // card's clipped edges.
                  left: `${Math.min(Math.max((hoverXY.x / SPARKLINE_WIDTH) * 100, 14), 86)}%`,
                }}
              >
                <span className="font-mono tabular-nums text-ink-soft">
                  {hoverPoint.isRaw ? formatMinutes(hoverPoint.minutes) : bucketRange(hoverPoint.minutes, BUCKET_MINUTES)}
                </span>
                <span className="mx-1 text-ink-soft">·</span>
                {hoverIsThisWeek ? (
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
