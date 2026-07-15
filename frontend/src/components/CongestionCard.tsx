import type { CurrentCongestion } from "../api/congestion";

export function CongestionCard({ data }: { data: CurrentCongestion | null }) {
  if (!data) {
    return <div className="rounded-lg border p-4">불러오는 중...</div>;
  }

  return (
    <div className="rounded-lg border p-4">
      <p className="text-sm text-gray-500">국립중앙박물관 현재 혼잡도</p>
      <p className="text-2xl font-bold">{data.congest_level}</p>
      <p className="text-sm text-gray-500">
        예상 인원: {Math.round(data.population_avg).toLocaleString()}명
      </p>
    </div>
  );
}
