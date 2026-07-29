import { useRef, useState, type MouseEvent } from "react";

import type { MmcaDailyLogPoint, MmcaRoomStatus } from "../api/mmca";
import { CHART_BLUE, CHART_SKY } from "../lib/chartColors";
import { DISABLED_MMCA_SPACE_CODES } from "../lib/mmcaDisabledRooms";
import { statusOf } from "../lib/status";

const CHART_WIDTH = 480;
const CHART_HEIGHT = 200;
const TIERS = ["여유", "보통", "약간 붐빔", "붐빔"];

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

export function MmcaRoomChartCard({
  room,
  daily,
  open,
  close,
  nowMinutes,
  isOpenToday,
}: {
  room: MmcaRoomStatus;
  daily: MmcaDailyLogPoint[] | null;
  open: number;
  close: number;
  nowMinutes: number;
  isOpenToday: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const spaceCode = room.space_code;
  const title = room.space_nm ?? spaceCode;

  if (DISABLED_MMCA_SPACE_CODES.has(spaceCode)) {
    return (
      <div className="relative overflow-hidden rounded-apple border border-hairline/60 bg-white/70 p-8 shadow-apple backdrop-blur-xl motion-safe:animate-rise-in sm:p-10">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-soft">{title}</p>
        <p className="mt-6 text-2xl font-semibold text-ink-soft">서비스 예정</p>
      </div>
    );
  }

  const isOpen = isOpenToday && nowMinutes >= open && nowMinutes <= close;

  const points: Point[] = (daily ?? [])
    .flatMap((row): Point[] => {
      const value = row.rooms.find((r) => r.space_code === spaceCode)?.congestion_nm;
      if (value == null) return [];
      const tier = TIERS.indexOf(value);
      if (tier === -1) return [];
      return [{ minutes: minutesOfDay(row.observed_at), tier, label: value }];
    })
    .filter((p) => p.minutes >= open && p.minutes <= close);

  const ticks = hourlyTicks(open, close);
  const xy = toXY(points, open, close);
  const linePath = points.length > 1 ? smoothPath(xy) : "";
  const areaD = points.length > 1 ? areaPath(xy, linePath) : "";
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

  function handleHoverMove(event: MouseEvent<SVGRectElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * CHART_WIDTH;

    let nearest: number | null = null;
    let nearestDist = Infinity;
    points.forEach((p, i) => {
      const dist = Math.abs(xOf(p.minutes, open, close) - svgX);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
    });
    setHoverIndex(nearest);
  }

  const hoverPoint = hoverIndex !== null ? points[hoverIndex] : undefined;

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
            {linePath && (
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
                <path d={areaD} fill={`url(#fill-${spaceCode})`} />
                <path
                  data-testid="mmca-room-chart-line"
                  d={linePath}
                  fill="none"
                  stroke={CHART_BLUE}
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
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
                      stroke={CHART_BLUE}
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
              <span className="font-semibold" style={{ color: statusOf(hoverPoint.label).text }}>
                {hoverPoint.label}
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
      </div>
    </div>
  );
}
