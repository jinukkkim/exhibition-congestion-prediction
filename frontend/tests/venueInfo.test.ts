import { describe, expect, it } from "vitest";

import { mmcaBusinessHours } from "../src/lib/mmcaBusinessHours";
import { nationalMuseumBusinessHours } from "../src/lib/nationalMuseumBusinessHours";
import { VENUES } from "../src/venues";

// venues.ts 의 휴관일·야간개장 문구는 영업시간 로직과 같은 사실을 말로 옮긴
// 것이다. 과천관이 실제로 어긋나 있었으므로(헤더는 공식 안내를, 차트는 서울관
// 시간표를 따랐다) 둘이 같은 말을 하는지 여기서 잠근다.
const MONDAY = new Date("2026-08-24T12:00:00");
const WEDNESDAY = new Date("2026-08-26T12:00:00");
const SATURDAY = new Date("2026-08-29T12:00:00");
const THURSDAY = new Date("2026-08-27T12:00:00");

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

  it("matches the weekly closure the business-hours logic applies", () => {
    for (const venue of VENUES) {
      const saysMonday = venue.info.closedDays.includes("매주 월요일");
      const isOpenMonday = venue.mmcaVenue
        ? mmcaBusinessHours(venue.mmcaVenue, MONDAY).isOpenToday
        : true; // 국중박은 요일 휴관이 없어 isOpenToday 인자 자체가 없다
      expect(isOpenMonday, `${venue.id} 월요일 휴관`).toBe(!saysMonday);
    }
  });

  it("matches the night opening the business-hours logic applies", () => {
    for (const venue of VENUES) {
      const closeAt = (date: Date) =>
        venue.mmcaVenue
          ? mmcaBusinessHours(venue.mmcaVenue, date).close
          : nationalMuseumBusinessHours(date).close;
      // 야간개장 문구가 있으면 수·토가 그 밖의 날보다 늦게 닫혀야 하고,
      // 없으면 요일과 무관하게 같은 시각에 닫혀야 한다.
      const weekday = closeAt(THURSDAY);
      const late = venue.info.nightOpening !== null;
      expect(closeAt(WEDNESDAY) > weekday, `${venue.id} 수요일 야간개장`).toBe(late);
      expect(closeAt(SATURDAY) > weekday, `${venue.id} 토요일 야간개장`).toBe(late);
    }
  });
});
