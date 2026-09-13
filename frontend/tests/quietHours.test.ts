import { describe, expect, it } from "vitest";

import type { WeeklyProfileCell } from "../src/api/congestion";
import {
  extremes,
  hourLabel,
  mmcaQuietHoursHeadline,
  quietHoursHeadline,
  rankLabel,
  rankScale,
} from "../src/lib/quietHours";

function cell(weekday: number, hour: number, population_avg: number): WeeklyProfileCell {
  return { weekday, hour, population_avg };
}

describe("hourLabel", () => {
  it("splits 오전·낮·오후 around noon", () => {
    expect(hourLabel(10)).toBe("오전 10시");
    expect(hourLabel(12)).toBe("낮 12시");
    expect(hourLabel(13)).toBe("오후 1시");
    expect(hourLabel(20)).toBe("오후 8시");
  });
});

describe("extremes", () => {
  it("has nothing to point at in an empty profile", () => {
    expect(extremes([])).toBeNull();
  });

  it("finds the lowest and the highest cell", () => {
    const quiet = cell(2, 20, 1250);
    const busy = cell(4, 14, 2953);
    const found = extremes([cell(0, 10, 2000), busy, quiet]);

    expect(found).toEqual({ quietest: quiet, busiest: busy });
  });
});

describe("quietHoursHeadline", () => {
  it("names both ends of the week", () => {
    const line = quietHoursHeadline("국립중앙박물관", [
      cell(2, 20, 1250),
      cell(0, 10, 2000),
      cell(4, 14, 2953),
    ]);

    expect(line).toBe(
      "국립중앙박물관 일대는 수요일 오후 8시가 가장 한산하고, 금요일 오후 2시가 가장 붐빕니다."
    );
  });

  it("says nothing when one cell would be both ends", () => {
    // 수집 첫날. "그 시각이 가장 한산하고 또 가장 붐빈다"는 문장은 만들지 않는다.
    expect(quietHoursHeadline("국립중앙박물관", [cell(0, 10, 2000)])).toBeNull();
    expect(quietHoursHeadline("국립중앙박물관", [])).toBeNull();
  });
});

describe("rankScale", () => {
  it("spreads a clustered run across the whole ramp", () => {
    // 실제 데이터 모양: 넷이 몰려 있고 하나만 뚝 떨어진다. 최솟값~최댓값 위치로
    // 칠하면 앞의 넷이 0.96~1.0 안에 겹쳐 앉아 농도가 갈리지 않는다.
    const rank = rankScale([1300, 2750, 2800, 2850, 2900]);

    expect([2750, 2800, 2850, 2900].map(rank)).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it("keeps the order — a busier cell is never lighter", () => {
    const values = [2100, 1500, 2900, 1200];
    const rank = rankScale(values);
    const sorted = [...values].sort((a, b) => a - b);

    expect(sorted.map(rank)).toEqual([...sorted.map(rank)].sort((a, b) => a - b));
    expect(rank(1200)).toBe(0);
    expect(rank(2900)).toBe(1);
  });

  it("gives ties the same shade and survives a single value", () => {
    expect(rankScale([900, 900, 900])(900)).toBe(0);
  });
});

describe("rankLabel", () => {
  const LEVELS = ["여유", "보통", "약간 붐빔", "붐빔"];

  it("rounds the mean to the level a visitor already knows", () => {
    expect(rankLabel(0.21, LEVELS)).toBe("여유");
    expect(rankLabel(1.4, LEVELS)).toBe("보통");
    expect(rankLabel(2.34, LEVELS)).toBe("약간 붐빔");
    expect(rankLabel(3.0, LEVELS)).toBe("붐빔");
  });

  it("stays inside the scale at both ends", () => {
    // 평균이라 0~3 을 벗어날 수 없지만, 벗어나면 undefined 가 칸에 찍힌다.
    expect(rankLabel(-1, LEVELS)).toBe("여유");
    expect(rankLabel(9, LEVELS)).toBe("붐빔");
  });
});

describe("mmcaQuietHoursHeadline", () => {
  it("makes the venue the subject — no 일대 hedge", () => {
    // 서울시 쪽은 생활인구라 "일대는" 이라고 물러서야 한다. 이쪽은 전시실
    // 혼잡도 그 자체라 관을 바로 주어로 쓴다.
    const line = mmcaQuietHoursHeadline("국립현대미술관 서울관", [
      { weekday: 1, hour: 10, rank: 0.0 },
      { weekday: 5, hour: 16, rank: 2.58 },
    ]);

    expect(line).toBe(
      "국립현대미술관 서울관은 화요일 오전 10시가 가장 한산하고, 토요일 오후 4시가 가장 붐빕니다."
    );
  });

  it("says nothing when one cell would be both ends", () => {
    expect(mmcaQuietHoursHeadline("국립현대미술관 서울관", [])).toBeNull();
    expect(
      mmcaQuietHoursHeadline("국립현대미술관 서울관", [{ weekday: 1, hour: 10, rank: 1 }])
    ).toBeNull();
  });
});
