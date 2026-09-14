import type { CurrentCongestion } from "../api/congestion";
import type { MmcaRoomStatus, MmcaVenue } from "../api/mmca";
import { seoulDateString } from "./date";
import { mmcaBusinessHours } from "./mmcaBusinessHours";
import { labelOf, latestObservedAt, venueTier } from "./mmcaVenueCongestion";
import { nationalMuseumBusinessHours } from "./nationalMuseumBusinessHours";

export type VenueSummary =
  // label 은 카드 안에 짧게 얹히는 상태 배지다 — 진행 중인 일도 말줄임표 없이
  // 쓴다("불러오는 중", "집계 중"). 말줄임표는 카드를 통째로 채우는 독립 문구의
  // 것이다(CongestionCard·MmcaPage 의 "불러오는 중...").
  | { kind: "inactive"; label: string }
  // population 은 국중박만 싣는다 — MMCA 는 인원 추정을 주지 않고 등급뿐이다.
  | { kind: "level"; level: string; population?: number; observedAt: string };

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
  //
  // 같은 `now` 를 두 가지로 나눠 읽는다. 휴관 판정에 필요한 것은 "그 순간이
  // KST 로 며칠인가" 라 seoulDateString(now) 로 접고, 분 단위 판정
  // (closedLabel 의 nowMinutes)은 로컬 벽시계 질문이라 `now` 를 그대로 넘긴다.
  // 접지 않으면 브라우저 로컬 Y/M/D 가 쓰여, KST 보다 느린(서쪽) 타임존이
  // 자정 근처에서 물을 때 하루 어긋난 날짜로 달력을 찾아 휴관을 놓친다.
  //
  // 시계를 직접 읽지 않고 `now` 를 접는 것이 요점이다 — 인자로 받은 시각과
  // 답이 갈라지면 이 함수가 인자만으로 결정되지 않게 된다.
  const { open, close, isOpenToday } = nationalMuseumBusinessHours(
    new Date(`${seoulDateString(now)}T00:00:00`)
  );
  if (!isOpenToday) return { kind: "inactive", label: "휴관일" };
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
  //
  // 휴관 판정에 넣는 날짜는 `now` 를 KST 로 접은 것이다 —
  // nationalMuseumSummary 와 같은 이유(위 주석 참고). 분 단위 판정은 `now`
  // 그대로 쓴다.
  const { open, close, isOpenToday } = mmcaBusinessHours(
    venue,
    new Date(`${seoulDateString(now)}T00:00:00`)
  );
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

  // 전시실별 개수("여유 3 · 보통 1")를 세던 자리다. 관 하나를 등급 하나로 접어
  // 국중박 카드와 같은 모양으로 읽히게 한다 — 집계 규칙과 그 대가는
  // lib/mmcaVenueCongestion.ts 에 적혀 있다.
  const tier = venueTier(read);
  // 네 등급 어디에도 없는 문자열만 온 경우. 실측 66k 판독에는 없었지만, 접을 수
  // 없는 값을 접은 척하느니 없다고 말한다.
  if (tier === null) return { kind: "inactive", label: "정보 없음" };

  return {
    kind: "level",
    level: labelOf(tier),
    // read 가 비어 있지 않음은 위에서 확인했다 — null 이 나올 수 없다.
    observedAt: latestObservedAt(read) as string,
  };
}
