import { describe, expect, it, vi } from "vitest";

import { fetchComparisonDay } from "../src/lib/comparisonDay";

const TODAY = "2026-07-28"; // 화요일

describe("fetchComparisonDay", () => {
  it("uses last week when that day has readings", async () => {
    const fetchDay = vi.fn(async () => ["a", "b"]);

    expect(await fetchComparisonDay(TODAY, fetchDay)).toEqual({
      date: "2026-07-21",
      points: ["a", "b"],
    });
    // 물러설 이유가 없으면 한 번만 부른다.
    expect(fetchDay).toHaveBeenCalledTimes(1);
  });

  it("falls back a week further when last week is empty", async () => {
    // 정기 휴관 요일이 아닌 날 문을 닫으면 게이트가 그날을 아예 수집하지 않아
    // 하루가 통째로 빈다. 그 이레 뒤 화면이 이 갈래를 탄다.
    const fetchDay = vi.fn(async (date: string) => (date === "2026-07-21" ? [] : ["c"]));

    expect(await fetchComparisonDay(TODAY, fetchDay)).toEqual({
      date: "2026-07-14",
      points: ["c"],
    });
    expect(fetchDay.mock.calls.map(([date]) => date)).toEqual(["2026-07-21", "2026-07-14"]);
  });

  it("stops at two weeks rather than walking back forever", async () => {
    // 둘 다 비는 것은 수집 첫 주다. 비교선 없는 화면은 이미 있는 상태이고,
    // 더 물러서면 비교 대상으로서 뜻이 옅어진다.
    const fetchDay = vi.fn(async () => [] as string[]);

    expect(await fetchComparisonDay(TODAY, fetchDay)).toEqual({
      date: "2026-07-14",
      points: [],
    });
    expect(fetchDay).toHaveBeenCalledTimes(2);
  });
});
