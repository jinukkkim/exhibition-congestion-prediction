const OPEN_MINUTES = 10 * 60; // 10:00, every day
const LONG_CLOSE_DAYS = new Set([3, 6]); // Wed, Sat: 21:00 close; other days: 18:00

export function mmcaBusinessHours(date: Date): { open: number; close: number } {
  const close = LONG_CLOSE_DAYS.has(date.getDay()) ? 21 * 60 : 18 * 60;
  return { open: OPEN_MINUTES, close };
}
