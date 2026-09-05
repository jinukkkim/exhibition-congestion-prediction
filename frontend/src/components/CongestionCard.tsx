import { useRef, useState, type MouseEvent } from "react";

import type { CurrentCongestion, DailyLogPoint, PredictionCurvePoint } from "../api/congestion";
import { CHART_BLUE, CHART_SKY, LAST_WEEK_FILL, LAST_WEEK_STROKE } from "../lib/chartColors";
import { formatMinutes, monthDayWeekday, shiftDate, todayString } from "../lib/date";
import { SEOUL_STALE_MINUTES, freshnessDotColor, isStale } from "../lib/freshness";
import { nationalMuseumBusinessHours } from "../lib/nationalMuseumBusinessHours";
import { statusOf } from "../lib/status";

// svg 는 w-full 이라 렌더 높이는 카드 폭 × (HEIGHT/WIDTH) 다 — 이 비율이 곧
// 차트의 모양이고, 폭만 줄여도 높이가 같이 줄어 모양은 안 바뀐다. 이 관은 카드가
// 하나뿐이라 폭을 거의 다 쓰므로(페이지 내용 폭 1152) 3.5:1 로 둔다:
// MmcaRoomChartCard 의 480×200(2열 카드, 2.4:1)을 그대로 쓰면 전폭에서 높이가
// 500px 까지 늘어나고, 더 납작하게 두면 곡선이 눌려 읽히지 않는다. 렌더 ~1152×329.
//
// 값 자체를 렌더 폭에 가깝게 잡는 이유는 선 굵기다 — 좌표계가 작으면 stroke 도
// 같은 배율로 확대돼(960 일 때 2.5 → 3px) 굵어 보인다. 호버·툴팁 좌표는 전부
// WIDTH 에 대한 비율이라 이 값에 딸려 움직인다.
const SPARKLINE_WIDTH = 1120;
const SPARKLINE_HEIGHT = 320;

