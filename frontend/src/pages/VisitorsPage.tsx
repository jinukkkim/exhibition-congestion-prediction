import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { fetchVisits, type Pageview, type RecentVisit, type UtmKey } from "../api/analytics";
import { METRIC_LABEL, VisitorsChart, type Metric } from "../components/VisitorsChart";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { usePolledFetch } from "../hooks/usePolledFetch";
import {
  applyFilters,
  breakdown,
  change,
  countVisitors,
  DIMENSIONS,
  series,
  type Dimension,
  type Filters,
} from "../lib/visitorStats";

// 개발자용 화면이라 홈이나 어디에서도 링크하지 않는다 — 주소를 아는 사람만
// 연다. 실리는 것은 해시한 방문자 이름과 집계뿐이라 그 이상의 잠금은 두지 않았다.
//
// 모양은 Vercel Web Analytics 를 따른다. 다만 비콘 없이 Caddy 로그만 읽으므로
// 이탈률·국가·앱 안 페이지 이동은 없다 — 페이지는 첫 진입 페이지다.

const RANGES: { days: number; label: string }[] = [
  { days: 1, label: "최근 24시간" },
  { days: 7, label: "최근 7일" },
  { days: 30, label: "최근 30일" },
  { days: 90, label: "최근 90일" },
];
const DEFAULT_DAYS = 7;

// 백엔드가 10분 캐시로 답하므로 그보다 자주 물어도 같은 값이다. 한 번 받으면
// 멈추고, 실패했을 때만 다음 tick 이 회복한다.
const POLL_INTERVAL_MS = 600_000;

// 패널마다 처음 보이는 줄 수. 나머지는 "모두 보기" 뒤에 있다.
const PANEL_ROWS = 8;

// 최근 방문은 최대 200줄이 온다. 처음엔 이만큼만 펼친다.
const RECENT_ROWS = 20;

const UTM_KEYS: UtmKey[] = ["source", "medium", "campaign", "content", "term"];

const DIMENSION_LABEL: Record<Dimension, string> = {
  page: "페이지",
  route: "라우트",
  referrer: "유입 경로",
  utm_source: "utm_source",
  utm_medium: "utm_medium",
  utm_campaign: "utm_campaign",
  utm_content: "utm_content",
  utm_term: "utm_term",
  device: "기기",
  browser: "브라우저",
  os: "OS",
};

const DEVICE_LABEL: Record<string, string> = {
  mobile: "모바일",
  tablet: "태블릿",
  desktop: "데스크톱",
};

function displayValue(dimension: Dimension, value: string): string {
  return dimension === "device" ? DEVICE_LABEL[value] ?? value : value;
}

const KIND_LABEL: Record<RecentVisit["kind"], string> = {
  human: "사람",
  unconfirmed: "미확인",
  bot: "봇",
};

