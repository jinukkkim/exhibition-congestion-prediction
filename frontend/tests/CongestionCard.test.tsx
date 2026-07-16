import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CongestionCard } from "../src/components/CongestionCard";

describe("CongestionCard", () => {
  it("renders the congestion level and population estimate", () => {
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        history={null}
      />
    );

    expect(screen.getByText("보통")).toBeInTheDocument();
    expect(screen.getByText(/1,500/)).toBeInTheDocument();
  });

  it("renders a loading state when data is null", () => {
    render(<CongestionCard data={null} history={null} />);
    expect(screen.getByText(/불러오는 중/)).toBeInTheDocument();
  });

  it("renders a sparkline when history has more than one point", () => {
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        history={[
          { observed_at: "2026-07-15T08:30:00", population_avg: 800 },
          { observed_at: "2026-07-15T14:30:00", population_avg: 1500 },
        ]}
      />
    );

    expect(screen.getByTestId("history-sparkline")).toBeInTheDocument();
  });

  it("omits the sparkline when history is empty", () => {
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        history={[]}
      />
    );

    expect(screen.queryByTestId("history-sparkline")).not.toBeInTheDocument();
  });
});
