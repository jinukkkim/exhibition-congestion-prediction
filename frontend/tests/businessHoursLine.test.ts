import { describe, expect, it } from "vitest";

import { businessHoursLine } from "../src/lib/businessHoursLine";

describe("businessHoursLine", () => {
  it("adds the Wed/Sat extension rule on a normal day", () => {
    // 고른 날 값만 적으면 매일 같은 시간에 닫는 것처럼 읽힌다.
    expect(businessHoursLine(9 * 60 + 30, 17 * 60 + 30, false)).toBe(
      "영업시간 09:30–17:30 (수·토는 21:00까지)"
    );
    expect(businessHoursLine(10 * 60, 18 * 60, false)).toBe(
      "영업시간 10:00–18:00 (수·토는 21:00까지)"
    );
  });

  it("does not restate 21:00 when the selected day is already Wed/Sat", () => {
    expect(businessHoursLine(9 * 60 + 30, 21 * 60, false)).toBe(
      "영업시간 09:30–21:00 (수·토 연장 운영)"
    );
  });

  it("marks the today tab as today", () => {
    expect(businessHoursLine(10 * 60, 18 * 60, true)).toBe(
      "영업시간 10:00–18:00 (수·토는 21:00까지)"
    );
  });

  it("claims no hours on a closed day", () => {
    expect(businessHoursLine(10 * 60, 18 * 60, true, false)).toBe("오늘은 휴관일입니다");
    expect(businessHoursLine(10 * 60, 18 * 60, false, false)).toBe("휴관일입니다");
  });
});
