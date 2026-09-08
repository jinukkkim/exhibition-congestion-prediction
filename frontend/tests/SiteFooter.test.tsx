import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SiteFooter } from "../src/components/SiteFooter";

describe("SiteFooter", () => {
  it("links to the repository in a new tab", () => {
    render(<SiteFooter />);

    const link = screen.getByRole("link", { name: "GitHub" });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/jinukkkim/exhibition-congestion-prediction"
    );
    expect(link).toHaveAttribute("target", "_blank");
    // target="_blank" 로 여는 링크는 rel 없이 두면 새 탭이 window.opener 로
    // 원래 문서를 건드릴 수 있고, referrer 도 그대로 나간다.
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("keeps the new-tab arrow out of the accessible name", () => {
    // 화살표는 장식이다 — 링크 이름이 "GitHub ↗" 로 읽히면 스크린리더에서
    // 기호까지 발음된다. getByRole 의 정확 일치가 그것을 고정한다.
    render(<SiteFooter />);

    expect(screen.getByRole("link", { name: "GitHub" })).toBeInTheDocument();
  });
});
