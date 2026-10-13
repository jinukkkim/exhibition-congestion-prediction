import { describe, expect, it } from "vitest";

import type { Pageview } from "../src/api/analytics";
import {
  applyFilters,
  breakdown,
  change,
  countVisitors,
  routeOf,
  series,
} from "../src/lib/visitorStats";

function pv(overrides: Partial<Pageview> = {}): Pageview {
  return {
    at: "2026-09-07T14:20:00+09:00",
    path: "/",
    visitor: "aaaaaa",
    device: "desktop",
    browser: "Chrome",
    os: "macOS",
    referrer: "직접 방문",
    utm: {},
    ...overrides,
  };
}

describe("routeOf", () => {
  it("folds each venue into one route", () => {
    expect(routeOf("/venues/mmca-seoul")).toBe("/venues/[venue]");
    expect(routeOf("/venues/national-museum/when")).toBe("/venues/[venue]/when");
    expect(routeOf("/logs")).toBe("/logs");
  });
});

describe("applyFilters", () => {
  it("keeps only rows matching every filter", () => {
    const rows = [
      pv({ browser: "Chrome", device: "mobile" }),
      pv({ browser: "Chrome", device: "desktop" }),
      pv({ browser: "Safari", device: "mobile" }),
    ];

    expect(applyFilters(rows, { browser: "Chrome", device: "mobile" })).toEqual([rows[0]]);
  });

  it("filters on routes and UTM parameters", () => {
    const rows = [
      pv({ path: "/venues/mmca-seoul", utm: { source: "instagram" } }),
      pv({ path: "/venues/mmca-gwacheon" }),
      pv({ path: "/logs", utm: { source: "instagram" } }),
    ];

    expect(applyFilters(rows, { route: "/venues/[venue]" })).toHaveLength(2);
    expect(applyFilters(rows, { utm_source: "instagram" })).toHaveLength(2);
  });
});

describe("countVisitors", () => {
  it("counts each visitor once over the whole period", () => {
    // Vercel 처럼 기간 전체의 순방문자다 — 날마다 세어 더하지 않는다.
    expect(
      countVisitors([
        pv({ visitor: "a", at: "2026-09-06T10:00:00+09:00" }),
        pv({ visitor: "a", at: "2026-09-07T10:00:00+09:00" }),
        pv({ visitor: "b" }),
      ])
    ).toBe(2);
  });
});

describe("breakdown", () => {
  it("ranks values by visitors, then views", () => {
    const rows = [
      pv({ path: "/logs", visitor: "a" }),
      pv({ path: "/logs", visitor: "a" }),
      pv({ path: "/", visitor: "b" }),
      pv({ path: "/", visitor: "c" }),
    ];

    expect(breakdown(rows, "page")).toEqual([
      { value: "/", visitors: 2, views: 2 },
      { value: "/logs", visitors: 1, views: 2 },
    ]);
  });

  it("leaves out rows that say nothing about the dimension", () => {
    // 우리 페이지에서 온 줄(null)과 UTM 이 없는 줄은 그 패널에 칸을 만들지 않는다.
    const rows = [pv({ referrer: null }), pv({ referrer: "www.google.com" })];

    expect(breakdown(rows, "referrer")).toEqual([
      { value: "www.google.com", visitors: 1, views: 1 },
    ]);
    expect(breakdown(rows, "utm_source")).toEqual([]);
  });
});

describe("series", () => {
  it("has a point for every day, including empty ones", () => {
    const rows = [
      pv({ at: "2026-09-05T09:00:00+09:00", visitor: "a" }),
      pv({ at: "2026-09-07T09:00:00+09:00", visitor: "a" }),
      pv({ at: "2026-09-07T10:00:00+09:00", visitor: "b" }),
    ];

    const points = series(rows, "2026-09-05T00:00:00+09:00", 3, new Date("2026-09-07T15:00:00+09:00"));

    expect(points.map((p) => [p.key, p.visitors, p.views])).toEqual([
      ["2026-09-05", 1, 1],
      ["2026-09-06", 0, 0],
      ["2026-09-07", 2, 2],
    ]);
  });

  it("goes by the hour for the last 24 hours", () => {
    const rows = [
      pv({ at: "2026-09-06T15:30:00+09:00" }),
      pv({ at: "2026-09-07T14:59:00+09:00" }),
    ];

    const points = series(
      rows,
      "2026-09-06T15:10:00+09:00",
      1,
      new Date("2026-09-07T15:10:00+09:00")
    );

    // 첫 칸은 15시대, 마지막 칸은 지금이 속한 15시대 — 25칸이어야 앞뒤가 다 담긴다.
    expect(points).toHaveLength(25);
    expect(points[0]).toMatchObject({ key: "2026-09-06T15", views: 1 });
    expect(points[23]).toMatchObject({ key: "2026-09-07T14", views: 1 });
  });
});

describe("change", () => {
  it("is the percentage against the previous period", () => {
    expect(change(12, 10)).toBe(20);
    expect(change(5, 10)).toBe(-50);
  });

  it("has nothing to say when there was nothing before", () => {
    expect(change(5, 0)).toBeNull();
  });
});
