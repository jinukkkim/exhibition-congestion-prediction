import { Link } from "react-router-dom";

import { fetchMmcaWeeklyProfile, type MmcaVenue } from "../api/mmca";
import { CongestionHeatmap } from "../components/CongestionHeatmap";
import { SiteFooter } from "../components/SiteFooter";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { usePolledFetch } from "../hooks/usePolledFetch";
import { mmcaQuietHoursHeadline, rankLabel } from "../lib/quietHours";
import { STATUS_LEVELS, statusOf } from "../lib/status";
import { VENUES } from "../venues";

// QuietHoursPage 와 같은 이유의 같은 값 — status: "collecting" 도 200 응답이라
// 한 번 받고 멈추면 그 상태에서 스스로 빠져나오지 못한다.
const POLL_INTERVAL_MS = 60_000;

// 요일 열 40 + 시각 열 11 × 58. "약간 붐빔" 이 줄바꿈되지 않는 폭이다.
const MIN_WIDTH_CLASS = "min-w-[680px]";

// 등급 색은 lib/status.ts 를 그대로 쓴다. 국립중앙박물관 쪽이 같은 색을 쓰지
// 못한 이유는 그쪽 값이 등급이 아니라 생활인구라서였는데, 여기 값은 전시실
// 혼잡도 그 자체라 등급 색이 거짓말을 하지 않는다.
//
// 배경은 wash 를 쓰되 글씨는 먹색이다. status.ts 의 text 토큰은 **캔버스 위**
// 작은 글씨용으로 고른 값이라, 같은 색조의 wash 를 깔면 배경이 어두워져 대비가
// 4.5:1 아래로 내려간다 (여유 3.73 / 보통 4.44 / 약간 붐빔 4.05 / 붐빔 4.49).
// 칸의 색조는 배경이 이미 말하고 있으므로 글씨까지 물들일 이유가 없다 — 먹색이면
// 네 등급 모두 12:1 을 넘는다.
const CELL_TEXT = "#1D1D1F";

function cellView(rank: number) {
  const label = rankLabel(rank, STATUS_LEVELS);
  return { label, style: { backgroundColor: statusOf(label).wash, color: CELL_TEXT } };
}

