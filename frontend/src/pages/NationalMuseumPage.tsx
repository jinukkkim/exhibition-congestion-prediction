import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  fetchCurrent,
  fetchDaily,
  fetchPrediction,
  type CurrentCongestion,
  type DailyLogPoint,
  type PredictionResult,
} from "../api/congestion";
import { CongestionCard } from "../components/CongestionCard";
import { DailyLogTable, todayString } from "../components/DailyLogTable";
import { PredictionChart } from "../components/PredictionChart";
import { useCongestionStream } from "../hooks/useCongestionStream";

export function NationalMuseumPage() {
  const [initial, setInitial] = useState<CurrentCongestion | null>(null);
  const [prediction, setPrediction] = useState<PredictionResult | null>(null);
  const [daily, setDaily] = useState<DailyLogPoint[] | null>(null);

  useEffect(() => {
    fetchCurrent().then(setInitial).catch(() => setInitial(null));
    fetchPrediction().then(setPrediction).catch(() => setPrediction(null));
    fetchDaily(todayString()).then(setDaily).catch(() => setDaily(null));
  }, []);

  const current = useCongestionStream(initial);

  return (
    <div className="min-h-screen bg-canvas">
      <main className="mx-auto max-w-[1400px] px-6 py-16 sm:px-10 lg:px-16">
        <header className="mb-12 flex items-end justify-between gap-6 border-b border-hairline/70 pb-8">
          <div>
            <Link
              to="/"
              className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-soft hover:text-accent"
            >
              ← 미술관 선택
            </Link>
            <p className="mt-2 text-xs font-semibold uppercase tracking-[0.2em] text-ink-soft">
              Exhibition · Seoul
            </p>
            <h1 className="mt-2 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
              전시 혼잡도 예측
            </h1>
          </div>
          <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-ink-soft">
            <span className="h-2 w-2 rounded-full bg-[#34C759] motion-safe:animate-pulse-live" />
            Live
          </span>
        </header>

        <section className="grid gap-6 lg:grid-cols-2">
          <CongestionCard data={current} daily={daily} />
          <PredictionChart prediction={prediction} />
        </section>

        <section className="mt-6">
          <DailyLogTable />
        </section>
      </main>
    </div>
  );
}
