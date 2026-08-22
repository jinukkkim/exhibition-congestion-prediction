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
  });

  it("says the reading has gone stale instead of claiming it is live", () => {
    render(
      <CongestionCard
        data={{
          observed_at: "2026-07-15T13:00:00", // 90분 전 — 임계값 45분 초과
          congest_level: "보통",
          population_avg: 1500,
        }}
        daily={null}
      />
    );

    expect(screen.getByText("갱신 지연")).toBeInTheDocument();
    expect(screen.queryByText("실시간")).not.toBeInTheDocument();
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

    expect(screen.getByText(/약 30분 지연/)).toBeInTheDocument();
  });

  it("says the museum is closed rather than loading when the clock already answers", () => {
    // 관 페이지에 진입할 때도 같은 깜빡임이 있었다 — 영업시간 밖이라는 사실은
    // 판독 없이도 확정된다.
    vi.setSystemTime(new Date("2026-07-15T07:00:00"));

    render(<CongestionCard data={null} daily={null} />);

    expect(screen.getByText(/영업 시간이 아닙니다/)).toBeInTheDocument();
    expect(screen.queryByText(/불러오는 중/)).not.toBeInTheDocument();
  });

  it("titles itself by the drawn date and drops the live headline when it is not today", () => {
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

    expect(screen.getByText(/7\/11\(토\) 실제/)).toBeInTheDocument();
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

    // 제목과 범례 둘 다 그 날짜를 적으므로 둘 이상이 정상
    expect(screen.getAllByText(/7\/11\(토\)/).length).toBeGreaterThan(1);
    expect(screen.queryByText(/오늘$/)).not.toBeInTheDocument();
    // 비교 데이터를 주지 않았으므로 지난주 범례도 없어야 한다
    expect(screen.queryByText(/지난주/)).not.toBeInTheDocument();
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

    // 오늘이 아니므로 "오늘"을 붙이지 않는다
    expect(screen.getByText("영업시간 09:30–17:30")).toBeInTheDocument();

    rerender(
      <CongestionCard
        data={null}
        daily={[dailyPoint("2026-07-11T10:00:00", 900)]}
        viewDate="2026-07-11"
      />
    );

    expect(screen.getByText("영업시간 09:30–21:00")).toBeInTheDocument();
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

    fireEvent.mouseMove(hoverTarget, { clientX: 0, clientY: 0 });

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

    fireEvent.mouseMove(hoverTarget, { clientX: 0, clientY: 0 });

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
