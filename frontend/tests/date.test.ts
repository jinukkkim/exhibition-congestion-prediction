import { describe, expect, it } from "vitest";

import { monthDay, monthDayWeekday, upcomingDates, weekdayKo } from "../src/lib/date";

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
