import type { CurrentCongestion } from "../api/congestion";
import { nationalMuseumBusinessHours } from "./nationalMuseumBusinessHours";

export type VenueSummary =
  | { kind: "inactive"; label: string }
  | { kind: "level"; level: string; population: number; observedAt: string }
  | { kind: "counts"; counts: { level: string; count: number }[]; observedAt: string };

function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

// 운영시간 밖에서는 레벨을 감춘다 — /congestion/current는 폐관 뒤에도 마지막
// 판독을 계속 돌려주므로, 그대로 적으면 밤에도 지금 값인 것처럼 읽힌다.
// (CongestionCard의 openBadge와 같은 판정)
function closedLabel(now: Date, open: number, close: number): string | null {
  const nowMinutes = minutesOfDay(now);
  if (nowMinutes < open) return "운영 전";
  if (nowMinutes > close) return "운영 종료";
  return null;
}

export function nationalMuseumSummary(
  current: CurrentCongestion | null,
  now: Date
): VenueSummary {
  if (current === null) return { kind: "inactive", label: "불러오는 중" };

  const { open, close } = nationalMuseumBusinessHours(now);
  const closed = closedLabel(now, open, close);
  if (closed) return { kind: "inactive", label: closed };

  return {
    kind: "level",
    level: current.congest_level,
    population: current.population_avg,
    observedAt: current.observed_at,
  };
}