function minutesOfDay(isoString: string): number {
  return Number(isoString.slice(11, 13)) * 60 + Number(isoString.slice(14, 16));
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
// rather than "10:00".
//
// 개관·폐관 라벨 옆에 붙는 눈금만 겹칠 수 있어 최소 간격을 둔다. 분이 아니라
// 좌표계 단위로 재는 이유는 두 가지다: 영업시간 길이가 요일마다 다르고(30분이
// 480분 축에서는 67단위, 690분 축에서는 46단위), 겹침은 시간이 아니라 폭의
// 문제다. 좌표계 단위는 렌더 픽셀과 거의 1:1 이다 (SPARKLINE_WIDTH 주석 참고).
// "09:30" 라벨이 약 33px, 가운데 정렬이라 옆 눈금과 필요한 간격은 그 절반 남짓 —
// 44 는 두 축 다 통과해 10시·17시가 남고, 480 단위 폭이던 시절 겹쳐 보였던
// 조합(그때 30분은 30단위였다)은 그대로 걸러진다.
const MIN_GAP_UNITS = 44;

function hourlyTicks(open: number, close: number): { minutes: number; label: string }[] {
  const ticks: number[] = [];
  const firstRoundHour = Math.ceil(open / 60) * 60;
  for (let m = firstRoundHour; m < close; m += 60) {
    const x = xOf(m, open, close);
    if (x < MIN_GAP_UNITS || SPARKLINE_WIDTH - x < MIN_GAP_UNITS) continue;
    ticks.push(m);
  }

  return [
    { minutes: open, label: tickLabel(open) },
    ...ticks.map((minutes) => ({ minutes, label: tickLabel(minutes) })),
    { minutes: close, label: tickLabel(close) },
  ];
}

type Point = { minutes: number; value: number; isRaw?: boolean };

// 서울시 판독은 5분 간격이고, 그것을 10분 마크(10:00, 10:10, …)에 붙여 평균낸다
// — MMCA 차트의 격자와 같은 간격(그쪽은 수집이 */10 이라 판독 자체가 마크에
// 있다)이라 두 관의 호버가 같은 눈금을 쓴다.
//
// 마크는 자정 기준의 10분 배수다. 개관(09:30)·폐관(17:30, 수·토 21:00)이 모두
// 10분 배수라 축의 양 끝도 마크이고, 그래서 호버·툴팁에 09:35 같은 시각이 아니라
// 10분·20분·30분만 나온다. 개관 기준으로 끊으면 마크가 5분씩 밀린다.
//
// 30분이던 이유는 이 차트가 2열 카드(480 단위 폭)였기 때문이다 — 그때 10분
// 간격은 22단위였다. 전폭이 된 뒤로는 같은 10분이 22px 라 점이 뭉치지 않는다.
const BUCKET_MINUTES = 10;
// 두 계열이 같은 마크 격자에 앉으므로 같은 마크는 항상 거리 0 이고 옆 마크는 정확히
// BUCKET_MINUTES 만큼 떨어져 있다 — 창을 한 마크 전체로 잡으면 그 옆의 (다른 시각)
// 마크가 걸려, 값이 없는 자리에서 없다고 말하지 못한다. 반 마크는 0 만 받는다.
const LAST_WEEK_MATCH_MINUTES = BUCKET_MINUTES / 2;

function resample(points: Point[], close: number, bucketMinutes: number): Point[] {
  const marks = new Map<number, Point[]>();
  for (const point of points) {
    // 가장 가까운 마크로 — 개관 기준 버킷의 시작·중심이 아니라 마크 자체가 그
    // 점의 시각이 된다. 09:55·10:00 이 10:00 에, 10:05·10:10 이 10:10 에 모인다.
    const mark = Math.round(point.minutes / bucketMinutes) * bucketMinutes;
    const bucket = marks.get(mark);
    if (bucket) bucket.push(point);
    else marks.set(mark, [point]);
  }
  return [...marks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([mark, bucketPoints]) => ({
      minutes: mark,
      value: bucketPoints.reduce((sum, p) => sum + p.value, 0) / bucketPoints.length,
    }))
    // 폐관이 10분 배수인 동안에는 걸릴 일이 없다 (판독이 폐관 이하이므로 마크도
    // 그렇다). 영업시간이 09:45 처럼 바뀌면 마지막 마크가 축을 넘고, svg 가
    // overflow-visible 이라 곡선이 축 밖 빈 자리로 이어져 그려진다.
    .filter((p) => p.minutes <= close);
}

// 곡선의 양 끝을 실제 판독으로 개관·폐관 시각에 닿게 한다. 개관·폐관이 10분
// 배수인 동안에는 첫·마지막 마크가 이미 축의 끝이라 아무것도 붙지 않고, 그날 첫
// 판독이 늦거나(개관 직후 수집 실패) 영업시간이 10분 배수가 아니게 되면 그때
// 실제로 붙는다. 마크 평균이 아닌 생판독이므로 isRaw 로 표시해 호버 조회에서
// 뺀다 — 마크 격자 위에 없는 시각이라 십자선이 어긋난다.
//
// `includeTrail` 이 false 인 경우는 오늘 영업 중일 때뿐이다 — 폐관 시각이 아직
// 오지 않았으므로 끝점을 붙일 판독이 없다.
function withEndpoints(raw: Point[], buckets: Point[], includeTrail: boolean): Point[] {
  const first = raw[0];
  const last = raw[raw.length - 1];
  const lead =
    first && (buckets.length === 0 || first.minutes < buckets[0].minutes)
      ? [{ ...first, isRaw: true }]
      : [];
  const trail =
    includeTrail && last && buckets.length > 0 && last.minutes > buckets[buckets.length - 1].minutes
      ? [{ ...last, isRaw: true }]
      : [];
  return [...lead, ...buckets, ...trail];
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

// 위·아래 여백. 0 이면 최소·최대값이 축의 맨 끝 선에 앉고, Catmull-Rom 이
// 그 바깥으로 오버슈트해(실측 −9 단위까지 나갔다) 눈금 라벨 위로 삐져나온다.
// MmcaRoomChartCard 의 yOf 와 같은 값이다.
const CHART_PAD = 24;

function yOf(value: number, range: Range): number {
  const span = range.max - range.min || 1; // ponytail: guards a flat/single-value range; a wider range never hits this
  return (
    SPARKLINE_HEIGHT - CHART_PAD - ((value - range.min) / span) * (SPARKLINE_HEIGHT - 2 * CHART_PAD)
  );
}

// yOf 의 역. 그린 곡선에서 읽은 y 를 툴팁에 적을 값으로 되돌린다 — 점의 위치와
// 숫자가 같은 곳에서 나와야 서로 어긋나지 않는다.
function valueOf(y: number, range: Range): number {
  const span = range.max - range.min || 1;
  return (
    range.min + ((SPARKLINE_HEIGHT - CHART_PAD - y) / (SPARKLINE_HEIGHT - 2 * CHART_PAD)) * span
  );
}

function toXY(points: Point[], open: number, close: number, range: Range): XY[] {
  return points.map(({ minutes, value }) => ({
    x: xOf(minutes, open, close),
    y: yOf(value, range),
  }));
}

// 정시 표본 사이의 선형 보간. 축 양 끝(개관·폐관)의 예측 점을 만드는 데만
// 쓴다 — 그 점들은 곡선의 제어점이 되므로 곡선이 정확히 그 위를 지난다.
// 호버 값에는 쓰지 않는다: 제어점 사이에서 곡선은 현(弦)에서 부풀어 올라
// (실측 최대 12단위 ≈ 11px) 점이 선에서 떠 보인다. 그쪽은 yAtX 가 그린
// 베지어를 그대로 읽는다.
function predictionAt(points: Point[], minutes: number): Point | undefined {
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    if (minutes < a.minutes || minutes > b.minutes) continue;
    const value =
      a.value + ((b.value - a.value) * (minutes - a.minutes)) / (b.minutes - a.minutes || 1);
    return { minutes, value };
  }
  return undefined;
}

// 축 양 끝의 예측 점. 표본 사이면 보간하고, 표본 구간 밖이면 가장 가까운 표본
// 값으로 눕힌다.
//
// 폐관에서 실제로 밖으로 나간다: 백엔드는 영업시간 정시만 담으므로(seoul.py 의
// in_business_hours) 17:30 폐관인 날의 마지막 표본이 17시고, 17:30 을 감쌀 18시
// 표본이 없다. 보간만 하면 그 30분을 못 그려 점선이 폐관 눈금보다 일찍 끊긴다.
// 눕히는 것이 값으로도 옳다: 17시 셀은 17:00~17:30 판독의 평균이라, 그 구간을
// 그 값으로 채우는 것이 없는 18시 값을 향해 기울이는 것보다 데이터에 가깝다.
// (개관 쪽은 09:30 판독이 9시 셀에 들어가 표본이 있어 보간으로 풀린다 —
// 그 셀이 빠진 날에는 여기서 눕는다.)
function predictionEdge(points: Point[], minutes: number): Point | undefined {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first) return undefined;
  if (minutes <= first.minutes) return { minutes, value: first.value };
  if (minutes >= last.minutes) return { minutes, value: last.value };
  return predictionAt(points, minutes);
}

