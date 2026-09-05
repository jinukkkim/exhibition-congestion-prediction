import { useRef, useState, type MouseEvent } from "react";

import type { MmcaDailyLogPoint, MmcaRoomPrediction, MmcaRoomStatus } from "../api/mmca";
import { CHART_BLUE, CHART_SKY, LAST_WEEK_FILL, LAST_WEEK_STROKE } from "../lib/chartColors";
import { formatMinutes, monthDayWeekday, shiftDate, todayString } from "../lib/date";
import { MMCA_STALE_MINUTES, freshnessDotColor, isStale } from "../lib/freshness";
import { BUCKET_MINUTES, resample } from "../lib/resample";
import { statusOf } from "../lib/status";

const CHART_WIDTH = 480;
const CHART_HEIGHT = 200;
const TIERS = ["여유", "보통", "약간 붐빔", "붐빔"];
// How close a resampled point must sit to the hovered x to count as a value
// there — applies to every series drawn on the mark grid (today's, last
// week's, the future tab's D−7 proxy), not just the last-week comparison.
//
// Both sides sit on the mark grid: roomPoints resamples onto multiples of
// BUCKET_MINUTES and handleHoverMove snaps the hovered x to the same marks,
// so in practice this window only ever admits distance 0. It stays a window
// rather than an equality test for the case that assumption breaks — a
// series whose points drift off the marks still matches instead of going
// silent. The width must stay strictly below the mark spacing (nearestWithin
// uses `dist <= maxDistance`): at exactly BUCKET_MINUTES the adjacent,
// different-time mark would match whenever a series is simply missing the
// hovered one — the same boundary bug as CongestionCard's window.
//
// This was written when readings themselves landed on 10-minute marks. It
// stopped being true when collection went to */1 and then */2 — the tooltip
// could report a value up to 5 minutes from the time it printed. Resampling
// is what makes it true again, this time without depending on the grid.
const HOVER_MATCH_MINUTES = BUCKET_MINUTES / 2;

// Several helpers here (tick math, xOf, chart dimensions, most of the JSX
// shell) are duplicated from CongestionCard.tsx rather than shared — they're
// pure and value-free so sharing wouldn't add venue-specific conditionals,
// but extracting them touches a file this task didn't otherwise need to
// touch. Revisit if a third consumer appears.
const MIN_GAP_MINUTES = 35;

