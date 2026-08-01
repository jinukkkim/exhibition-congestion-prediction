import { useEffect, useState } from "react";
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
import { shiftDate, todayString } from "../lib/date";
import { mmcaBusinessHours } from "../lib/mmcaBusinessHours";
import { DISABLED_MMCA_SPACE_CODES } from "../lib/mmcaDisabledRooms";

const POLL_INTERVAL_MS = 60_000;

export function MmcaPage({ venue, title }: { venue: MmcaVenue; title: string }) {
  const [rooms, setRooms] = useState<MmcaRoomStatus[] | null>(null);
  const [daily, setDaily] = useState<MmcaDailyLogPoint[] | null>(null);
  const [lastWeekDaily, setLastWeekDaily] = useState<MmcaDailyLogPoint[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let ignore = false;

    function load() {
      fetchMmcaRooms(venue)
        .then((data) => {
          if (ignore) return;
          setRooms(data);
          setError(false);
        })
        .catch(() => {
          if (!ignore) setError(true);
        });
    }

    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      ignore = true;
      clearInterval(timer);
    };
  }, [venue]);

  useEffect(() => {
    let ignore = false;

    function load() {
      fetchMmcaDaily(venue, todayString())
        .then((data) => {
          if (!ignore) setDaily(data);
        })
        .catch(() => {
          // Silently retry — keep showing whatever we already have rather
          // than blanking every card on one failed poll.
        });
    }

    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      ignore = true;
      clearInterval(timer);
    };
  }, [venue]);

  useEffect(() => {
    let ignore = false;

    fetchMmcaDaily(venue, shiftDate(todayString(), -7))
      .then((data) => {
        if (!ignore) setLastWeekDaily(data);
      })
      .catch(() => {
        if (!ignore) setLastWeekDaily(null);
      });

    return () => {
      ignore = true;
    };
  }, [venue]);

  const now = new Date();
  const { open, close, isOpenToday } = mmcaBusinessHours(venue, now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  // Mirrors MmcaRoomChartCard's own isOpen formula — needed here too since
  // partitioning happens a level above that component.
  const isOpen = isOpenToday && nowMinutes >= open && nowMinutes <= close;

  const hasReadingToday = (code: string) =>
    daily?.some((row) => row.rooms.find((r) => r.space_code === code)?.congestion_nm != null) ?? false;

  const isRoomInactiveToday = (room: MmcaRoomStatus) =>
    DISABLED_MMCA_SPACE_CODES.has(room.space_code) ||
    (isOpen && room.congestion_nm == null && (daily?.length ?? 0) > 0 && !hasReadingToday(room.space_code));

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
                reason={DISABLED_MMCA_SPACE_CODES.has(room.space_code) ? "서비스 예정" : "오늘 정보 없음"}
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
