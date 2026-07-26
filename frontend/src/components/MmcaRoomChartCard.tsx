import { useEffect, useState } from "react";

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

// Step path: horizontal hold at each value, vertical jump exactly at the
// change point. Unlike CongestionCard's smoothed curve, this is honest
// about categorical data — the value really did jump, not drift.
function stepPath(points: Point[], open: number, close: number): string {
  let d = `M ${xOf(points[0].minutes, open, close)} ${yOf(points[0].tier)}`;
  for (let i = 1; i < points.length; i++) {
    const x = xOf(points[i].minutes, open, close);
    const prevY = yOf(points[i - 1].tier);
    d += ` L ${x} ${prevY} L ${x} ${yOf(points[i].tier)}`;
  }
  return d;
}

function areaPath(points: Point[], open: number, close: number, linePath: string): string {
  const firstX = xOf(points[0].minutes, open, close);
  const lastX = xOf(points[points.length - 1].minutes, open, close);
  return `M ${firstX} ${CHART_HEIGHT} L ${firstX} ${yOf(points[0].tier)} ${linePath.slice(linePath.indexOf("L"))} L ${lastX} ${CHART_HEIGHT} Z`;
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
  const [daily, setDaily] = useState<MmcaDailyLogPoint[] | null>(null);

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
  const linePath = points.length > 1 ? stepPath(points, open, close) : "";
  const areaD = points.length > 1 ? areaPath(points, open, close, linePath) : "";
  const lastPoint = points[points.length - 1];
  const lastStatus = lastPoint ? statusOf(lastPoint.label) : null;

  const title = room?.space_nm ?? spaceCode;
  const currentLabel = room?.congestion_nm;
  const currentStatus = statusOf(currentLabel ?? "");

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
            data-testid="mmca-room-chart"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            className="w-full overflow-visible"
          >
            {linePath && lastStatus && (
              <>
                <defs>
                  <linearGradient id={`fill-${spaceCode}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={lastStatus.core} stopOpacity="0.22" />
                    <stop offset="100%" stopColor={lastStatus.core} stopOpacity="0" />
                  </linearGradient>
                  {isOpen && (
                    <radialGradient id={`glow-${spaceCode}`}>
                      <stop offset="0%" stopColor={lastStatus.core} stopOpacity="0.5" />
                      <stop offset="100%" stopColor={lastStatus.core} stopOpacity="0" />
                    </radialGradient>
                  )}
                </defs>
                <path d={areaD} fill={`url(#fill-${spaceCode})`} />
                <path
                  data-testid="mmca-room-chart-line"
                  d={linePath}
                  fill="none"
                  stroke={lastStatus.core}
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
                      stroke={lastStatus.core}
                      strokeWidth={2.5}
                    />
                  </>
                )}
              </>
            )}
          </svg>
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