function minutesOfDay(isoString: string): number {
  return Number(isoString.slice(11, 13)) * 60 + Number(isoString.slice(14, 16));
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

// 예측은 시간 단위로 표본되지만 연속 곡선으로 그려진다 — 곡선 위 어디를 짚어도
// 값이 나와야 한다. 보여주는 건 등급명이고 실제로 그린 Catmull-Rom 과의 차이는
// 0.1 등급 수준이라 등급명이 바뀌는 일이 사실상 없으므로 선형 보간으로 족하다.
// 구간 밖(첫 점 이전·마지막 점 이후)에는 예측값이 없다.
function predictionAt(points: Point[], minutes: number): Point | undefined {
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    if (minutes < a.minutes || minutes > b.minutes) continue;
    const tier = a.tier + ((b.tier - a.tier) * (minutes - a.minutes)) / (b.minutes - a.minutes || 1);
    return { minutes, tier, label: TIERS[Math.round(tier)] };
  }
  return undefined;
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

// 판독을 마크 격자로 모아 평균낸 점. 생판독을 그대로 그리지 않는 이유는
// lib/resample.ts 에 있다 — 요약하면 등급이 0~3 네 단계라 생값은 계단이고,
// 그 위를 지나는 Catmull-Rom 은 출렁일 수밖에 없다. 마크 평균이 소수를 만들어
// 곡선이 실제로 연속이 된다.
//
// 영업시간 자르기가 리샘플보다 **먼저**다: 폐관 뒤 판독이 폐관 마크로 반올림돼
// 마지막 값에 섞이면 안 된다.
function roomPoints(daily: MmcaDailyLogPoint[] | null, spaceCode: string, open: number, close: number): Point[] {
  const raw = (daily ?? [])
    .flatMap((row): { minutes: number; value: number }[] => {
      const value = row.rooms.find((r) => r.space_code === spaceCode)?.congestion_nm;
      if (value == null) return [];
      const tier = TIERS.indexOf(value);
      if (tier === -1) return [];
      return [{ minutes: minutesOfDay(row.observed_at), value: tier }];
    })
    .filter((p) => p.minutes >= open && p.minutes <= close);

  // 등급명은 평균 뒤에 다시 붙인다 — 1.4 는 "보통"이라 부른다. 곡선은 1.4 를
  // 그리고 툴팁만 반올림한 이름을 쓴다.
  return resample(raw, close, BUCKET_MINUTES).map((p) => ({
    minutes: p.minutes,
    tier: p.value,
    label: TIERS[Math.round(p.value)],
  }));
}

// 예측 점은 이미 방별로 갈라져 있고 tier 가 소수다 — roomPoints 처럼 등급명을
// 인덱스로 되돌릴 필요가 없다.
function predictionPoints(prediction: MmcaRoomPrediction | null, open: number, close: number): Point[] {
  return (prediction?.points ?? [])
    .map((p) => ({ minutes: minutesOfDay(p.observed_at), tier: p.tier, label: p.label }))
    .filter((p) => p.minutes >= open && p.minutes <= close);
}

export function MmcaRoomChartCard({
  room,
  exhibitionTitle = null,
  daily,
  lastWeekDaily = null,
  prediction = null,
  open,
  close,
  nowMinutes,
  now,
  viewDate,
  isOpenToday,
}: {
  room: MmcaRoomStatus;
  // 이 방에서 진행중인 전시. 전시실 표기가 없는 전시만 있는 관이거나 목록을
  // 못 받았으면 null 이고, 그때는 줄 자체가 빠진다.
  exhibitionTitle?: string | null;
  daily: MmcaDailyLogPoint[] | null;
  lastWeekDaily?: MmcaDailyLogPoint[] | null;
  // 이 방의 예측. 이력이 모자라 응답에서 빠진 방은 null 이다.
  prediction?: MmcaRoomPrediction | null;
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
  // 커서의 x 를 분으로 되돌려 마크 격자에 맞춘 값 하나. 계열 위의 점으로
  // 스냅하는 게 아니다 — 격자 위의 그 시각에서 각 계열을 따로 조회해 있는
  // 것만 말한다.
  const [hoverMinutes, setHoverMinutes] = useState<number | null>(null);

  const spaceCode = room.space_code;
  const title = room.space_nm ?? spaceCode;

  const chartDate = viewDate ?? todayString();
  const isTodayView = chartDate === todayString();
  // 미래 탭의 곡선은 지난주 같은 요일의 대리값이다 — 오늘 차트의 회색 비교선과
  // 같은 뜻이므로 색도 같게 둔다 (CongestionCard 와 같은 규칙).
  const lineStroke = isTodayView ? CHART_BLUE : LAST_WEEK_STROKE;
  const isOpen = isTodayView && isOpenToday && nowMinutes >= open && nowMinutes <= close;

  const points = roomPoints(daily, spaceCode, open, close);
  // Last week is always a fully-elapsed day, so it just uses the plain
  // per-room series — no synthetic-opening-point treatment (that's about
  // masking today's known 10:00-poll gap, not relevant to a past day).
  const lastWeekPoints = roomPoints(lastWeekDaily, spaceCode, open, close);

  const ticks = hourlyTicks(open, close);
  // 합성 개관점이 여기 있었다. 백엔드가 10:00 폴을 건너뛰던 시절 곡선이 10:10
  // 에서 시작하는 것을 가리려고 10:00 에 여유 한 점을 얹던 것인데, 수집 시작이
  // 10:00 이 된 뒤로(collector.py 의 _COLLECTION_START) 그 조건(첫 점이 :10)이
  // 참이 되는 일이 없어 죽은 코드였다. 지금은 첫 마크가 곧 개관이다.
  const xy = points.length > 0 ? toXY(points, open, close) : [];
  const lastWeekXy = lastWeekPoints.length > 0 ? toXY(lastWeekPoints, open, close) : [];
  const linePath = points.length > 1 ? smoothPath(xy) : "";
  const lastWeekLinePath = lastWeekPoints.length > 1 ? smoothPath(lastWeekXy) : "";
  const areaD = points.length > 1 ? areaPath(xy, linePath) : "";
  const lastWeekAreaD = lastWeekPoints.length > 1 ? areaPath(lastWeekXy, lastWeekLinePath) : "";
  const lastPoint = points[points.length - 1];
  // /mmca/prediction 은 60초 캐시, /mmca/daily 는 캐시가 없다 — 최대 한 폴링
  // 만큼 예측이 낡아 있을 수 있고, 그러면 페이로드의 이음매가 실선의 마지막
  // 마크보다 뒤처져 실선과 겹쳐 그려진다. 페이로드를
  // 믿는 대신 프론트가 항상 다시 고정한다: 실선 마지막 시각 이하의 예측 점을
  // 버리고 실선의 마지막 점을 그대로 앞에 붙인다. 신선한 페이로드는 버림+
  // 재삽입이 같은 값이라 결과가 그대로고(분기 없음), 낡았을 때만 실질적으로
  // 이음매가 바뀐다.
  //
  // 단, 이 재이음은 오늘 탭에서만 옳다. 미래 탭의 `points` 는 오늘의 판독이
  // 아니라 D−7(지난주 같은 요일)의 대리 기록이라 하루가 이미 다 차 있고,
  // 예측은 그 날 하루 전체를 덮는다 — 여기서 재이음하면 실선의 마지막 시각
  // 이하인 예측 점이 전부 걸려 곡선이 통째로 사라진다. 애초에 미래 탭에는
  // 지킬 이음매가 없다(실선과 예측이 서로 다른 날짜다).
  const predPointsRaw = predictionPoints(prediction, open, close);
  const predPoints =
    isTodayView && lastPoint
      ? [lastPoint, ...predPointsRaw.filter((p) => p.minutes > lastPoint.minutes)]
      : predPointsRaw;
  const predXy = predPoints.length > 1 ? toXY(predPoints, open, close) : [];
  const predictionPath = predPoints.length > 1 ? smoothPath(predXy) : "";
  // 예측만 있어도 차트는 보여야 한다.
  const hasAnySeries = Boolean(linePath || lastWeekLinePath || predictionPath);

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
    // xOf 의 역 (0 나눗셈 가드까지 대칭으로).
    const minutes = open + (svgX / CHART_WIDTH) * (close - open || 1);
    // 계열이 마크 격자 위에 있으므로(roomPoints 의 resample) 짚은 위치도 같은
    // 격자로 맞춘다 — 십자선이 미끄러지지 않고 마크 단위로 튀고, 시계에 12:43
    // 같은 임의의 분이 뜨지 않는다. 스냅을 먼저, 영업시간 가두기를 나중에
    // (순서를 바꾸면 open/close 가 마크가 아닐 때 영업시간 밖으로 튀어나간다).
    const snapped = Math.round(minutes / BUCKET_MINUTES) * BUCKET_MINUTES;
    setHoverMinutes(Math.min(Math.max(snapped, open), close));
  }

  // 비교 시리즈는 탭에 따라 다른 prop 에 담긴다. 오늘 탭은 lastWeekPoints(회색
  // 지난주선), 미래 탭은 points — MmcaPage 가 미래 탭에서 lastWeekDaily 를 null
  // 로 두고 D−7 실측을 daily 로 내려보내기 때문이다. 여기서 prop 을 고정하면
  // 미래 탭의 괄호가 영구히 빈다.
  const comparePoints = isTodayView ? lastWeekPoints : points;

  // 마크 격자 계열은 짚은 x 에 값이 실제로 있을 때만 값을 낸다 (창을 넓히면
  // 없는 시각을 있는 것처럼 말한다 — HOVER_MATCH_MINUTES 주석 참고).
  //
  // 오늘의 실측은 오늘 탭에만 있다: 미래 탭의 `points` 는 오늘의 판독이 아니라
  // D−7 대리 기록(= 비교 시리즈)이다. 이 게이트를 빼면 미래 탭의 대리 기록이
  // 오늘의 실측인 척하며 예측값을 온종일 가린다 (같은 원인의 버그가 예측 점선
  // 자체에서 한 번 있었다 — predPoints 재이음 주석 참고).
  const hoverActual =
    hoverMinutes == null || !isTodayView ? undefined : nearestWithin(points, hoverMinutes, HOVER_MATCH_MINUTES);
  const hoverCompare =
    hoverMinutes == null ? undefined : nearestWithin(comparePoints, hoverMinutes, HOVER_MATCH_MINUTES);
  // 실측이 있는 x 에서는 예측을 지운다 — 값이 확정된 자리에 나란히 놓인 추정치는
  // 잡음이다.
  const hoverPrediction = hoverMinutes == null || hoverActual ? undefined : predictionAt(predPoints, hoverMinutes);

  // 주값은 예측 > 실측 > 비교 순(앞의 둘은 서로 배타적이다). 주값이 비교
  // 시리즈 자신일 때만 괄호를 생략한다.
  const hoverPrimary = hoverPrediction ?? hoverActual ?? hoverCompare;
  const hoverPrefix = hoverPrediction ? "예측 " : hoverActual ? "" : "지난주 ";
  const hoverSuffix = hoverPrediction || hoverActual ? hoverCompare : undefined;

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
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-soft">
              {title}
            </p>
            {exhibitionTitle && (
              <p className="mt-1 truncate text-sm text-ink" title={exhibitionTitle}>
                {exhibitionTitle}
              </p>
            )}
          </div>
          {isTodayView && (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-ink-soft">
              <span
                data-testid="freshness-dot"
                className={`h-1.5 w-1.5 rounded-full ${isLive ? "motion-safe:animate-pulse-live" : ""}`}
                style={{ backgroundColor: freshnessDotColor(isOpen, stale) }}
              />
              {openBadge}
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
          {hasAnySeries && (
            <div className="mb-2 flex justify-end gap-3 text-[11px] text-ink-soft">
              <span className="flex items-center gap-1.5">
                <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: lineStroke }} />
                {monthDayWeekday(chartDate)}
                {isTodayView ? " 오늘" : ""}
              </span>
              {lastWeekLinePath && (
                <span className="flex items-center gap-1.5">
                  <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: LAST_WEEK_STROKE }} />
                  {monthDayWeekday(shiftDate(chartDate, -7))} 지난주
                </span>
              )}
              {predictionPath && (
                <span className="flex items-center gap-1.5">
                  <span
                    className="h-0 w-3 border-t-2 border-dashed"
                    style={{ borderColor: CHART_BLUE }}
                  />
                  {prediction?.anchored ? "예측 (오늘 반영)" : "예측"}
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
            {hasAnySeries && (
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
                {areaD &&
                  (isTodayView ? (
                    <path d={areaD} fill={`url(#fill-${spaceCode})`} />
                  ) : (
                    <path d={areaD} fill={LAST_WEEK_FILL} opacity={0.2} />
                  ))}
                {linePath && (
                  <path
                    data-testid="mmca-room-chart-line"
                    d={linePath}
                    fill="none"
                    stroke={lineStroke}
                    strokeWidth={2.5}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                )}
                {predictionPath && (
                  <path
                    data-testid="mmca-room-chart-prediction-line"
                    d={predictionPath}
                    fill="none"
                    stroke={CHART_BLUE}
                    strokeWidth={2.5}
                    strokeDasharray="5 5"
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
                {hoverPrimary && hoverMinutes != null && (
                  <>
                    <line
                      x1={xOf(hoverMinutes, open, close)}
                      y1={0}
                      x2={xOf(hoverMinutes, open, close)}
                      y2={CHART_HEIGHT}
                      stroke="#D2D2D7"
                      strokeWidth={1}
                    />
                    {/* 그 x 에서 값이 있는 계열마다 자기 y 에 점을 하나씩. */}
                    {[
                      [hoverActual, lineStroke] as const,
                      [hoverCompare, LAST_WEEK_STROKE] as const,
                      [hoverPrediction, CHART_BLUE] as const,
                    ].map(([point, stroke], i) =>
                      point ? (
                        <circle
                          key={i}
                          cx={xOf(hoverMinutes, open, close)}
                          cy={yOf(point.tier)}
                          r={4}
                          fill="#FFFFFF"
                          stroke={stroke}
                          strokeWidth={2}
                        />
                      ) : null
                    )}
                  </>
                )}
                <rect
                  x={0}
                  y={0}
                  width={CHART_WIDTH}
                  height={CHART_HEIGHT}
                  fill="transparent"
                  onMouseMove={handleHoverMove}
                  onMouseLeave={() => setHoverMinutes(null)}
                />
              </>
            )}
          </svg>
          {hoverPrimary && hoverMinutes != null && (
            <div
              data-testid="mmca-room-chart-tooltip"
              className="pointer-events-none absolute -top-2 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-hairline/60 bg-white/95 px-2.5 py-1.5 text-[11px] shadow-apple backdrop-blur-xl"
              style={{
                left: `${Math.min(Math.max((xOf(hoverMinutes, open, close) / CHART_WIDTH) * 100, 14), 86)}%`,
              }}
            >
              {/* 짚은 x 는 이미 마크 위라 걸린 계열 값의 시각과 항상 같고,
                  예측만 걸린 x 에서는 예측이 곧 그 x 의 값이다 — 어느 쪽이든
                  짚은 시각을 그대로 적으면 된다. */}
              <span className="font-mono tabular-nums text-ink-soft">
                {formatMinutes(hoverMinutes)}
              </span>
              <span className="mx-1 text-ink-soft">·</span>
              {hoverPrefix && <span className="text-ink-soft">{hoverPrefix}</span>}
              <span className="font-semibold" style={{ color: statusOf(hoverPrimary.label).text }}>
                {hoverPrimary.label}
              </span>
              {hoverSuffix && <span className="ml-1 text-ink-soft">(지난주 {hoverSuffix.label})</span>}
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
