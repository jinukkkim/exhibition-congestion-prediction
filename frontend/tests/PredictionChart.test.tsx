import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PredictionChart } from "../src/components/PredictionChart";

describe("PredictionChart", () => {
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
