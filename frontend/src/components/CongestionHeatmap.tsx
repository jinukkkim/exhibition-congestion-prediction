import type { CSSProperties } from "react";

import { WEEKDAY_NAMES } from "../lib/quietHours";

export interface HeatmapCell {
  weekday: number;
  hour: number;
}

/** 한 칸이 어떻게 보일지. 값의 정체는 관마다 달라서 호출부가 정한다. */
export interface HeatmapCellView {
  label: string;
  style: CSSProperties;
}

/**
 * 요일 × 시각 격자.
 *
 * `<table>` 그대로다 — 요일이 행 머리, 시각이 열 머리라 스크린리더가 칸마다
 * "금요일 14시"를 읽고 ARIA 를 얹을 것이 없다. 같은 이유로 hover 툴팁도 두지
 * 않는다: 값은 이미 칸에 적혀 있다.
 *
 * 값을 무엇으로 적고 어떻게 칠할지는 `renderCell` 이 정한다. 국립중앙박물관은
 * 생활인구(명)를 한 색의 농도로, MMCA 는 평균 등급을 등급 색으로 칠한다 —
 * 격자의 모양만 같고 값의 정체가 다르기 때문이다.
 */
export function CongestionHeatmap<T extends HeatmapCell>({
  cells,
  caption,
  minWidthClass,
  renderCell,
}: {
  cells: T[];
  caption: string;
  minWidthClass: string;
  renderCell: (cell: T) => HeatmapCellView;
}) {
  // 요일마다 열리는 시각이 다르다(야간개장, 관별 폐관 시각). 열은 실제로 값이
  // 있는 시각만 세워야 빈 열이 생기지 않는다.
  const hours = [...new Set(cells.map((cell) => cell.hour))].sort((a, b) => a - b);
  const byCell = new Map(cells.map((cell) => [`${cell.weekday}-${cell.hour}`, cell]));

  return (
    // 좁은 화면에서는 표가 가로로 넘친다 — 본문을 밀어내는 대신 표만 스스로
    // 스크롤한다. min-w 가 없으면 표가 화면에 맞춰 줄어들 뿐 스크롤되지 않는다
    // (w-full 이 이미 100% 라 넘칠 것이 없다).
    <div className="overflow-x-auto">
      <table
        // table-fixed: 열 너비가 내용이 아니라 표 폭으로 정해진다. 없으면 방마다
        // 가장 긴 등급 이름이 달라("붐빔" 대 "약간 붐빔") 세로로 쌓인 격자들의
        // 열이 서로 어긋나고, 한 세트로 읽히지 않는다.
        className={`w-full table-fixed ${minWidthClass} border-separate border-spacing-0.5 text-center`}
      >
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th className="w-10" />
            {hours.map((hour) => (
              <th
                key={hour}
                scope="col"
                className="pb-1 text-xs font-normal tabular-nums text-ink-soft"
              >
                {hour}시
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {WEEKDAY_NAMES.map((name, weekday) => (
            <tr key={name}>
              <th scope="row" className="pr-2 text-sm font-normal text-ink-soft">
                {name}
              </th>
              {hours.map((hour) => {
                const cell = byCell.get(`${weekday}-${hour}`);
                if (cell === undefined) {
                  // 그 요일 그 시각에는 문을 열지 않는다. 빈 칸이 곧 야간개장이
                  // 수·토뿐이라는 말이고, 과천관에서는 월요일 행이 통째로 빈다.
                  return <td key={hour} className="h-9" />;
                }
                const view = renderCell(cell);
                return (
                  <td
                    key={hour}
                    className="h-9 rounded text-xs tabular-nums"
                    style={view.style}
                  >
                    {view.label}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
