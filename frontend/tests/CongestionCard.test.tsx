import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CongestionCard } from "../src/components/CongestionCard";
import type { DailyLogPoint } from "../src/api/congestion";

function dailyPoint(observedAt: string, avg: number): DailyLogPoint {
  return {
    observed_at: observedAt,
    congest_level: "보통",
    population_min: avg,
    population_max: avg,
    male_ppltn_rate: null,
    female_ppltn_rate: null,
    ppltn_rate_0: null,
    ppltn_rate_10: null,
    ppltn_rate_20: null,
    ppltn_rate_30: null,
    ppltn_rate_40: null,
    ppltn_rate_50: null,
    ppltn_rate_60: null,
    ppltn_rate_70: null,
    resnt_ppltn_rate: null,
    non_resnt_ppltn_rate: null,
  };
}

describe("CongestionCard", () => {
  // Pinned inside business hours (Wed 14:30) — the card hides the level/count
  // display outside business hours, so tests need a stable "now".
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T14:30:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the congestion level and population estimate", () => {
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={null}
      />
    );

    expect(screen.getByText("보통")).toBeInTheDocument();
    expect(screen.getByText(/1,500/)).toBeInTheDocument();
  });

  it("hides the level/population line outside business hours", () => {
    vi.setSystemTime(new Date("2026-07-16T20:00:00")); // Thu closes at 17:30

    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-16T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={null}
      />
    );

    expect(screen.getByText("영업 시간이 아닙니다")).toBeInTheDocument();
    expect(screen.queryByText("보통")).not.toBeInTheDocument();
    expect(screen.queryByText(/1,500/)).not.toBeInTheDocument();
  });

  it("renders a loading state when data is null", () => {
    render(<CongestionCard data={null} daily={null} />);
    expect(screen.getByText(/불러오는 중/)).toBeInTheDocument();
  });

  it("draws a curve through points within business hours (09:30 onward)", () => {
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={[dailyPoint("2026-07-15T10:00:00", 800), dailyPoint("2026-07-15T14:30:00", 1500)]}
      />
    );

    expect(screen.getByTestId("history-sparkline")).toBeInTheDocument();
    expect(screen.getByTestId("sparkline-line")).toBeInTheDocument();
  });

  it("excludes points before opening time and leaves the chart blank when fewer than 2 remain", () => {
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={[dailyPoint("2026-07-15T06:00:00", 100)]}
      />
    );

    expect(screen.getByTestId("history-sparkline")).toBeInTheDocument();
    expect(screen.queryByTestId("sparkline-line")).not.toBeInTheDocument();
  });
});
