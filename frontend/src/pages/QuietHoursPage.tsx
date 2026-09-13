import { Link } from "react-router-dom";

import { fetchWeeklyProfile, type WeeklyProfileCell } from "../api/congestion";
import { CongestionHeatmap } from "../components/CongestionHeatmap";
import { SiteFooter } from "../components/SiteFooter";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { usePolledFetch } from "../hooks/usePolledFetch";
import { extremes, quietHoursHeadline, rankScale } from "../lib/quietHours";
import { VENUES } from "../venues";

// 다른 화면과 같은 주기다. 값 자체는 서버가 6시간 캐시하므로 한 번 받고 멈추어도
// 될 것 같지만, 그러면 status: "collecting" 에서 빠져나올 길이 없어진다 — 그것도
// 200 응답이라 usePolledFetch 는 "받았다"로 보고 폴링을 끊고, 집계가 시작된 뒤에도
// 손으로 새로고침하기 전까지 "아직 집계할 판독이 모이지 않았습니다" 에 머문다.
// 스스로 풀려야 하는 상태이므로 멈추지 않는다. 매 요청은 Redis 적중이다.
const POLL_INTERVAL_MS = 60_000;

// CHART_BLUE(#0071E3)의 rgb. 알파로 농담을 내야 해서 16진수 토큰을 그대로는
// 쓰지 못한다 — 색 자체는 차트와 같은 파랑이다.
const CELL_RGB = "0, 113, 227";
// 가장 한산한 칸도 칠해져 있어야 "값이 없는 칸"(문 닫은 시각)과 구별된다.
const MIN_ALPHA = 0.08;
// 0.65 에서 멈추는 이유는 글씨다. 더 진해지면 먹색이 묻혀 글씨색을 도중에
// 흰색으로 뒤집어야 하는데, 값이 몰려 있는 낮 시간대가 하필 그 경계에 걸려
// 거의 같은 농도의 두 칸이 서로 다른 글씨색으로 나온다 — 색 규칙이 아니라
// 결함으로 읽힌다. 0.65 까지면 #1D1D1F 가 6:1 로 끝까지 읽히고, 어차피 가장
// 붐비는 칸이 어디인지는 맨 위 문장이 말한다.
const MAX_ALPHA = 0.65;

function cellShade(rank: number): string {
  return `rgba(${CELL_RGB}, ${MIN_ALPHA + (MAX_ALPHA - MIN_ALPHA) * rank})`;
}

export function QuietHoursPage() {
  const venue = VENUES.find((v) => v.id === "national-museum")!;
  // 제목은 사람이 검색창에 치는 말에 맞춘다 — "혼잡도"로 검색하는 사람은 없다.
  useDocumentTitle(`${venue.name} 한산한 시간`);

  const profile = usePolledFetch(fetchWeeklyProfile, { intervalMs: POLL_INTERVAL_MS });

  const cells: WeeklyProfileCell[] = profile.data?.cells ?? [];
  const found = extremes(cells);
  const headline = quietHoursHeadline(venue.name, cells);
  const rankOf = rankScale(cells.map((cell) => cell.population_avg));

  return (
    <div className="min-h-screen bg-canvas">
      <main className="mx-auto max-w-[900px] px-6 py-16 sm:px-10">
        <header className="mb-10 border-b border-hairline/70 pb-8">
          <Link
            to={venue.path}
            className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-soft hover:text-accent"
          >
            ← {venue.name}
          </Link>
          {/* 바로 위 되돌아가기 링크가 이미 관 이름을 말하지만 제목에서
              빼지는 않는다 — 검색창에 치는 말이 관 이름이고, h1 이 그
              말을 갖고 있어야 한다. 대신 서술을 줄이고 한 급 작게 쓴다:
              관 이름이 긴 MMCA 에서 5xl 짜리 두 줄이 화면을 다 먹었다. */}
          <h1 className="mt-2 text-balance break-keep text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            {venue.name} 시간대별 혼잡도
          </h1>
          {headline !== null && (
            // 히트맵은 그림이라 검색엔진이 읽지 못한다. 이 페이지가 색인되는
            // 경로는 사실상 이 한 줄이라 제목 바로 아래, 본문 첫 줄에 둔다.
            <p className="mt-4 text-lg text-ink sm:text-xl">{headline}</p>
          )}
        </header>

        {found === null ? (
          <p className="text-sm text-ink-soft">
            {profile.error
              ? "집계를 불러오지 못했습니다."
              : "아직 집계할 판독이 모이지 않았습니다."}
          </p>
        ) : (
          <CongestionHeatmap
            cells={cells}
            caption="요일과 시각별 평균 생활인구. 진할수록 사람이 많습니다."
            // 요일 열 40 + 시각 열 11 × 52. 네 자리 숫자가 뭉개지지 않는 폭이다.
            minWidthClass="min-w-[620px]"
            renderCell={(cell) => ({
              label: Math.round(cell.population_avg).toLocaleString(),
              style: {
                backgroundColor: cellShade(rankOf(cell.population_avg)),
                color: "#1D1D1F",
              },
            })}
          />
        )}

        {/* 각주 뭉치가 아니라 데이터 명세다. 관 페이지의 VenueInfoList 와 같은
            2열 dl 을 쓴다 — 같은 사이트의 같은 성격의 표라 라벨 폭과 간격을
            맞춰 둔다. 값이 명사형으로 끝나는 것은 이 표만의 규칙이다: 맨 위
            한 문장은 관람객에게 말을 걸고, 여기는 데이터를 기술한다. */}
        <section className="mt-10 border-t border-hairline/70 pt-6">
          {/* GitHub 링크 같은 uppercase·0.2em 자간을 따라가지 않는다 — 한글에
              uppercase 는 아무 일도 하지 않고, 그 자간은 글자를 흩어 놓는다. */}
          <h2 className="text-xs font-semibold tracking-wide text-ink-soft">데이터 및 집계 방법</h2>
          <dl className="mt-4 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm text-ink">
            <dt className="text-ink-soft">출처</dt>
            <dd>
              <a
                href="https://data.seoul.go.kr/"
                target="_blank"
                rel="noreferrer"
                className="underline decoration-hairline underline-offset-4 hover:text-accent"
              >
                서울시 열린데이터광장
              </a>{" "}
              실시간 도시데이터(citydata)
            </dd>

            {/* 이 줄이 없으면 위의 숫자가 관람객 수로 읽힌다. 표 안으로 들어왔을
                뿐 문구를 약하게 만들지 않는다. */}
            <dt className="text-ink-soft">지표</dt>
            <dd>
              생활인구 — 해당 시각 {venue.name} 일대에 체류한 인구. 관람객 수가 아님
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

            {/* 시각은 백엔드 close_minutes() 가 정하는 값을 사람 말로 옮겨 적은
                것이다 — 개관시간이 바뀌면 이 줄도 함께 고쳐야 한다. */}
            <dt className="text-ink-soft">집계 단위</dt>
            <dd>
              요일 × 정시. 개관 시간에 온전히 포함되는 정시만 집계(평일 10~16시, 야간개장하는
              수·토 10~20시). 빈 칸은 미개관
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