// Centripetal Catmull-Rom -> cubic Bezier. Unlike the uniform variant (which
// weights every neighbor equally regardless of how close it is), this
// parametrizes each segment by sqrt(distance), so a point sitting unusually
// close to its neighbor (e.g. the 09:30 raw reading, ~15min from the first
// 30min bucket while every other point is a full bucket apart) contributes
// proportionally less to the tangent instead of bending the curve.
type Segment = { p1: XY; cp1: XY; cp2: XY; p2: XY };

function bezierSegments(xy: XY[]): Segment[] {
  const segments: Segment[] = [];
  const dist = (a: XY, b: XY) => Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)) || 1e-6;
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

    segments.push({
      p1,
      cp1: { x: p1.x + m1x / 3, y: p1.y + m1y / 3 },
      cp2: { x: p2.x - m2x / 3, y: p2.y - m2y / 3 },
      p2,
    });
  }
  return segments;
}

function smoothPath(xy: XY[]): string {
  return bezierSegments(xy).reduce(
    (d, { cp1, cp2, p2 }) => `${d} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${p2.x} ${p2.y}`,
    `M ${xy[0].x} ${xy[0].y}`
  );
}

function cubicAt(t: number, a: number, b: number, c: number, d: number): number {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

// 그려진 곡선 자체에서 x 의 y 를 읽는다 — 호버 점이 선 위에 앉으려면 점의 y 가
// 화면에 그린 것과 같은 식에서 나와야 한다.
//
// 이분탐색인 이유는 베지어가 t 로 매개화돼 x 를 직접 풀 수 없기 때문이다. 우리
// 데이터에서 x(t) 는 단조라(제어점의 x 가 시간 순) 탐색이 성립한다. 24회면
// 1120 단위 폭에서 오차가 10^-4 단위 아래다.
function yAtX(segments: Segment[], x: number): number | undefined {
  const segment = segments.find((s) => x >= s.p1.x && x <= s.p2.x);
  if (!segment) return undefined;
  const { p1, cp1, cp2, p2 } = segment;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (cubicAt(mid, p1.x, cp1.x, cp2.x, p2.x) < x) lo = mid;
    else hi = mid;
  }
  return cubicAt((lo + hi) / 2, p1.y, cp1.y, cp2.y, p2.y);
}