function Delta({ value }: { value: number | null }) {
  if (value === null) return null;
  const up = value >= 0;
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${
        up ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
      }`}
    >
      {up ? "↑" : "↓"} {Math.abs(value)}%
    </span>
  );
}

function MetricTab({
  metric,
  value,
  delta,
  selected,
  onSelect,
}: {
  metric: Metric;
  value: number | null;
  delta: number | null;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`-mb-px border-b-2 px-6 py-5 text-left transition focus-visible:bg-neutral-50 focus-visible:outline-none ${
        selected ? "border-neutral-900" : "border-transparent hover:bg-neutral-50"
      }`}
    >
      <div className="text-[13px] font-medium text-neutral-500">{METRIC_LABEL[metric]}</div>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-3xl font-semibold tabular-nums tracking-tight text-neutral-900">
          {value === null ? "—" : value.toLocaleString()}
        </span>
        <Delta value={delta} />
      </div>
    </button>
  );
}

function Panel({
  title,
  tabs,
  rows,
  filters,
  onToggle,
  extra,
}: {
  title: string;
  tabs: { dimension: Dimension; label: string }[];
  rows: Pageview[];
  filters: Filters;
  onToggle: (dimension: Dimension, value: string) => void;
  // 탭 줄 오른쪽에 붙는 것 — UTM 탭의 파라미터 선택처럼.
  extra?: (dimension: Dimension, setDimension: (d: Dimension) => void) => ReactNode;
}) {
  // 탭과 차원을 따로 든다 — UTM 탭 하나가 파라미터 다섯 개를 오간다.
  const [active, setActive] = useState(tabs[0]);
  const [dimension, setDimension] = useState(tabs[0].dimension);
  const [expanded, setExpanded] = useState(false);
  const items = breakdown(rows, dimension);
  const max = Math.max(1, ...items.map((item) => item.visitors));
  const shown = expanded ? items : items.slice(0, PANEL_ROWS);

  return (
    <section
      aria-label={title}
      className="flex flex-col rounded-xl border border-neutral-200 bg-white"
    >
      <div className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4">
        <div role="tablist" className="flex gap-4">
          {tabs.map((tab) => (
            <button
              key={tab.label}
              type="button"
              role="tab"
              aria-selected={tab === active}
              onClick={() => {
                setActive(tab);
                setDimension(tab.dimension);
                setExpanded(false);
              }}
              className={`-mb-px border-b-2 py-3 text-[13px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 ${
                tab === active
                  ? "border-neutral-900 text-neutral-900"
                  : "border-transparent text-neutral-500 hover:text-neutral-900"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {extra?.(dimension, setDimension)}
          <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            방문자
          </span>
        </div>
      </div>

      <div role="tabpanel" className="flex-1 space-y-0.5 p-2">
        {shown.length === 0 && (
          <p className="px-2 py-8 text-center text-[13px] text-neutral-400">데이터 없음</p>
        )}
        {shown.map((item) => {
          const selected = filters[dimension] === item.value;
          return (
            <button
              key={item.value}
              type="button"
              aria-pressed={selected}
              title={`${DIMENSION_LABEL[dimension]} = ${item.value} 로 거르기`}
              onClick={() => onToggle(dimension, item.value)}
              className="group relative flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400"
            >
              <span
                aria-hidden
                className={`absolute inset-y-0 left-0 rounded-md transition-colors ${
                  selected ? "bg-blue-100" : "bg-neutral-100 group-hover:bg-neutral-200"
                }`}
                style={{ width: `${(item.visitors / max) * 100}%` }}
              />
              <span className="relative truncate text-neutral-900">
                {displayValue(dimension, item.value)}
              </span>
              <span className="relative shrink-0 tabular-nums text-neutral-600">
                {item.visitors.toLocaleString()}
              </span>
            </button>
          );
        })}
      </div>

      {items.length > PANEL_ROWS && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="border-t border-neutral-200 py-2.5 text-[13px] font-medium text-neutral-600 transition hover:bg-neutral-50 hover:text-neutral-900"
        >
          {expanded ? "접기" : `모두 보기 (${items.length})`}
        </button>
      )}
    </section>
  );
}

function UtmPicker(dimension: Dimension, setDimension: (d: Dimension) => void) {
  if (!dimension.startsWith("utm_")) return null;
  return (
    <select
      aria-label="UTM 파라미터"
      value={dimension}
      onChange={(event) => setDimension(event.target.value as Dimension)}
      className="rounded-md border border-neutral-200 bg-white px-2 py-1 text-[12px] text-neutral-700"
    >
      {UTM_KEYS.map((key) => (
        <option key={key} value={`utm_${key}`}>
          {key}
        </option>
      ))}
    </select>
  );
}

