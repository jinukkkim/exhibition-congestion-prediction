import { useState } from "react";
import { Link } from "react-router-dom";

import {
  fetchMmcaDaily,
  fetchMmcaRooms,
  type MmcaDailyLogPoint,
  type MmcaRoomStatus,
  type MmcaVenue,
} from "../api/mmca";
import { DateTabs } from "../components/DateTabs";
import { MmcaRoomChartCard } from "../components/MmcaRoomChartCard";
import { MmcaRoomInactiveCard } from "../components/MmcaRoomInactiveCard";
import { usePolledFetch } from "../hooks/usePolledFetch";
import { shiftDate, todayString, upcomingDates } from "../lib/date";
import { mmcaBusinessHours } from "../lib/mmcaBusinessHours";
import { DISABLED_MMCA_SPACE_CODES } from "../lib/mmcaDisabledRooms";

const POLL_INTERVAL_MS = 60_000;
const COLLECTION_START_DELAY_MINUTES = 10;

export function MmcaPage({ venue, title }: { venue: MmcaVenue; title: string }) {
  const today = todayString();
  const [selectedDate, setSelectedDate] = useState(today);

  // MMCA 는 예측 모델이 없다(등급만 수집하고 인원수가 없어 회귀의 목표변수가
  // 없다). 그래서 미래 탭에서는 지난주 같은 요일의 실제 기록을 대리로 그린다.
  // 오늘 탭은 지금까지처럼 오늘 실선 + 지난주 회색선.
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

  const rooms = roomsPoll.data;
  const error = roomsPoll.error;
  const daily = dailyPoll.data;
  // 미래 탭에서는 대리값 하나만 보여준다 — D-14 까지 겹치면 무엇이 기준인지
  // 흐려진다.
  const lastWeekDaily = isTodayTab ? lastWeekPoll.data : null;
  // 오늘/지난주 로그는 전시실 전체가 공유하는 fetch 한 건이다. 실패하면 방
  // 카드가 빈 차트만 그린 채 조용히 남으므로 안내가 필요하지만, 실패는 관
  // 단위로 한 번 일어난 일이라 카드마다 반복하지 않고 그리드 위에 한 줄 둔다.
  const trendError = dailyPoll.error || (isTodayTab && lastWeekPoll.error);

  const now = new Date();
  // 축은 그리는 날짜의 영업시간을 쓴다 — 수·토는 21:00 폐관이라 요일에 따라
  // 축의 오른쪽 끝이 달라진다. (D 와 D-7 은 같은 요일이라 결과는 같지만,
  // 그리는 날짜를 기준으로 두는 편이 읽기에 분명하다.)
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
            ← 미술관 선택
          </Link>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            {title}
          </h1>
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
