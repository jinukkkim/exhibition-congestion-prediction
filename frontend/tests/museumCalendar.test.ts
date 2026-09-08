import { describe, expect, it } from "vitest";

import testCases from "../../shared/museum-holidays.test-cases.json";
import { isClosedDay, isWeeklyClosed, type Venue } from "../src/lib/museumCalendar";

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

  it("does not close the day after a lunar new year Monday", () => {
    // 설·추석 연휴 월요일은 publicHolidays 에 넣지 않는다.
    //
    // 2026-02-16(월)은 설 연휴 전날이고 2026-02-17 은 설날이다. 그 월요일을
    // 공휴일로 실으면 셋째 갈래가 설날을 대체 휴관으로 닫는데, 과천·덕수궁의
    // 공표 휴관일은 "1월1일, 매주 월요일" 뿐이라 그날 문을 연다. 셋째 갈래의
    // 근거는 대체공휴일 한 사례(2026-08-17)뿐이라 연휴 월요일까지 늘리지
    // 않는다.
    for (const venue of ["gwacheon", "deoksugung"] as const) {
      // 월요일 자체는 여전히 요일 휴관이다 — 공휴일 예외를 주지 않았다.
      expect(isClosedDay(venue, new Date("2026-02-16T12:00:00"))).toBe(true);
      // 설날은 열려 있다.
      expect(isClosedDay(venue, new Date("2026-02-17T12:00:00"))).toBe(false);
      // 2027 년의 같은 충돌.
      expect(isClosedDay(venue, new Date("2027-02-08T12:00:00"))).toBe(true);
      expect(isClosedDay(venue, new Date("2027-02-09T12:00:00"))).toBe(false);
    }
  });

  it("matches the shared fixture", () => {
    // shared/museum-holidays.test-cases.json 은 두 언어 구현이 같은 답을
    // 내는지 확인하는 유일한 장치다 — 백엔드의 같은 이름 테스트가 같은
    // 파일을 읽는다. 한쪽 규칙만 바뀌면 이 테스트나 그쪽이 실패한다.
    expect(testCases.length).toBeGreaterThan(0);
    for (const { venue, date, closed, why } of testCases) {
      expect(isClosedDay(venue as Venue, new Date(`${date}T12:00:00`)), `${venue} ${date}: ${why}`).toBe(
        closed
      );
    }
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
