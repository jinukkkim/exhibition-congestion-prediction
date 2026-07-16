import { useEffect, useState } from "react";

import { fetchDaily, type DailyLogPoint } from "../api/congestion";

const STATUS_COLOR: Record<string, string> = {
  여유: "#0ca30c",
  보통: "#fab219",
  약간붐빔: "#ec835a",
  붐빔: "#d03b3b",
};
const FALLBACK_COLOR = "#94a3b8";

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

function todayString(): string {
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
    setRows(null);
    setError(false);
    fetchDaily(selectedDate)
      .then(setRows)
      .catch(() => setError(true));
  }, [selectedDate]);

  const isToday = selectedDate === todayString();

  return (
    <div className="rounded-lg border p-8">
      <div className="mb-4 flex items-center justify-between">
        <button
          className="text-sm text-gray-500"
          onClick={() => setSelectedDate((d) => shiftDate(d, -1))}
        >
          ← 이전 날짜
        </button>
        <span className="text-sm font-semibold">{selectedDate}</span>
        <button
          className="text-sm text-gray-500 disabled:opacity-30"
          disabled={isToday}
          onClick={() => setSelectedDate((d) => shiftDate(d, 1))}
        >
          다음 날짜 →
        </button>
      </div>

      {error && <p className="text-sm text-gray-500">불러오지 못했습니다.</p>}
      {!error && rows && rows.length === 0 && (
        <p className="text-sm text-gray-500">데이터 없음</p>
      )}
      {!error && rows && rows.length > 0 && (
        <div className="max-h-96 overflow-x-auto overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                {COLUMNS.map((col) => (
                  <th key={col.key} className="whitespace-nowrap px-2 py-1 text-gray-500">
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.observed_at}>
                  {COLUMNS.map((col) => (
                    <td
                      key={col.key}
                      className="whitespace-nowrap px-2 py-1"
                      style={
                        col.key === "congest_level"
                          ? { color: STATUS_COLOR[row.congest_level] ?? FALLBACK_COLOR }
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
