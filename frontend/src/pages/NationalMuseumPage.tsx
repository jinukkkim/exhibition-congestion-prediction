import { Link } from "react-router-dom";

import { fetchCurrent, fetchDaily, fetchPrediction } from "../api/congestion";
import { CongestionCard } from "../components/CongestionCard";
import { shiftDate, todayString } from "../lib/date";
import { PredictionChart } from "../components/PredictionChart";
import { useCongestionStream } from "../hooks/useCongestionStream";
import { usePolledFetch } from "../hooks/usePolledFetch";

const POLL_INTERVAL_MS = 60_000; // MmcaPage와 같은 주기

export function NationalMuseumPage() {
  const today = todayString();
  const lastWeek = shiftDate(today, -7);

  // 계속 폴링: 새 판독이 실제로 쌓이는 값. current 는 SSE 가 주 경로지만,
  // 스트림이 죽어도 갱신이 멈추지 않도록 폴링을 폴백으로 둔다.
  const initial = usePolledFetch(fetchCurrent, { intervalMs: POLL_INTERVAL_MS });
  const daily = usePolledFetch(() => fetchDaily(today), { intervalMs: POLL_INTERVAL_MS }, [today]);

  // 성공하면 정지: 다시 요청해도 같은 답이 오는 값. 실패했을 때만 다음 tick 에
  // 재시도한다 (지난주 로그는 지나간 날의 확정 데이터, 예측은 일 1회 배치).
  const prediction = usePolledFetch(fetchPrediction, {
    intervalMs: POLL_INTERVAL_MS,
    stopWhenLoaded: true,
  });
  const lastWeekDaily = usePolledFetch(
    () => fetchDaily(lastWeek),
    { intervalMs: POLL_INTERVAL_MS, stopWhenLoaded: true },
    [lastWeek]
  );

  const current = useCongestionStream(initial.data);

  return (
    <div className="min-h-screen bg-canvas">
      <main className="mx-auto max-w-[1400px] px-6 py-16 sm:px-10 lg:px-16">
        <header className="mb-12 border-b border-hairline/70 pb-8">
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
        </header>

        <section className="grid gap-6 lg:grid-cols-2">
          <CongestionCard
            data={current}
            daily={daily.data}
            lastWeekDaily={lastWeekDaily.data}
            error={initial.error}
            chartError={daily.error || lastWeekDaily.error}
          />
          <PredictionChart prediction={prediction.data} error={prediction.error} />
        </section>
      </main>
    </div>
  );
}
