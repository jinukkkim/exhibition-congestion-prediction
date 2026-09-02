import { describe, expect, it } from "vitest";

import { VENUES } from "../src/venues";

describe("VENUES info", () => {
  it("gives every venue a full info block", () => {
    for (const venue of VENUES) {
      const { address, transit, admission, closedDays, phone, homepage } = venue.info;
      for (const [field, value] of Object.entries({
        address,
        transit,
        admission,
        closedDays,
        phone,
      })) {
        expect(value, `${venue.id}.${field}`).not.toBe("");
      }
      expect(homepage, `${venue.id}.homepage`).toMatch(/^https:\/\//);
    }
  });

  it("keeps the weekly closure out of closedDays", () => {
    // 요일 휴관은 영업시간 줄이 말한다. 여기에도 적으면 같은 말이 두 줄이 된다.
    for (const venue of VENUES) {
      expect(venue.info.closedDays, `${venue.id}.closedDays`).not.toContain("요일");
    }
  });
});
