import { useState } from "react";
import { Link } from "react-router-dom";

import {
  fetchMmcaDaily,
  fetchMmcaExhibitions,
  fetchMmcaPrediction,
  fetchMmcaRooms,
  type MmcaDailyLogPoint,
  type MmcaExhibition,
  type MmcaRoomStatus,
  type MmcaVenue,
} from "../api/mmca";
import { DateTabs } from "../components/DateTabs";
import { MmcaRoomChartCard } from "../components/MmcaRoomChartCard";
import { MmcaRoomInactiveCard } from "../components/MmcaRoomInactiveCard";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { usePolledFetch } from "../hooks/usePolledFetch";
import { businessHoursLine } from "../lib/businessHoursLine";
import { shiftDate, todayString, upcomingDates } from "../lib/date";
import { mmcaBusinessHours } from "../lib/mmcaBusinessHours";
import { DISABLED_MMCA_SPACE_CODES } from "../lib/mmcaDisabledRooms";
import { VENUES } from "../venues";

const POLL_INTERVAL_MS = 60_000;
const COLLECTION_START_DELAY_MINUTES = 10;

// 2026-08-27 → 2026.08.27. 전시 기간은 연도가 걸쳐 있는 경우가 흔해
// (2026-08-27~2027-02-09) 연도를 지우면 안 된다.
function formatPeriod({ start_date, end_date }: MmcaExhibition): string {
  return `${start_date.replaceAll("-", ".")} – ${end_date.replaceAll("-", ".")}`;
}

