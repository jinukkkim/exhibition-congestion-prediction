import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { shiftDate, todayString } from "../lib/date";
import { fetchDailyRaw, type RawLogPoint } from "../api/congestion";
import { statusOf } from "../lib/status";
import { SEOUL_FIELD_NOTES } from "../lib/seoulFieldNotes";
import { STICKY_TIME_CELL } from "../lib/stickyTimeColumn";

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

// aria-describedby 가 가리킬 id. 설명을 머리글 안에 숨긴 글로 넣으면 열의
// 접근성 이름에 섞여 들어가므로("TEMP 기온 (℃)."), 표 밖에 따로 두고 잇는다.
function noteId(key: string): string {
  return `seoul-field-note-${key}`;
}

// 혼잡도만 색을 입힌다. 나머지는 수치라 색으로 구분할 것이 없다.
const LEVEL_KEY = "AREA_CONGEST_LVL";

interface Tip {
  note: string;
  bottom: number;
  left?: number;
  right?: number;
}

// 표가 overflow-auto 안에 있어 그 안에 그린 툴팁은 오른쪽 열에서 잘린다.
// position: fixed 로 컨테이너 밖에 띄우고 ⓘ 의 화면 좌표에 맞춘다. 마우스를
// 따라가지 않고 ⓘ 에 붙이는 이유는 흔들리지 않기 때문이다.
//
// top/left 대신 bottom 과, 화면 오른쪽 절반이면 right 로 잡는다. 그러면 툴팁의
// 실제 크기를 몰라도 ⓘ 바로 위에 붙고 화면 밖으로도 안 나간다 — 왼쪽 정렬만
// 하고 밀려나지 않게 당기면 넓게 잡은 최대 너비만큼 ⓘ 에서 멀어진다.
function tipPosition(icon: DOMRect): Omit<Tip, "note"> {
  const bottom = window.innerHeight - icon.top + 8;
  return icon.left > window.innerWidth / 2
    ? { bottom, right: Math.max(8, window.innerWidth - icon.right - 12) }
    : { bottom, left: Math.max(8, icon.left - 12) };
}

function cellValue(value: string | number | null | undefined): string {
  // 0 은 값이다 — falsy 로 묶어 비우면 안 된다.
  return value === null || value === undefined ? "" : String(value);
}

export function DailyLogTable() {
  const [selectedDate, setSelectedDate] = useState(todayString());
  const [rows, setRows] = useState<RawLogPoint[] | null>(null);
  // 올려둔 열의 설명과 그것을 띄울 자리. 네이티브 title 툴팁은 포인터가 완전히
  // 멈춰 있어야 뜨고 리렌더·창 포커스 변화에 취소되므로 직접 그린다. title 은
  // 남겨둔다 — 스크린리더가 읽는 열 설명이다.
  const [tip, setTip] = useState<Tip | null>(null);
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
  // 하루치가 288행 × 44열이라 본문만 12,000 셀이 넘는다. 머리글에 마우스를
  // 올릴 때마다 그걸 통째로 다시 그리지 않도록 행·열과 본문을 memo 로 묶는다
  // (툴팁 상태만 바뀌면 머리글과 툴팁만 다시 그려진다).
  const displayRows = useMemo(() => (rows ? [...rows].reverse() : rows), [rows]);
  const columns = useMemo(() => (rows ? columnsOf(rows) : []), [rows]);

  const tableBody = useMemo(
    () => (
      <tbody>
        {displayRows?.map((row) => (
          <tr key={row.observed_at} className="transition-colors hover:bg-ink/[0.03]">
            <td className={`${STICKY_TIME_CELL} z-10 border-b border-hairline/40 px-4 py-2.5 font-mono tabular-nums text-ink`}>
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
    ),
    [displayRows, columns]
  );

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
        <>
          <div data-testid="log-scroll" className="max-h-[28rem] overflow-auto">
            <table className="w-full border-collapse text-left text-[13px]">
              <thead className="sticky top-0 z-20 bg-white/85 backdrop-blur-xl">
                <tr>
                  <th className={`${STICKY_TIME_CELL} z-30 border-b border-hairline/60 px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-ink-soft`}>
                    시각
                  </th>
                  {columns.map((key) => {
                    const note = SEOUL_FIELD_NOTES[key];
                    return (
                      <th
                        key={key}
                        // 네이티브 title 은 쓰지 않는다 — 우리 툴팁이 뜬 뒤
                        // 몇 초 지나면 OS 가 같은 내용을 회색 상자로 하나 더
                        // 띄운다. 스크린리더용 설명은 아래 sr-only 목록을
                        // 가리켜 잇는다.
                        aria-describedby={note ? noteId(key) : undefined}
                        className="whitespace-nowrap border-b border-hairline/60 px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-ink-soft"
                      >
                        {key}
                        {note && (
                          <span
                            aria-hidden
                            data-testid="column-note"
                            // 9px 글자를 정확히 겨냥하기는 어려우므로 글자보다
                            // 넓은 판을 두고, 그 여백만큼 -m 으로 되돌려 열
                            // 너비는 그대로 둔다.
                            onMouseEnter={(event) =>
                              setTip({
                                note,
                                ...tipPosition(event.currentTarget.getBoundingClientRect()),
                              })
                            }
                            onMouseLeave={() => setTip(null)}
                            className="-my-1 ml-0.5 inline-block cursor-help px-1 py-1 align-super text-[9px] text-ink-soft/60"
                          >
                            ⓘ
                          </span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              {tableBody}
            </table>
          </div>
        </>
      )}

      <div className="sr-only">
        {columns.map((key) =>
          SEOUL_FIELD_NOTES[key] ? (
            <span key={key} id={noteId(key)}>
              {SEOUL_FIELD_NOTES[key]}
            </span>
          ) : null
        )}
      </div>

      {/* body 로 빼서 그린다 — 카드의 backdrop-blur 가 position: fixed 의 기준
          컨테이너가 되어버려 좌표가 카드 기준으로 어긋나고, 카드의
          overflow-hidden 에 잘리기까지 한다. */}
      {tip &&
        createPortal(
          <div
            role="tooltip"
            className="pointer-events-none fixed z-50 max-w-[20rem] rounded-2xl border border-hairline/60 bg-white px-3.5 py-2.5 text-xs leading-relaxed text-ink shadow-apple"
            style={{ left: tip.left, right: tip.right, bottom: tip.bottom }}
          >
            {tip.note}
          </div>,
          document.body
        )}
    </div>
  );
}
