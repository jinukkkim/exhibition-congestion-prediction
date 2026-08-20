import { describe, expect, it } from "vitest";

import { nationalMuseumBusinessHours } from "../src/lib/nationalMuseumBusinessHours";

describe("nationalMuseumBusinessHours", () => {
  it("closes at 21:00 on Wednesday and Saturday", () => {
    // 2026-08-19 수요일, 2026-08-22 토요일
    expect(nationalMuseumBusinessHours(new Date("2026-08-19T12:00:00"))).toEqual({
      open: 9 * 60 + 30,
      close: 21 * 60,
    });
    expect(nationalMuseumBusinessHours(new Date("2026-08-22T12:00:00"))).toEqual({
      open: 9 * 60 + 30,
      close: 21 * 60,
    });
  });

  it("closes at 17:30 on other days", () => {
    // 2026-08-20 목요일
    expect(nationalMuseumBusinessHours(new Date("2026-08-20T12:00:00"))).toEqual({
      open: 9 * 60 + 30,
      close: 17 * 60 + 30,
    });
  });
});