function areaPath(xy: XY[], linePath: string): string {
  const first = xy[0];
  const last = xy[xy.length - 1];
  return `M ${first.x} ${SPARKLINE_HEIGHT} L ${first.x} ${first.y} ${linePath.slice(linePath.indexOf("C"))} L ${last.x} ${SPARKLINE_HEIGHT} Z`;
}

export function CongestionCard({
  data,
  daily = null,
  lastWeekDaily = null,
  prediction = null,
  error = false,
  chartError = false,
  viewDate,
}: {
  data: CurrentCongestion | null;
  daily: DailyLogPoint[] | null;
  lastWeekDaily?: DailyLogPoint[] | null;
  // 그리는 날짜의 예측 곡선(정시 24점). 배치가 아직 못 돌았거나 조회가 실패하면
  // null 이고, 그때는 점선만 없다 — 실측 곡선은 예측 없이도 온전히 읽힌다.
  prediction?: PredictionCurvePoint[] | null;
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
  // 커서의 x 를 분으로 되돌린 값 하나. 계열의 점으로 스냅하는 게 아니다 —
  // 그 시각에서 각 계열을 따로 조회해 있는 것만 말한다 (MmcaRoomChartCard 와
  // 같은 규칙).
  const [hoverMinutes, setHoverMinutes] = useState<number | null>(null);

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
          <span className="text-2xl font-semibold text-ink-soft">영업 시간이 아닙니다</span>
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
  const ticks = hourlyTicks(open, close);
  // 개관 시각의 실제 판독(버킷 평균이 아닌 그 한 판독)으로 곡선을 개관 눈금에
  // 닿게 하고, 영업이 끝난 뒤에는 폐관 시각으로도 같게 한다.
  const points: Point[] = withEndpoints(
    rawPoints,
    resample(rawPoints, close, BUCKET_MINUTES),
    !isOpen
  );

  const lastWeekRawPoints: Point[] = (lastWeekDaily ?? [])
    .map((row) => ({
      minutes: minutesOfDay(row.observed_at),
      value: (row.population_min + row.population_max) / 2,
    }))
    .filter((p) => p.minutes >= open && p.minutes <= close);
  // 지난주는 늘 다 지나간 하루다 — 양 끝점이 항상 있다.
  const lastWeekPoints = withEndpoints(
    lastWeekRawPoints,
    resample(lastWeekRawPoints, close, BUCKET_MINUTES),
    true
  );

  // 예측은 실측과 같은 단위(population_avg)라 같은 축에 그대로 올라간다.
  // 표본이 정시뿐이라 영업시간 밖 점을 그냥 버리면 곡선이 개관·폐관 눈금에
  // 닿지 못한다(09:30~10:00, 17:00~17:30 이 빈다). 버리는 대신 축 양 끝에
  // 점을 만들어 곡선을 축에 맞춰 자른다.
  const predHourly: Point[] = (prediction ?? []).map((p) => ({
    minutes: p.hour * 60,
    value: p.model,
  }));
  const predOpen = predictionEdge(predHourly, open);
  const predClose = predictionEdge(predHourly, close);
  const predRawPoints: Point[] = predHourly.length === 0
    ? []
    : [
        ...(predOpen ? [predOpen] : []),
        ...predHourly.filter((p) => p.minutes > open && p.minutes < close),
        ...(predClose ? [predClose] : []),
      ];
  // 오늘 탭에서는 실선이 이미 그린 구간의 예측 점을 버리고 실선의 마지막 점을
  // 그대로 첫 점으로 붙인다 — 이음매가 없어야 하나의 곡선으로 읽힌다
  // (MmcaRoomChartCard 와 같은 규칙). 미래 탭의 `points` 는 오늘의 판독이 아니라
  // D−7 대리 기록이라 지킬 이음매가 없다: 거기서 재이음하면 하루가 이미 다 찬
  // 실선에 걸려 예측 곡선이 통째로 사라진다.
  //
  // 이음매는 붙이지만 MMCA 처럼 곡선을 오늘 수준으로 평행이동하지는 않는다 —
  // 그쪽 계수는 백테스트로 확정한 값이고, 여기(연속값·GBR)에는 그 근거가 없다.
  const lastActual = points[points.length - 1];
  const predPoints: Point[] =
    isTodayView && lastActual
      ? [lastActual, ...predRawPoints.filter((p) => p.minutes > lastActual.minutes)]
      : predRawPoints;

  const hasThisWeek = points.length > 0;
  const allValues = [...points, ...lastWeekPoints, ...predPoints].map((p) => p.value);
  const range: Range = allValues.length > 0 ? { min: Math.min(...allValues), max: Math.max(...allValues) } : { min: 0, max: 1 };

  const xy = hasThisWeek ? toXY(points, open, close, range) : [];
  const lastWeekXy = lastWeekPoints.length > 0 ? toXY(lastWeekPoints, open, close, range) : [];
  const predXy = predPoints.length > 1 ? toXY(predPoints, open, close, range) : [];
  const linePath = xy.length > 1 ? smoothPath(xy) : "";
  const lastWeekLinePath = lastWeekXy.length > 1 ? smoothPath(lastWeekXy) : "";
  // 점선의 기하는 한 곳에서만 나온다 — 그린 path 와 호버가 읽는 곡선이 같은
  // 세그먼트다.
  const predSegments = predXy.length > 1 ? bezierSegments(predXy) : [];
  const predictionPath = predSegments.length > 0 ? smoothPath(predXy) : "";
  const areaD = xy.length > 1 ? areaPath(xy, linePath) : "";
  const lastWeekAreaD = lastWeekXy.length > 1 ? areaPath(lastWeekXy, lastWeekLinePath) : "";
  const lastPoint = xy[xy.length - 1];
  // 예측만 있어도 차트는 보여야 한다. 점이 하나뿐이면 선은 없지만(위의 path 들이
  // 빈 문자열) 라이브 끝점 마커는 그려야 하므로 개수로 판단한다.
  const hasAnySeries = hasThisWeek || lastWeekXy.length > 0 || predictionPath !== "";

  function handleHoverMove(event: MouseEvent<SVGRectElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * SPARKLINE_WIDTH;
    // xOf 의 역 (0 나눗셈 가드까지 대칭으로).
    const minutes = open + (svgX / SPARKLINE_WIDTH) * (close - open || 1);
    // 계열과 같은 마크 격자로 맞춘다 — 값이 있으면 조회 거리가 늘 0 이고, 툴팁의
    // 시계도 10분 단위로만 튄다. 스냅을 먼저, 영업시간 가두기를 나중에 (순서를
    // 바꾸면 개관·폐관이 10분 배수가 아닐 때 영업시간 밖으로 튀어나간다).
    const snapped = Math.round(minutes / BUCKET_MINUTES) * BUCKET_MINUTES;
    setHoverMinutes(Math.min(Math.max(snapped, open), close));
  }

  // 09:30·폐관 시각의 생판독은 버킷이 아니라 곡선의 끝을 실측값으로 닿게 하려고
  // 넣은 점이다 — 호버 조회에서는 뺀다.
  const hoverablePoints = points.filter((p) => !p.isRaw);
  // 비교 계열은 탭에 따라 다른 prop 에 담긴다. 오늘 탭은 lastWeekPoints(회색
  // 지난주선), 미래 탭은 points — 페이지가 미래 탭에서 lastWeekDaily 를 null 로
  // 두고 D−7 실측을 daily 로 내려보내기 때문이다.
  const comparePoints = isTodayView ? lastWeekPoints.filter((p) => !p.isRaw) : hoverablePoints;

  // 오늘의 실측은 오늘 탭에만 있다: 미래 탭의 `points` 는 D−7 대리 기록(= 비교
  // 계열)이므로 오늘의 실측인 척하며 예측값을 온종일 가리면 안 된다.
  const hoverActual =
    hoverMinutes == null || !isTodayView
      ? undefined
      : nearestWithin(hoverablePoints, hoverMinutes, LAST_WEEK_MATCH_MINUTES);
  const hoverCompare =
    hoverMinutes == null ? undefined : nearestWithin(comparePoints, hoverMinutes, LAST_WEEK_MATCH_MINUTES);
  // 표시할 x 는 하나다: 걸린 그리드 점의 시각(두 그리드 계열은 같은 버킷 격자를
  // 쓴다), 없으면 짚은 시각. 예측값도 그 시각에서 다시 잡는다 — 짚은 시각 그대로
  // 두면 예측 점만 십자선에서 최대 15분 옆에 떨어진다.
  const anchorMinutes = (hoverActual ?? hoverCompare)?.minutes ?? hoverMinutes;
  // 실측이 있는 x 에서는 예측을 지운다 — 값이 확정된 자리에 나란히 놓인 추정치는
  // 잡음이다. 값은 그린 곡선에서 직접 읽는다 (yAtX 주석 참고).
  const hoverPredictionY =
    anchorMinutes == null || hoverActual
      ? undefined
      : yAtX(predSegments, xOf(anchorMinutes, open, close));
  const hoverPrediction =
    hoverPredictionY == null || anchorMinutes == null
      ? undefined
      : { minutes: anchorMinutes, value: valueOf(hoverPredictionY, range) };

  // 주값은 예측 > 실측 > 비교 순(앞의 둘은 서로 배타적이다). 주값이 비교 계열
  // 자신일 때만 괄호를 생략한다.
  const hoverPrimary = hoverPrediction ?? hoverActual ?? hoverCompare;
  const hoverPrefix = hoverPrediction ? "예측 " : hoverActual ? "" : "지난주 ";
  const hoverSuffix = hoverPrediction || hoverActual ? hoverCompare : undefined;

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
            {/* 기준 시각이 현재보다 한참 이전인 것을 장애로 읽지 않도록 옆에
                적어 둔다. 지나간 날의 기록에는 해당하지 않는다.
                문구가 "정상" 이라고 말하지는 않으므로, 이 줄이 경고처럼 읽힌다는
                제보가 오면 그 단어를 되살리는 쪽이 맞다 — 실측 지연은 34.1분
                (lib/freshness.ts)이라 "약" 도 함께 돌아와야 한다. */}
            {isTodayView && (
              <p className="mt-1 text-[11px] text-ink-soft/70">30분 지연됨</p>
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

        {(daily || lastWeekDaily || predictionPath) && (
          <div className="relative mt-8">
            {hasAnySeries && (
              // 범례는 그리는 날짜를 따라간다 — todayString() 에 고정하면 지나간
              // 날의 곡선 옆에 오늘 날짜가 적힌다. 비교선은 데이터가 있을 때만.
              <div className="mb-2 flex justify-end gap-3 text-[11px] text-ink-soft">
                {/* 그리는 날짜의 곡선이 실제로 있을 때만 — 예측 점선만 있는 개관
                    전 시각에는 그을 실선이 없어 범례가 없는 선을 가리킨다. */}
                {xy.length > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: lineStroke }} />
                    {monthDayWeekday(chartDate)}
                    {isTodayView ? " 오늘" : ""}
                  </span>
                )}
                {lastWeekXy.length > 0 && (
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
                    예측
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
              {hasAnySeries && (
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
                  {predictionPath && (
                    <path
                      data-testid="sparkline-prediction-line"
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
                      <circle cx={lastPoint.x} cy={lastPoint.y} r={14} fill="url(#sparkline-glow)" />
                      <circle cx={lastPoint.x} cy={lastPoint.y} r={4.5} fill="#FFFFFF" stroke={CHART_BLUE} strokeWidth={2.5} />
                    </>
                  )}
                  {hoverPrimary && (
                    <>
                      {/* 십자선은 주값의 시각에 선다 — 짚은 x 그대로 두면 버킷
                          중심에서 최대 15분 벗어나 점이 곡선에서 떠 보인다.
                          두 그리드 계열은 같은 버킷 격자라 함께 맞는다. */}
                      <line
                        x1={xOf(hoverPrimary.minutes, open, close)}
                        y1={0}
                        x2={xOf(hoverPrimary.minutes, open, close)}
                        y2={SPARKLINE_HEIGHT}
                        stroke="#D2D2D7"
                        strokeWidth={1}
                      />
                      {/* 값이 있는 계열마다 자기 점 위에 하나씩 — 예측 점의
                          minutes 는 짚은 시각 그대로다. */}
                      {[
                        [hoverActual, lineStroke] as const,
                        [hoverCompare, LAST_WEEK_STROKE] as const,
                        [hoverPrediction, CHART_BLUE] as const,
                      ].map(([point, stroke], i) =>
                        point ? (
                          <circle
                            key={i}
                            cx={xOf(point.minutes, open, close)}
                            cy={yOf(point.value, range)}
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
                    width={SPARKLINE_WIDTH}
                    height={SPARKLINE_HEIGHT}
                    fill="transparent"
                    onMouseMove={handleHoverMove}
                    onMouseLeave={() => setHoverMinutes(null)}
                  />
                </>
              )}
            </svg>
            {hoverPrimary && (
              <div
                data-testid="sparkline-tooltip"
                className="pointer-events-none absolute -top-2 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-hairline/60 bg-white/95 px-2.5 py-1.5 text-[11px] shadow-apple backdrop-blur-xl"
                style={{
                  // Follows the guide line, clamped so the box never overflows
                  // the card's clipped edges.
                  left: `${Math.min(Math.max((xOf(hoverPrimary.minutes, open, close) / SPARKLINE_WIDTH) * 100, 14), 86)}%`,
                }}
              >
                {/* 세 계열 모두 시각 하나로 적는다 (MmcaRoomChartCard 와 같은
                    모양). 10분 버킷은 5분 판독 두 개의 평균이고 그 시각이 곧
                    버킷의 중심이라, 구간을 적어도 더 말해주는 것이 없다 —
                    30분 버킷이던 동안에는 구간이 실제로 정보였다. */}
                <span className="font-mono tabular-nums text-ink-soft">
                  {formatMinutes(hoverPrimary.minutes)}
                </span>
                <span className="mx-1 text-ink-soft">·</span>
                {hoverPrefix && <span className="text-ink-soft">{hoverPrefix}</span>}
                <span className="font-mono font-semibold tabular-nums text-ink">
                  {Math.round(hoverPrimary.value).toLocaleString()}
                </span>
                <span className="text-ink-soft">명</span>
                {hoverSuffix && (
                  <span className="ml-1 text-ink-soft">
                    (지난주 <span className="font-mono tabular-nums">{Math.round(hoverSuffix.value).toLocaleString()}</span>명)
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
