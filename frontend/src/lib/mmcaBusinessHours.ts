import type { MmcaVenue } from "../api/mmca";

const OPEN_MINUTES = 10 * 60; // 10:00, every day
const NORMAL_CLOSE_MINUTES = 18 * 60;
const LONG_CLOSE_MINUTES = 21 * 60;

// 야간개장 요일: 수·토 21:00 폐관, 그 밖의 날은 18:00. 과천관은 야간개장이
// 없어 요일과 무관하게 18:00에 닫는다 — 공식 관람정보가 "화~일요일 10:00~
// 18:00"이고, 수집한 판독도 과천관 수·토 18시 이후에 비-여유가 한 건도 없다
// (종일 여유 = 빈 건물의 센서값).
const LONG_CLOSE_DAYS: Partial<Record<MmcaVenue, Set<number>>> = {
  seoul: new Set([3, 6]),
  deoksugung: new Set([3, 6]),
};

// Same rule as the backend's collector.py _VENUE_CLOSED_DAYS — Deoksugung is
// inside the palace grounds and Gwacheon keeps the same Tuesday–Sunday week;
// only Seoul opens every day. JS Date.getDay(): Sun=0, Mon=1 (the backend's
// Python datetime.weekday() is Mon=0, a different convention — this is the
// same real-world rule translated to JS's convention, not a copy of the
// value).
//
// ponytail: 요일만 본다. 대체공휴일 월요일에는 실제로 문을 열지만(2026-08-17
// 과천관에 정상 혼잡 기록이 있다) 그날은 휴관일로 그려진다. 공휴일 달력이
// 들어오면 그때 함께 고친다.
//
// MmcaPage 가 그날 방 목록을 통째로 안내 하나로 바꾸게 됐지만 잃는 것은 없다 —
// 백엔드의 _VENUE_CLOSED_DAYS 가 같은 요일 규칙으로 수집을 막고 있어 그날은
// 보여줄 판독이 애초에 없다(8/17 의 그 기록은 게이트가 생기기 전 것이다).
// 뒤집으면 고칠 때도 한쪽만 고쳐서는 안 된다는 뜻이다.
const VENUE_CLOSED_DAYS: Partial<Record<MmcaVenue, Set<number>>> = {
  gwacheon: new Set([1]),
  deoksugung: new Set([1]),
};

export function mmcaBusinessHours(
  venue: MmcaVenue,
  date: Date
): { open: number; close: number; isOpenToday: boolean } {
  const close = LONG_CLOSE_DAYS[venue]?.has(date.getDay())
    ? LONG_CLOSE_MINUTES
    : NORMAL_CLOSE_MINUTES;
  const isOpenToday = !VENUE_CLOSED_DAYS[venue]?.has(date.getDay());
  return { open: OPEN_MINUTES, close, isOpenToday };
}

/**
 * `from` **다음**으로 이 관이 문을 여는 날. 휴관일 안내가 "언제 다시 오면
 * 되는지"까지 말하려면 필요한 값이라 요일 휴관 규칙 바로 옆에 둔다 — 다른
 * 파일에 두면 VENUE_CLOSED_DAYS 를 고칠 때 한쪽만 고치게 된다.
 *
 * `from` 자신은 세지 않는다. 부르는 자리가 이미 "그날은 휴관일" 인 곳이다.
 *
 * 7일을 넘겨 찾지 않고 `null` 을 돌려준다. 어느 관도 이틀을 잇달아 쉬지
 * 않지만, VENUE_CLOSED_DAYS 에 일곱 요일을 다 적으면 무한 루프가 되는 형태라
 * 상한을 둔다 — businessHoursLine 이 같은 상황에서 "상시 휴관" 을 돌려주는
 * 것과 같은 방어이고, 호출부는 안내 줄을 생략하면 된다.
 */
export function nextOpenDay(
  venue: MmcaVenue,
  from: Date
): { weekday: number; open: number } | null {
  const date = new Date(from);
  for (let i = 0; i < 7; i++) {
    date.setDate(date.getDate() + 1);
    const { open, isOpenToday } = mmcaBusinessHours(venue, date);
    if (isOpenToday) return { weekday: date.getDay(), open };
  }
  return null;
}
