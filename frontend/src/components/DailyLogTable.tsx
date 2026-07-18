import { useEffect, useState } from "react";

import { fetchDaily, type DailyLogPoint } from "../api/congestion";
import { statusOf } from "../lib/status";

const EARLIEST_DATE = "2026-07-15"; // first day the collector started storing readings

type ColumnKey = keyof DailyLogPoint;

const COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: "observed_at", label: "시각" },
  { key: "congest_level", label: "혼잡도" },
  { key: "population_min", label: "최소 인구" },
  { key: "population_max", label: "최대 인구" },
  { key: "male_ppltn_rate", label: "남성 비율" },
  { key: "female_ppltn_rate", label: "여성 비율" },
  { key: "ppltn_rate_0", label: "10대 미만" },
  { key: "ppltn_rate_10", label: "10대" },
  { key: "ppltn_rate_20", label: "20대" },
  { key: "ppltn_rate_30", label: "30대" },
  { key: "ppltn_rate_40", label: "40대" },
  { key: "ppltn_rate_50", label: "50대" },
  { key: "ppltn_rate_60", label: "60대" },
  { key: "ppltn_rate_70", label: "70대 이상" },
  { key: "resnt_ppltn_rate", label: "상주인구" },
  { key: "non_resnt_ppltn_rate", label: "비상주인구" },
];

function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function todayString(): string {
  return formatDate(new Date());
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

function cellValue(row: DailyLogPoint, key: ColumnKey): string {
  if (key === "observed_at") return row.observed_at.slice(11, 16);
  const value = row[key];
  return value === null || value === undefined ? "" : String(value);
}

export function DailyLogTable() {
  const [selectedDate, setSelectedDate] = useState(todayString());
  const [rows, setRows] = useState<DailyLogPoint[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let ignore = false;
    setRows(null);
    setError(false);
    fetchDaily(selectedDate)
      .then((data) => {
        if (!ignore) setRows(data);
      })
      .catch(() => {
        if (!ignore) setError(true);
      });
    return () => {
      ignore = true;
    };
  }, [selectedDate]);

  const isToday = selectedDate === todayString();
  const isEarliest = selectedDate <= EARLIEST_DATE;
  const displayRows = rows ? [...rows].reverse() : rows;

  return (
    <div className="overflow-hidden rounded-apple border border-hairline/60 bg-white/70 shadow-apple backdrop-blur-xl motion-safe:animate-rise-in">
      <div className="flex items-center justify-between border-b border-hairline/60 px-8 py-6">
        <button
          className="rounded-full px-3 py-1.5 text-sm font-medium text-ink-soft transition hover:bg-ink/5 hover:text-ink disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          disabled={isEarliest}
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
        <div className="max-h-[28rem] overflow-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead className="sticky top-0 z-10 bg-white/85 backdrop-blur-xl">
              <tr>
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    className="whitespace-nowrap border-b border-hairline/60 px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-ink-soft"
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row) => (
                <tr key={row.observed_at} className="transition-colors hover:bg-ink/[0.03]">
                  {COLUMNS.map((col) => (
                    <td
                      key={col.key}
                      className="whitespace-nowrap border-b border-hairline/40 px-4 py-2.5 font-mono tabular-nums text-ink"
                      style={
                        col.key === "congest_level"
                          ? { color: statusOf(row.congest_level).text, fontWeight: 600 }
                          : undefined
                      }
                    >
                      {cellValue(row, col.key)}
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
