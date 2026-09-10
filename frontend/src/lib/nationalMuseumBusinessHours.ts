import { isClosedDay } from "./museumCalendar";

const OPEN_MINUTES = 9 * 60 + 30; // 09:30, every day
const LONG_CLOSE_DAYS = new Set([3, 6]); // Wed, Sat: 21:00 close; other days: 17:30

// 요일 휴관이 없는 관이라 isOpenToday 는 달력에서만 온다 — 관람정보 원문이
// "1월1일, 설날, 추석" 이다. 상설전시관 정기휴실일(3·6·9·12월 첫째 월요일)은
// 관 전체 휴관이 아니고, 이 관의 혼잡도는 서울시 생활인구(그 지역 인구지
// 관람객 수가 아니다)라 애초에 보이지 않아 달력에 넣지 않았다.
export function nationalMuseumBusinessHours(
  date: Date
): { open: number; close: number; isOpenToday: boolean } {
  const close = LONG_CLOSE_DAYS.has(date.getDay()) ? 21 * 60 : 17 * 60 + 30;
  return { open: OPEN_MINUTES, close, isOpenToday: !isClosedDay("national-museum", date) };
}
