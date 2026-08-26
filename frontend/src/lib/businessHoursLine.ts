import { formatMinutes, monthDayWeekday } from "./date";

// 영업시간은 관 단위 정보다(방마다 다르지 않다) — 카드마다 같은 값을 반복하지
// 않고 페이지 헤더에 한 줄로 둔다.
//
// 어느 날의 시간인지를 줄 안에서 직접 말한다. 날짜 탭이 위에 있긴 하지만,
// 이 줄만 읽어도 뜻이 닫히는 편이 낫다.
export function businessHoursLine(
  date: string,
  open: number,
  close: number,
  isOpenToday = true
): string {
  const day = monthDayWeekday(date);
  if (!isOpenToday) return `${day} 휴관일입니다`;
  return `${day} 영업시간 ${formatMinutes(open)}–${formatMinutes(close)}`;
}
