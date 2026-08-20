import { describe, expect, it } from "vitest";

import type { CurrentCongestion } from "../src/api/congestion";
import type { MmcaRoomStatus } from "../src/api/mmca";
import { STATUS_LEVELS } from "../src/lib/status";
import { mmcaSummary, nationalMuseumSummary } from "../src/lib/venueSummary";

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
      label: "영업 전",
    });
    expect(nationalMuseumSummary(CURRENT, new Date("2026-08-20T18:00:00"))).toEqual({
      kind: "inactive",
      label: "영업 종료",
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

function makeRoom(overrides: Partial<MmcaRoomStatus> = {}): MmcaRoomStatus {
  return {
    space_code: "MMCA-SPACE-1001",
    space_nm: "1전시실",
    congestion_nm: "여유",
    observed_at: "2026-08-20T14:20:00",
    ...overrides,
  };
}

// MMCA 영업시간은 10:00-18:00 (수·토는 21:00), 2026-08-20은 목요일
const MMCA_MIDDAY = new Date("2026-08-20T14:20:00");

describe("mmcaSummary", () => {
  it("counts rooms per level, least crowded first", () => {
    const rooms = [
      makeRoom({ space_code: "MMCA-SPACE-1001", congestion_nm: "붐빔" }),
      makeRoom({ space_code: "MMCA-SPACE-1002", congestion_nm: "여유" }),
      makeRoom({ space_code: "MMCA-SPACE-1003", congestion_nm: "보통" }),
      makeRoom({ space_code: "MMCA-SPACE-1004", congestion_nm: "여유" }),
    ];

    expect(mmcaSummary("seoul", rooms, MMCA_MIDDAY)).toEqual({
      kind: "counts",
      counts: [
        { level: "여유", count: 2 },
        { level: "보통", count: 1 },
        { level: "붐빔", count: 1 },
      ],
      observedAt: "2026-08-20T14:20:00",
    });
  });

  it("appends unknown levels after the known ones", () => {
    const rooms = [
      makeRoom({ space_code: "MMCA-SPACE-1001", congestion_nm: "매우 붐빔" }),
      makeRoom({ space_code: "MMCA-SPACE-1002", congestion_nm: "여유" }),
    ];

    const summary = mmcaSummary("seoul", rooms, MMCA_MIDDAY);
    expect(summary.kind === "counts" && summary.counts).toEqual([
      { level: "여유", count: 1 },
      { level: "매우 붐빔", count: 1 },
    ]);
  });

  it("uses the newest observed_at among counted rooms", () => {
    const rooms = [
      makeRoom({ space_code: "MMCA-SPACE-1001", observed_at: "2026-08-20T14:10:00" }),
      makeRoom({ space_code: "MMCA-SPACE-1002", observed_at: "2026-08-20T14:20:00" }),
    ];

    const summary = mmcaSummary("seoul", rooms, MMCA_MIDDAY);
    expect(summary.kind === "counts" && summary.observedAt).toBe("2026-08-20T14:20:00");
  });

  it("excludes disabled rooms and rooms with no reading from the counts", () => {
    const rooms = [
      makeRoom({ space_code: "MMCA-SPACE-1001", congestion_nm: "여유" }),
      makeRoom({ space_code: "MMCA-SPACE-2008", congestion_nm: "붐빔" }), // disabled
      makeRoom({ space_code: "MMCA-SPACE-1002", congestion_nm: null, observed_at: null }),
    ];

    const summary = mmcaSummary("seoul", rooms, MMCA_MIDDAY);
    expect(summary.kind === "counts" && summary.counts).toEqual([{ level: "여유", count: 1 }]);
  });

  it("reports loading while there is no data yet", () => {
    expect(mmcaSummary("seoul", null, MMCA_MIDDAY)).toEqual({
      kind: "inactive",
      label: "불러오는 중",
    });
  });

  it("reports service-pending when every room is disabled", () => {
    // 덕수궁관은 MMCA-SPACE-4001 한 칸뿐이고 그 방이 disabled다
    const rooms = [makeRoom({ space_code: "MMCA-SPACE-4001", congestion_nm: null, observed_at: null })];

    expect(mmcaSummary("deoksugung", rooms, MMCA_MIDDAY)).toEqual({
      kind: "inactive",
      label: "서비스 예정",
    });
  });

  it("puts service-pending above the clock so night-time does not read as reopening", () => {
    const rooms = [makeRoom({ space_code: "MMCA-SPACE-4001", congestion_nm: null, observed_at: null })];

    expect(mmcaSummary("deoksugung", rooms, new Date("2026-08-20T23:00:00"))).toEqual({
      kind: "inactive",
      label: "서비스 예정",
    });
  });

  it("reports the Monday closure for Deoksugung", () => {
    // 2026-08-17은 월요일. disabled 방만 있으면 서비스 예정이 이기므로 활성 방을 쓴다.
    const rooms = [makeRoom({ space_code: "MMCA-SPACE-4002" })];

    expect(mmcaSummary("deoksugung", rooms, new Date("2026-08-17T14:00:00"))).toEqual({
      kind: "inactive",
      label: "휴관일",
    });
  });

  it("reports before-open and after-close", () => {
    const rooms = [makeRoom()];

    expect(mmcaSummary("seoul", rooms, new Date("2026-08-20T09:00:00"))).toEqual({
      kind: "inactive",
      label: "영업 전",
    });
    expect(mmcaSummary("seoul", rooms, new Date("2026-08-20T19:00:00"))).toEqual({
      kind: "inactive",
      label: "영업 종료",
    });
  });

  it("reports tallying while open but before the first poll of the day", () => {
    const rooms = [makeRoom({ congestion_nm: null, observed_at: null })];

    expect(mmcaSummary("seoul", rooms, new Date("2026-08-20T10:05:00"))).toEqual({
      kind: "inactive",
      label: "집계 중",
    });
  });
});
