import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DateTabs } from "../src/components/DateTabs";

const DATES = ["2026-08-23", "2026-08-24", "2026-08-25"];

describe("DateTabs", () => {
  it("labels the first date as today and the rest by weekday and date", () => {
    render(<DateTabs dates={DATES} selected={DATES[0]} onSelect={() => {}} />);

    // 2026-08-23 은 일요일, 24 는 월요일
    expect(screen.getByRole("tab", { name: "오늘 (일)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "월 8/24" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "화 8/25" })).toBeInTheDocument();
  });

  it("marks only the selected tab as selected", () => {
    render(<DateTabs dates={DATES} selected={DATES[1]} onSelect={() => {}} />);

    expect(screen.getByRole("tab", { name: "월 8/24" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "오늘 (일)" })).toHaveAttribute("aria-selected", "false");
  });

  it("reports the clicked date", () => {
    const onSelect = vi.fn();
    render(<DateTabs dates={DATES} selected={DATES[0]} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("tab", { name: "화 8/25" }));

    expect(onSelect).toHaveBeenCalledWith("2026-08-25");
  });
});
