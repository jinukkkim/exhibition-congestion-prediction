import { fireEvent, render, screen } from "@testing-library/react";
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

  it("shows the live endpoint marker even when only one 30-min bucket of data exists", () => {
    const { container } = render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        // Both readings fall in the same 30-min bucket (10:00–10:30), so
        // resampling collapses them into a single point.
        daily={[dailyPoint("2026-07-15T10:00:00", 800), dailyPoint("2026-07-15T10:15:00", 900)]}
      />
    );

    // Live marker renders as two circles (soft glow + white ring dot). Before
    // the fix, a single resampled point left `xy` empty and the marker never
    // rendered even though the card is open.
    expect(container.querySelectorAll("circle")).toHaveLength(2);
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

  it("renders a grey last-week line alongside this week's when both have data", () => {
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={[dailyPoint("2026-07-15T10:00:00", 800), dailyPoint("2026-07-15T14:30:00", 1500)]}
        lastWeekDaily={[dailyPoint("2026-07-08T10:00:00", 600), dailyPoint("2026-07-08T14:30:00", 900)]}
      />
    );

    expect(screen.getByTestId("sparkline-line")).toBeInTheDocument();
    expect(screen.getByTestId("sparkline-last-week-line")).toBeInTheDocument();
  });

  it("omits the last-week line when lastWeekDaily is null or empty", () => {
    const { rerender } = render(
      <CongestionCard
        data={{ observed_at: "2026-07-15T14:30:00", congest_level: "보통", population_avg: 1500 }}
        daily={[dailyPoint("2026-07-15T10:00:00", 800), dailyPoint("2026-07-15T14:30:00", 1500)]}
        lastWeekDaily={null}
      />
    );
    expect(screen.queryByTestId("sparkline-last-week-line")).not.toBeInTheDocument();

    rerender(
      <CongestionCard
        data={{ observed_at: "2026-07-15T14:30:00", congest_level: "보통", population_avg: 1500 }}
        daily={[dailyPoint("2026-07-15T10:00:00", 800), dailyPoint("2026-07-15T14:30:00", 1500)]}
        lastWeekDaily={[]}
      />
    );
    expect(screen.queryByTestId("sparkline-last-week-line")).not.toBeInTheDocument();
  });

  it("shows the grey line on its own when this week has no data yet but last week does", () => {
    render(
      <CongestionCard
        data={{ observed_at: "2026-07-15T14:30:00", congest_level: "보통", population_avg: 1500 }}
        daily={[]}
        lastWeekDaily={[dailyPoint("2026-07-08T10:00:00", 600), dailyPoint("2026-07-08T14:30:00", 900)]}
      />
    );

    expect(screen.getByTestId("history-sparkline")).toBeInTheDocument();
    expect(screen.getByTestId("sparkline-last-week-line")).toBeInTheDocument();
    expect(screen.queryByTestId("sparkline-line")).not.toBeInTheDocument();
  });

  it("shows both values in the tooltip when hovering a time both weeks have data near", () => {
    const { container } = render(
      <CongestionCard
        data={{ observed_at: "2026-07-15T14:30:00", congest_level: "보통", population_avg: 1500 }}
        daily={[dailyPoint("2026-07-15T10:00:00", 800), dailyPoint("2026-07-15T10:15:00", 1000)]}
        lastWeekDaily={[dailyPoint("2026-07-08T10:00:00", 600), dailyPoint("2026-07-08T10:15:00", 700)]}
      />
    );

    const svg = screen.getByTestId("history-sparkline");
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 480, height: 200, right: 480, bottom: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const hoverTarget = container.querySelector('rect[fill="transparent"]') as SVGRectElement;

    fireEvent.mouseMove(hoverTarget, { clientX: 0, clientY: 0 });

    expect(screen.getByText(/지난주/)).toBeInTheDocument();
    expect(screen.getByText(/\(지난주/)).toBeInTheDocument();
  });

  it("shows the standalone '지난주' tooltip when hovering with only last-week data", () => {
    const { container } = render(
      <CongestionCard
        data={{ observed_at: "2026-07-15T14:30:00", congest_level: "보통", population_avg: 1500 }}
        daily={[]}
        lastWeekDaily={[dailyPoint("2026-07-08T10:00:00", 600), dailyPoint("2026-07-08T10:15:00", 700)]}
      />
    );

    const svg = screen.getByTestId("history-sparkline");
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 480, height: 200, right: 480, bottom: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const hoverTarget = container.querySelector('rect[fill="transparent"]') as SVGRectElement;

    fireEvent.mouseMove(hoverTarget, { clientX: 0, clientY: 0 });

    expect(screen.getByText(/지난주/)).toBeInTheDocument();
    expect(screen.queryByText(/\(지난주/)).not.toBeInTheDocument();
  });

  it("shows the standalone '지난주' tooltip over a time slot today hasn't reached yet, even though today has earlier data", () => {
    const { container } = render(
      <CongestionCard
        data={{ observed_at: "2026-07-15T14:30:00", congest_level: "보통", population_avg: 1500 }}
        // Today has one reading at 10:00. Last week has a 10:00 reading and
        // a 15:00 reading. Hovering near 15:00 must be closer to last
        // week's 15:00 point than to today's only (10:00) point, so it
        // must show the standalone last-week tooltip, not re-anchor to
        // today's 10:00 value.
        daily={[dailyPoint("2026-07-15T10:00:00", 800)]}
        lastWeekDaily={[dailyPoint("2026-07-08T10:00:00", 600), dailyPoint("2026-07-08T15:00:00", 950)]}
      />
    );

    const svg = screen.getByTestId("history-sparkline");
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 480, height: 200, right: 480, bottom: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const hoverTarget = container.querySelector('rect[fill="transparent"]') as SVGRectElement;

    // clientX 230 ≈ the 15:00 point's x position on this fixture's axis
    // (open 09:30, close 21:00 on a Wed) — much closer to last week's
    // 15:00 point (~x 240) than to today's only 10:00 point (~x 31).
    fireEvent.mouseMove(hoverTarget, { clientX: 230, clientY: 0 });

    expect(screen.getByText(/지난주/)).toBeInTheDocument();
    expect(screen.queryByText(/\(지난주/)).not.toBeInTheDocument();
  });
});
