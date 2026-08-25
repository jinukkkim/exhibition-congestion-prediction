import { describe, expect, it } from "vitest";

import { businessHoursLine } from "../src/lib/businessHoursLine";

describe("businessHoursLine", () => {
  it("names the date the hours belong to", () => {
    // 날짜 탭이 위에 있어도 이 줄만 읽고 뜻이 닫혀야 한다 — 어느 날의 시간인지
    // 줄 안에서 말한다.
    expect(businessHoursLine("2026-08-25", 9 * 60 + 30, 17 * 60 + 30)).toBe(
      "8/25(화) 영업시간 09:30–17:30"
    );
    expect(businessHoursLine("2026-07-28", 10 * 60, 18 * 60)).toBe("7/28(화) 영업시간 10:00–18:00");
  });

  it("takes the close time it is given rather than deriving it", () => {
    // 수·토는 21:00 폐관이지만 그 규칙은 호출부(관별 businessHours 함수)가 안다.
    // 이 함수는 받은 값을 적을 뿐이라 관이 늘어도 고칠 데가 없다.
    expect(businessHoursLine("2026-08-29", 9 * 60 + 30, 21 * 60)).toBe(
      "8/29(토) 영업시간 09:30–21:00"
    );
  });

  it("claims no hours on a closed day", () => {
    expect(businessHoursLine("2026-07-27", 10 * 60, 18 * 60, false)).toBe("7/27(월) 휴관일입니다");
  });
});
