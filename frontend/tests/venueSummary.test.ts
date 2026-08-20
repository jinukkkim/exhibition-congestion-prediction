import { describe, expect, it } from "vitest";

import type { CurrentCongestion } from "../src/api/congestion";
import { STATUS_LEVELS } from "../src/lib/status";
import { nationalMuseumSummary } from "../src/lib/venueSummary";

const CURRENT: CurrentCongestion = {
  observed_at: "2026-08-20T14:20:00",
  congest_level: "보통",
  population_avg: 1240.4,
};

// 2026-08-20은 목요일 → 09:30-17:30
const THURSDAY_MIDDAY = new Date("2026-08-20T14:20:00");

describe("STATUS_LEVELS", () => {
  it("lists levels from least to most crowded", () => {
    expect(STATUS_LEVELS).toEqual(["여유", "보통", "약간 붐빔", "붐빔"]);
  });
});

describe("nationalMuseumSummary", () => {
  it("shows the level and population during business hours", () => {
    expect(nationalMuseumSummary(CURRENT, THURSDAY_MIDDAY)).toEqual({
      kind: "level",
      level: "보통",
      population: 1240.4,
      observedAt: "2026-08-20T14:20:00",
    });
  });

  it("reports loading while there is no data yet", () => {
    expect(nationalMuseumSummary(null, THURSDAY_MIDDAY)).toEqual({
      kind: "inactive",
      label: "불러오는 중",
    });
  });

  it("reports before-open and after-close instead of a stale level", () => {
    expect(nationalMuseumSummary(CURRENT, new Date("2026-08-20T09:00:00"))).toEqual({
      kind: "inactive",
      label: "운영 전",
    });
    expect(nationalMuseumSummary(CURRENT, new Date("2026-08-20T18:00:00"))).toEqual({
      kind: "inactive",
      label: "운영 종료",
    });
  });

  it("still shows the level at the exact open and close minute", () => {
    expect(nationalMuseumSummary(CURRENT, new Date("2026-08-20T09:30:00")).kind).toBe("level");
    expect(nationalMuseumSummary(CURRENT, new Date("2026-08-20T17:30:00")).kind).toBe("level");
  });

  it("keeps the long Wednesday hours open past 17:30", () => {
    // 2026-08-19 수요일 → 21:00 폐관
    expect(nationalMuseumSummary(CURRENT, new Date("2026-08-19T19:00:00")).kind).toBe("level");
  });
});
