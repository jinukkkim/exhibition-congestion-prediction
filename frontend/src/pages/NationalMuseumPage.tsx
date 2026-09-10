import { useState } from "react";
import { Link } from "react-router-dom";

import { fetchCurrent, fetchDaily, fetchExhibitions, fetchPrediction } from "../api/congestion";
import { CongestionCard } from "../components/CongestionCard";
import { DateTabs } from "../components/DateTabs";
import { SiteFooter } from "../components/SiteFooter";
import { VenueInfoList } from "../components/VenueInfoList";
import { useCongestionStream } from "../hooks/useCongestionStream";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { usePolledFetch } from "../hooks/usePolledFetch";
import { exhibitionPeriod, shiftDate, todayString } from "../lib/date";
import { VENUES } from "../venues";

const POLL_INTERVAL_MS = 60_000; // MmcaPage와 같은 주기

// 장소 문자열은 "국립중앙박물관 상설전시실 3층 …" 처럼 관 이름부터 시작하는
// 경우가 섞여 있다. 바로 위 제목이 이미 관 이름이라 지운다.
function shortPlace(place: string): string {
  return place.replace(/^국립중앙박물관\s*/, "");
}

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

  // 계속 폴링한다. 받으면 멈추던 자리인데(배치가 하루 한 번 만드는 값이었다),
  // 오늘 곡선의 보정이 요청 시각에 붙게 된 뒤로는 그러면 점선이 페이지를 연
  // 시점에 얼어붙은 채 실선만 자라난다 — 이 보정의 요점이 사라진다.
  //
  // 탭에 따라 멈추지는 않는다. 한 응답이 7일치를 다 담으므로 미래 탭에서도
  // 그 안의 오늘 곡선이 계속 낡고 있고, MmcaPage 처럼 날짜를 deps 로 걸 수도
  // 없다 — 이 엔드포인트는 날짜를 받지 않아 deps 가 없고, 억지로 넣으면 훅이
  // 탭을 옮길 때마다 값을 비워 차트가 한 번씩 사라진다.
  const prediction = usePolledFetch(fetchPrediction, { intervalMs: POLL_INTERVAL_MS });
  const lastWeekDaily = usePolledFetch(
    () => fetchDaily(lastWeek),
    { intervalMs: POLL_INTERVAL_MS, stopWhenLoaded: true },
    [lastWeek]
  );
  // 전시 목록은 하루 단위로도 거의 안 바뀐다 — 한 번 받고 멈춘다(백엔드도
  // 6시간 캐시다). 실패하면 그냥 목록이 없는 화면이고, 혼잡도는 그대로 읽힌다.
  const exhibitions = usePolledFetch(fetchExhibitions, {
    intervalMs: POLL_INTERVAL_MS,
    stopWhenLoaded: true,
  });

  const current = useCongestionStream(initial.data);
  const exhibitionList = exhibitions.data ?? [];

  return (
    <div className="min-h-screen bg-canvas">
      {/* 카드가 하나뿐인 관이라 1400 을 다 쓰면 차트가 지나치게 가로로 늘어난다
          — 좌우 패딩(lg:px-16)을 뺀 내용 폭이 1152 가 되는 값. MmcaPage 는 카드가
          여러 장이라 여전히 1400 이다. */}
      <main className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10 lg:px-16">
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
          {/* 관 정보와 전시 목록을 2열로 가른다 — MmcaPage 와 같은 구성이고
              같은 이유다(세로로 쌓으면 차트에 닿기까지 목록 전체를 지난다).
              전시가 없으면 열이 하나뿐이라, 표가 페이지 폭 전체로 늘어나 라벨과
              값이 멀어지지 않게 그때는 좁게 가둔다. */}
          <div
            className={
              exhibitionList.length > 0
                ? "mt-6 gap-x-16 gap-y-8 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]"
                : "mt-6 max-w-md"
            }
          >
            {/* 관 단위 정보 — 카드마다 반복하지 않는다. */}
            <VenueInfoList venue={venueMeta} />
            {exhibitionList.length > 0 && (
              <div className="mt-8 lg:mt-0">
                {/* 옆 열 첫 줄(영업시간)과 같은 높이에, 같은 모양으로 선다. */}
                <p className="text-sm text-ink-soft">현재 전시</p>
                <ul className="mt-3 space-y-3">
                  {exhibitionList.map((exhibition) => (
                    <li key={`${exhibition.title}-${exhibition.start_date}`} className="text-sm">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-6 text-ink">
                        <span>{exhibition.title}</span>
                        {/* 기간은 열 오른쪽 끝에 맞춰 세운다 — 제목 길이가
                            제각각이라 왼쪽에 붙이면 날짜가 들쭉날쭉해진다. */}
                        <span className="shrink-0 text-xs tabular-nums text-ink-soft">
                          {exhibitionPeriod(exhibition.start_date, exhibition.end_date)}
                        </span>
                      </div>
                      {/* 전시실 단위 혼잡도가 없는 관이라 이 줄이 유일한 위치
                          정보다. MmcaPage 는 방 카드가 그 일을 해서 없다. */}
                      <p className="mt-0.5 text-xs text-ink-soft">
                        {shortPlace(exhibition.place)}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
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
      <SiteFooter container="max-w-[1280px] px-6 sm:px-10 lg:px-16" />
    </div>
  );
}
