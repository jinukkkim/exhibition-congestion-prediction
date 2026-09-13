import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { VenueInfoList } from "../src/components/VenueInfoList";
import { VENUES } from "../src/venues";

// 표가 기록 페이지로 가는 내부 링크를 들게 되면서 Router 컨텍스트 없이는
// 렌더되지 않는다.
function renderList(venue: (typeof VENUES)[number]) {
  return render(
    <MemoryRouter>
      <VenueInfoList venue={venue} />
    </MemoryRouter>
  );
}

describe("VenueInfoList", () => {
  it("makes every venue's phone number dialable", () => {
    // 링크가 아니라 평문으로 돌아가도 화면은 멀쩡해 보인다 — 눌러 걸리는지는
    // href 로만 확인된다.
    for (const venue of VENUES) {
      const { unmount } = renderList(venue);
      expect(screen.getByRole("link", { name: venue.info.phone }), venue.id).toHaveAttribute(
        "href",
        `tel:${venue.info.phone}`
      );
      unmount();
    }
  });

  it("opens the official page in a new tab", () => {
    renderList(VENUES[0]);

    const link = screen.getByRole("link", { name: "공식 웹사이트 →" });
    expect(link).toHaveAttribute("href", VENUES[0].info.homepage);
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("links each venue to its own weekday-by-hour record", () => {
    // 사이트 안에서 그 페이지로 가는 유일한 길이다. 관 정보 안에 두는 이유는
    // 그 기록이 이 관에 대한 것이어서고, 링크가 사라지면 고아 페이지가 된다.
    for (const venue of VENUES.filter((v) => v.hasQuietHours)) {
      const { unmount } = renderList(venue);

      expect(
        screen.getByRole("link", { name: /요일·시간대별 혼잡도 기록/ })
      ).toHaveAttribute("href", `${venue.path}/when`);
      unmount();
    }
  });

  it("leaves the row out for the venue that has no record page", () => {
    // 덕수궁관은 판독에 혼잡도가 실리지 않아 격자가 비고, 그래서 페이지가 없다.
    // 링크가 없는 것이 빠뜨린 것으로 읽히지 않도록 고정한다.
    const deoksugung = VENUES.find((v) => v.id === "mmca-deoksugung")!;
    renderList(deoksugung);

    expect(screen.queryByRole("link", { name: /혼잡도 기록/ })).toBeNull();
  });
});
