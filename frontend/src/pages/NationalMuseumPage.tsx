import { useState } from "react";
import { Link } from "react-router-dom";

import { fetchCurrent, fetchDaily, fetchPrediction } from "../api/congestion";
import { CongestionCard } from "../components/CongestionCard";
import { DateTabs } from "../components/DateTabs";
import { VenueInfoList } from "../components/VenueInfoList";
import { useCongestionStream } from "../hooks/useCongestionStream";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { usePolledFetch } from "../hooks/usePolledFetch";
import { shiftDate, todayString } from "../lib/date";
import { VENUES } from "../venues";

const POLL_INTERVAL_MS = 60_000; // MmcaPage와 같은 주기

export function NationalMuseumPage() {
  // 관 이름·관 정보는 venues.ts 하나에서만 온다 — 홈 카드·로그 탭과 같은 출처.
  const venueMeta = VENUES.find((v) => v.id === "national-museum")!;
  const name = venueMeta.name;
  useDocumentTitle(name);
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
          <Link
            to="/"
            className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-soft hover:text-accent"
          >
            ← 전체 보기
          </Link>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            {name}
          </h1>
          {/* 관 단위 정보 — 카드마다 반복하지 않는다. MmcaPage 와 달리 전시
              목록이 없어 헤더가 1열이다. 값이 페이지 폭 전체로 늘어나면 라벨과
              값이 멀어지므로 표만 좁게 가둔다. */}
          <div className="mt-6 max-w-md">
            <VenueInfoList venue={venueMeta} />
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

        {/* 카드는 하나다 — 예측 점선이 실측 곡선과 같은 축에 올라가면서 별도
            예측 카드가 없어졌다 (MmcaPage 의 전시실 카드와 같은 구성). */}
        <section className="grid gap-6">
          <CongestionCard
            data={current}
            daily={daily.data}
            // 미래 탭에서는 대리값 하나만 보여준다 — D-14 까지 겹치면 무엇이
            // 기준인지 흐려진다.
            lastWeekDaily={selectedDate === today ? lastWeekDaily.data : null}
            // 예측은 고른 날짜의 것을 그대로 — 실측(오늘 또는 D−7)과 축만
            // 공유하고 날짜는 다를 수 있다. 응답의 days 에 그 날짜가 없으면
            // (자정을 넘겨 폴링이 갱신된 직후) 점선만 없다.
            prediction={
              prediction.data?.days?.find((day) => day.date === selectedDate)?.curve ?? null
            }
            viewDate={chartDate}
            error={initial.error}
            chartError={daily.error || (selectedDate === today && lastWeekDaily.error)}
          />
        </section>
      </main>
    </div>
  );
}
