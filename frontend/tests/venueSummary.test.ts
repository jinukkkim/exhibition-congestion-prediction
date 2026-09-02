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

  it("answers from the clock before the data arrives when it can", () => {
    // 영업시간 밖은 시계만으로 확정되는 답이다. 데이터를 기다렸다가 답하면
    // 이미 아는 답 대신 로딩 문구를 먼저 보여주게 된다.
    expect(nationalMuseumSummary(null, new Date("2026-08-20T07:00:00"))).toEqual({
      kind: "inactive",
      label: "영업 전",
    });
    expect(nationalMuseumSummary(null, new Date("2026-08-20T22:00:00"))).toEqual({
      kind: "inactive",
      label: "영업 종료",
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

  it("excludes rooms with no reading from the counts", () => {
    const rooms = [
      makeRoom({ space_code: "MMCA-SPACE-1001", congestion_nm: "여유" }),
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

  it("counts the Deoksugung room like any other venue's", () => {
    // 이 관은 전시실이 MMCA-SPACE-4001 하나뿐이라, 그 한 칸이 빠지면 카드가
    // 통째로 빈다 — 수집 대상이 아닌 동안 실제로 "서비스 예정"만 떴다.
    const rooms = [makeRoom({ space_code: "MMCA-SPACE-4001", congestion_nm: "여유" })];

    expect(mmcaSummary("deoksugung", rooms, MMCA_MIDDAY)).toEqual({
      kind: "counts",
      counts: [{ level: "여유", count: 1 }],
      observedAt: "2026-08-20T14:20:00",
    });
  });

  it("answers from the clock before the rooms arrive when it can", () => {
    expect(mmcaSummary("seoul", null, new Date("2026-08-20T07:00:00"))).toEqual({
      kind: "inactive",
      label: "영업 전",
    });
    expect(mmcaSummary("seoul", null, new Date("2026-08-20T19:00:00"))).toEqual({
      kind: "inactive",
      label: "영업 종료",
    });
    // 휴관일도 방 목록 없이 확정된다 — 요일 휴관은 덕수궁·과천관에만 있다.
    expect(mmcaSummary("deoksugung", null, new Date("2026-08-17T14:00:00"))).toEqual({
      kind: "inactive",
      label: "휴관일",
    });
  });

  it("reports the Monday closure for Deoksugung", () => {
    // 2026-08-17은 월요일.
    const rooms = [makeRoom({ space_code: "MMCA-SPACE-4001" })];

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
