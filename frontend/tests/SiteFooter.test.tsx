import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { SiteFooter } from "../src/components/SiteFooter";

// 푸터가 내부 링크를 들게 되면서 Router 컨텍스트 없이는 렌더되지 않는다.
function renderFooter() {
  return render(
    <MemoryRouter>
      <SiteFooter container="max-w-[1400px] px-6" />
    </MemoryRouter>
  );
}

describe("SiteFooter", () => {
  it("links to the repository in a new tab", () => {
    renderFooter();

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

  it("keeps the GitHub mark decorative", () => {
    // 마크는 옆의 "GitHub" 를 그림으로 되풀이할 뿐이라 접근성 트리에 두 번
    // 나오면 안 된다. 링크 이름은 아래 테스트가 따로 고정한다.
    const { container } = renderFooter();

    const mark = container.querySelector("svg");
    expect(mark).not.toBeNull();
    expect(mark).toHaveAttribute("aria-hidden", "true");
    // 링크 색을 그대로 따라가야 hover 전환이 글자와 함께 일어난다.
    expect(mark).toHaveAttribute("fill", "currentColor");
    expect(within(screen.getByRole("link", { name: "GitHub" })).getByText("↗")).toBeInTheDocument();
  });

  it("keeps the new-tab arrow out of the accessible name", () => {
    // 화살표는 장식이다 — 링크 이름이 "GitHub ↗" 로 읽히면 스크린리더에서
    // 기호까지 발음된다. getByRole 의 정확 일치가 그것을 고정한다.
    renderFooter();

    expect(screen.getByRole("link", { name: "GitHub" })).toBeInTheDocument();
  });

  it("carries the only in-app link to the quiet-hours page", () => {
    // 관 페이지에서 링크를 걷어냈으므로 여기가 사이트 안의 유일한 경로다.
    // 이 링크가 사라지면 /when 은 sitemap.xml 에만 남은 고아 페이지가 된다.
    renderFooter();

    expect(screen.getByRole("link", { name: "국립중앙박물관 한산한 시간" })).toHaveAttribute(
      "href",
      "/venues/national-museum/when"
    );
  });
});
