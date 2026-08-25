import { Link, useSearchParams } from "react-router-dom";

import { DailyLogTable } from "../components/DailyLogTable";
import { MmcaDailyLogTable } from "../components/MmcaDailyLogTable";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { DISABLED_MMCA_VENUES } from "../lib/mmcaDisabledRooms";
import { VENUES } from "../venues";

// 수집하지 않는 관은 표가 영원히 비어 있으므로 탭에서 뺀다 — App.tsx 가 그 관의
// 상세 라우트를 홈으로 돌려보내는 것과 같은 규칙이다.
const LOGGED_VENUES = VENUES.filter(
  (venue) => venue.mmcaVenue === undefined || !DISABLED_MMCA_VENUES.has(venue.mmcaVenue)
);

export function LogsPage() {
  useDocumentTitle("수집 원본 데이터");
  const [params, setParams] = useSearchParams();
  // 관을 URL 에 둔다 — 새로고침해도, 링크를 공유해도 같은 관이 열린다.
  // 모르는 값이면 404 대신 첫 관: 오래된 링크에도 보여줄 것이 있다.
  const selected =
    LOGGED_VENUES.find((venue) => venue.id === params.get("venue")) ?? LOGGED_VENUES[0];

  return (
    <div className="min-h-screen bg-canvas">
      <main className="mx-auto max-w-[1400px] px-6 py-16 sm:px-10 lg:px-16">
        <header className="mb-12 border-b border-hairline/70 pb-8">
          <Link
            to="/"
            className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-soft hover:text-accent"
          >
            ← 미술관 선택
          </Link>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            수집 원본 데이터
          </h1>
          <p className="mt-3 text-sm text-ink-soft">
            수집해 보관 중인 판독 전체. 열 이름은 공공 API 의 필드 이름 그대로입니다.
          </p>
        </header>

        <div className="mb-6 flex flex-wrap gap-2">
          {LOGGED_VENUES.map((venue) => {
            const isSelected = venue.id === selected.id;
            return (
              <button
                key={venue.id}
                aria-pressed={isSelected}
                onClick={() => setParams({ venue: venue.id })}
                className={`rounded-full px-4 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${
                  isSelected
                    ? "bg-ink text-canvas"
                    : "text-ink-soft hover:bg-ink/5 hover:text-ink"
                }`}
              >
                {venue.name}
              </button>
            );
          })}
        </div>

        {/* 관마다 표가 다르다 — 국중박은 지역 인구 통계, MMCA 는 전시실별 혼잡도.
            key 로 관이 바뀔 때 표를 새로 마운트해 이전 관의 행이 한 프레임
            남아 있는 것을 막는다. */}
        {selected.mmcaVenue ? (
          <MmcaDailyLogTable key={selected.id} venue={selected.mmcaVenue} />
        ) : (
          <DailyLogTable key={selected.id} />
        )}
      </main>
    </div>
  );
}
