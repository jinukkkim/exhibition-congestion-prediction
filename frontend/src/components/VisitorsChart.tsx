import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";

import { CHART_BLUE } from "../lib/chartColors";
import { axisLabel, longLabel, type Point } from "../lib/visitorStats";

export type Metric = "visitors" | "views";

export const METRIC_LABEL: Record<Metric, string> = {
  visitors: "방문자",
  views: "페이지뷰",
};

// 가로축 라벨 최대 개수. 일정한 간격으로 건너뛴다 — 7일은 매일, 30일은 5일마다.
const X_TICKS = 8;

// 축 눈금은 1·2·5 x 10^k 단위로 — 3.7 같은 눈금은 읽는 사람이 다시 계산하게 만든다.
function niceStep(raw: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 5, 10].find((m) => m * magnitude >= raw) ?? 10) * magnitude;
}

// 한 줄짜리 영역 차트. 이 repo 에는 차트 라이브러리가 없고 다른 화면도 SVG 를
// 직접 그린다. 선과 면은 늘어나는 viewBox 안에, 글자는 HTML 로 바깥에 둬서
// 폭이 바뀌어도 글자가 찌그러지지 않는다.
export function VisitorsChart({ points, metric }: { points: Point[]; metric: Metric }) {
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);

  const values = points.map((point) => point[metric]);
  const step = niceStep(Math.max(4, ...values) / 4);
  const top = step * Math.ceil(Math.max(1, ...values) / step);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);

  const x = (i: number) => (points.length > 1 ? (i / (points.length - 1)) * 100 : 50);
  const y = (value: number) => 100 - (value / top) * 100;
  const line = values.map((value, i) => `${i ? "L" : "M"}${x(i)},${y(value)}`).join("");
  const area = `${line}L${x(values.length - 1)},100L${x(0)},100Z`;

  const every = Math.max(1, Math.ceil((points.length - 1) / (X_TICKS - 1)));
  const xTicks = points.map((_, i) => i).filter((i) => i % every === 0);

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    setHover(Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1)))));
  }

  // 마우스가 없어도 같은 값을 읽을 수 있게 — 좌우 화살표로 칸을 옮긴다.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const delta = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!delta) return;
    event.preventDefault();
    setHover((current) =>
      Math.min(points.length - 1, Math.max(0, (current ?? points.length - 1) + delta))
    );
  }

  const hovered = hover === null ? null : points[hover];

  return (
    <div className="flex gap-3">
      <div aria-hidden className="relative h-[240px] w-8 shrink-0">
        {ticks.map((tick) => (
          <span
            key={tick}
            className="absolute right-0 -translate-y-1/2 font-mono text-[11px] tabular-nums text-neutral-400"
            style={{ top: `${y(tick)}%` }}
          >
            {tick.toLocaleString()}
          </span>
        ))}
      </div>

      <div className="min-w-0 flex-1">
        <div
          role="group"
          tabIndex={0}
          aria-label={`${METRIC_LABEL[metric]} 추이. 좌우 화살표로 날짜별 값을 읽습니다.`}
          className="relative h-[240px] cursor-crosshair rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-neutral-400"
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKeyDown}
          onBlur={() => setHover(null)}
        >
          {ticks.map((tick) => (
            <div
              key={tick}
              aria-hidden
              className={`absolute inset-x-0 border-t ${
                tick ? "border-dashed border-neutral-200" : "border-neutral-300"
              }`}
              style={{ top: `${y(tick)}%` }}
            />
          ))}

          <svg
            aria-hidden
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full overflow-visible"
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_BLUE} stopOpacity={0.18} />
                <stop offset="100%" stopColor={CHART_BLUE} stopOpacity={0} />
              </linearGradient>
            </defs>
            <path d={area} fill={`url(#${gradientId})`} />
            <path
              d={line}
              fill="none"
              stroke={CHART_BLUE}
              strokeWidth={2}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {hovered && hover !== null && (
            <>
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 w-px bg-neutral-300"
                style={{ left: `${x(hover)}%` }}
              />
              <div
                aria-hidden
                className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
                style={{
                  left: `${x(hover)}%`,
                  top: `${y(hovered[metric])}%`,
                  backgroundColor: CHART_BLUE,
                }}
              />
              <div
                role="status"
                className={`pointer-events-none absolute top-2 z-10 min-w-[140px] rounded-lg border border-neutral-200 bg-white px-3 py-2 shadow-md ${
                  x(hover) > 60 ? "-translate-x-[calc(100%+12px)]" : "translate-x-3"
                }`}
                style={{ left: `${x(hover)}%` }}
              >
                <div className="text-[11px] text-neutral-500">{longLabel(hovered.key)}</div>
                <div className="mt-1 flex items-center gap-2 text-[13px]">
                  <span aria-hidden className="h-0.5 w-3 rounded" style={{ backgroundColor: CHART_BLUE }} />
                  <span className="font-semibold tabular-nums text-neutral-900">
                    {hovered[metric].toLocaleString()}
                  </span>
                  <span className="text-neutral-500">{METRIC_LABEL[metric]}</span>
                </div>
              </div>
            </>
          )}
        </div>

        <div aria-hidden className="relative mt-2 h-4">
          {xTicks.map((i) => (
            <span
              key={points[i].key}
              className={`absolute whitespace-nowrap font-mono text-[11px] tabular-nums text-neutral-400 ${
                i === 0 ? "" : i === points.length - 1 ? "-translate-x-full" : "-translate-x-1/2"
              }`}
              style={{ left: `${x(i)}%` }}
            >
              {axisLabel(points[i].key)}
            </span>
          ))}
        </div>

        {/* 스크린리더용 표. 툴팁은 값을 읽는 지름길일 뿐 유일한 길이 아니다. */}
        <table className="sr-only">
          <caption>{METRIC_LABEL[metric]} 추이</caption>
          <tbody>
            {points.map((point) => (
              <tr key={point.key}>
                <th scope="row">{longLabel(point.key)}</th>
                <td>{point[metric]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
