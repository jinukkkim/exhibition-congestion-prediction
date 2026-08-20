import { Link } from "react-router-dom";

import {
  fetchMmcaDaily,
  fetchMmcaRooms,
  type MmcaDailyLogPoint,
  type MmcaRoomStatus,
  type MmcaVenue,
} from "../api/mmca";
import { MmcaDailyLogTable } from "../components/MmcaDailyLogTable";
import { MmcaRoomChartCard } from "../components/MmcaRoomChartCard";
import { MmcaRoomInactiveCard } from "../components/MmcaRoomInactiveCard";
import { usePolledFetch } from "../hooks/usePolledFetch";
import { shiftDate, todayString } from "../lib/date";
import { mmcaBusinessHours } from "../lib/mmcaBusinessHours";
import { DISABLED_MMCA_SPACE_CODES } from "../lib/mmcaDisabledRooms";

const POLL_INTERVAL_MS = 60_000;
const COLLECTION_START_DELAY_MINUTES = 10;

export function MmcaPage({ venue, title }: { venue: MmcaVenue; title: string }) {
  const today = todayString();
  const lastWeek = shiftDate(today, -7);

  // 계속 폴링: 6분 주기 수집이 새 판독을 쌓는 값.
  const roomsPoll = usePolledFetch(() => fetchMmcaRooms(venue), { intervalMs: POLL_INTERVAL_MS }, [
    venue,
  ]);
  const dailyPoll = usePolledFetch(
    () => fetchMmcaDaily(venue, today),
    { intervalMs: POLL_INTERVAL_MS },
    [venue, today]
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
  const lastWeekDaily = lastWeekPoll.data;

  const now = new Date();
  const { open, close, isOpenToday } = mmcaBusinessHours(venue, now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  // A room only earns a full-size chart card if it has a curve worth showing.
  // Until today's first reading exists, last week's same-weekday curve is the
  // deciding signal; from then on (including after close) it's today's data.
  // The collector's first poll of the day lands 10 minutes after the opening
  // time we display (backend/app/collector.py's `_COLLECTION_START`), so
  // that window — plus all day on a closed day — goes by last week too.
  // `<=` not `<`: the poll itself takes a few seconds, and this page only
  // re-renders once a minute.
  const beforeFirstPoll = !isOpenToday || nowMinutes <= open + COLLECTION_START_DELAY_MINUTES;

  // `null` means the fetch hasn't landed yet: don't shrink a card on the
  // strength of data we haven't received.
  const loadedWithNoReading = (rows: MmcaDailyLogPoint[] | null, code: string) =>
    rows !== null && !rows.some((row) => row.rooms.find((r) => r.space_code === code)?.congestion_nm != null);

  const isRoomInactiveToday = (room: MmcaRoomStatus) =>
    DISABLED_MMCA_SPACE_CODES.has(room.space_code) ||
    (beforeFirstPoll
      ? loadedWithNoReading(lastWeekDaily, room.space_code)
      : room.congestion_nm == null && loadedWithNoReading(daily, room.space_code));

  const inactiveReason = (room: MmcaRoomStatus) =>
    DISABLED_MMCA_SPACE_CODES.has(room.space_code)
      ? "서비스 예정"
      : isOpenToday
        ? "오늘 정보 없음"
        : "휴관일";

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

        <section className="mt-6">
          <MmcaDailyLogTable venue={venue} />
        </section>
      </main>
    </div>
  );
}
