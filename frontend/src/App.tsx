import { useEffect, useState } from "react";

import { fetchCurrent, fetchPrediction, type CurrentCongestion, type PredictionResult } from "./api/congestion";
import { CongestionCard } from "./components/CongestionCard";
import { PredictionChart } from "./components/PredictionChart";
import { useCongestionStream } from "./hooks/useCongestionStream";

export default function App() {
  const [initial, setInitial] = useState<CurrentCongestion | null>(null);
  const [prediction, setPrediction] = useState<PredictionResult | null>(null);

  useEffect(() => {
    fetchCurrent().then(setInitial).catch(() => setInitial(null));
    fetchPrediction().then(setPrediction).catch(() => setPrediction(null));
  }, []);

  const current = useCongestionStream(initial);

  return (
    <main className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">전시 혼잡도 예측</h1>
      <CongestionCard data={current} />
      <PredictionChart prediction={prediction} />
    </main>
  );
}
