import { useRef, useState, type MouseEvent } from "react";

import type { MmcaDailyLogPoint, MmcaRoomStatus } from "../api/mmca";
import { CHART_BLUE, CHART_SKY, LAST_WEEK_FILL, LAST_WEEK_STROKE } from "../lib/chartColors";
import { monthDayWeekday, shiftDate, todayString } from "../lib/date";
import { MMCA_STALE_MINUTES, isStale } from "../lib/freshness";
import { statusOf } from "../lib/status";

const CHART_WIDTH = 480;
const CHART_HEIGHT = 200;
const TIERS = ["여유", "보통", "약간 붐빔", "붐빔"];
// MMCA readings snap to a 10-minute grid (see collector.py), so a genuine
// same-time match is always distance 0, and the next reading on the grid
// is always exactly 10 minutes away. A window of exactly 10 (nearestWithin
// uses `dist <= maxDistance`) would let that adjacent, different-time
// reading match when last week is simply missing the exact time slot
// (e.g. a confirmed-empty skip in collector.py) — same boundary bug as
// CongestionCard's bucket-width window, fixed the same way: strictly less
// than the grid spacing so only distance 0 admits.
const LAST_WEEK_MATCH_MINUTES = 5;

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
  now,
  viewDate,
  isOpenToday,
}: {
  room: MmcaRoomStatus;
  daily: MmcaDailyLogPoint[] | null;
  lastWeekDaily?: MmcaDailyLogPoint[] | null;
  open: number;
  close: number;
  nowMinutes: number;
  // nowMinutes 와 같은 시계에서 나온 값 (MmcaPage 가 하나의 new Date() 로 둘을
  // 만든다). 판독 나이를 재려면 분 단위가 아닌 실제 시각이 필요하다.
  now: Date;
  // 차트가 그리는 날짜. 생략하면 오늘. 오늘이 아니면 지나간 날의 기록만 그리므로
  // 실시간 배지·현재 등급을 그리지 않는다.
  viewDate?: string;
  isOpenToday: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ isLastWeek: boolean; index: number } | null>(null);

  const spaceCode = room.space_code;
  const title = room.space_nm ?? spaceCode;

  const chartDate = viewDate ?? todayString();
  const isTodayView = chartDate === todayString();
  const isOpen = isTodayView && isOpenToday && nowMinutes >= open && nowMinutes <= close;

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
  const xy = renderPoints.length > 0 ? toXY(renderPoints, open, close) : [];
  const lastWeekXy = lastWeekPoints.length > 0 ? toXY(lastWeekPoints, open, close) : [];
  const linePath = renderPoints.length > 1 ? smoothPath(xy) : "";
  const lastWeekLinePath = lastWeekPoints.length > 1 ? smoothPath(lastWeekXy) : "";
  const areaD = renderPoints.length > 1 ? areaPath(xy, linePath) : "";
  const lastWeekAreaD = lastWeekPoints.length > 1 ? areaPath(lastWeekXy, lastWeekLinePath) : "";
  const lastPoint = points[points.length - 1];

  const currentLabel = room.congestion_nm;
  const currentStatus = statusOf(currentLabel ?? "");
  // 영업시간만 보고 "실시간"이라 적으면 수집이 멈춰도 초록 점이 계속 뛴다.
  // 표시 중인 판독 자체의 나이로 판정한다.
  const stale = isStale(room.observed_at, now, MMCA_STALE_MINUTES);
  const isLive = isOpen && !stale;
  const openBadge = !isOpenToday
    ? "휴관일"
    : isOpen
      ? stale
        ? "갱신 지연"
        : "실시간"
      : nowMinutes < open
        ? "영업 전"
        : "영업 종료";

  function handleHoverMove(event: MouseEvent<SVGRectElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * CHART_WIDTH;

    let thisWeekIndex: number | null = null;
    let thisWeekDist = Infinity;
    points.forEach((p, i) => {
      const dist = Math.abs(xOf(p.minutes, open, close) - svgX);
      if (dist < thisWeekDist) {
        thisWeekDist = dist;
        thisWeekIndex = i;
      }
    });

    let lastWeekIndex: number | null = null;
    let lastWeekDist = Infinity;
    lastWeekPoints.forEach((p, i) => {
      const dist = Math.abs(xOf(p.minutes, open, close) - svgX);
      if (dist < lastWeekDist) {
        lastWeekDist = dist;
        lastWeekIndex = i;
      }
    });

    // Whichever series has an actual point closer to the hovered x wins —
    // not a fixed "does this week have any data at all" switch. See
    // CongestionCard.tsx's handleHoverMove for the same pattern and
    // rationale (today's partial-day data shouldn't re-anchor a hover over
    // a time slot today hasn't reached yet).
    if (thisWeekIndex !== null && (lastWeekIndex === null || thisWeekDist <= lastWeekDist)) {
      setHover({ isLastWeek: false, index: thisWeekIndex });
    } else if (lastWeekIndex !== null) {
      setHover({ isLastWeek: true, index: lastWeekIndex });
    } else {
      setHover(null);
    }
  }

  const hoverSeriesPoints = hover ? (hover.isLastWeek ? lastWeekPoints : points) : undefined;
  const hoverPoint = hover && hoverSeriesPoints ? hoverSeriesPoints[hover.index] : undefined;
  const hoverIsThisWeek = hover ? !hover.isLastWeek : false;
  const hoverLastWeekMatch =
    hoverIsThisWeek && hoverPoint ? nearestWithin(lastWeekPoints, hoverPoint.minutes, LAST_WEEK_MATCH_MINUTES) : undefined;

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
              {isOpenToday
                ? `${isTodayView ? "오늘 " : ""}영업시간 ${formatMinutes(open)}–${formatMinutes(close)}`
                : isTodayView
                  ? "오늘은 휴관일입니다"
                  : "휴관일입니다"}
            </p>
          </div>
          {isTodayView ? (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-ink-soft">
              <span
                className={`h-1.5 w-1.5 rounded-full ${isLive ? "motion-safe:animate-pulse-live" : ""}`}
                style={{ backgroundColor: isLive ? currentStatus.core : "#C7C7CC" }}
              />
              {openBadge}
            </span>
          ) : (
            <span className="shrink-0 text-[11px] font-medium text-ink-soft">
              {monthDayWeekday(chartDate)} 실제
            </span>
          )}
        </div>

        {isTodayView && (
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
        )}

        <div className="relative mt-8">
          {(linePath || lastWeekLinePath) && (
            <div className="mb-2 flex justify-end gap-3 text-[11px] text-ink-soft">
              <span className="flex items-center gap-1.5">
                <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: CHART_BLUE }} />
                {monthDayWeekday(chartDate)}
                {isTodayView ? " 오늘" : ""}
              </span>
              {lastWeekLinePath && (
                <span className="flex items-center gap-1.5">
                  <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: LAST_WEEK_STROKE }} />
                  {monthDayWeekday(shiftDate(chartDate, -7))} 지난주
                </span>
              )}
            </div>
          )}
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
                {lastWeekAreaD && (
                  <path data-testid="mmca-room-chart-last-week-area" d={lastWeekAreaD} fill={LAST_WEEK_FILL} opacity={0.2} />
                )}
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
                {areaD && <path d={areaD} fill={`url(#fill-${spaceCode})`} />}
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
                      stroke={hoverIsThisWeek ? CHART_BLUE : LAST_WEEK_STROKE}
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
                  onMouseLeave={() => setHover(null)}
                />
              </>
            )}
          </svg>
          {hoverPoint && (
            <div
              data-testid="mmca-room-chart-tooltip"
              className="pointer-events-none absolute -top-2 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-hairline/60 bg-white/95 px-2.5 py-1.5 text-[11px] shadow-apple backdrop-blur-xl"
              style={{
                left: `${Math.min(Math.max((xOf(hoverPoint.minutes, open, close) / CHART_WIDTH) * 100, 14), 86)}%`,
              }}
            >
              <span className="font-mono tabular-nums text-ink-soft">{formatMinutes(hoverPoint.minutes)}</span>
              <span className="mx-1 text-ink-soft">·</span>
              {hoverIsThisWeek ? (
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
