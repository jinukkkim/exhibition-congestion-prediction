import type { CurrentCongestion } from "../api/congestion";
import type { MmcaRoomStatus, MmcaVenue } from "../api/mmca";
import { mmcaBusinessHours } from "./mmcaBusinessHours";
import { DISABLED_MMCA_SPACE_CODES } from "./mmcaDisabledRooms";
import { nationalMuseumBusinessHours } from "./nationalMuseumBusinessHours";
import { STATUS_LEVELS } from "./status";

export type VenueSummary =
  | { kind: "inactive"; label: string }
  | { kind: "level"; level: string; population: number; observedAt: string }
  | { kind: "counts"; counts: { level: string; count: number }[]; observedAt: string };

function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

// 영업시간 밖에서는 레벨을 감춘다 — /congestion/current는 폐관 뒤에도 마지막
// 판독을 계속 돌려주므로, 그대로 적으면 밤에도 지금 값인 것처럼 읽힌다.
// (CongestionCard의 openBadge와 같은 판정)
function closedLabel(now: Date, open: number, close: number): string | null {
  const nowMinutes = minutesOfDay(now);
  if (nowMinutes < open) return "영업 전";
  if (nowMinutes > close) return "영업 종료";
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

export function mmcaSummary(
  venue: MmcaVenue,
  rooms: MmcaRoomStatus[] | null,
  now: Date
): VenueSummary {
  if (rooms === null) return { kind: "inactive", label: "불러오는 중" };

  const active = rooms.filter((room) => !DISABLED_MMCA_SPACE_CODES.has(room.space_code));
  // 시각 판정보다 위 — 덕수궁관은 시간과 무관하게 영구히 수집 대상이 아니므로,
  // 밤에 "영업 종료"로 적으면 아침에는 값이 나올 것처럼 읽힌다.
  if (active.length === 0) return { kind: "inactive", label: "서비스 예정" };

  const { open, close, isOpenToday } = mmcaBusinessHours(venue, now);
  if (!isOpenToday) return { kind: "inactive", label: "휴관일" };
  const closed = closedLabel(now, open, close);
  if (closed) return { kind: "inactive", label: closed };

  const read = active.filter(
    (room): room is MmcaRoomStatus & { congestion_nm: string; observed_at: string } =>
      room.congestion_nm !== null && room.observed_at !== null
  );
  // /mmca/rooms는 당일 판독만 돌려주고 수집기의 첫 폴은 개관 10분 뒤에 돈다
  // (backend/app/collector.py의 _COLLECTION_START) — 그 창은 오류가 아니다.
  if (read.length === 0) return { kind: "inactive", label: "집계 중" };

  const tally = new Map<string, number>();
  for (const room of read) {
    tally.set(room.congestion_nm, (tally.get(room.congestion_nm) ?? 0) + 1);
  }

  // 아는 레벨을 혼잡도순으로 먼저 쏟고, 목록에 없는 레벨은 등장 순서대로 뒤에
  // 붙인다 (statusOf가 회색 fallback으로 그려 준다).
  const unknown = [...tally.keys()].filter((level) => !STATUS_LEVELS.includes(level));
  const counts = [...STATUS_LEVELS, ...unknown]
    .filter((level) => tally.has(level))
    .map((level) => ({ level, count: tally.get(level) as number }));

  return {
    kind: "counts",
    counts,
    // ISO 문자열은 같은 포맷이면 사전순 = 시간순.
    observedAt: read.reduce(
      (latest, room) => (room.observed_at > latest ? room.observed_at : latest),
      read[0].observed_at
    ),
  };
}
