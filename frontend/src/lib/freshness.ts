// 백엔드 backend/app/routes/health.py 의 같은 이름 상수와 짝을 이룬다. 한쪽만
// 바꾸면 배지와 헬스체크가 서로 다른 판정을 내리므로 함께 고쳐야 한다.

// 국중박의 observed_at 은 서울 Open API 가 준 PPLTN_TIME — 우리가 폴링한 시각이
// 아니라 상류가 발행한 측정 시각이다. 발행이 약 30분 지연되므로 정상 수집 중에도
// 그만큼 낡아 있다 (2026-08-22 실측 34.1분, 같은 시각 당일 판독은 5분 간격 결손
// 0).
//
// 45 였다가 2026-08-30 에 75 로 넓혔다. 그날 서울 Open API 가 폴의 17%에
// ReadTimeout 으로 답해 수집에 10~40분 공백이 24번 생겼고, 45 는 정상 나이
// ~34분 위로 여유가 11분뿐이라 한 사이클만 밀려도 넘겼다. 45일치 기록에서
// 알림 발생일이 45분 2일 / 60분 1일 / 75분 0일이고 그 위로는 이득이 없다.
// 근거표 전체는 backend/app/routes/health.py 의 짝에 있다.
export const SEOUL_STALE_MINUTES = 75;

// MMCA 는 mmca_api.py 가 폴링 시각을 그대로 찍으므로 발행 지연이 없다. 그래서
// 이 값은 순수하게 "몇 라운드까지 빠져도 지금 값이라 부를 수 있나"이고, 수집
// 격자가 움직이면 같이 움직여야 한다 — 단위는 분이지만 재는 것은 라운드다.
//
// 25 였다. 10분 격자에서 "2회 유실 + 여유"로 잡은 값인데 격자가 10 → 1 → 2 로
// 바뀌는 동안 그대로 남아, */2 에서는 12.5 라운드 결손을 허용했다. 그 상태로
// 2026-09-03 의 실제 장애(라운드 407개 중 55개 유실, 하루 판독의 20.6%)를
// 놓쳤다 — 그날 최악 공백이 1분 격자에서 9분, */2 로 환산하면 18분이라 25 에
// 닿지 못했다. 수집이 죽어 가는 내내 배지는 초록으로 뛰었을 값이다.
//
// 12 는 37일치(2026-07-29~09-03)를 재서 나왔다. 방 자신의 판독 사이 최악 공백을
// 그날 격자의 배수로 재고 */2 로 환산했을 때 지연 배지가 뜨는 날 수:
// 6분 8일 / 8분 5일 / 10분 4일 / 12분 2일 / 15분 2일 / 20분 2일 / 25분 1일.
// 12 위로는 살 것이 없고(15·20 이 같은 2일), 남는 2일은 위 장애일과 전시
// 교체기(09-01, 방 1003)라 지연이라 부르는 것이 맞는 날이다.
//
// 전시가 없는 방(resultCode 0002)은 이 측정에서 뺐다. 그런 방은 몇 주씩
// 응답이 비어 판독 간격이 매일 120분씩 벌어지지만, MmcaPage 가 비활성 카드로
// 내려 배지 자체를 그리지 않는다.
//
// 근거표 전체와 헬스체크 쪽 논거는 backend/app/routes/health.py 의 짝에 있다.
export const MMCA_STALE_MINUTES = 12;

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
