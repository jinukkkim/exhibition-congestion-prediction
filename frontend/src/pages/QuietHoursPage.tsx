import { Link } from "react-router-dom";

import { fetchWeeklyProfile, type WeeklyProfileCell } from "../api/congestion";
import { SiteFooter } from "../components/SiteFooter";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { usePolledFetch } from "../hooks/usePolledFetch";
import { WEEKDAY_NAMES, extremes, quietHoursHeadline, rankScale } from "../lib/quietHours";
import { VENUES } from "../venues";

// 값은 서버가 6시간 캐시한다. 다시 받을 이유가 없으므로 한 번 받고 멈추고,
// 이 주기는 첫 요청이 실패했을 때의 재시도 간격으로만 쓰인다.
const RETRY_INTERVAL_MS = 60_000;

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

  const profile = usePolledFetch(fetchWeeklyProfile, {
    intervalMs: RETRY_INTERVAL_MS,
    stopWhenLoaded: true,
  });

  const cells: WeeklyProfileCell[] = profile.data?.cells ?? [];
  const found = extremes(cells);
  const headline = quietHoursHeadline(venue.name, cells);
  // 요일마다 열리는 시각이 다르다(수·토는 야간개장). 열은 실제로 값이 있는
  // 시각만 세워야 빈 열이 생기지 않는다.
  const hours = [...new Set(cells.map((cell) => cell.hour))].sort((a, b) => a - b);
  const byCell = new Map(cells.map((cell) => [`${cell.weekday}-${cell.hour}`, cell]));
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
          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            {venue.name} 요일·시간대별 혼잡도 기록
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
          // 좁은 화면에서는 표가 가로로 넘친다 — 본문을 밀어내는 대신 표만
          // 스스로 스크롤한다.
          <div className="overflow-x-auto">
            {/* min-w 가 없으면 표가 좁은 화면에 맞춰 줄어들 뿐 스크롤되지
                않는다 — w-full 이 이미 100% 라 넘칠 것이 없기 때문이다. 그러면
                네 자리 숫자 열두 칸이 뭉개진다. 요일 열 40 + 시각 열 11 × 52. */}
            <table className="w-full min-w-[620px] border-separate border-spacing-0.5 text-center">
              <caption className="sr-only">
                요일과 시각별 평균 생활인구. 진할수록 사람이 많습니다.
              </caption>
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
                        // 그 요일 그 시각에는 문을 열지 않는다. 빈 칸이 곧
                        // 야간개장이 수·토뿐이라는 말이다.
                        return <td key={hour} className="h-9" />;
                      }
                      return (
                        <td
                          key={hour}
                          className="h-9 rounded text-xs tabular-nums text-ink"
                          style={{ backgroundColor: cellShade(rankOf(cell.population_avg)) }}
                        >
                          {Math.round(cell.population_avg).toLocaleString()}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