export function MmcaQuietHoursPage({ venue }: { venue: MmcaVenue }) {
  const venueMeta = VENUES.find((v) => v.mmcaVenue === venue)!;
  useDocumentTitle(`${venueMeta.name} 한산한 시간`);

  const profile = usePolledFetch(
    () => fetchMmcaWeeklyProfile(venue),
    { intervalMs: POLL_INTERVAL_MS },
    [venue]
  );

  const cells = profile.data?.cells ?? [];
  const rooms = profile.data?.rooms ?? [];
  const headline = mmcaQuietHoursHeadline(venueMeta.name, cells);

  return (
    <div className="min-h-screen bg-canvas">
      <main className="mx-auto max-w-[900px] px-6 py-16 sm:px-10">
        <header className="mb-10 border-b border-hairline/70 pb-8">
          <Link
            to={venueMeta.path}
            className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-soft hover:text-accent"
          >
            ← {venueMeta.name}
          </Link>
          {/* 바로 위 되돌아가기 링크가 이미 관 이름을 말하지만 제목에서
              빼지는 않는다 — 검색창에 치는 말이 관 이름이고, h1 이 그
              말을 갖고 있어야 한다. 대신 서술을 줄이고 한 급 작게 쓴다:
              관 이름이 긴 MMCA 에서 5xl 짜리 두 줄이 화면을 다 먹었다. */}
          <h1 className="mt-2 text-balance break-keep text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            {venueMeta.name} 시간대별 혼잡도
          </h1>
          {headline !== null && (
            // 히트맵은 그림이라 검색엔진이 읽지 못한다. 색인되는 경로는 사실상
            // 이 한 줄이라 제목 바로 아래, 본문 첫 줄에 둔다.
            <p className="mt-4 text-lg text-ink sm:text-xl">{headline}</p>
          )}
        </header>

        {cells.length === 0 ? (
          <p className="text-sm text-ink-soft">
            {profile.error
              ? "집계를 불러오지 못했습니다."
              : "아직 집계할 판독이 모이지 않았습니다."}
          </p>
        ) : (
          <>
            <CongestionHeatmap
              cells={cells}
              caption={`요일과 시각별 평균 혼잡도. ${venueMeta.name}의 전시실 평균입니다.`}
              minWidthClass={MIN_WIDTH_CLASS}
              renderCell={(cell) => cellView(cell.rank)}
            />

            {/* 관 평균이 가리는 것을 여기서 편다 — 방마다 성격이 다르고, 그것이
                전시실 단위로 혼잡도를 주는 이 데이터의 강점이다. 접어 두는 것은
                관람객이 먼저 볼 것이 관 한 장이기 때문이고, details/summary 라
                여는 데 자바스크립트가 들지 않는다. */}
            <details className="mt-8 border-t border-hairline/70 pt-6">
              <summary className="cursor-pointer text-sm text-ink-soft hover:text-accent">
                전시실별로 보기 ({rooms.length})
              </summary>
              <div className="mt-6 space-y-8">
                {rooms.map((room) => (
                  <section key={room.space_code}>
                    <h3 className="mb-2 text-sm text-ink">{room.space_nm ?? room.space_code}</h3>
                    <CongestionHeatmap
                      cells={room.cells}
                      caption={`${room.space_nm ?? room.space_code}의 요일과 시각별 평균 혼잡도.`}
                      minWidthClass={MIN_WIDTH_CLASS}
                      renderCell={(cell) => cellView(cell.rank)}
                    />
                  </section>
                ))}
              </div>
            </details>
          </>
        )}

        <section className="mt-10 border-t border-hairline/70 pt-6">
          <h2 className="text-xs font-semibold tracking-wide text-ink-soft">데이터 및 집계 방법</h2>
          <dl className="mt-4 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm text-ink">
            <dt className="text-ink-soft">출처</dt>
            <dd>
              <a
                href="https://www.data.go.kr/"
                target="_blank"
                rel="noreferrer"
                className="underline decoration-hairline underline-offset-4 hover:text-accent"
              >
                공공데이터포털
              </a>{" "}
              국립현대미술관 전시실별 혼잡도(mmcadensity)
            </dd>

            <dt className="text-ink-soft">지표</dt>
            <dd>
              전시실 혼잡도 4단계(여유·보통·약간 붐빔·붐빔). 관 단위 칸은 전시실 평균을
              다시 평균한 값이며, 칸의 이름은 그 평균을 반올림한 등급
            </dd>

            {profile.data?.since && profile.data.until && (
              <>
                <dt className="text-ink-soft">집계 기간</dt>
                <dd className="tabular-nums">
                  {profile.data.since} ~ {profile.data.until}
                  <span className="text-ink-soft">
                    {" "}
                    (판독 {profile.data.samples.toLocaleString()}건)
                  </span>
                </dd>
              </>
            )}

            {rooms.length > 0 && (
              <>
                <dt className="text-ink-soft">전시실</dt>
                {/* 어느 방이 혼잡도를 주는지는 전시 일정이 정한다 — 밝혀 적지
                    않으면 관 평균이 무엇의 평균인지 알 수 없다. */}
                <dd>
                  {rooms.map((room) => room.space_nm ?? room.space_code).join(" · ")}
                  <span className="text-ink-soft"> — 전시 일정에 따라 달라짐</span>
                </dd>
              </>
            )}

            {/* 시각은 백엔드 _in_profile_window 가 정하는 값을 사람 말로 옮겨 적은
                것이다 — 개관시간이 바뀌면 이 줄도 함께 고쳐야 한다. */}
            <dt className="text-ink-soft">집계 단위</dt>
            <dd>
              요일 × 정시. 개관 시간에 온전히 포함되는 정시만 집계
              {venue === "seoul"
                ? "(10~17시, 야간개장하는 수·토 10~20시)"
                : "(10~17시)"}
              . 휴관 요일과 미개관 시각은 빈 칸
            </dd>

            {/* cache.WEEKLY_PROFILE_TTL_SECONDS 와 같은 값이다. */}
            <dt className="text-ink-soft">갱신</dt>
            <dd>6시간</dd>
          </dl>
        </section>
      </main>
      <SiteFooter container="max-w-[900px] px-6 sm:px-10" />
    </div>
  );
}
