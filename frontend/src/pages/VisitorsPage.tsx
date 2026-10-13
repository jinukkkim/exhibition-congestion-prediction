import { Link, useSearchParams } from "react-router-dom";

import { fetchVisits, type Visit, type VisitDay } from "../api/analytics";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { usePolledFetch } from "../hooks/usePolledFetch";

// 개발자용 화면이라 홈이나 어디에서도 링크하지 않는다 — 주소를 아는 사람만
// 연다. 실리는 것은 집계 숫자뿐이라 그 이상의 잠금은 두지 않았다.

const RANGES = [7, 30, 90];

// 백엔드가 10분 캐시로 답하므로 그보다 자주 물어도 같은 값이다. 한 번 받으면
// 멈추고, 실패했을 때만 다음 tick 이 회복한다.
const POLL_INTERVAL_MS = 600_000;

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-hairline/70 px-5 py-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
        {label}
      </div>
      <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-ink">
        {value.toLocaleString()}
      </div>
    </div>
  );
}

// 방문 수를 막대로도 보여준다. 이 repo 에는 차트 라이브러리가 없고 다른 화면은
// SVG 를 직접 그리지만, 가로 막대 하나에 그럴 이유는 없다 — 칸 너비가 곧 막대다.
function DayRow({ day, max }: { day: VisitDay; max: number }) {
  return (
    <tr className="border-b border-hairline/40 last:border-0">
      <td className="whitespace-nowrap px-4 py-2 font-mono tabular-nums text-ink-soft">
        {day.date}
      </td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="w-10 shrink-0 text-right font-mono tabular-nums text-ink">
            {day.views}
          </span>
          <span
            aria-hidden
            className="h-1.5 rounded-full bg-accent/70"
            // max 가 0 이면 아무 막대도 없다 — 0/0 을 그리지 않게 먼저 막는다.
            style={{ width: max ? `${(day.views / max) * 100}%` : 0 }}
          />
        </div>
      </td>
      <td className="px-4 py-2 text-right font-mono tabular-nums text-ink">{day.visitors}</td>
      <td className="px-4 py-2 text-right font-mono tabular-nums text-ink-soft">
        {day.unconfirmed}
      </td>
      <td className="px-4 py-2 text-right font-mono tabular-nums text-ink-soft">{day.bots}</td>
    </tr>
  );
}

const KIND_LABEL: Record<Visit["kind"], string> = {
  human: "사람",
  unconfirmed: "미확인",
  bot: "봇",
};

function VisitRow({ visit }: { visit: Visit }) {
  const isHuman = visit.kind === "human";
  return (
    <tr className="border-b border-hairline/40 last:border-0">
      <td className="whitespace-nowrap px-4 py-2 font-mono tabular-nums text-ink-soft">
        {/* 날짜와 시각만. 초는 이 표에서 읽을 일이 없다. */}
        {visit.at.slice(5, 16).replace("T", " ")}
      </td>
      <td className="px-4 py-2 font-mono text-ink-soft">{visit.visitor}</td>
      <td className={`px-4 py-2 ${isHuman ? "text-ink" : "text-ink-soft"}`}>
        {KIND_LABEL[visit.kind]}
      </td>
      <td className="px-4 py-2 text-ink-soft">{visit.device === "mobile" ? "모바일" : "데스크톱"}</td>
      <td className="px-4 py-2 font-mono text-[12px] text-ink-soft">{visit.path}</td>
      <td className="px-4 py-2 text-ink-soft">{visit.referrer ?? "—"}</td>
    </tr>
  );
}

