import calendar from "../../../shared/museum-holidays.json";
import { dateString, shiftDate } from "./date";

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
 * 여유 하나뿐이다. 2026-10-05(월, 공휴일)는 개관 규칙을 다시 검증할 다음
 * 기회다 — 그날 과천관에 non-빈 판독이 쌓이면 확인된다. 다만 대체휴무일
 * 규칙은 이 배포 이후로는 우리 데이터로 재검증할 수 없다: 백엔드가 10/06 을
 * 닫힘으로 판정해 그날 과천관 수집 자체를 건너뛰기 때문이다 — 10/06 이
 * 실제로 휴관인지는 이제 관 공지나 방문으로만 확인할 수 있다.
 *
 * 그 근거를 설·추석 연휴 월요일까지 늘리지 않는다 — publicHolidays 는 그런
 * 날짜(2026-02-16, 2027-02-08)를 일부러 뺀다. shared/museum-holidays.json
 * 의 _comment 참고.
 */
export function isClosedDay(venue: Venue, date: Date): boolean {
  const day = dateString(date);
  if (CLOSED[venue]?.includes(day)) return true;

  if (isWeeklyClosed(venue, date)) return !PUBLIC_HOLIDAYS.has(day);

  // 전날이 그 관의 요일 휴관일이었는지는 두 번째 Date 를 만들지 않고 셈으로
  // 구한다 — shiftDate 가 이미 문자열 날짜 하나로 요일 이동을 계산해 준다.
  // isWeeklyClosed 는 Date 를 받는 형태라 여기서는 요일 번호를 직접 인라인한다
  // (JS Date.getDay(): 일=0 이므로 하루 전 요일은 (오늘 요일 + 6) % 7).
  const previousWeekday = (date.getDay() + 6) % 7;
  const previousDay = shiftDate(day, -1);
  return WEEKLY_CLOSED[venue] === previousWeekday && PUBLIC_HOLIDAYS.has(previousDay);
}
