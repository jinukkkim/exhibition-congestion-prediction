import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { VenueInfoList } from "../src/components/VenueInfoList";
import { VENUES } from "../src/venues";

describe("VenueInfoList", () => {
  it("makes every venue's phone number dialable", () => {
    // 링크가 아니라 평문으로 돌아가도 화면은 멀쩡해 보인다 — 눌러 걸리는지는
    // href 로만 확인된다.
    for (const venue of VENUES) {
      const { unmount } = render(<VenueInfoList venue={venue} />);
      expect(screen.getByRole("link", { name: venue.info.phone }), venue.id).toHaveAttribute(
        "href",
        `tel:${venue.info.phone}`
      );
      unmount();
    }
  });

  it("opens the official page in a new tab", () => {
    render(<VenueInfoList venue={VENUES[0]} />);

    const link = screen.getByRole("link", { name: "공식 웹사이트 →" });
    expect(link).toHaveAttribute("href", VENUES[0].info.homepage);
    expect(link).toHaveAttribute("target", "_blank");
  });
});
