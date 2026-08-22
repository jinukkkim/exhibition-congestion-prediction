function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function todayString(): string {
  return formatDate(new Date());
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];

export function monthDay(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function weekdayKo(date: string): string {
  return WEEKDAY_KO[new Date(`${date}T00:00:00`).getDay()];
}

export function monthDayWeekday(date: string): string {
  return `${monthDay(date)}(${weekdayKo(date)})`;
}

// 날짜 탭용. shiftDate 를 그대로 써서 월·연 경계 계산을 한곳에 둔다.
export function upcomingDates(from: string, count: number): string[] {
  return Array.from({ length: count }, (_, offset) => shiftDate(from, offset));
}
