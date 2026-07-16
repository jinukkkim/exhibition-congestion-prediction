import { useEffect, useState } from "react";

import {
  fetchCurrent,
  fetchHistory,
  fetchPrediction,
  type CongestionHistoryPoint,
  type CurrentCongestion,
  type PredictionResult,
} from "./api/congestion";
import { CongestionCard } from "./components/CongestionCard";
import { DailyLogTable } from "./components/DailyLogTable";
import { PredictionChart } from "./components/PredictionChart";
import { useCongestionStream } from "./hooks/useCongestionStream";

const HISTORY_HOURS = 24;

export default function App() {
  const [initial, setInitial] = useState<CurrentCongestion | null>(null);
  const [prediction, setPrediction] = useState<PredictionResult | null>(null);
  const [history, setHistory] = useState<CongestionHistoryPoint[] | null>(null);

  useEffect(() => {
    fetchCurrent().then(setInitial).catch(() => setInitial(null));
    fetchPrediction().then(setPrediction).catch(() => setPrediction(null));
    fetchHistory(HISTORY_HOURS).then(setHistory).catch(() => setHistory(null));
  }, []);

  const current = useCongestionStream(initial);

  return (
    <main className="mx-auto max-w-[1600px] space-y-4 p-6">
      <h1 className="text-xl font-semibold">전시 혼잡도 예측</h1>
      <div className="flex gap-4">
        <div className="w-80 shrink-0 space-y-4">
          <CongestionCard data={current} history={history} />
          <PredictionChart prediction={prediction} />
        </div>
        <div className="min-w-0 flex-1">
          <DailyLogTable />
        </div>
      </div>
    </main>
  );
}
