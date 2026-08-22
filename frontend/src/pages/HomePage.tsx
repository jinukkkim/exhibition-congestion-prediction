import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { fetchCurrent } from "../api/congestion";
import { fetchMmcaRooms } from "../api/mmca";
import { DISABLED_MMCA_VENUES } from "../lib/mmcaDisabledRooms";
import { statusOf } from "../lib/status";
import { mmcaSummary, nationalMuseumSummary, type VenueSummary } from "../lib/venueSummary";
import { VENUES } from "../venues";

const POLL_INTERVAL_MS = 60_000; // MmcaPage와 같은 주기

// 레벨 하나를 점 + 이름(+ MMCA는 방 개수)으로. 색은 상세 페이지와 같은 토큰.
function LevelText({ level, count }: { level: string; count?: number }) {
  const status = statusOf(level);
  return (
    <span
      className="flex items-center gap-1.5 text-lg font-semibold"
      style={{ color: status.text }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: status.core }} />
      {level}
      {count !== undefined && <span className="font-mono tabular-nums">{count}</span>}
    </span>
  );
}

export function HomePage() {
  const [summaries, setSummaries] = useState<Record<string, VenueSummary>>({});
  // 폴링은 이전 tick의 요청을 취소하지 않는다. tick N의 응답이 tick N+1보다 늦게
  // 도착하면 화면이 과거 값으로 되돌아가므로, 발사 시점의 tick 번호를 들고 있다가
  // 최신 tick의 응답만 반영한다.
  const pollSeq = useRef(0);

  useEffect(() => {
    let ignore = false;

    function load() {
      const now = new Date();
      const seq = ++pollSeq.current;
      // 관별로 따로 띄운다 — allSettled로 묶으면 가장 느린 관이 나머지 세 카드의
      // 첫 렌더를 붙잡는다.
      for (const venue of VENUES) {
        const mmca = venue.mmcaVenue;
        const request = mmca
          ? fetchMmcaRooms(mmca).then((rooms) => mmcaSummary(mmca, rooms, now))
          : fetchCurrent().then((current) => nationalMuseumSummary(current, now));

        request
          .then((summary) => {
            if (!ignore && seq === pollSeq.current) {
              setSummaries((prev) => ({ ...prev, [venue.id]: summary }));
            }
          })
          .catch(() => {
            // 한 관의 실패가 다른 카드를 비우지 않게 관별로 따로 처리한다.
            // 직전 요약이 있으면 그대로 두고 (다음 폴이 갱신한다), 처음부터
            // 못 받았을 때만 안내 문구로 떨어진다.
            if (!ignore && seq === pollSeq.current) {
              setSummaries((prev) =>
                prev[venue.id]
                  ? prev
                  : { ...prev, [venue.id]: { kind: "inactive", label: "정보 없음" } }
              );
            }
          });
      }
    }

    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      ignore = true;
      clearInterval(timer);
    };
  }, []);

  // 응답이 아직 없는 카드도 시계로 답할 수 있는 만큼은 답한다 (영업 전/종료,
  // 휴관일). 고정 "불러오는 중" 문구를 쓰면 홈에 돌아올 때마다 그게 한 번
  // 스쳐 지나간다.
  const now = new Date();
  const summaryOf = (venue: (typeof VENUES)[number]): VenueSummary =>
    summaries[venue.id] ??
    (venue.mmcaVenue
      ? mmcaSummary(venue.mmcaVenue, null, now)
      : nationalMuseumSummary(null, now));

  return (
    <div className="min-h-screen bg-canvas">
      <main className="mx-auto max-w-[1400px] px-6 py-16 sm:px-10 lg:px-16">
        <header className="mb-12 border-b border-hairline/70 pb-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-soft">
            Exhibition · Seoul
          </p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            전시 혼잡도 예측
          </h1>
        </header>

        <section className="grid gap-6 sm:grid-cols-2">
          {VENUES.map((venue) => {
            const summary = summaryOf(venue);
            // 갈 곳이 없는 관은 링크로 두지 않는다. 비활성 링크(aria-disabled)는
            // 스크린리더가 여전히 링크로 읽어 혼란스러우므로 요소 자체를 바꾸고,
            // 클릭 가능하다는 신호인 호버 반응도 뺀다.
            const unreachable =
              venue.mmcaVenue !== undefined && DISABLED_MMCA_VENUES.has(venue.mmcaVenue);
            const className = `rounded-apple border border-hairline/60 bg-white/70 p-8 shadow-apple backdrop-blur-xl transition${
              unreachable ? "" : " hover:border-accent/50"
            }${summary.kind === "inactive" ? " opacity-60" : ""}`;
            // 컴포넌트를 렌더 안에서 만들면 매 렌더 타입이 달라져 카드가 통째로
            // 리마운트된다 — 요소 종류만 분기한다.
            const content = (
              <>
                <span className="text-xl font-semibold text-ink">{venue.name}</span>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {summary.kind === "inactive" && (
                    <span className="text-lg text-ink-soft">{summary.label}</span>
                  )}
                  {summary.kind === "level" && (
                    <>
                      <LevelText level={summary.level} />
                      <span className="text-sm text-ink-soft">
                        <span className="font-mono tabular-nums">
                          {Math.round(summary.population).toLocaleString()}
                        </span>
                        명
                      </span>
                    </>
                  )}
                  {summary.kind === "counts" &&
                    summary.counts.map(({ level, count }) => (
                      <LevelText key={level} level={level} count={count} />
                    ))}
                </div>
                {summary.kind !== "inactive" && (
                  <p className="mt-1 text-[11px] text-ink-soft/70">
                    {summary.observedAt.slice(11, 16)} 기준
                  </p>
                )}
              </>
            );

            return unreachable ? (
              <div key={venue.id} className={className}>
                {content}
              </div>
            ) : (
              <Link key={venue.id} to={venue.path} className={className}>
                {content}
              </Link>
            );
          })}
        </section>
      </main>
    </div>
  );
}
