import { describe, expect, it } from "vitest";

import type { MmcaRoomPrediction, MmcaRoomStatus } from "../src/api/mmca";
import {
  VENUE_SPACE_CODE,
  VENUE_TITLE,
  labelOf,
  latestObservedAt,
  tierOf,
  venuePrediction,
  venueRoomStatus,
  venueTier,
} from "../src/lib/mmcaVenueCongestion";

function makeRoom(overrides: Partial<MmcaRoomStatus> = {}): MmcaRoomStatus {
  return {
    space_code: "MMCA-SPACE-1001",
    space_nm: "1전시실",
    congestion_nm: "여유",
    observed_at: "2026-07-28T10:55:00",
    ...overrides,
  };
}

function makePrediction(overrides: Partial<MmcaRoomPrediction> = {}): MmcaRoomPrediction {
  return {
    space_code: "MMCA-SPACE-1001",
    space_nm: "1전시실",
    anchored: true,
    points: [{ observed_at: "2026-07-28T11:00:00", tier: 1, label: "보통" }],
    ...overrides,
  };
}

describe("tierOf / labelOf", () => {
  it("maps the four levels onto 0~3 in order", () => {
    expect(["여유", "보통", "약간 붐빔", "붐빔"].map(tierOf)).toEqual([0, 1, 2, 3]);
  });

  it("treats a missing or unknown level as no reading", () => {
    expect(tierOf(null)).toBeNull();
    expect(tierOf(undefined)).toBeNull();
    expect(tierOf("매우 붐빔")).toBeNull();
  });

  it("names a fractional tier by its nearest level", () => {
    expect(labelOf(1.4)).toBe("보통");
    expect(labelOf(1.5)).toBe("약간 붐빔");
  });
});

describe("venueTier", () => {
  it("averages the rooms that have a reading", () => {
    const tier = venueTier([
      { congestion_nm: "여유" },
      { congestion_nm: "보통" },
      { congestion_nm: "붐빔" },
    ]);
    expect(tier).toBeCloseTo(4 / 3);
  });

  it("leaves rooms with no reading out of the mean instead of counting them as 여유", () => {
    // 0 으로 섞이면 평균이 통째로 내려간다 — 관 하나가 조용해 보이는 가장 흔한
    // 거짓말이 여기서 나온다.
    expect(venueTier([{ congestion_nm: "붐빔" }, { congestion_nm: null }])).toBe(3);
  });

  it("ignores levels outside the four-level scale", () => {
    expect(venueTier([{ congestion_nm: "보통" }, { congestion_nm: "매우 붐빔" }])).toBe(1);
  });

  it("reports null when nothing is readable", () => {
    expect(venueTier([])).toBeNull();
    expect(venueTier([{ congestion_nm: null }])).toBeNull();
  });
});

describe("latestObservedAt", () => {
  it("takes the newest timestamp", () => {
    expect(
      latestObservedAt([
        { observed_at: "2026-07-28T10:55:00" },
        { observed_at: "2026-07-28T11:05:00" },
        { observed_at: "2026-07-28T11:00:00" },
      ])
    ).toBe("2026-07-28T11:05:00");
  });

  it("skips rooms with no timestamp, and reports null when there are none", () => {
    expect(latestObservedAt([{ observed_at: null }, { observed_at: "2026-07-28T10:55:00" }])).toBe(
      "2026-07-28T10:55:00"
    );
    expect(latestObservedAt([{ observed_at: null }])).toBeNull();
  });
});

describe("venueRoomStatus", () => {
  it("folds the rooms into one synthetic room the chart card can draw", () => {
    const status = venueRoomStatus([
      makeRoom({ congestion_nm: "여유" }),
      makeRoom({ space_code: "MMCA-SPACE-1002", congestion_nm: "약간 붐빔" }),
    ]);

    expect(status).toEqual({
      space_code: VENUE_SPACE_CODE,
      space_nm: VENUE_TITLE,
      congestion_nm: "보통", // 평균 1.0
      observed_at: "2026-07-28T10:55:00",
    });
  });

  it("takes the newest timestamp only from rooms that actually reported a level", () => {
    // 값 없이 시각만 실려 온 방이 "기준" 시각을 끌어올리면, 카드가 현재 등급보다
    // 새 시각을 적는다.
    const status = venueRoomStatus([
      makeRoom({ congestion_nm: "붐빔", observed_at: "2026-07-28T10:55:00" }),
      makeRoom({
        space_code: "MMCA-SPACE-1002",
        congestion_nm: null,
        observed_at: "2026-07-28T11:05:00",
      }),
    ]);

    expect(status.congestion_nm).toBe("붐빔");
    expect(status.observed_at).toBe("2026-07-28T10:55:00");
  });

  it("reports no level when no room has a reading", () => {
    // 덕수궁관이 상시로 이 상태다 — 전시실 하나가 resultCode 0002 로 빈 응답을
    // 준다.
    const status = venueRoomStatus([makeRoom({ congestion_nm: null, observed_at: null })]);
    expect(status.congestion_nm).toBeNull();
    expect(status.observed_at).toBeNull();
  });

  it("survives rooms not having arrived yet", () => {
    expect(venueRoomStatus(null).congestion_nm).toBeNull();
  });
});

describe("venuePrediction", () => {
  it("averages the rooms' curves at each sampled time", () => {
    const venue = venuePrediction([
      makePrediction({
        points: [
          { observed_at: "2026-07-28T11:00:00", tier: 0, label: "여유" },
          { observed_at: "2026-07-28T12:00:00", tier: 2, label: "약간 붐빔" },
        ],
      }),
      makePrediction({
        space_code: "MMCA-SPACE-1002",
        points: [
          { observed_at: "2026-07-28T11:00:00", tier: 1, label: "보통" },
          { observed_at: "2026-07-28T12:00:00", tier: 3, label: "붐빔" },
        ],
      }),
    ]);

    expect(venue?.points).toEqual([
      { observed_at: "2026-07-28T11:00:00", tier: 0.5, label: "보통" },
      { observed_at: "2026-07-28T12:00:00", tier: 2.5, label: "붐빔" },
    ]);
  });

  it("orders the points by time however the rooms arrived", () => {
    const venue = venuePrediction([
      makePrediction({
        points: [
          { observed_at: "2026-07-28T12:00:00", tier: 2, label: "약간 붐빔" },
          { observed_at: "2026-07-28T11:00:00", tier: 0, label: "여유" },
        ],
      }),
    ]);

    expect(venue?.points.map((p) => p.observed_at)).toEqual([
      "2026-07-28T11:00:00",
      "2026-07-28T12:00:00",
    ]);
  });

  it("claims 'today' anchoring only when every room is anchored", () => {
    expect(venuePrediction([makePrediction(), makePrediction({ anchored: true })])?.anchored).toBe(
      true
    );
    expect(venuePrediction([makePrediction(), makePrediction({ anchored: false })])?.anchored).toBe(
      false
    );
  });

  it("reports null when there is nothing to average", () => {
    expect(venuePrediction([])).toBeNull();
    expect(venuePrediction([makePrediction({ points: [] })])).toBeNull();
  });
});
