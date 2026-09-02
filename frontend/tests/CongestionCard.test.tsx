import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CongestionCard } from "../src/components/CongestionCard";
import type { DailyLogPoint } from "../src/api/congestion";

function dailyPoint(observedAt: string, avg: number): DailyLogPoint {
  return {
    observed_at: observedAt,
    congest_level: "보통",
    population_min: avg,
    population_max: avg,
    male_ppltn_rate: null,
    female_ppltn_rate: null,
    ppltn_rate_0: null,
    ppltn_rate_10: null,
    ppltn_rate_20: null,
    ppltn_rate_30: null,
    ppltn_rate_40: null,
    ppltn_rate_50: null,
    ppltn_rate_60: null,
    ppltn_rate_70: null,
    resnt_ppltn_rate: null,
    non_resnt_ppltn_rate: null,
  };
}

describe("CongestionCard", () => {
  // Pinned inside business hours (Wed 14:30) — the card hides the level/count
  // display outside business hours, so tests need a stable "now".
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T14:30:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the congestion level and population estimate", () => {
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={null}
      />
    );

    expect(screen.getByText("보통")).toBeInTheDocument();
    expect(screen.getByText(/1,500/)).toBeInTheDocument();
  });

  it("hides the level/population line outside business hours", () => {
    vi.setSystemTime(new Date("2026-07-16T20:00:00")); // Thu closes at 17:30

    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-16T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={null}
      />
    );

    expect(screen.getByText("영업 시간이 아닙니다")).toBeInTheDocument();
    expect(screen.queryByText("보통")).not.toBeInTheDocument();
    expect(screen.queryByText(/1,500/)).not.toBeInTheDocument();
  });

  it("says the trend failed instead of silently dropping the chart", () => {
    // current 는 도착했는데 daily 만 계속 실패하면, 차트 블록이 조건부라
    // 스파크라인이 아무 안내 없이 사라진 채로 남는다.
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={null}
        lastWeekDaily={null}
        chartError
      />
    );

    expect(screen.getByText("보통")).toBeInTheDocument();
    expect(screen.getByText(/추이를 불러오지 못했습니다/)).toBeInTheDocument();
  });

  it("still notes the failure when the other series loaded but came back empty", () => {
    // 자정~그날 첫 판독 사이에는 오늘 로그가 [] 로 정상 도착한다. 배열의
    // null 여부로만 판단하면 그 구간에 지난주 fetch 가 실패해도 안내가 사라져,
    // 시간축만 있는 빈 차트가 이유 없이 남는다.
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={[]}
        lastWeekDaily={null}
        chartError
      />
    );

    expect(screen.getByText(/추이를 불러오지 못했습니다/)).toBeInTheDocument();
  });

  it("prefers the chart over the failure note once either series has data", () => {
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={[dailyPoint("2026-07-15T10:00:00", 900), dailyPoint("2026-07-15T11:00:00", 1100)]}
        lastWeekDaily={null}
        chartError
      />
    );

    expect(screen.queryByText(/추이를 불러오지 못했습니다/)).not.toBeInTheDocument();
    expect(screen.getByTestId("history-sparkline")).toBeInTheDocument();
  });

  it("keeps the live badge while the reading is within the freshness window", () => {
    render(
      <CongestionCard
        data={{
          // 14:30 기준 시각 고정, 서울 API 발행 지연을 감안한 34분 전 판독
          observed_at: "2026-07-15T13:56:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={null}
      />
    );

    expect(screen.getByText("실시간")).toBeInTheDocument();
    // 점 색은 혼잡도가 아니라 신선도를 말한다. 이 판독의 등급은 "보통"(노랑)이지만
    // 점은 초록이어야 한다 — 예전에는 status.core 를 써서 노랑이 나왔다.
    expect(screen.getByTestId("freshness-dot")).toHaveStyle({ backgroundColor: "#34C759" });
  });

  it("says the reading has gone stale instead of claiming it is live", () => {
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T13:00:00", // 90분 전 — 임계값 75분 초과
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={null}
      />
    );

    expect(screen.getByText("갱신 지연")).toBeInTheDocument();
    expect(screen.queryByText("실시간")).not.toBeInTheDocument();
    // 지연은 주황이다 — 영업 전·종료·휴관일의 회색과 섞이면 멈춘 수집이
    // "말할 게 없음"으로 읽힌다.
    expect(screen.getByTestId("freshness-dot")).toHaveStyle({ backgroundColor: "#FF9F0A" });
  });

  it("explains that the national museum feed is published with a delay", () => {
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T13:56:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={null}
      />
    );

    expect(screen.getByText("30분 지연됨")).toBeInTheDocument();
  });

  it("says the museum is closed rather than loading when the clock already answers", () => {
    // 관 페이지에 진입할 때도 같은 깜빡임이 있었다 — 영업시간 밖이라는 사실은
    // 판독 없이도 확정된다.
    vi.setSystemTime(new Date("2026-07-15T07:00:00"));

    render(<CongestionCard data={null} daily={null} />);

    expect(screen.getByText(/영업 시간이 아닙니다/)).toBeInTheDocument();
    expect(screen.queryByText(/불러오는 중/)).not.toBeInTheDocument();
  });

  it("drops the live headline when it is not today", () => {
    // 미래 탭에서는 지난주 같은 요일의 실제 곡선을 대리로 그린다. 지나간 날의
    // 곡선 옆에 "실시간"이나 현재 등급을 놓으면 무엇을 보는지 알 수 없다.
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={[dailyPoint("2026-07-11T10:00:00", 900), dailyPoint("2026-07-11T11:00:00", 1100)]}
        viewDate="2026-07-11"
      />
    );

    expect(screen.queryByText("실시간")).not.toBeInTheDocument();
    expect(screen.queryByText("갱신 지연")).not.toBeInTheDocument();
    expect(screen.queryByText("보통")).not.toBeInTheDocument();
    expect(screen.getByTestId("history-sparkline")).toBeInTheDocument();
  });

  it("labels the legend by the drawn date, not by today", () => {
    // 범례가 todayString() 에 하드코딩되어 있으면 8/22 곡선 옆에 "8/23(일) 오늘"
    // 이라고 적힌다. 그리는 것과 적는 것이 어긋나면 안 된다.
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={[dailyPoint("2026-07-11T10:00:00", 900), dailyPoint("2026-07-11T11:00:00", 1100)]}
        lastWeekDaily={null}
        viewDate="2026-07-11"
      />
    );

    // 날짜를 적는 곳은 범례뿐이다
    expect(screen.getAllByText(/7\/11\(토\)/).length).toBe(1);
    expect(screen.queryByText(/오늘$/)).not.toBeInTheDocument();
    // 비교 데이터를 주지 않았으므로 지난주 범례도 없어야 한다
    expect(screen.queryByText(/지난주/)).not.toBeInTheDocument();
  });

  it("draws a past-day curve in the last-week grey, not the today blue", () => {
    // 미래 탭의 곡선은 그 날짜의 실제가 아니라 지난주 대리값이다 — 오늘 차트의
    // 회색 비교선과 같은 뜻이므로 색도 같아야 한다.
    const { rerender } = render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={[dailyPoint("2026-07-11T10:00:00", 900), dailyPoint("2026-07-11T11:00:00", 1100)]}
        viewDate="2026-07-11"
      />
    );

    expect(screen.getByTestId("sparkline-line")).toHaveAttribute("stroke", "#D1D1D1");

    rerender(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={[dailyPoint("2026-07-15T10:00:00", 900), dailyPoint("2026-07-15T11:00:00", 1100)]}
      />
    );

    expect(screen.getByTestId("sparkline-line")).toHaveAttribute("stroke", "#0071E3");
  });

  it("uses the drawn date's business hours for the axis", () => {
    // 2026-07-11 은 토요일 → 21:00 폐관. 오늘(수요일)도 21:00 이므로 평일과
    // 구분되는 날짜를 쓴다: 7/13 월요일은 17:30 폐관.
    const { rerender } = render(
      <CongestionCard
        data={null}
        daily={[dailyPoint("2026-07-13T10:00:00", 900)]}
        viewDate="2026-07-13"
      />
    );

    // 영업시간 문구는 페이지 헤더로 옮겼으므로, 축이 실제로 그 날짜의 폐관
    // 시각을 쓰는지는 x 축 끝 눈금으로 확인한다 (17:30 은 반시간이라 HH:MM,
    // 21:00 은 정시라 "21").
    expect(screen.getByText("17:30")).toBeInTheDocument();
    expect(screen.queryByText("21")).not.toBeInTheDocument();

    rerender(
      <CongestionCard
        data={null}
        daily={[dailyPoint("2026-07-11T10:00:00", 900)]}
        viewDate="2026-07-11"
      />
    );

    expect(screen.getByText("21")).toBeInTheDocument();
    expect(screen.queryByText("17:30")).not.toBeInTheDocument();
  });

  it("labels the hour next to opening and closing time too", () => {
    // 480 단위 폭이던 시절 30분 간격은 30단위라 "09:30" 옆에 "10" 이 겹쳤다.
    // 카드가 전폭이 된 뒤로는 같은 30분이 67단위(수·토의 690분 축에서도 46단위)
    // 라 둘 다 들어간다.
    const { rerender } = render(
      <CongestionCard data={null} daily={[dailyPoint("2026-07-13T10:00:00", 900)]} viewDate="2026-07-13" />
    );

    // 월요일 = 17:30 폐관.
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("17")).toBeInTheDocument();

    // 토요일 = 21:00 폐관. 폐관 자체가 정시라 눈금은 "21", 그 앞 "20" 도 남는다.
    rerender(
      <CongestionCard data={null} daily={[dailyPoint("2026-07-11T10:00:00", 900)]} viewDate="2026-07-11" />
    );

    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("20")).toBeInTheDocument();
  });

  it("names the Seoul open-data area, not the museum alone, in the card subtitle", () => {
    // 차트가 그리는 값은 국립중앙박물관·용산가족공원 한 구역의 인구다
    // (backend/app/config.py 의 seoul_area_name). 관 이름만 적으면 관 안의
    // 인원처럼 읽힌다.
    const { rerender } = render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={null}
      />
    );

    expect(screen.getByText("국립중앙박물관·용산가족공원 · 현재 혼잡도")).toBeInTheDocument();

    rerender(
      <CongestionCard data={null} daily={[]} viewDate="2026-07-13" />
    );

    expect(screen.getByText("국립중앙박물관·용산가족공원")).toBeInTheDocument();
  });

  it("leaves the business-hours line to the page header instead of repeating it per card", () => {
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={null}
      />
    );

    expect(screen.queryByText(/영업시간/)).not.toBeInTheDocument();
  });

  it("renders a loading state when data is null", () => {
    render(<CongestionCard data={null} daily={null} />);
    expect(screen.getByText(/불러오는 중/)).toBeInTheDocument();
  });

  it("says it failed, not that it is loading, when the fetch errored with nothing to show", () => {
    render(<CongestionCard data={null} daily={null} error />);
    expect(screen.getByText(/불러오지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByText(/재시도 중/)).toBeInTheDocument();
    expect(screen.queryByText(/불러오는 중/)).not.toBeInTheDocument();
  });

  it("draws a curve through points within business hours (09:30 onward)", () => {
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={[dailyPoint("2026-07-15T10:00:00", 800), dailyPoint("2026-07-15T14:30:00", 1500)]}
      />
    );

    expect(screen.getByTestId("history-sparkline")).toBeInTheDocument();
    expect(screen.getByTestId("sparkline-line")).toBeInTheDocument();
  });

  it("shows the live endpoint marker even when only one 30-min bucket of data exists", () => {
    const { container } = render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        // Both readings fall in the same 30-min bucket (10:00–10:30), so
        // resampling collapses them into a single point.
        daily={[dailyPoint("2026-07-15T10:00:00", 800), dailyPoint("2026-07-15T10:15:00", 900)]}
      />
    );

    // Live marker renders as two circles (soft glow + white ring dot). Before
    // the fix, a single resampled point left `xy` empty and the marker never
    // rendered even though the card is open.
    expect(container.querySelectorAll("circle")).toHaveLength(2);
  });

  it("excludes points before opening time and leaves the chart blank when fewer than 2 remain", () => {
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={[dailyPoint("2026-07-15T06:00:00", 100)]}
      />
    );

    expect(screen.getByTestId("history-sparkline")).toBeInTheDocument();
    expect(screen.queryByTestId("sparkline-line")).not.toBeInTheDocument();
  });

  it("renders a grey last-week line alongside this week's when both have data", () => {
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T14:30:00",
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={[dailyPoint("2026-07-15T10:00:00", 800), dailyPoint("2026-07-15T14:30:00", 1500)]}
        lastWeekDaily={[dailyPoint("2026-07-08T10:00:00", 600), dailyPoint("2026-07-08T14:30:00", 900)]}
      />
    );

    expect(screen.getByTestId("sparkline-line")).toBeInTheDocument();
    expect(screen.getByTestId("sparkline-last-week-line")).toBeInTheDocument();
  });

  it("omits the last-week line when lastWeekDaily is null or empty", () => {
    const { rerender } = render(
      <CongestionCard
        data={{ observed_at: "2026-07-15T14:30:00", congest_level: "보통", population_avg: 1500 }}
        daily={[dailyPoint("2026-07-15T10:00:00", 800), dailyPoint("2026-07-15T14:30:00", 1500)]}
        lastWeekDaily={null}
      />
    );
    expect(screen.queryByTestId("sparkline-last-week-line")).not.toBeInTheDocument();

    rerender(
      <CongestionCard
        data={{ observed_at: "2026-07-15T14:30:00", congest_level: "보통", population_avg: 1500 }}
        daily={[dailyPoint("2026-07-15T10:00:00", 800), dailyPoint("2026-07-15T14:30:00", 1500)]}
        lastWeekDaily={[]}
      />
    );
    expect(screen.queryByTestId("sparkline-last-week-line")).not.toBeInTheDocument();
  });

  it("shows the grey line on its own when this week has no data yet but last week does", () => {
    render(
      <CongestionCard
        data={{ observed_at: "2026-07-15T14:30:00", congest_level: "보통", population_avg: 1500 }}
        daily={[]}
        lastWeekDaily={[dailyPoint("2026-07-08T10:00:00", 600), dailyPoint("2026-07-08T14:30:00", 900)]}
      />
    );

    expect(screen.getByTestId("history-sparkline")).toBeInTheDocument();
    expect(screen.getByTestId("sparkline-last-week-line")).toBeInTheDocument();
    expect(screen.queryByTestId("sparkline-line")).not.toBeInTheDocument();
  });

  it("shows both values in the tooltip when hovering a time both weeks have data near", () => {
    const { container } = render(
      <CongestionCard
        data={{ observed_at: "2026-07-15T14:30:00", congest_level: "보통", population_avg: 1500 }}
        daily={[dailyPoint("2026-07-15T10:00:00", 800), dailyPoint("2026-07-15T10:15:00", 1000)]}
        lastWeekDaily={[dailyPoint("2026-07-08T10:00:00", 600), dailyPoint("2026-07-08T10:15:00", 700)]}
      />
    );

    const svg = screen.getByTestId("history-sparkline");
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 480, height: 200, right: 480, bottom: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const hoverTarget = container.querySelector('rect[fill="transparent"]') as SVGRectElement;

    // clientX 31 ≈ the 10:00–10:30 bucket's x on this fixture's axis (open
    // 09:30, close 21:00 on a Wed). 짚은 시각에 판독이 실제로 있는 자리다.
    fireEvent.mouseMove(hoverTarget, { clientX: 31, clientY: 0 });

    const tooltip = within(screen.getByTestId("sparkline-tooltip"));
    expect(tooltip.getByText(/지난주/)).toBeInTheDocument();
    expect(tooltip.getByText(/\(지난주/)).toBeInTheDocument();
  });

  it("shows the standalone '지난주' tooltip when hovering with only last-week data", () => {
    const { container } = render(
      <CongestionCard
        data={{ observed_at: "2026-07-15T14:30:00", congest_level: "보통", population_avg: 1500 }}
        daily={[]}
        lastWeekDaily={[dailyPoint("2026-07-08T10:00:00", 600), dailyPoint("2026-07-08T10:15:00", 700)]}
      />
    );

    const svg = screen.getByTestId("history-sparkline");
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 480, height: 200, right: 480, bottom: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const hoverTarget = container.querySelector('rect[fill="transparent"]') as SVGRectElement;

    fireEvent.mouseMove(hoverTarget, { clientX: 31, clientY: 0 });

    const tooltip = within(screen.getByTestId("sparkline-tooltip"));
    expect(tooltip.getByText(/지난주/)).toBeInTheDocument();
    expect(tooltip.queryByText(/\(지난주/)).not.toBeInTheDocument();
  });

  it("shows the standalone '지난주' tooltip over a time slot today hasn't reached yet, even though today has earlier data", () => {
    const { container } = render(
      <CongestionCard
        data={{ observed_at: "2026-07-15T14:30:00", congest_level: "보통", population_avg: 1500 }}
        // Today has one reading at 10:00. Last week has a 10:00 reading and
        // a 15:00 reading. Hovering near 15:00 must be closer to last
        // week's 15:00 point than to today's only (10:00) point, so it
        // must show the standalone last-week tooltip, not re-anchor to
        // today's 10:00 value.
        daily={[dailyPoint("2026-07-15T10:00:00", 800)]}
        lastWeekDaily={[dailyPoint("2026-07-08T10:00:00", 600), dailyPoint("2026-07-08T15:00:00", 950)]}
      />
    );

    const svg = screen.getByTestId("history-sparkline");
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 480, height: 200, right: 480, bottom: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const hoverTarget = container.querySelector('rect[fill="transparent"]') as SVGRectElement;

    // clientX 230 ≈ the 15:00 point's x position on this fixture's axis
    // (open 09:30, close 21:00 on a Wed) — much closer to last week's
    // 15:00 point (~x 240) than to today's only 10:00 point (~x 31).
    fireEvent.mouseMove(hoverTarget, { clientX: 230, clientY: 0 });

    const tooltip = within(screen.getByTestId("sparkline-tooltip"));
    expect(tooltip.getByText(/지난주/)).toBeInTheDocument();
    expect(tooltip.queryByText(/\(지난주/)).not.toBeInTheDocument();
  });
});

describe("CongestionCard prediction line", () => {
  // 수요일 14:30 — 영업시간 09:30~21:00 안.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T14:30:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const CURRENT = { observed_at: "2026-07-15T14:30:00", congest_level: "보통", population_avg: 1500 };

  function curve(model: (hour: number) => number) {
    return Array.from({ length: 24 }, (_, hour) => ({ hour, baseline: null, model: model(hour) }));
  }

  function hoverAt(container: HTMLElement, clientX: number) {
    const svg = screen.getByTestId("history-sparkline");
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 480, height: 200, right: 480, bottom: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    fireEvent.mouseMove(container.querySelector('rect[fill="transparent"]') as SVGRectElement, {
      clientX,
      clientY: 0,
    });
  }

  it("draws the prediction as a dashed line in the same chart, with its own legend entry", () => {
    render(
      <CongestionCard
        data={CURRENT}
        daily={[dailyPoint("2026-07-15T10:00:00", 800)]}
        prediction={curve(() => 1200)}
      />
    );

    expect(screen.getByTestId("sparkline-prediction-line")).toHaveAttribute("stroke-dasharray", "5 5");
    expect(screen.getByText("예측")).toBeInTheDocument();
  });

  it("draws the chart for a prediction alone, before today has any reading", () => {
    render(<CongestionCard data={CURRENT} daily={[]} prediction={curve((hour) => 1000 + hour)} />);

    expect(screen.getByTestId("history-sparkline")).toBeInTheDocument();
    expect(screen.getByTestId("sparkline-prediction-line")).toBeInTheDocument();
    expect(screen.queryByTestId("sparkline-line")).not.toBeInTheDocument();
    // 그을 실선이 없으면 범례도 그것을 가리키지 않는다.
    expect(screen.queryByText(/오늘/)).not.toBeInTheDocument();
    expect(screen.getByText("예측")).toBeInTheDocument();
  });

  it("hands the elapsed part of the day to the reading and the rest to the prediction", () => {
    // 실측이 있는 시각에서는 예측을 지운다 — 확정된 값 옆의 추정치는 잡음이다.
    const { container } = render(
      <CongestionCard
        data={CURRENT}
        daily={[dailyPoint("2026-07-15T10:00:00", 800), dailyPoint("2026-07-15T10:15:00", 1000)]}
        prediction={curve(() => 2000)}
      />
    );

    // clientX 31 ≈ 10:00–10:30 버킷 — 실측이 있는 자리.
    hoverAt(container, 31);
    expect(within(screen.getByTestId("sparkline-tooltip")).queryByText(/예측/)).not.toBeInTheDocument();
    expect(screen.getByTestId("sparkline-tooltip")).toHaveTextContent("900");

    // clientX 104 ≈ 12:00 — 오늘이 아직 닿지 않은 자리라 점선의 값이 나온다.
    hoverAt(container, 104);
    expect(within(screen.getByTestId("sparkline-tooltip")).getByText(/예측/)).toBeInTheDocument();
    expect(screen.getByTestId("sparkline-tooltip")).toHaveTextContent("2,000");
  });

  it("keeps the whole prediction curve on a past-day view instead of re-joining a finished line", () => {
    // 미래 탭의 실선은 오늘의 판독이 아니라 D−7 대리 기록이라 하루가 이미 다 차
    // 있다. 거기서 이음매를 다시 잡으면 예측 점 전부가 걸려 곡선이 사라진다.
    const { container } = render(
      <CongestionCard
        data={CURRENT}
        daily={[dailyPoint("2026-07-08T10:00:00", 800), dailyPoint("2026-07-08T20:00:00", 900)]}
        viewDate="2026-07-08"
        prediction={curve(() => 2000)}
      />
    );

    expect(screen.getByTestId("sparkline-prediction-line")).toBeInTheDocument();
    // 대리 실선이 하루를 다 덮고 있어도 이른 시각에서 예측값이 나온다.
    hoverAt(container, 104);
    expect(within(screen.getByTestId("sparkline-tooltip")).getByText(/예측/)).toBeInTheDocument();
  });

  it("says nothing at a time where no series has a value", () => {
    // 값이 없는 자리에서 가까운 점을 끌어오면 없는 시각을 있는 것처럼 말한다.
    const { container } = render(
      <CongestionCard data={CURRENT} daily={[dailyPoint("2026-07-15T10:00:00", 800)]} />
    );

    hoverAt(container, 300);
    expect(screen.queryByTestId("sparkline-tooltip")).not.toBeInTheDocument();
  });
});


describe("CongestionCard chart geometry", () => {
  // 목요일 20:00 — 폐관(17:30) 뒤라 하루가 다 찼다.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T20:00:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const CURRENT = { observed_at: "2026-07-16T17:30:00", congest_level: "보통", population_avg: 1500 };

  // 09:30~17:30 을 5분 간격으로 — 실제 수집 간격이고, 마지막 버킷(17:30 하나)의
  // 중심이 폐관을 넘는 조건이다.
  function fullDay(date: string, value: (minutes: number) => number) {
    const rows = [];
    for (let m = 9 * 60 + 30; m <= 17 * 60 + 30; m += 5) {
      const hh = String(Math.floor(m / 60)).padStart(2, "0");
      const mm = String(m % 60).padStart(2, "0");
      rows.push(dailyPoint(`${date}T${hh}:${mm}:00`, value(m)));
    }
    return rows;
  }

  // "M x y C x1 y1, x2 y2, x y ..." 의 좌표를 전부 꺼낸다.
  function coords(d: string) {
    const nums = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    const xs = nums.filter((_, i) => i % 2 === 0);
    const ys = nums.filter((_, i) => i % 2 === 1);
    return { xs, ys };
  }

  // 지나간 날을 그린다 — 세 계열이 한 화면에 다 있는 유일한 조합이다. 오늘
  // 탭에서 하루가 다 차면 예측 점선은 정상적으로 사라진다(남은 시간이 없다).
  function render_() {
    return render(
      <CongestionCard
        data={CURRENT}
        viewDate="2026-07-09"
        daily={fullDay("2026-07-09", (m) => 1000 + (m - 570))}
        lastWeekDaily={fullDay("2026-07-02", (m) => 900 + (m - 570) / 2)}
        prediction={Array.from({ length: 24 }, (_, hour) => ({
          hour,
          baseline: null,
          model: 1200 + hour * 20,
        }))}
      />
    );
  }

  // 축 크기는 viewBox 에서 읽는다 — 상수를 테스트에 또 적으면 비율을 손볼 때
  // 두 곳이 갈라진다.
  function viewBox() {
    const [, , width, height] = screen
      .getByTestId("history-sparkline")
      .getAttribute("viewBox")!
      .split(" ")
      .map(Number);
    return { width, height };
  }

  it("starts every series at the opening tick and stops at the closing tick", () => {
    // 30분 버킷의 중심은 반 버킷만큼 안쪽이라 그것만 이으면 09:30 쪽이 비고,
    // 폐관에 걸친 마지막 버킷의 중심(17:45)은 축을 넘어가 곡선이 축 밖으로
    // 이어져 그려졌다. 예측도 정시 표본이라 09:30·17:30 에 점이 없다.
    render_();

    for (const id of ["sparkline-line", "sparkline-last-week-line", "sparkline-prediction-line"]) {
      const { xs } = coords(screen.getByTestId(id).getAttribute("d")!);
      expect(Math.min(...xs), id).toBe(0);
      expect(Math.max(...xs), id).toBeCloseTo(viewBox().width, 5);
    }
  });

  it("keeps every curve inside the chart box", () => {
    // 여백 없이 최소·최대값을 축 끝에 앉히면 Catmull-Rom 이 그 바깥으로
    // 오버슈트해 눈금 라벨 위로 삐져나온다.
    render_();

    for (const id of ["sparkline-line", "sparkline-last-week-line", "sparkline-prediction-line"]) {
      const { ys } = coords(screen.getByTestId(id).getAttribute("d")!);
      expect(Math.min(...ys), id).toBeGreaterThanOrEqual(0);
      expect(Math.max(...ys), id).toBeLessThanOrEqual(viewBox().height);
    }
  });

  it("puts the guide line and every hover dot on one x", () => {
    // 짚은 x 에 점을 찍고 y 만 계열에서 가져오면 점이 곡선에서 떠 보인다.
    const { container } = render_();

    const svg = screen.getByTestId("history-sparkline");
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 480, height: 200, right: 480, bottom: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    fireEvent.mouseMove(container.querySelector('rect[fill="transparent"]') as SVGRectElement, {
      clientX: 200,
      clientY: 0,
    });

    const guide = [...container.querySelectorAll("line")].find(
      (l) => l.getAttribute("stroke") === "#D2D2D7" && l.getAttribute("stroke-width") === "1"
    )!;
    const dots = [...container.querySelectorAll("circle")].filter((c) => c.getAttribute("r") === "4");

    expect(dots.length).toBeGreaterThan(1);
    for (const dot of dots) {
      expect(Number(dot.getAttribute("cx"))).toBeCloseTo(Number(guide.getAttribute("x1")), 5);
    }
  });
});
