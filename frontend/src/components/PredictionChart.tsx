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

const PLACEHOLDER_CLASS =
  "flex min-h-[420px] flex-col items-center justify-center rounded-apple border border-hairline/60 bg-white/70 p-10 text-center shadow-apple backdrop-blur-xl motion-safe:animate-rise-in";

export function PredictionChart({
  prediction,
  error = false,
}: {
  prediction: PredictionResult | null;
  error?: boolean;
}) {
  // 수집 진행도는 서버 응답에만 있다. 응답이 없는 동안 "0/14일"로 적으면
  // 아무것도 모으지 않았다고 단정하는 셈이라, 상태를 그대로 말한다.
  if (!prediction) {
    return (
      <div className={PLACEHOLDER_CLASS}>
        {error ? (
          <>
            <p className="text-sm text-ink-soft">불러오지 못했습니다.</p>
            <p className="mt-1 text-xs text-ink-soft/70">재시도 중...</p>
          </>
        ) : (
          <p className="text-sm text-ink-soft">불러오는 중...</p>
        )}
      </div>
    );
  }

  if (prediction.status === "collecting") {
    return (
      <div className={PLACEHOLDER_CLASS}>
        <p className="text-sm text-ink-soft">데이터 수집 중</p>
        <p className="mt-2 font-mono text-3xl font-semibold tabular-nums text-ink">
          {prediction.days_collected ?? 0}
          <span className="text-ink-soft">/14일</span>
        </p>
        <p className="mt-3 text-xs text-ink-soft">예측을 위해 조금 더 기다려주세요.</p>
      </div>
    );
  }

  const curve = prediction.curve ?? [];
  const baselineValues = curve.map((point) => point.baseline ?? point.model);
  const modelValues = curve.map((point) => point.model);
  const maxValue = Math.max(...baselineValues, ...modelValues, 1);

  return (
    <div className="rounded-apple border border-hairline/60 bg-white/70 p-8 shadow-apple backdrop-blur-xl motion-safe:animate-rise-in sm:p-10">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-soft">
        오늘의 시간대별 예측
      </p>

      <div className="mt-4 flex gap-8">
        <div>
          <p className="flex items-center gap-1.5 text-xs text-ink-soft">
            <span className="h-2 w-2 rounded-full bg-ink-soft/50" />
            베이스라인 MAE
          </p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-ink">
            {prediction.baseline_mae?.toFixed(1)}
          </p>
        </div>
        <div>
          <p className="flex items-center gap-1.5 text-xs text-ink-soft">
            <span className="h-2 w-2 rounded-full bg-accent" />
            모델 MAE
          </p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-accent">
            {prediction.model_mae?.toFixed(1)}
          </p>
        </div>
      </div>

      <svg data-testid="prediction-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="mt-8 w-full">
        <polyline
          points={toPoints(baselineValues, maxValue)}
          fill="none"
          stroke="#6E6E73"
          strokeWidth={2}
          strokeDasharray="4 4"
          strokeLinecap="round"
        />
        <polyline
          points={toPoints(modelValues, maxValue)}
          fill="none"
          stroke="#0071E3"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
