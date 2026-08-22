import { useEffect, useState } from "react";

import { shiftDate, todayString } from "../lib/date";
import { fetchDailyRaw, type RawLogPoint } from "../api/congestion";
import { statusOf } from "../lib/status";

const EARLIEST_DATE = "2026-07-15"; // first day the collector started storing readings

// 컬럼을 여기 나열하지 않는다 — 응답에 실제로 들어 있는 필드 이름이 그대로
// 헤더가 되므로, 서울시가 필드를 늘리면 코드를 안 고쳐도 표에 나타난다.
// 헤더도 한글 라벨로 바꾸지 않고 API 키 이름을 그대로 쓴다: 라벨 맵을 두면
// 새 필드마다 손봐야 하고, 원본 데이터 화면에서는 API 문서와 같은 이름이 맞다.
function columnsOf(rows: RawLogPoint[]): string[] {
  // ?? {} : fields 없는 행은 API 계약 위반이지만, Object.keys(undefined) 가
  // 페이지를 통째로 하얗게 만드는 것보다 그 행이 비는 편이 낫다.
  return [...new Set(rows.flatMap((row) => Object.keys(row.fields ?? {})))];
}

// 혼잡도만 색을 입힌다. 나머지는 수치라 색으로 구분할 것이 없다.
const LEVEL_KEY = "AREA_CONGEST_LVL";

function cellValue(value: string | number | null | undefined): string {
  // 0 은 값이다 — falsy 로 묶어 비우면 안 된다.
  return value === null || value === undefined ? "" : String(value);
}

export function DailyLogTable() {
  const [selectedDate, setSelectedDate] = useState(todayString());
  const [rows, setRows] = useState<RawLogPoint[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let ignore = false;
    setRows(null);
    setError(false);
    fetchDailyRaw(selectedDate)
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
  const columns = rows ? columnsOf(rows) : [];

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
      {/* ponytail: 하루 288행 × 필드 수(현재 40 안팎)를 전부 DOM 에 그린다.
          지금은 견디지만 필드가 더 늘거나 여러 날을 한 번에 보게 되면
          가상 스크롤로 올려야 한다. 지하철·버스 승하차처럼 행마다 배열인
          값도 여기 컬럼으로는 못 담는다 — 행 펼치기로 붙일 자리. */}
      {!error && displayRows && displayRows.length > 0 && (
        <div className="max-h-[28rem] overflow-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead className="sticky top-0 z-10 bg-white/85 backdrop-blur-xl">
              <tr>
                <th className="whitespace-nowrap border-b border-hairline/60 px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
                  시각
                </th>
                {columns.map((key) => (
                  <th
                    key={key}
                    className="whitespace-nowrap border-b border-hairline/60 px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-ink-soft"
                  >
                    {key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row) => (
                <tr key={row.observed_at} className="transition-colors hover:bg-ink/[0.03]">
                  <td className="whitespace-nowrap border-b border-hairline/40 px-4 py-2.5 font-mono tabular-nums text-ink">
                    {row.observed_at.slice(11, 16)}
                  </td>
                  {columns.map((key) => (
                    <td
                      key={key}
                      className="whitespace-nowrap border-b border-hairline/40 px-4 py-2.5 font-mono tabular-nums text-ink"
                      style={
                        key === LEVEL_KEY
                          ? {
                              color: statusOf(cellValue(row.fields[key])).text,
                              fontWeight: 600,
                            }
                          : undefined
                      }
                    >
                      {cellValue(row.fields[key])}
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
