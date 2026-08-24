import { useEffect, useState } from "react";

import { fetchMmcaDaily, type MmcaDailyLogPoint, type MmcaVenue } from "../api/mmca";
import { shiftDate, todayString } from "../lib/date";
import { statusOf } from "../lib/status";
import { STICKY_TIME_CELL } from "../lib/stickyTimeColumn";

export function MmcaDailyLogTable({ venue }: { venue: MmcaVenue }) {
  const [selectedDate, setSelectedDate] = useState(todayString());
  const [rows, setRows] = useState<MmcaDailyLogPoint[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let ignore = false;
    setRows(null);
    setError(false);
    fetchMmcaDaily(venue, selectedDate)
      .then((data) => {
        if (!ignore) setRows(data);
      })
      .catch(() => {
        if (!ignore) setError(true);
      });
    return () => {
      ignore = true;
    };
  }, [venue, selectedDate]);

  const isToday = selectedDate === todayString();
  const displayRows = rows ? [...rows].reverse() : rows;
  const columns = rows && rows.length > 0 ? rows[0].rooms : [];

  return (
    <div className="overflow-hidden rounded-apple border border-hairline/60 bg-white/70 shadow-apple backdrop-blur-xl motion-safe:animate-rise-in">
      <div className="flex items-center justify-between border-b border-hairline/60 px-8 py-6">
        <button
          className="rounded-full px-3 py-1.5 text-sm font-medium text-ink-soft transition hover:bg-ink/5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          onClick={() => setSelectedDate((d) => shiftDate(d, -1))}
        >
          ← 이전 날짜
        </button>
        <span className="font-mono text-sm font-semibold tabular-nums text-ink">{selectedDate}</span>
        <button
          className="rounded-full px-3 py-1.5 text-sm font-medium text-ink-soft transition hover:bg-ink/5 hover:text-ink disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          disabled={isToday}
          onClick={() => setSelectedDate((d) => shiftDate(d, 1))}
        >
          다음 날짜 →
        </button>
      </div>

      {error && <p className="px-8 py-12 text-center text-sm text-ink-soft">불러오지 못했습니다.</p>}
      {!error && rows && rows.length === 0 && (
        <p className="px-8 py-12 text-center text-sm text-ink-soft">데이터 없음</p>
      )}
      {!error && displayRows && displayRows.length > 0 && (
        <div data-testid="log-scroll" className="max-h-[28rem] overflow-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead className="sticky top-0 z-20 bg-white/85 backdrop-blur-xl">
              <tr>
                <th className={`${STICKY_TIME_CELL} z-30 border-b border-hairline/60 px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-ink-soft`}>
                  시각
                </th>
                {columns.map((room) => (
                  <th
                    key={room.space_code}
                    className="whitespace-nowrap border-b border-hairline/60 px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-ink-soft"
                  >
                    {room.space_nm ?? room.space_code}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row) => (
                <tr key={row.observed_at} className="transition-colors hover:bg-ink/[0.03]">
                  <td className={`${STICKY_TIME_CELL} z-10 border-b border-hairline/40 px-4 py-2.5 font-mono tabular-nums text-ink`}>
                    {row.observed_at.slice(11, 16)}
                  </td>
                  {row.rooms.map((room) => (
                    <td
                      key={room.space_code}
                      className="whitespace-nowrap border-b border-hairline/40 px-4 py-2.5 font-mono tabular-nums text-ink"
                      style={{ color: statusOf(room.congestion_nm ?? "").text, fontWeight: 600 }}
                    >
                      {room.congestion_nm ?? "-"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
