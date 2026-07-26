import { useEffect, useRef, useState, type MouseEvent } from "react";

import { fetchMmcaDaily, type MmcaDailyLogPoint, type MmcaRoomStatus, type MmcaVenue } from "../api/mmca";
import { todayString } from "../lib/date";
import { mmcaBusinessHours } from "../lib/mmcaBusinessHours";
import { statusOf } from "../lib/status";

const CHART_WIDTH = 480;
const CHART_HEIGHT = 200;
const POLL_INTERVAL_MS = 60_000;
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

function xOf(minutes: number, open: number, close: number): number {
  return ((minutes - open) / (close - open || 1)) * CHART_WIDTH;
}

function yOf(tier: number): number {
  return CHART_HEIGHT - 24 - (tier / (TIERS.length - 1)) * (CHART_HEIGHT - 48);
}

type Segment = { d: string; areaD: string; color: string };

// One segment per hold-then-jump: horizontal at points[i]'s tier from
// points[i] to points[i+1], then the vertical jump into the next value.
// Each segment is colored by its OWN tier (points[i]'s status) rather than
// one color for the whole line — since this is a step chart specifically to
// be honest that the value actually changed, the color should show that too:
// a single line color (e.g. today's latest status) would hide that the room
// was 붐빔 an hour ago. No trailing segment after the last point — nothing
// to hold it against yet, which is what the live glow marker communicates.
function buildSegments(points: Point[], open: number, close: number): Segment[] {
  const segments: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const x0 = xOf(points[i].minutes, open, close);
    const x1 = xOf(points[i + 1].minutes, open, close);
    const y0 = yOf(points[i].tier);
    const y1 = yOf(points[i + 1].tier);
    segments.push({
      d: `M ${x0} ${y0} L ${x1} ${y0} L ${x1} ${y1}`,
      areaD: `M ${x0} ${CHART_HEIGHT} L ${x0} ${y0} L ${x1} ${y0} L ${x1} ${CHART_HEIGHT} Z`,
      color: statusOf(points[i].label).core,
    });
  }
  return segments;
}

export function MmcaRoomChartCard({
  venue,
  spaceCode,
  room,
}: {
  venue: MmcaVenue;
  spaceCode: string;
  room: MmcaRoomStatus | undefined;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [daily, setDaily] = useState<MmcaDailyLogPoint[] | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  useEffect(() => {
    let ignore = false;

    function load() {
      fetchMmcaDaily(venue, todayString())
        .then((data) => {
          if (!ignore) setDaily(data);
        })
        .catch(() => {
          // Silently retry, matching MmcaDailyLogTable — keep whatever we
          // already have rather than blanking the card.
        });
    }

    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      ignore = true;
      clearInterval(timer);
    };
  }, [venue, spaceCode]);

  const now = new Date();
  const { open, close } = mmcaBusinessHours(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const isOpen = nowMinutes >= open && nowMinutes <= close;
  const openBadge = isOpen ? "실시간" : nowMinutes < open ? "영업 전" : "영업 종료";

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
  const segments = points.length > 1 ? buildSegments(points, open, close) : [];
  const lastPoint = points[points.length - 1];
  const lastStatus = lastPoint ? statusOf(lastPoint.label) : null;

  const title = room?.space_nm ?? spaceCode;
  const currentLabel = room?.congestion_nm;
  const currentStatus = statusOf(currentLabel ?? "");

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
              오늘 영업시간 {formatMinutes(open)}–{formatMinutes(close)}
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
                <span className="text-base text-ink-soft">{room?.observed_at.slice(11, 16)} 기준</span>
              </div>
            ) : (
              <span className="text-2xl font-semibold text-ink-soft">정보 없음</span>
            )
          ) : (
            <span className="text-2xl font-semibold text-ink-soft">영업 시간이 아닙니다</span>
          )}
        </div>

        <div className="relative mt-8">
          <svg
            ref={svgRef}
            data-testid="mmca-room-chart"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            className="w-full overflow-visible"
          >
            {segments.length > 0 && lastStatus && (
              <>
                {isOpen && (
                  <defs>
                    <radialGradient id={`glow-${spaceCode}`}>
                      <stop offset="0%" stopColor={lastStatus.core} stopOpacity="0.5" />
                      <stop offset="100%" stopColor={lastStatus.core} stopOpacity="0" />
                    </radialGradient>
                  </defs>
                )}
                {segments.map((segment, i) => (
                  <path key={`area-${i}`} d={segment.areaD} fill={segment.color} fillOpacity={0.16} />
                ))}
                {segments.map((segment, i) => (
                  <path
                    key={`line-${i}`}
                    data-testid="mmca-room-chart-segment"
                    d={segment.d}
                    fill="none"
                    stroke={segment.color}
                    strokeWidth={2.5}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ))}
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
                      stroke={lastStatus.core}
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
                      stroke={statusOf(hoverPoint.label).core}
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