export function MmcaPage({ venue }: { venue: MmcaVenue }) {
  // 관 이름은 venues.ts 하나에서만 온다 — 홈 카드·로그 탭과 같은 출처.
  // MmcaVenue 는 셋 다 VENUES 에 있으므로 못 찾는 경우는 없다.
  const name = VENUES.find((v) => v.mmcaVenue === venue)!.name;
  useDocumentTitle(name);
  const today = todayString();
  const [selectedDate, setSelectedDate] = useState(today);

  // 미래 탭의 회색선은 지난주 같은 요일의 실제 기록이다(대리값). 그 위에
  // 파란 점선으로 예측을 겹친다 — 예측은 selectedDate 기준이고, chartDate 는
  // 회색선을 가져오는 날짜(미래 탭에서 D-7)라 예측에 쓰면 안 된다.
  const chartDate = selectedDate === today ? today : shiftDate(selectedDate, -7);
  const isTodayTab = selectedDate === today;
  // 국중박과 달리 따라갈 서버 목록이 없어 프론트가 날짜를 만든다.
  const tabDates = upcomingDates(today, 7);
  const lastWeek = shiftDate(today, -7);

  // 계속 폴링: 6분 주기 수집이 새 판독을 쌓는 값.
  const roomsPoll = usePolledFetch(() => fetchMmcaRooms(venue), { intervalMs: POLL_INTERVAL_MS }, [
    venue,
  ]);
  // 오늘이면 새 판독이 쌓이므로 계속 폴링, 지나간 날이면 확정 데이터라 한 번
  // 받고 멈춘다.
  const dailyPoll = usePolledFetch(
    () => fetchMmcaDaily(venue, chartDate),
    { intervalMs: POLL_INTERVAL_MS, stopWhenLoaded: !isTodayTab },
    [venue, chartDate]
  );

  // 성공하면 정지: 지나간 날의 확정 데이터라 다시 물어볼 이유가 없다. 다만
  // 실패했을 때 재시도가 없으면 회색 비교선이 그 페이지 세션 내내 사라지므로,
  // 값이 도착할 때까지는 다음 tick 에 다시 시도한다.
  const lastWeekPoll = usePolledFetch(
    () => fetchMmcaDaily(venue, lastWeek),
    { intervalMs: POLL_INTERVAL_MS, stopWhenLoaded: true },
    [venue, lastWeek]
  );

  // 오늘 탭은 곡선이 최근 120분 실측에 매달려 있어 판독마다 바뀌므로 계속
  // 폴링한다. 미래 탭은 편차가 없어 정적이라 한 번 받고 멈춘다.
  const predictionPoll = usePolledFetch(
    () => fetchMmcaPrediction(venue, selectedDate),
    { intervalMs: POLL_INTERVAL_MS, stopWhenLoaded: !isTodayTab },
    [venue, selectedDate]
  );

  // 전시 목록은 백엔드가 6시간 캐시한다 — 하루에 몇 번 바뀔 값이 아니므로
  // 받으면 멈춘다. 실패하면 다음 tick 에 다시 시도하고, 그때까지 이 줄은
  // 그냥 없다 (혼잡도는 이것 없이도 온전히 읽힌다).
  const exhibitionsPoll = usePolledFetch(
    () => fetchMmcaExhibitions(venue),
    { intervalMs: POLL_INTERVAL_MS, stopWhenLoaded: true },
    [venue]
  );

  const rooms = roomsPoll.data;
  const exhibitions = exhibitionsPoll.data ?? [];
  const error = roomsPoll.error;
  const daily = dailyPoll.data;
  // 미래 탭에서는 대리값 하나만 보여준다 — D-14 까지 겹치면 무엇이 기준인지
  // 흐려진다.
  const lastWeekDaily = isTodayTab ? lastWeekPoll.data : null;
  // 오늘/지난주 로그는 전시실 전체가 공유하는 fetch 한 건이다. 실패하면 방
  // 카드가 빈 차트만 그린 채 조용히 남으므로 안내가 필요하지만, 실패는 관
  // 단위로 한 번 일어난 일이라 카드마다 반복하지 않고 그리드 위에 한 줄 둔다.
  const trendError = dailyPoll.error || (isTodayTab && lastWeekPoll.error);
  // 예측은 없어도 차트가 그려져야 한다 — trendError 에 넣지 않는다. 이력이
  // 모자란 방은 응답에서 빠지므로 조회 실패는 곧 "그 방은 점선 없음"이다.
  const predictionByCode = new Map(
    (predictionPoll.data ?? []).map((room) => [room.space_code, room])
  );

  const now = new Date();
  // 축은 그리는 날짜의 영업시간을 쓴다 — 수·토는 21:00 폐관이라 요일에 따라
  // 축의 오른쪽 끝이 달라진다. (D 와 D-7 은 같은 요일이라 결과는 같지만,
  // 그리는 날짜를 기준으로 두는 편이 읽기에 분명하다.)
  // 헤더의 영업시간 한 줄도 이 값을 그대로 쓴다: chartDate 는 selectedDate 이거나
  // 그 -7 일이고 -7 은 요일을 보존하므로, 고른 날짜의 영업시간·휴관 여부와 항상
  // 같다. 두 번 계산할 이유가 없다.
  const { open, close, isOpenToday } = mmcaBusinessHours(
    venue,
    isTodayTab ? now : new Date(`${chartDate}T00:00:00`)
  );
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  // A room only earns a full-size chart card if it has a curve worth showing.
  // Until today's first reading exists, last week's same-weekday curve is the
  // deciding signal; from then on (including after close) it's today's data.
  // The collector's first poll of the day lands 10 minutes after the opening
  // time we display (backend/app/collector.py's `_COLLECTION_START`), so
  // that window — plus all day on a closed day — goes by last week too.
  // `<=` not `<`: the poll itself takes a few seconds, and this page only
  // re-renders once a minute.
  const beforeFirstPoll = isTodayTab && (!isOpenToday || nowMinutes <= open + COLLECTION_START_DELAY_MINUTES);

  // `null` means the fetch hasn't landed yet: don't shrink a card on the
  // strength of data we haven't received.
  const loadedWithNoReading = (rows: MmcaDailyLogPoint[] | null, code: string) =>
    rows !== null && !rows.some((row) => row.rooms.find((r) => r.space_code === code)?.congestion_nm != null);

  const isRoomInactiveToday = (room: MmcaRoomStatus) => {
    if (DISABLED_MMCA_SPACE_CODES.has(room.space_code)) return true;
    // 미래 탭에서는 그릴 곡선이 D-7 판독이므로 그것으로 카드 크기를 가른다 —
    // 오늘 판독을 기준으로 두면 그리지 않을 곡선을 위해 전체 카드를 내준다.
    if (!isTodayTab) return loadedWithNoReading(daily, room.space_code);
    return beforeFirstPoll
      ? loadedWithNoReading(lastWeekDaily, room.space_code)
      : room.congestion_nm == null && loadedWithNoReading(daily, room.space_code);
  };

  const inactiveReason = (room: MmcaRoomStatus) =>
    DISABLED_MMCA_SPACE_CODES.has(room.space_code)
      ? "서비스 예정"
      : !isOpenToday
        ? "휴관일"
        : isTodayTab
          ? "오늘 정보 없음"
          : "정보 없음";

  const activeRooms = rooms?.filter((room) => !isRoomInactiveToday(room)) ?? [];
  const inactiveRooms = rooms?.filter(isRoomInactiveToday) ?? [];

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
          {/* 관 단위 정보 — 전시실 카드마다 같은 값을 반복하지 않는다. */}
          <p className="mt-3 text-sm text-ink-soft">
            {businessHoursLine(selectedDate, open, close, isOpenToday)}
          </p>
          {/* 전시명은 전시실이 아니라 관에 붙는다 — 출처 API 가 전시실까지
              내려주지 않는다. 방 카드 대신 헤더에 관 단위로 한 번 나열한다. */}
          {exhibitions.length > 0 && (
            <div className="mt-6">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-soft">
                현재 전시
              </p>
              <ul className="mt-2 space-y-1.5">
                {exhibitions.map((exhibition) => (
                  <li
                    key={`${exhibition.title}-${exhibition.start_date}`}
                    className="flex flex-wrap items-baseline gap-x-3 text-sm text-ink"
                  >
                    <span>{exhibition.title}</span>
                    <span className="text-xs tabular-nums text-ink-soft">
                      {formatPeriod(exhibition)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </header>

        {rooms === null && !error && <p className="text-sm text-ink-soft">불러오는 중...</p>}
        {error && rooms === null && (
          <p className="text-sm text-ink-soft">불러오지 못했습니다.</p>
        )}
        <div className="mb-6">
          <DateTabs dates={tabDates} selected={selectedDate} onSelect={setSelectedDate} />
        </div>

        {trendError && rooms !== null && (
          <p className="mb-4 text-xs text-ink-soft/70">추이를 불러오지 못했습니다. 재시도 중...</p>
        )}
        {activeRooms.length > 0 && (
          <section className={`grid gap-6${activeRooms.length > 1 ? " lg:grid-cols-2" : ""}`}>
            {activeRooms.map((room) => (
              <MmcaRoomChartCard
                key={room.space_code}
                room={room}
                daily={daily}
                lastWeekDaily={lastWeekDaily}
                prediction={predictionByCode.get(room.space_code) ?? null}
                open={open}
                close={close}
                nowMinutes={nowMinutes}
                now={now}
                viewDate={chartDate}
                isOpenToday={isOpenToday}
              />
            ))}
          </section>
        )}
        {inactiveRooms.length > 0 && (
          <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {inactiveRooms.map((room) => (
              <MmcaRoomInactiveCard
                key={room.space_code}
                room={room}
                reason={inactiveReason(room)}
              />
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
