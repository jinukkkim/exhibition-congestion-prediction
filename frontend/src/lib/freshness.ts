// 백엔드 backend/app/routes/health.py 의 같은 이름 상수와 짝을 이룬다. 한쪽만
// 바꾸면 배지와 헬스체크가 서로 다른 판정을 내리므로 함께 고쳐야 한다.

// 국중박의 observed_at 은 서울 Open API 가 준 PPLTN_TIME — 우리가 폴링한 시각이
// 아니라 상류가 발행한 측정 시각이다. 발행이 약 30분 지연되므로 정상 수집 중에도
// 그만큼 낡아 있다 (2026-08-22 실측 34.1분, 같은 시각 당일 판독은 5분 간격 결손
// 0). 45 = ~30 발행 지연 + 5분 단위 + 5분 주기 2회 유실.
export const SEOUL_STALE_MINUTES = 45;

// MMCA 는 mmca_api.py 가 폴링 시각을 그대로 찍으므로 발행 지연이 없다. 10분
// 주기 × 2회 유실 + 여유.
export const MMCA_STALE_MINUTES = 25;

/**
 * 표시 중인 판독을 아직 "지금 값"이라 불러도 되는지.
 *
 * 판독이 없으면 stale로 본다 — 보여줄 최신값이 없다는 뜻이므로 배지가 실시간을
 * 주장해선 안 된다. 미래 시각(서버 시계가 앞선 경우)은 신선한 쪽으로 둔다.
 */
export function isStale(observedAt: string | null, now: Date, staleAfterMinutes: number): boolean {
  if (observedAt === null) return true;
  const ageMinutes = (now.getTime() - new Date(observedAt).getTime()) / 60_000;
  return ageMinutes > staleAfterMinutes;
}

// 신선도 배지의 점 색. 혼잡도 팔레트(status.ts)와 값이 겹치지만 **뜻이 다르다**
// — 여기서 초록은 "여유"가 아니라 "지금 값", 주황은 "약간 붐빔"이 아니라
// "갱신이 밀렸다"는 뜻이다. 혼잡도 자체는 옆의 큰 글자와 카드 배경 글로우가
// 말하므로, 점은 신선도 한 축만 담당한다.
//
// 영업시간 밖(영업 전·종료·휴관일)에는 신선도를 주장할 일이 없어 회색이다.
const LIVE_DOT = "#34C759";
const STALE_DOT = "#FF9F0A";
const IDLE_DOT = "#C7C7CC";

export function freshnessDotColor(isOpen: boolean, stale: boolean): string {
  if (!isOpen) return IDLE_DOT;
  return stale ? STALE_DOT : LIVE_DOT;
}
