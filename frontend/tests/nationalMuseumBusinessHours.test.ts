import { describe, expect, it } from "vitest";

import { nationalMuseumBusinessHours } from "../src/lib/nationalMuseumBusinessHours";

describe("nationalMuseumBusinessHours", () => {
  it("closes at 21:00 on Wednesday and Saturday", () => {
    // 2026-08-19 수요일, 2026-08-22 토요일
    expect(nationalMuseumBusinessHours(new Date("2026-08-19T12:00:00"))).toEqual({
      open: 9 * 60 + 30,
      close: 21 * 60,
      isOpenToday: true,
    });
    expect(nationalMuseumBusinessHours(new Date("2026-08-22T12:00:00"))).toEqual({
      open: 9 * 60 + 30,
      close: 21 * 60,
      isOpenToday: true,
    });
  });

  it("closes at 17:30 on other days", () => {
    // 2026-08-20 목요일
    expect(nationalMuseumBusinessHours(new Date("2026-08-20T12:00:00"))).toEqual({
      open: 9 * 60 + 30,
      close: 17 * 60 + 30,
      isOpenToday: true,
    });
  });

  it("closes on the calendar days the museum publishes", () => {
    // 관람정보 원문: "휴관일: 2026년 1월1일, 설날(2.17.화), 추석(9.25.금)"
    expect(nationalMuseumBusinessHours(new Date("2026-09-25T12:00:00")).isOpenToday).toBe(false);
    expect(nationalMuseumBusinessHours(new Date("2026-01-01T12:00:00")).isOpenToday).toBe(false);
    // 요일 휴관은 없다.
    expect(nationalMuseumBusinessHours(new Date("2026-09-07T12:00:00")).isOpenToday).toBe(true);
  });
});
