import type { CongestionHistoryPoint, CurrentCongestion } from "../api/congestion";

const STATUS_COLOR: Record<string, string> = {
  여유: "#0ca30c",
  보통: "#fab219",
  약간붐빔: "#ec835a",
  붐빔: "#d03b3b",
};
const FALLBACK_COLOR = "#94a3b8";

const SPARKLINE_WIDTH = 200;
const SPARKLINE_HEIGHT = 40;

function sparklinePoints(history: CongestionHistoryPoint[]): string {
  const values = history.map((point) => point.population_avg);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1; // ponytail: guards a flat/single-value window; a wider range never hits this
  const denominator = values.length - 1;

  return values
    .map((value, index) => {
      const x = (index / denominator) * SPARKLINE_WIDTH;
      const y = SPARKLINE_HEIGHT - ((value - min) / range) * SPARKLINE_HEIGHT;
      return `${x},${y}`;
    })
    .join(" ");
}

export function CongestionCard({
  data,
  history = null,
}: {
  data: CurrentCongestion | null;
  history: CongestionHistoryPoint[] | null;
}) {
  if (!data) {
    return <div className="rounded-lg border p-8">불러오는 중...</div>;
  }

  const color = STATUS_COLOR[data.congest_level] ?? FALLBACK_COLOR;

  return (
    <div className="rounded-lg border p-8">
      <p className="text-xs text-gray-500">국립중앙박물관 현재 혼잡도</p>
      <div className="mt-2 flex items-baseline gap-3">
        <span className="text-4xl font-bold" style={{ color }}>
          {data.congest_level}
        </span>
        <span className="text-sm text-gray-500">
          {Math.round(data.population_avg).toLocaleString()}명 ·{" "}
          {data.observed_at.slice(11, 16)} 기준
        </span>
      </div>
      {history && history.length > 1 && (
        <svg
          data-testid="history-sparkline"
          viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
          className="mt-4 h-10 w-full"
        >
          <polyline
            points={sparklinePoints(history)}
            fill="none"
            stroke={color}
            strokeWidth={2}
          />
        </svg>
      )}
    </div>
  );
}
