import { useState } from "react";
import { Link } from "react-router-dom";

import { fetchCurrent, fetchDaily, fetchPrediction } from "../api/congestion";
import { CongestionCard } from "../components/CongestionCard";
import { DateTabs } from "../components/DateTabs";
import { shiftDate, todayString } from "../lib/date";
import { PredictionChart } from "../components/PredictionChart";
import { useCongestionStream } from "../hooks/useCongestionStream";
import { usePolledFetch } from "../hooks/usePolledFetch";
import { VENUES } from "../venues";

const POLL_INTERVAL_MS = 60_000; // MmcaPage와 같은 주기

export function NationalMuseumPage() {
  // 관 이름은 venues.ts 하나에서만 온다 — 홈 카드·로그 탭과 같은 출처.
  const name = VENUES.find((v) => v.id === "national-museum")!.name;
  const today = todayString();
  const [selectedDate, setSelectedDate] = useState(today);

  // 오늘 탭은 오늘 실제를 그리고, 미래 탭은 그릴 실제가 없으므로 지난주 같은
  // 요일(D-7)의 실제 기록을 대리로 쓴다.
  const chartDate = selectedDate === today ? today : shiftDate(selectedDate, -7);
  const lastWeek = shiftDate(today, -7);

  // 계속 폴링: 새 판독이 실제로 쌓이는 값. current 는 SSE 가 주 경로지만,
  // 스트림이 죽어도 갱신이 멈추지 않도록 폴링을 폴백으로 둔다.
  const initial = usePolledFetch(fetchCurrent, { intervalMs: POLL_INTERVAL_MS });
  // chartDate 가 오늘이면 계속 폴링(새 판독이 쌓인다), 지나간 날이면 확정
  // 데이터이므로 한 번 받고 멈춘다.
  const daily = usePolledFetch(
    () => fetchDaily(chartDate),
    { intervalMs: POLL_INTERVAL_MS, stopWhenLoaded: chartDate !== today },
    [chartDate]
  );

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
              {name}
            </h1>
          </div>
        </header>

        {(prediction.data?.days?.length ?? 0) > 0 && (
          <div className="mb-6">
            {/* 탭 날짜는 응답의 days 를 따른다 — 프론트가 upcomingDates 로 따로
                만들면 배치 실패로 백엔드가 걸러낸 결과와 어긋난다. */}
            <DateTabs
              dates={prediction.data!.days!.map((day) => day.date)}
              selected={selectedDate}
              onSelect={setSelectedDate}
            />
          </div>
        )}

        <section className="grid gap-6 lg:grid-cols-2">
          <CongestionCard
            data={current}
            daily={daily.data}
            // 미래 탭에서는 대리값 하나만 보여준다 — D-14 까지 겹치면 무엇이
            // 기준인지 흐려진다.
            lastWeekDaily={selectedDate === today ? lastWeekDaily.data : null}
            viewDate={chartDate}
            error={initial.error}
            chartError={daily.error || (selectedDate === today && lastWeekDaily.error)}
          />
          <PredictionChart
            prediction={prediction.data}
            selectedDate={selectedDate}
            error={prediction.error}
          />
        </section>
      </main>
    </div>
  );
}
