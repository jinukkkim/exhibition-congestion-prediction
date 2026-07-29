import { describe, expect, it } from "vitest";

import { mmcaBusinessHours } from "../src/lib/mmcaBusinessHours";

describe("mmcaBusinessHours", () => {
  it("returns 10:00-18:00 on a normal day", () => {
    // 2026-07-28 is a Tuesday
    const { open, close, isOpenToday } = mmcaBusinessHours("seoul", new Date("2026-07-28T12:00:00"));
    expect(open).toBe(10 * 60);
    expect(close).toBe(18 * 60);
    expect(isOpenToday).toBe(true);
  });

  it("returns 10:00-21:00 on Wednesday/Saturday", () => {
    // 2026-07-29 is a Wednesday
    expect(mmcaBusinessHours("gwacheon", new Date("2026-07-29T12:00:00")).close).toBe(21 * 60);
    // 2026-08-01 is a Saturday
    expect(mmcaBusinessHours("gwacheon", new Date("2026-08-01T12:00:00")).close).toBe(21 * 60);
  });

  it("marks Deoksugung closed on Monday but open on other days", () => {
    // 2026-07-27 is a Monday
    expect(mmcaBusinessHours("deoksugung", new Date("2026-07-27T12:00:00")).isOpenToday).toBe(false);
    // 2026-07-28 is a Tuesday
    expect(mmcaBusinessHours("deoksugung", new Date("2026-07-28T12:00:00")).isOpenToday).toBe(true);
  });

  it("does not mark Seoul or Gwacheon closed on Monday", () => {
    expect(mmcaBusinessHours("seoul", new Date("2026-07-27T12:00:00")).isOpenToday).toBe(true);
    expect(mmcaBusinessHours("gwacheon", new Date("2026-07-27T12:00:00")).isOpenToday).toBe(true);
  });
});
