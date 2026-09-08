import { describe, expect, it } from "vitest";

import { mmcaBusinessHours, nextOpenDay } from "../src/lib/mmcaBusinessHours";

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
    expect(mmcaBusinessHours("seoul", new Date("2026-07-29T12:00:00")).close).toBe(21 * 60);
    // 2026-08-01 is a Saturday
    expect(mmcaBusinessHours("deoksugung", new Date("2026-08-01T12:00:00")).close).toBe(21 * 60);
  });

  it("keeps Gwacheon at 18:00 on Wednesday/Saturday too", () => {
    // 과천관은 야간개장이 없다 — 공식 관람정보가 "화~일요일 10:00~18:00"이고,
    // 수집한 판독에도 수·토 18시 이후 비-여유가 한 건도 없다.
    expect(mmcaBusinessHours("gwacheon", new Date("2026-07-29T12:00:00")).close).toBe(18 * 60);
    expect(mmcaBusinessHours("gwacheon", new Date("2026-08-01T12:00:00")).close).toBe(18 * 60);
  });

  it("marks Gwacheon and Deoksugung closed on Monday but open on other days", () => {
    // 2026-07-27 is a Monday
    for (const venue of ["gwacheon", "deoksugung"] as const) {
      expect(mmcaBusinessHours(venue, new Date("2026-07-27T12:00:00")).isOpenToday).toBe(false);
      // 2026-07-28 is a Tuesday
      expect(mmcaBusinessHours(venue, new Date("2026-07-28T12:00:00")).isOpenToday).toBe(true);
    }
  });

  it("does not mark Seoul closed on Monday", () => {
    expect(mmcaBusinessHours("seoul", new Date("2026-07-27T12:00:00")).isOpenToday).toBe(true);
  });
});

describe("nextOpenDay", () => {
  it("points a closed Monday at the next day", () => {
    // 2026-07-27 is a Monday
    expect(nextOpenDay("gwacheon", new Date("2026-07-27T12:00:00"))).toEqual({
      weekday: 2, // 화
      open: 10 * 60,
    });
  });

  it("skips over the closed Monday when asked from the Sunday before it", () => {
    // 휴관일 안내는 "고른 날짜 다음" 을 말하므로, 일요일에서 부르면 월요일이
    // 아니라 화요일이 나와야 한다.
    // 2026-08-02 is a Sunday
    expect(nextOpenDay("deoksugung", new Date("2026-08-02T12:00:00"))?.weekday).toBe(2);
  });

  it("never returns the day it was given", () => {
    // 화요일에서 불러도 그 화요일이 아니라 수요일이다 — 부르는 자리가 이미
    // "그날은 휴관일" 인 곳이다.
    expect(nextOpenDay("seoul", new Date("2026-07-28T12:00:00"))?.weekday).toBe(3);
  });

  it("counts a public-holiday Monday as the next open day", () => {
    // 2026-08-16 은 일요일, 다음 날 8/17 은 광복절 대체공휴일 월요일이다.
    // 요일 규칙만 보면 월요일을 건너뛰어 8/18 이 나오지만, 그날 과천관은
    // 문을 연다 — 달력이 mmcaBusinessHours 를 거쳐 여기까지 닿는지를
    // 고정하는 유일한 테스트다.
    expect(nextOpenDay("gwacheon", new Date("2026-08-16T12:00:00"))).toEqual({
      weekday: 1,
      open: 10 * 60,
    });
  });
});
