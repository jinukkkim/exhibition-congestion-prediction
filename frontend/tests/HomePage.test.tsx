import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { HomePage } from "../src/pages/HomePage";

describe("HomePage", () => {
  it("renders a link to each venue page", () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: "국립중앙박물관" })).toHaveAttribute(
      "href",
      "/venues/national-museum"
    );
    expect(screen.getByRole("link", { name: "국립현대미술관 서울관" })).toHaveAttribute(
      "href",
      "/venues/mmca-seoul"
    );
    expect(screen.getByRole("link", { name: "국립현대미술관 과천관" })).toHaveAttribute(
      "href",
      "/venues/mmca-gwacheon"
    );
    expect(screen.getByRole("link", { name: "국립현대미술관 덕수궁관" })).toHaveAttribute(
      "href",
      "/venues/mmca-deoksugung"
    );
  });
});
