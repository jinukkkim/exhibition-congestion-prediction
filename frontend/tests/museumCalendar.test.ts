import { describe, expect, it } from "vitest";

import { isClosedDay, isWeeklyClosed } from "../src/lib/museumCalendar";

describe("isClosedDay", () => {
  it("opens Gwacheon on a public-holiday Monday", () => {
    // 2026-08-17 광복절 대체. 실측: 과천 non-여유 185건.
    expect(isClosedDay("gwacheon", new Date("2026-08-17T12:00:00"))).toBe(false);
  });

  it("closes Gwacheon the day after a public-holiday Monday", () => {
    // 실측: 2026-08-18 과천 219판독 전부 여유. 다른 화요일은 59~157.
    expect(isClosedDay("gwacheon", new Date("2026-08-18T12:00:00"))).toBe(true);
    // 서울관은 요일 휴관이 없어 대체 휴관도 없다.
    expect(isClosedDay("seoul", new Date("2026-08-18T12:00:00"))).toBe(false);
  });

  it("still closes a plain Monday", () => {
    expect(isClosedDay("gwacheon", new Date("2026-09-07T12:00:00"))).toBe(true);
    expect(isClosedDay("seoul", new Date("2026-09-07T12:00:00"))).toBe(false);
  });

  it("honours an ad-hoc closure", () => {
    // 서울관 임시 휴관. 실측: 그날 1,928판독의 non-여유 0.
    expect(isClosedDay("seoul", new Date("2026-09-08T12:00:00"))).toBe(true);
    expect(isClosedDay("gwacheon", new Date("2026-09-08T12:00:00"))).toBe(false);
  });
});

describe("isWeeklyClosed", () => {
  it("ignores the calendar and answers on the weekday alone", () => {
    // businessHoursLine 이 쓰는 값이다 — 한 주를 한 줄로 접는 요약이라
    // 특정 날짜의 달력 휴관을 섞으면 "월요일 휴무"가 엉뚱하게 바뀐다.
    expect(isWeeklyClosed("gwacheon", new Date("2026-08-17T12:00:00"))).toBe(true);
    expect(isWeeklyClosed("gwacheon", new Date("2026-08-18T12:00:00"))).toBe(false);
  });
});
