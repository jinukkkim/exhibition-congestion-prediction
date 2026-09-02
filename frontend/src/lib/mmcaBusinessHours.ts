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
