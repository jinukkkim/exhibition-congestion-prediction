import type { CurrentCongestion } from "../api/congestion";
import type { MmcaRoomStatus, MmcaVenue } from "../api/mmca";
import { mmcaBusinessHours } from "./mmcaBusinessHours";
import { nationalMuseumBusinessHours } from "./nationalMuseumBusinessHours";
import { STATUS_LEVELS } from "./status";

export type VenueSummary =
  // label 은 카드 안에 짧게 얹히는 상태 배지다 — 진행 중인 일도 말줄임표 없이
  // 쓴다("불러오는 중", "집계 중"). 말줄임표는 카드를 통째로 채우는 독립 문구의
  // 것이다(CongestionCard·PredictionChart·MmcaPage 의 "불러오는 중...").
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
  // 시계만으로 확정되는 답을 데이터 도착보다 먼저 낸다. 순서를 뒤집으면
  // 페이지를 다시 열 때마다 이미 아는 답 대신 "불러오는 중"이 한 번 스쳐
  // 지나간다 (홈 카드는 마운트마다 fetch 를 다시 시작한다).
  const { open, close } = nationalMuseumBusinessHours(now);
  const closed = closedLabel(now, open, close);
  if (closed) return { kind: "inactive", label: closed };

  if (current === null) return { kind: "inactive", label: "불러오는 중" };

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
  // 시계 판정은 데이터 없이도 확정된다 — nationalMuseumSummary 와 같은
  // 이유로 데이터 검사보다 위에 둔다.
  const { open, close, isOpenToday } = mmcaBusinessHours(venue, now);
  if (!isOpenToday) return { kind: "inactive", label: "휴관일" };
  const closed = closedLabel(now, open, close);
  if (closed) return { kind: "inactive", label: closed };

  if (rooms === null) return { kind: "inactive", label: "불러오는 중" };

  const read = rooms.filter(
    (room): room is MmcaRoomStatus & { congestion_nm: string; observed_at: string } =>
      room.congestion_nm !== null && room.observed_at !== null
  );
  if (read.length === 0) {
    // 당일 폴이 한 번이라도 돌았는지로 "아직"과 "없음"을 가른다. /mmca/rooms는
    // 당일 판독만 돌려주므로 개관 직후에는 방이 비어 있는 것이 정상이고
    // (backend/app/collector.py의 _COLLECTION_START), 그 창은 오류가 아니다.
    // 반면 폴이 돈 뒤에도 값이 없는 것은 집계가 늦은 것이 아니라 줄 값이 없는
    // 것이다 — MMCA API 는 진행 중인 전시가 없거나 혼잡도를 제공하지 않는
    // 전시실에 resultCode 0002 로 빈 응답을 준다. 덕수궁관은 전시실이
    // MMCA-SPACE-4001 하나뿐이고 그 방이 계속 이 상태라, 가르지 않으면 영업
    // 시간 내내 곧 값이 올 것처럼 "집계 중"이 떠 있는다.
    const polled = rooms.some((room) => room.observed_at !== null);
    return { kind: "inactive", label: polled ? "정보 없음" : "집계 중" };
  }

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
