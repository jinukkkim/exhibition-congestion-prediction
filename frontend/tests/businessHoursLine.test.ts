import { describe, expect, it } from "vitest";

import { businessHoursLine } from "../src/lib/businessHoursLine";
import { VENUES } from "../src/venues";

const lineOf = (id: string) => businessHoursLine(VENUES.find((v) => v.id === id)!);

describe("businessHoursLine", () => {
  it("folds a week into one line per venue", () => {
    // 야간개장만 있는 관, 요일 휴관만 있는 관, 둘 다 있는 관, 둘 다 없는 관 —
    // 괄호가 생기고 사라지는 네 경우가 실제 관에 다 있다.
    expect(lineOf("national-museum")).toBe("09:30~17:30 (수·토 21:00까지)");
    expect(lineOf("mmca-seoul")).toBe("10:00~18:00 (수·토 21:00까지)");
    expect(lineOf("mmca-gwacheon")).toBe("10:00~18:00 (월요일 휴무)");
    expect(lineOf("mmca-deoksugung")).toBe("10:00~18:00 (수·토 21:00까지, 월요일 휴무)");
  });
});
