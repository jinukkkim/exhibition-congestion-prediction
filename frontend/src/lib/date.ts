function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// 백엔드는 날짜를 KST 로 다루고(routes/prediction.py 의 _today_seoul,
// batch.py, collector.py) observed_at 도 KST 벽시계다. 브라우저 타임존으로
// "오늘"을 정하면 "오늘"이 두 벌이 되어, 탭 선택이 서버가 내려준 날짜 목록과
// 어긋나고 실시간 헤드라인 판정도 갈린다.
const SEOUL_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function todayString(): string {
  return SEOUL_DAY.format(new Date());
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

// 하루 안의 분(0–1439)을 HH:MM 으로. 영업시간 한 줄과 두 차트의 축 눈금이 같은
// 표기를 써야 하므로 한 곳에 둔다 — 사본이 셋이던 동안에는 하나만 고치면 헤더와
// 축이 조용히 어긋날 수 있었다.
export function formatMinutes(minutes: number): string {
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}
