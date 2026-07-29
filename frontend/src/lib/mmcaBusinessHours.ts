import type { MmcaVenue } from "../api/mmca";

const OPEN_MINUTES = 10 * 60; // 10:00, every day
const LONG_CLOSE_DAYS = new Set([3, 6]); // Wed, Sat: 21:00 close; other days: 18:00

// Same rule as the backend's collector.py _VENUE_CLOSED_DAYS — Deoksugung is
// inside the palace grounds and closed on Mondays; Seoul/Gwacheon have no
// closed days. JS Date.getDay(): Sun=0, Mon=1 (the backend's Python
// datetime.weekday() is Mon=0, a different convention — this is the same
// real-world rule translated to JS's convention, not a copy of the value).
const VENUE_CLOSED_DAYS: Partial<Record<MmcaVenue, Set<number>>> = {
  deoksugung: new Set([1]),
};

export function mmcaBusinessHours(
  venue: MmcaVenue,
  date: Date
): { open: number; close: number; isOpenToday: boolean } {
  const close = LONG_CLOSE_DAYS.has(date.getDay()) ? 21 * 60 : 18 * 60;
  const isOpenToday = !VENUE_CLOSED_DAYS[venue]?.has(date.getDay());
  return { open: OPEN_MINUTES, close, isOpenToday };
}
