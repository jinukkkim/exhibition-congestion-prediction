import type { CurrentCongestion } from "../api/congestion";
import type { MmcaRoomStatus, MmcaVenue } from "../api/mmca";
import { mmcaBusinessHours } from "./mmcaBusinessHours";
import { DISABLED_MMCA_SPACE_CODES, DISABLED_MMCA_VENUES } from "./mmcaDisabledRooms";
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
  // 시각 판정보다 위 — 덕수궁관은 시간과 무관하게 영구히 수집 대상이 아니므로,
  // 밤에 "영업 종료"로 적으면 아침에는 값이 나올 것처럼 읽힌다. 다만 이 판정만은
  // 방 목록이 있어야 가능하므로, 목록이 없는 동안은 아래 시계 판정에 맡긴다.
  const active = rooms?.filter((room) => !DISABLED_MMCA_SPACE_CODES.has(room.space_code)) ?? null;
  if (active !== null && active.length === 0) {
    return { kind: "inactive", label: "서비스 예정" };
  }

  // 목록을 기다리는 동안에도 결론이 정해진 관은 미리 답한다 (덕수궁관). 시계
  // 답을 먼저 보여주면 곧 "서비스 예정"으로 바뀌는 값을 한 번 스쳐 보이게 된다.
  if (active === null && DISABLED_MMCA_VENUES.has(venue)) {
    return { kind: "inactive", label: "서비스 예정" };
  }

  // 나머지 시계 판정은 데이터 없이도 확정된다 — nationalMuseumSummary 와 같은
  // 이유로 데이터 검사보다 위에 둔다.
  const { open, close, isOpenToday } = mmcaBusinessHours(venue, now);
  if (!isOpenToday) return { kind: "inactive", label: "휴관일" };
  const closed = closedLabel(now, open, close);
  if (closed) return { kind: "inactive", label: closed };

  if (active === null) return { kind: "inactive", label: "불러오는 중" };

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
