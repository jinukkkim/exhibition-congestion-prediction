import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PredictionChart } from "../src/components/PredictionChart";

describe("PredictionChart", () => {
  it("says it failed when the fetch errored with nothing to show", () => {
    render(<PredictionChart prediction={null} error />);
    expect(screen.getByText(/불러오지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByText(/재시도 중/)).toBeInTheDocument();
    expect(screen.queryByText(/수집 중/)).not.toBeInTheDocument();
  });

  it("does not claim zero days collected while the first fetch is still in flight", () => {
    // prediction === null 은 수집 진행도를 모르는 상태다. "0/14일"로 적으면
    // 서버가 아직 아무것도 모았다고 답하지 않았는데 0일이라고 단정하게 된다.
    render(<PredictionChart prediction={null} />);
    expect(screen.getByText(/불러오는 중/)).toBeInTheDocument();
    expect(screen.queryByText("/14일")).not.toBeInTheDocument();
  });

  it("shows a collecting message before enough data exists", () => {
    render(
      <PredictionChart prediction={{ status: "collecting", days_collected: 5 }} />
    );
    expect(screen.getByText(/수집 중/)).toBeInTheDocument();
  });

  it("renders an svg chart with baseline and model MAE once ready", () => {
    const curve = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      baseline: 1000 + hour,
      model: 1050 + hour,
    }));

    render(
      <PredictionChart
        prediction={{
          status: "ready",
          baseline_mae: 120.5,
          model_mae: 95.2,
          curve,
        }}
      />
    );

    expect(screen.getByTestId("prediction-svg")).toBeInTheDocument();
    expect(screen.getByText(/95\.2/)).toBeInTheDocument();
  });
});
