import { afterEach, describe, expect, it, vi } from "vitest";

import { monthDay, monthDayWeekday, todayString, upcomingDates, weekdayKo } from "../src/lib/date";

describe("upcomingDates", () => {
  it("lists the given day and the following ones in order", () => {
    expect(upcomingDates("2026-08-23", 7)).toEqual([
      "2026-08-23",
      "2026-08-24",
      "2026-08-25",
      "2026-08-26",
      "2026-08-27",
      "2026-08-28",
      "2026-08-29",
    ]);
  });

  it("crosses a month boundary", () => {
    expect(upcomingDates("2026-08-30", 3)).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
    ]);
  });
});

describe("monthDay / weekdayKo / monthDayWeekday", () => {
  it("splits the pieces the tab strip reorders", () => {
    // 2026-08-24 는 월요일
    expect(monthDay("2026-08-24")).toBe("8/24");
    expect(weekdayKo("2026-08-24")).toBe("월");
  });

  it("keeps the combined format unchanged for existing callers", () => {
    expect(monthDayWeekday("2026-08-24")).toBe("8/24(월)");
  });
});

describe("todayString", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the Seoul calendar day, not the browser's", () => {
    // 백엔드는 KST 기준으로 days 를 필터하고 observed_at 도 KST 벽시계다.
    // 브라우저 타임존이 다르면 "오늘"이 두 벌이 되어 탭 선택과 실시간 헤드라인이
    // 어긋난다. 2026-08-23T15:10Z 는 KST 로 이미 8/24 다.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T15:10:00Z"));

    expect(todayString()).toBe("2026-08-24");
  });

  it("still reports the Seoul day when the browser is ahead of it", () => {
    // 2026-08-23T16:00Z 는 KST 8/24 01:00. 브라우저가 UTC+14 라면 로컬로는 8/24 06:00
    // 이지만 판정은 여전히 KST 여야 한다.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T16:00:00Z"));

    expect(todayString()).toBe("2026-08-24");
  });
});