function RecentTable({ visits }: { visits: RecentVisit[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="overflow-x-auto">
      <table aria-label="최근 방문" className="w-full border-collapse text-left text-[13px]">
        <thead>
          <tr className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            {["시각", "방문자", "구분", "기기", "브라우저", "경로", "유입"].map((head) => (
              <th key={head} className="border-b border-neutral-200 px-4 py-2.5 font-medium">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(expanded ? visits : visits.slice(0, RECENT_ROWS)).map((visit, index) => (
            // 같은 초에 같은 곳에서 두 번 온 요청이 있다 (새로고침 연타).
            // 시각만으로는 키가 안 되므로 순서를 함께 쓴다.
            <tr
              key={`${visit.at}-${index}`}
              className={`border-b border-neutral-100 last:border-0 ${
                visit.kind === "human" ? "text-neutral-900" : "text-neutral-400"
              }`}
            >
              <td className="whitespace-nowrap px-4 py-2 font-mono tabular-nums">
                {/* 날짜와 시각만. 초는 이 표에서 읽을 일이 없다. */}
                {visit.at.slice(5, 16).replace("T", " ")}
              </td>
              <td className="px-4 py-2 font-mono">{visit.visitor}</td>
              <td className="px-4 py-2">{KIND_LABEL[visit.kind]}</td>
              <td className="px-4 py-2">{DEVICE_LABEL[visit.device]}</td>
              <td className="whitespace-nowrap px-4 py-2">{visit.browser}</td>
              <td className="px-4 py-2 font-mono text-[12px]">{visit.path}</td>
              <td className="px-4 py-2">{visit.referrer ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {visits.length === 0 && (
        <p className="px-4 py-8 text-center text-[13px] text-neutral-400">데이터 없음</p>
      )}
      {visits.length > RECENT_ROWS && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full border-t border-neutral-200 py-2.5 text-[13px] font-medium text-neutral-600 transition hover:bg-neutral-50 hover:text-neutral-900"
        >
          {expanded ? "접기" : `모두 보기 (${visits.length})`}
        </button>
      )}
    </div>
  );
}

export function VisitorsPage() {
  useDocumentTitle("방문자");
  const [params, setParams] = useSearchParams();
  const [metric, setMetric] = useState<Metric>("visitors");

  // 기간과 필터를 URL 에 둔다 — 새로고침해도, 링크를 열어도 같은 화면이다.
  // 모르는 기간이면 Vercel 의 기본값처럼 7일: 오래된 링크에도 보여줄 것이 있다.
  const asked = Number(params.get("days"));
  const days = RANGES.some((range) => range.days === asked) ? asked : DEFAULT_DAYS;
  const filters: Filters = {};
  for (const dimension of DIMENSIONS) {
    const value = params.get(dimension);
    if (value !== null) filters[dimension] = value;
  }

  const { data, error } = usePolledFetch(
    () => fetchVisits(days),
    { intervalMs: POLL_INTERVAL_MS, stopWhenLoaded: true },
    [days]
  );

  function update(change: (next: URLSearchParams) => void) {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      change(next);
      return next;
    });
  }

  function toggleFilter(dimension: Dimension, value: string) {
    update((next) =>
      next.get(dimension) === value ? next.delete(dimension) : next.set(dimension, value)
    );
  }

  const rows = data ? applyFilters(data.pageviews, filters) : [];
  // 시각은 둘 다 서울 시간 ISO 문자열이라 문자열 비교가 곧 시각 비교다.
  const current = data ? rows.filter((row) => row.at >= data.start) : [];
  const previous = data ? rows.filter((row) => row.at < data.start) : [];
  // 직전 기간을 로그가 다 덮지 못하면 그 기간의 0 은 "없었다"가 아니라 "모른다"다.
  const comparable =
    data?.coverage_start != null && data.coverage_start <= data.previous_start;
  const totals: Record<Metric, number> = {
    visitors: countVisitors(current),
    views: current.length,
  };
  const deltas: Record<Metric, number | null> = {
    visitors: comparable ? change(totals.visitors, countVisitors(previous)) : null,
    views: comparable ? change(totals.views, previous.length) : null,
  };
  const recent = data ? applyFilters(data.recent, filters) : [];
  const activeFilters = Object.entries(filters) as [Dimension, string][];

  return (
    <div className="min-h-screen bg-neutral-50">
      <main className="mx-auto max-w-[1100px] px-4 py-10 sm:px-8">
        <Link
          to="/"
          className="text-[13px] font-medium text-neutral-500 transition hover:text-neutral-900"
        >
          ← 전체 보기
        </Link>

        <header className="mt-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">방문자</h1>
            <p className="mt-1 text-[13px] text-neutral-500">
              Caddy 접근 로그 기준 · 페이지는 첫 진입 페이지만 셉니다 · 로그가 롤되어 사라진
              기간은 비어 보입니다
            </p>
          </div>
          <select
            aria-label="기간"
            value={days}
            onChange={(event) => update((next) => next.set("days", event.target.value))}
            className="rounded-md border border-neutral-200 bg-white px-3 py-2 text-[13px] font-medium text-neutral-900 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400"
          >
            {RANGES.map((range) => (
              <option key={range.days} value={range.days}>
                {range.label}
              </option>
            ))}
          </select>
        </header>

        {activeFilters.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {activeFilters.map(([dimension, value]) => (
              <span
                key={dimension}
                className="flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white py-1 pl-3 pr-1.5 text-[12px] shadow-sm"
              >
                <span className="text-neutral-500">{DIMENSION_LABEL[dimension]}</span>
                <span className="font-medium text-neutral-900">
                  {displayValue(dimension, value)}
                </span>
                <button
                  type="button"
                  aria-label={`${DIMENSION_LABEL[dimension]} 필터 해제`}
                  onClick={() => toggleFilter(dimension, value)}
                  className="rounded-full px-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-900"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {error && !data ? (
          <p className="mt-8 text-sm text-neutral-500">집계를 불러오지 못했습니다.</p>
        ) : (
          <>
            <section className="mt-6 rounded-xl border border-neutral-200 bg-white">
              <div className="flex border-b border-neutral-200">
                {(["visitors", "views"] as Metric[]).map((m) => (
                  <MetricTab
                    key={m}
                    metric={m}
                    value={data ? totals[m] : null}
                    delta={deltas[m]}
                    selected={metric === m}
                    onSelect={() => setMetric(m)}
                  />
                ))}
              </div>
              <div className="px-4 pb-4 pt-6 sm:px-6">
                {data ? (
                  <VisitorsChart
                    points={series(current, data.start, days, new Date())}
                    metric={metric}
                  />
                ) : (
                  <div className="h-[264px]" />
                )}
              </div>
            </section>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Panel
                title="페이지"
                tabs={[
                  { dimension: "page", label: "페이지" },
                  { dimension: "route", label: "라우트" },
                ]}
                rows={current}
                filters={filters}
                onToggle={toggleFilter}
              />
              <Panel
                title="유입 경로"
                tabs={[
                  { dimension: "referrer", label: "유입 경로" },
                  { dimension: "utm_source", label: "UTM" },
                ]}
                rows={current}
                filters={filters}
                onToggle={toggleFilter}
                extra={UtmPicker}
              />
              <Panel
                title="기기"
                tabs={[
                  { dimension: "device", label: "기기" },
                  { dimension: "browser", label: "브라우저" },
                  { dimension: "os", label: "OS" },
                ]}
                rows={current}
                filters={filters}
                onToggle={toggleFilter}
              />
            </div>

            <section className="mt-4 rounded-xl border border-neutral-200 bg-white">
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-neutral-200 px-4 py-3">
                <h2 className="text-[13px] font-medium text-neutral-900">최근 방문</h2>
                {/* 위 숫자에 안 잡힌 것이 무엇인지. 사람은 페이지를 받은 뒤 앱이
                    실제로 떠서 API 를 부른 방문이고, 미확인은 HTML 만 받아 가고
                    앱은 뜨지 않은 요청 — 대개 스캐너다. */}
                {data && (
                  <p className="text-[12px] text-neutral-500">
                    제외됨: 봇 {data.excluded.bots.toLocaleString()} · 미확인{" "}
                    {data.excluded.unconfirmed.toLocaleString()}
                  </p>
                )}
              </div>
              <RecentTable visits={recent} />
            </section>
          </>
        )}
      </main>
    </div>
  );
}
