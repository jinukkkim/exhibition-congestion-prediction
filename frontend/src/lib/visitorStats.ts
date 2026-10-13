import type { Pageview, UtmKey } from "../api/analytics";
import { monthDay, monthDayWeekday, shiftDate } from "./date";

// /visitors 의 집계 전부. 백엔드는 행만 내리고 세는 일은 여기서 한다 — 필터를
// 겹칠 때마다 서버에서 다시 세면 조합마다 로그 창 전체를 훑게 된다.

export type Dimension =
  | "page"
  | "route"
  | "referrer"
  | `utm_${UtmKey}`
  | "device"
  | "browser"
  | "os";

export const DIMENSIONS: Dimension[] = [
  "page",
  "route",
  "referrer",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "device",
  "browser",
  "os",
];

export type Filters = Partial<Record<Dimension, string>>;

// App.tsx 의 /venues/:venue 와 그 아래 /when 을 하나로 묶는다. 라우트가
// 늘면 여기 패턴도 늘려야 하지만, 빠진 라우트는 경로 그대로 보일 뿐이다.
export function routeOf(path: string): string {
  return path.replace(/^\/venues\/[^/]+/, "/venues/[venue]");
}

export function valueOf(row: Pageview, dimension: Dimension): string | null {
  switch (dimension) {
    case "page":
      return row.path;
    case "route":
      return routeOf(row.path);
    case "referrer":
      return row.referrer;
    case "device":
    case "browser":
    case "os":
      return row[dimension];
    default:
      return row.utm[dimension.slice(4) as UtmKey] ?? null;
  }
}

export function applyFilters<T extends Pageview>(rows: T[], filters: Filters): T[] {
  const active = Object.entries(filters) as [Dimension, string][];
  return rows.filter((row) => active.every(([dim, value]) => valueOf(row, dim) === value));
}

export function countVisitors(rows: Pageview[]): number {
  return new Set(rows.map((row) => row.visitor)).size;
}

function groupBy(rows: Pageview[], keyOf: (row: Pageview) => string | null) {
  const groups = new Map<string, Pageview[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) continue;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

export interface BreakdownRow {
  value: string;
  visitors: number;
  views: number;
}

export function breakdown(rows: Pageview[], dimension: Dimension): BreakdownRow[] {
  return [...groupBy(rows, (row) => valueOf(row, dimension))]
    .map(([value, group]) => ({ value, visitors: countVisitors(group), views: group.length }))
    .sort(
      (a, b) => b.visitors - a.visitors || b.views - a.views || a.value.localeCompare(b.value)
    );
}

export interface Point {
  // 일 단위면 "2026-09-07", 시간 단위면 "2026-09-07T14" — 행의 at 앞부분과 같다.
  key: string;
  visitors: number;
  views: number;
}

const HOUR_MS = 3_600_000;
const SEOUL_OFFSET_MS = 9 * HOUR_MS;

// 백엔드는 시각을 늘 서울 시간(+09:00)으로 싣는다. 그래서 키는 문자열 앞부분이고,
// 칸을 만들 때만 브라우저 시간대와 상관없이 서울 기준으로 센다.
function bucketKeys(start: string, days: number, now: Date): string[] {
  if (days > 1) {
    return Array.from({ length: days }, (_, i) => shiftDate(start.slice(0, 10), i));
  }
  const keys: string[] = [];
  for (let t = Date.parse(`${start.slice(0, 13)}:00:00+09:00`); t <= now.getTime(); t += HOUR_MS) {
    keys.push(new Date(t + SEOUL_OFFSET_MS).toISOString().slice(0, 13));
  }
  return keys;
}

// 빈 칸도 0 으로 싣는다 — 빠지면 가로축이 조용히 압축되어 뜸했던 기간이 안 보인다.
export function series(rows: Pageview[], start: string, days: number, now: Date): Point[] {
  const width = days > 1 ? 10 : 13;
  const groups = groupBy(rows, (row) => row.at.slice(0, width));
  return bucketKeys(start, days, now).map((key) => {
    const group = groups.get(key) ?? [];
    return { key, visitors: countVisitors(group), views: group.length };
  });
}

export function axisLabel(key: string): string {
  return key.length > 10 ? `${key.slice(11)}:00` : monthDay(key);
}

export function longLabel(key: string): string {
  return key.length > 10
    ? `${monthDayWeekday(key.slice(0, 10))} ${key.slice(11)}:00`
    : monthDayWeekday(key);
}

// 직전 기간이 0 이면 몇 퍼센트라 해도 거짓말이다.
export function change(current: number, previous: number): number | null {
  return previous ? Math.round(((current - previous) / previous) * 100) : null;
}
