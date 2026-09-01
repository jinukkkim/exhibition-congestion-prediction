import { describe, expect, it } from "vitest";

import { businessHoursLine } from "../src/lib/businessHoursLine";
import { VENUES } from "../src/venues";

describe("VENUES info", () => {
  it("gives every venue a full info block", () => {
    for (const venue of VENUES) {
      const { address, transit, admission, closedDays, homepage } = venue.info;
      for (const [field, value] of Object.entries({
        address,
        transit,
        admission,
        closedDays,
      })) {
        expect(value, `${venue.id}.${field}`).not.toBe("");
      }
      expect(homepage, `${venue.id}.homepage`).toMatch(/^https:\/\//);
    }
  });

  it("only promises a night-opening discount where there is a night opening", () => {
    // 관람료 문구는 정적이고 야간개장 여부는 영업시간 로직에서 나온다 — 과천관
    // 처럼 야간개장이 없는 관이 "야간개장 18시 이후 무료"를 달고 있으면 안 된다.
    for (const venue of VENUES) {
      if (!venue.info.admission.includes("야간개장")) continue;
      expect(businessHoursLine(venue), `${venue.id} 야간개장`).toContain("까지");
    }
  });

  it("keeps the weekly closure out of closedDays", () => {
    // 요일 휴관은 영업시간 줄이 말한다. 여기에도 적으면 같은 말이 두 줄이 된다.
    for (const venue of VENUES) {
      expect(venue.info.closedDays, `${venue.id}.closedDays`).not.toContain("요일");
    }
  });
});
