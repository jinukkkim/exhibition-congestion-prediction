// 영업시간은 관 단위 정보다(방마다 다르지 않다) — 카드마다 같은 값을 반복하지
// 않고 페이지 헤더에 한 줄로 둔다.
//
// 고른 날의 값만 적으면 수·토 야간 연장이 보이지 않으므로 규칙을 같은 줄에
// 담는다. 고른 날이 이미 수·토라면 연장 시각이 곧 그날의 폐관 시각이므로,
// 같은 시각을 두 번 적지 않고 "연장 운영"이라고만 적는다.
const LONG_CLOSE_MINUTES = 21 * 60; // 수·토 폐관 — 국중박·MMCA 공통

function formatMinutes(minutes: number): string {
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function businessHoursLine(
  open: number,
  close: number,
  isToday: boolean,
  isOpenToday = true
): string {
  if (!isOpenToday) return isToday ? "오늘은 휴관일입니다" : "휴관일입니다";
  const rule =
    close === LONG_CLOSE_MINUTES
      ? "수·토 연장 운영"
      : `수·토는 ${formatMinutes(LONG_CLOSE_MINUTES)}까지`;
  // "오늘" 을 붙이지 않는다 — 이 줄 바로 아래 날짜 탭이 오늘 탭을 "오늘 8/25"
  // 로 표시하므로 같은 말이 한 화면에 두 번 나온다. 휴관일 문구는 그대로 둔다:
  // 거기서는 "오늘은" 이 영업시간이라는 말과 겹치지 않는다.
  return `영업시간 ${formatMinutes(open)}–${formatMinutes(close)} (${rule})`;
}
