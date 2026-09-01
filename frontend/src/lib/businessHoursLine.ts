import type { Venue } from "../venues";
import { formatMinutes } from "./date";
import { mmcaBusinessHours } from "./mmcaBusinessHours";
import { nationalMuseumBusinessHours } from "./nationalMuseumBusinessHours";

const WEEKDAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

// 요일별 영업시간을 모으려면 요일마다 Date 가 하나씩 필요하다. 영업시간 함수는
// getDay() 만 보므로 어느 주를 골라도 답이 같다 — 일요일로 시작하는 주 하나를
// 기준으로 쓴다.
const REFERENCE_SUNDAY = "2026-01-04";

function dayHours(venue: Venue, weekday: number) {
  const date = new Date(`${REFERENCE_SUNDAY}T12:00:00`);
  date.setDate(date.getDate() + weekday);
  // 국중박은 요일 휴관이 없어 isOpenToday 를 돌려주지 않는다.
  return venue.mmcaVenue
    ? mmcaBusinessHours(venue.mmcaVenue, date)
    : { ...nationalMuseumBusinessHours(date), isOpenToday: true };
}

function joinWeekdays(weekdays: number[]): string {
  return weekdays.map((weekday) => WEEKDAY_NAMES[weekday]).join("·");
}

// 한 주 전체를 "10:00~18:00 (수·토 21:00까지, 월요일 휴무)" 한 줄로 접는다.
//
// 고른 날짜가 아니라 관을 받는다 — 관 정보 표에 실리는 값이라 날짜 탭과 함께
// 바뀌지 않는다. 대신 영업시간 로직에서 직접 뽑으므로 차트 축과 어긋날 수 없다
// (과천관이 어긋나 있던 자리다).
export function businessHoursLine(venue: Venue): string {
  const week = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    ...dayHours(venue, weekday),
  }));
  const openDays = week.filter((day) => day.isOpenToday);
  const closedDays = week.filter((day) => !day.isOpenToday);

  // 기본 폐관 시각은 가장 이른 것으로 잡고, 그보다 늦게 닫는 요일만 괄호에
  // 따로 적는다 (야간개장).
  const baseClose = Math.min(...openDays.map((day) => day.close));
  const lateDays = openDays.filter((day) => day.close > baseClose);

  const notes: string[] = [];
  if (lateDays.length > 0) {
    // ponytail: 야간개장 요일의 폐관 시각은 관마다 하나뿐이라 가장 늦은 것
    // 하나로 적는다. 요일마다 다른 시각이 생기면 요일별로 쪼개야 한다.
    const lateClose = Math.max(...lateDays.map((day) => day.close));
    notes.push(
      `${joinWeekdays(lateDays.map((day) => day.weekday))} ${formatMinutes(lateClose)}까지`
    );
  }
  if (closedDays.length > 0) {
    notes.push(`${joinWeekdays(closedDays.map((day) => day.weekday))}요일 휴무`);
  }

  const hours = `${formatMinutes(openDays[0].open)}~${formatMinutes(baseClose)}`;
  return notes.length > 0 ? `${hours} (${notes.join(", ")})` : hours;
}
