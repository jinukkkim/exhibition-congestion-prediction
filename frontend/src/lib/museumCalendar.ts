import calendar from "../../../shared/museum-holidays.json";
import { dateString } from "./date";

// 요일 휴관. 덕수궁관은 궁 안에 있고 과천관도 화~일 주간을 지킨다 — 매주
// 월요일 문을 여는 것은 서울관뿐이다. JS Date.getDay(): 일=0, 월=1
// (백엔드 collector.py 의 datetime.weekday() 는 월=0 인 다른 규약이다.
// 같은 현실 규칙을 JS 규약으로 옮긴 것이지 값을 베낀 것이 아니다).
const WEEKLY_CLOSED: Record<string, number> = {
  gwacheon: 1,
  deoksugung: 1,
};

const PUBLIC_HOLIDAYS = new Set<string>(calendar.publicHolidays);
const CLOSED: Record<string, string[]> = calendar.closed;

type Venue = keyof typeof calendar.closed;

export function isWeeklyClosed(venue: Venue, date: Date): boolean {
  return WEEKLY_CLOSED[venue] === date.getDay();
}

/**
 * 그날 그 관이 문을 닫는가.
 *
 * 백엔드 collector.py 의 `_is_closed_day` 와 같은 규칙이다. 목록은
 * shared/museum-holidays.json 하나뿐이고 규칙만 양쪽에 있다 — 값이 아니라
 * 목록을 중복하는 쪽이 위험해서 그것만 공유한다.
 *
 * 공휴일 월요일에 열고 다음 날 쉬는 규칙의 출처는 **공식 문서가 아니라
 * 실측**이다. 과천·덕수궁 관람정보와 MMCA FAQ 모두 "1월1일, 매주 월요일"
 * 만 적는다. 근거는 2026-08-17 과천 non-여유 185건과 이튿날 219판독 전부
 * 여유 하나뿐이다. 다음 검증 기회는 2026-10-05 → 10/06.
 */
export function isClosedDay(venue: Venue, date: Date): boolean {
  const day = dateString(date);
  if (CLOSED[venue]?.includes(day)) return true;

  if (isWeeklyClosed(venue, date)) return !PUBLIC_HOLIDAYS.has(day);

  const previous = new Date(date);
  previous.setDate(previous.getDate() - 1);
  return isWeeklyClosed(venue, previous) && PUBLIC_HOLIDAYS.has(dateString(previous));
}
