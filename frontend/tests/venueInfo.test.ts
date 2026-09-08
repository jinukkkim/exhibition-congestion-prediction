import { describe, expect, it } from "vitest";

import calendar from "../../shared/museum-holidays.json";
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

  it("gives every venue a key in shared/museum-holidays.json's closed map", () => {
    // MMCA 관은 mmcaVenue(seoul/gwacheon/deoksugung)가 달력 키다 — venues.ts
    // 의 id(mmca-seoul 등)가 아니다. 국립중앙박물관은 MMCA 가 아니라
    // mmcaVenue 가 없으므로 그때는 id(national-museum) 자체가 키다.
    // info.closedDays 문자열과 JSON 이 어긋나는 것(임시 휴관일 생략)은
    // 의도된 것이라 여기서 검사하지 않는다.
    for (const venue of VENUES) {
      const calendarKey = venue.mmcaVenue ?? venue.id;
      expect(calendar.closed, venue.id).toHaveProperty(calendarKey);
    }
  });
});