export function VisitorsPage() {
  useDocumentTitle("방문자");
  const [params, setParams] = useSearchParams();
  // LogsPage 처럼 기간을 URL 에 둔다 — 새로고침해도, 링크를 열어도 같은 기간이다.
  // 모르는 값이면 기본 30일: 오래된 링크에도 보여줄 것이 있다.
  const asked = Number(params.get("days"));
  const days = RANGES.includes(asked) ? asked : 30;
  const { data, error } = usePolledFetch(
    () => fetchVisits(days),
    { intervalMs: POLL_INTERVAL_MS, stopWhenLoaded: true },
    [days]
  );

  const daily = data?.daily ?? [];
  const max = Math.max(0, ...daily.map((day) => day.views));
  const total = daily.reduce((sum, day) => sum + day.views, 0);
  const bots = daily.reduce((sum, day) => sum + day.bots, 0);
  // 순방문자는 날짜별 집합의 크기라 기간 전체로는 더할 수 없다 — 같은 사람이
  // 이틀 오면 2 가 된다. 그래서 합이 아니라 하루 최대치를 싣고 그렇게 부른다.
  const busiest = Math.max(0, ...daily.map((day) => day.visitors));

  return (
    <div className="min-h-screen bg-canvas">
      <main className="mx-auto max-w-[900px] px-6 py-16 sm:px-10">
        <header className="mb-12 border-b border-hairline/70 pb-8">
          <Link
            to="/"
            className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-soft hover:text-accent"
          >
            ← 전체 보기
          </Link>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            방문자
          </h1>
          <p className="mt-3 text-sm text-ink-soft">
            Caddy 접근 로그에서 집계합니다. 방문으로 세는 것은 앱이 실제로 뜬 요청뿐입니다.
            로그가 롤되면 오래된 날짜부터 사라지므로 여기 보이는 기간이 남아 있는 기록의
            전부입니다.
          </p>
        </header>

        <div className="mb-6 flex flex-wrap gap-2">
          {RANGES.map((range) => (
            <button
              key={range}
              aria-pressed={range === days}
              onClick={() => setParams({ days: String(range) })}
              className={`rounded-full px-4 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${
                range === days
                  ? "bg-ink text-canvas"
                  : "text-ink-soft hover:bg-ink/5 hover:text-ink"
              }`}
            >
              {range}일
            </button>
          ))}
        </div>

        {error && !data ? (
          <p className="text-sm text-ink-soft">집계를 불러오지 못했습니다.</p>
        ) : (
          <>
            <div className="mb-10 grid gap-3 sm:grid-cols-3">
              <Metric label="기간 방문" value={total} />
              <Metric label="하루 최다 순방문자" value={busiest} />
              <Metric label="봇 요청" value={bots} />
            </div>

            <section className="mb-12">
              <h2 id="visits-daily" className="mb-3 text-sm font-semibold text-ink">
                일별
              </h2>
              <table
                aria-labelledby="visits-daily"
                className="w-full border-collapse text-left text-[13px]"
              >
                <thead>
                  <tr className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
                    <th className="border-b border-hairline/60 px-4 py-3">날짜</th>
                    <th className="border-b border-hairline/60 px-4 py-3">방문</th>
                    <th className="border-b border-hairline/60 px-4 py-3 text-right">
                      순방문자
                    </th>
                    <th className="border-b border-hairline/60 px-4 py-3 text-right">미확인</th>
                    <th className="border-b border-hairline/60 px-4 py-3 text-right">봇</th>
                  </tr>
                </thead>
                <tbody>
                  {daily.map((day) => (
                    <DayRow key={day.date} day={day} max={max} />
                  ))}
                </tbody>
              </table>
            </section>

            <section className="grid gap-10 sm:grid-cols-2">
              <div>
                <h2 id="visits-referrers" className="mb-3 text-sm font-semibold text-ink">
                  유입 경로
                </h2>
                {data && data.referrers.length === 0 ? (
                  <p className="text-sm text-ink-soft">아직 없습니다.</p>
                ) : (
                  <table
                    aria-labelledby="visits-referrers"
                    className="w-full border-collapse text-left text-[13px]"
                  >
                    <tbody>
                      {data?.referrers.map((referrer) => (
                        <tr
                          key={referrer.source}
                          className="border-b border-hairline/40 last:border-0"
                        >
                          <td className="px-4 py-2 text-ink">{referrer.source}</td>
                          <td className="px-4 py-2 text-right font-mono tabular-nums text-ink-soft">
                            {referrer.views}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div>
                <h2 id="visits-devices" className="mb-3 text-sm font-semibold text-ink">
                  기기
                </h2>
                <table
                  aria-labelledby="visits-devices"
                  className="w-full border-collapse text-left text-[13px]"
                >
                  <tbody>
                    <tr className="border-b border-hairline/40">
                      <td className="px-4 py-2 text-ink">모바일</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums text-ink-soft">
                        {data?.devices.mobile ?? 0}
                      </td>
                    </tr>
                    <tr>
                      <td className="px-4 py-2 text-ink">데스크톱</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums text-ink-soft">
                        {data?.devices.desktop ?? 0}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section className="mt-12">
              <h2 id="visits-list" className="mb-1 text-sm font-semibold text-ink">
                방문 목록
              </h2>
              {/* 이 페이지의 진짜 용도. "나 말고 누가 왔나" 는 합계로는 안 읽히고
                  목록으로 읽힌다 — 같은 방문자 이름이 계속 나오면 그게 답이다. */}
              <p className="mb-3 text-xs text-ink-soft">
                최근 순. <strong className="font-semibold text-ink">사람</strong>은 페이지를 받은 뒤
                앱이 실제로 떠서 API 를 부른 방문입니다. <strong className="font-semibold">미확인</strong>은
                HTML 만 받아 가고 앱은 뜨지 않은 요청 — 대개 스캐너입니다.
              </p>
              <div className="overflow-x-auto">
                <table
                  aria-labelledby="visits-list"
                  className="w-full border-collapse text-left text-[13px]"
                >
                  <thead>
                    <tr className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
                      <th className="border-b border-hairline/60 px-4 py-3">시각</th>
                      <th className="border-b border-hairline/60 px-4 py-3">방문자</th>
                      <th className="border-b border-hairline/60 px-4 py-3">구분</th>
                      <th className="border-b border-hairline/60 px-4 py-3">기기</th>
                      <th className="border-b border-hairline/60 px-4 py-3">경로</th>
                      <th className="border-b border-hairline/60 px-4 py-3">유입</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data?.visits.map((visit, index) => (
                      // 같은 초에 같은 곳에서 두 번 온 요청이 있다 (새로고침 연타).
                      // 시각만으로는 키가 안 되므로 순서를 함께 쓴다.
                      <VisitRow key={`${visit.at}-${index}`} visit={visit} />
                    ))}
                  </tbody>
                </table>
              </div>
              {data && data.visits.length === 0 && (
                <p className="text-sm text-ink-soft">아직 없습니다.</p>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
