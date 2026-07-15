import type { PredictionResult } from "../api/congestion";

const WIDTH = 480;
const HEIGHT = 160;

function toPoints(values: number[], maxValue: number): string {
  const denominator = values.length - 1 || 1; // ponytail: guards a single-point curve; 24-point curve never hits this
  return values
    .map((value, index) => {
      const x = (index / denominator) * WIDTH;
      const y = HEIGHT - (value / maxValue) * HEIGHT;
      return `${x},${y}`;
    })
    .join(" ");
}

export function PredictionChart({ prediction }: { prediction: PredictionResult | null }) {
  if (!prediction || prediction.status === "collecting") {
    const days = prediction?.days_collected ?? 0;
    return (
      <div className="rounded-lg border p-8">
        데이터 수집 중 ({days}/14일) — 예측을 위해 조금 더 기다려주세요.
      </div>
    );
  }

  const curve = prediction.curve ?? [];
  const baselineValues = curve.map((point) => point.baseline ?? point.model);
  const modelValues = curve.map((point) => point.model);
  const maxValue = Math.max(...baselineValues, ...modelValues, 1);

  return (
    <div className="rounded-lg border p-8">
      <p className="mb-2 text-xs text-gray-500">
        베이스라인 MAE {prediction.baseline_mae?.toFixed(1)} · 모델 MAE{" "}
        {prediction.model_mae?.toFixed(1)}
      </p>
      <svg
        data-testid="prediction-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
      >
        <polyline points={toPoints(baselineValues, maxValue)} fill="none" stroke="#94a3b8" strokeWidth={2} />
        <polyline points={toPoints(modelValues, maxValue)} fill="none" stroke="#2563eb" strokeWidth={2} />
      </svg>
    </div>
  );
}
