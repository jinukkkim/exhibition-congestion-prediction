import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MmcaRoomChartCard } from "../src/components/MmcaRoomChartCard";
import type { MmcaDailyLogPoint, MmcaRoomPrediction, MmcaRoomStatus } from "../src/api/mmca";

function dailyPoint(observedAt: string, byCode: Record<string, string | null>): MmcaDailyLogPoint {
  return {
    observed_at: observedAt,
    rooms: Object.entries(byCode).map(([space_code, congestion_nm]) => ({
      space_code,
      space_nm: null,
      congestion_nm,
    })),
  };
}

function makeRoom(overrides: Partial<MmcaRoomStatus> = {}): MmcaRoomStatus {
  return {
    space_code: "MMCA-SPACE-2001",
    space_nm: "1전시실",
    congestion_nm: "약간 붐빔",
    observed_at: "2026-07-15T14:30:00",
    ...overrides,
  };
}

function prediction(
  points: [string, number][],
  overrides: Partial<MmcaRoomPrediction> = {}
): MmcaRoomPrediction {
  return {
    space_code: "MMCA-SPACE-2001",
    space_nm: "1전시실",
    anchored: true,
    points: points.map(([observed_at, tier]) => ({
      observed_at,
      tier,
      label: ["여유", "보통", "약간 붐빔", "붐빔"][Math.round(tier)],
    })),
    ...overrides,
  };
}

const OPEN = 10 * 60;
const CLOSE = 18 * 60;
const WITHIN_HOURS = 14 * 60 + 30; // 14:30
// nowMinutes 와 같은 시계 — MmcaPage 는 둘을 하나의 new Date() 에서 뽑는다.
const NOW = new Date("2026-07-15T14:30:00");
const AFTER_CLOSE_NOW = new Date("2026-07-15T20:00:00");

describe("MmcaRoomChartCard", () => {
  it("renders the room name and current status headline when open", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    expect(screen.getByText("1전시실")).toBeInTheDocument();
    expect(screen.getByText("약간 붐빔")).toBeInTheDocument();
  });

  it("shows '영업 시간이 아닙니다' when outside today's hours", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={20 * 60}
        now={AFTER_CLOSE_NOW}
        isOpenToday
      />
    );

    expect(screen.getByText("영업 시간이 아닙니다")).toBeInTheDocument();
    expect(screen.queryByText("약간 붐빔")).not.toBeInTheDocument();
  });

  it("shows a distinct closed-day state instead of business hours when isOpenToday is false", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday={false}
      />
    );

    // A closed weekly day (e.g. Deoksugung on Monday) is not the same thing
    // as "outside hours today" — it must not claim hours it doesn't have.
    // (관 단위 휴관 안내 한 줄은 페이지 헤더가 맡는다 — MmcaPage.test.tsx.)
    expect(screen.getByText("휴관일입니다")).toBeInTheDocument();
    expect(screen.getByText("휴관일")).toBeInTheDocument();
    expect(screen.queryByText(/영업시간/)).not.toBeInTheDocument();
    expect(screen.queryByText("영업 시간이 아닙니다")).not.toBeInTheDocument();
  });

  it("leaves the business-hours line to the page header instead of repeating it per room", () => {
    // 영업시간은 관 단위 값이라 방마다 같은 줄이 반복됐다.
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    expect(screen.queryByText(/영업시간/)).not.toBeInTheDocument();
  });

  it("falls back to the space code as the title when the room has no name yet", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom({ space_nm: null })}
        daily={[]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    expect(screen.getByText("MMCA-SPACE-2001")).toBeInTheDocument();
  });

  it("shows '정보 없음' when open but the room has no current status yet", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom({ congestion_nm: null })}
        daily={[]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    expect(screen.getByText("정보 없음")).toBeInTheDocument();
  });

  it("draws a smoothed curve through today's readings for just this room", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[
          dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유", "MMCA-SPACE-2008": "보통" }),
          dailyPoint("2026-07-15T10:15:00", { "MMCA-SPACE-2001": "붐빔", "MMCA-SPACE-2008": "여유" }),
        ]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    const line = screen.getByTestId("mmca-room-chart-line");
    const d = line.getAttribute("d") ?? "";
    expect(d).toMatch(/C/);
    expect(line.getAttribute("stroke")).toBe("#0071E3");
  });

  it("skips points where this room's reading is null", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[
          dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유" }),
          dailyPoint("2026-07-15T10:15:00", { "MMCA-SPACE-2001": null }),
          dailyPoint("2026-07-15T10:30:00", { "MMCA-SPACE-2001": "보통" }),
        ]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    // 2 valid points (null dropped) → exactly one Bezier "C" segment; a
    // spurious 3rd point would produce two.
    const d = screen.getByTestId("mmca-room-chart-line").getAttribute("d") ?? "";
    expect(d.match(/C/g)).toHaveLength(1);
  });

  it("extends the line back to a synthetic 여유 point at open when the :10 reading exists", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[
          dailyPoint("2026-07-15T10:10:00", { "MMCA-SPACE-2001": "여유" }),
          dailyPoint("2026-07-15T10:20:00", { "MMCA-SPACE-2001": "보통" }),
        ]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    // 2 real readings + 1 synthetic opening point → 2 Bezier segments.
    const d = screen.getByTestId("mmca-room-chart-line").getAttribute("d") ?? "";
    expect(d.match(/C/g)).toHaveLength(2);
  });

  it("skips the synthetic opening point when the :10 reading is missing", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[
          dailyPoint("2026-07-15T10:20:00", { "MMCA-SPACE-2001": "여유" }),
          dailyPoint("2026-07-15T10:30:00", { "MMCA-SPACE-2001": "보통" }),
        ]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    const d = screen.getByTestId("mmca-room-chart-line").getAttribute("d") ?? "";
    expect(d.match(/C/g)).toHaveLength(1);
  });

  it("never surfaces a hover tooltip for the synthetic opening point", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[
          dailyPoint("2026-07-15T10:10:00", { "MMCA-SPACE-2001": "여유" }),
          dailyPoint("2026-07-15T10:20:00", { "MMCA-SPACE-2001": "보통" }),
        ]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    const svg = screen.getByTestId("mmca-room-chart");
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 480, height: 200, right: 480, bottom: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const hoverTarget = svg.querySelector('rect[fill="transparent"]') as SVGRectElement;

    // Mouse all the way at the left edge, right over the synthetic 10:00 point.
    fireEvent.mouseMove(hoverTarget, { clientX: 0, clientY: 0 });

    // The decorative 10:00 여유 point isn't in the hover-eligible set, and no
    // other series reaches 10:00 — so there is nothing to report there.
    expect(screen.queryByTestId("mmca-room-chart-tooltip")).not.toBeInTheDocument();

    // The real 10:10 reading one grid step over is still hoverable.
    fireEvent.mouseMove(hoverTarget, { clientX: 10, clientY: 0 });
    const tooltip = within(screen.getByTestId("mmca-room-chart-tooltip"));
    expect(tooltip.getByText("10:10")).toBeInTheDocument();
    expect(tooltip.getByText(/^여유$/)).toBeInTheDocument();
  });

  it("shows the live glow marker only when open", () => {
    const props = {
      room: makeRoom(),
      daily: [
        dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유" }),
        dailyPoint("2026-07-15T14:15:00", { "MMCA-SPACE-2001": "붐빔" }),
      ],
      open: OPEN,
      close: CLOSE,
      nowMinutes: WITHIN_HOURS,
      now: NOW,
    };

    const { container, rerender } = render(<MmcaRoomChartCard {...props} isOpenToday />);
    // Glow renders as two circles (soft glow + white ring dot).
    expect(container.querySelectorAll("circle")).toHaveLength(2);

    rerender(<MmcaRoomChartCard {...props} isOpenToday={false} />);
    expect(container.querySelectorAll("circle")).toHaveLength(0);
  });

  it("renders a grey last-week line alongside this week's when both have data", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[
          dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유" }),
          dailyPoint("2026-07-15T10:15:00", { "MMCA-SPACE-2001": "보통" }),
        ]}
        lastWeekDaily={[
          dailyPoint("2026-07-08T10:00:00", { "MMCA-SPACE-2001": "붐빔" }),
          dailyPoint("2026-07-08T10:15:00", { "MMCA-SPACE-2001": "약간 붐빔" }),
        ]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    expect(screen.getByTestId("mmca-room-chart-line")).toBeInTheDocument();
    expect(screen.getByTestId("mmca-room-chart-last-week-line")).toBeInTheDocument();
  });

  it("omits the last-week line when lastWeekDaily is null or empty", () => {
    const dailyThisWeek = [
      dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유" }),
      dailyPoint("2026-07-15T10:15:00", { "MMCA-SPACE-2001": "보통" }),
    ];
    const { rerender } = render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={dailyThisWeek}
        lastWeekDaily={null}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );
    expect(screen.getByTestId("mmca-room-chart-line")).toBeInTheDocument();
    expect(screen.queryByTestId("mmca-room-chart-last-week-line")).not.toBeInTheDocument();

    rerender(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={dailyThisWeek}
        lastWeekDaily={[]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );
    expect(screen.queryByTestId("mmca-room-chart-last-week-line")).not.toBeInTheDocument();
  });

  it("shows the grey line on its own when this week has no data yet but last week does", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom({ congestion_nm: null, observed_at: null })}
        daily={[]}
        lastWeekDaily={[
          dailyPoint("2026-07-08T10:00:00", { "MMCA-SPACE-2001": "여유" }),
          dailyPoint("2026-07-08T10:30:00", { "MMCA-SPACE-2001": "보통" }),
        ]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    expect(screen.getByTestId("mmca-room-chart-last-week-line")).toBeInTheDocument();
    expect(screen.queryByTestId("mmca-room-chart-line")).not.toBeInTheDocument();
  });

  it("shows both labels in the tooltip when hovering a time both weeks have data near", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[
          dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유" }),
          dailyPoint("2026-07-15T10:15:00", { "MMCA-SPACE-2001": "보통" }),
        ]}
        lastWeekDaily={[dailyPoint("2026-07-08T10:00:00", { "MMCA-SPACE-2001": "붐빔" })]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    const svg = screen.getByTestId("mmca-room-chart");
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 480, height: 200, right: 480, bottom: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const hoverTarget = svg.querySelector('rect[fill="transparent"]') as SVGRectElement;

    // Left edge — nearest point is the 10:00 reading, which has a last-week
    // match at the same minute (10:00).
    fireEvent.mouseMove(hoverTarget, { clientX: 0, clientY: 0 });

    const tooltip = within(screen.getByTestId("mmca-room-chart-tooltip"));
    expect(tooltip.getByText(/지난주/)).toBeInTheDocument();
    expect(tooltip.getByText(/\(지난주/)).toBeInTheDocument();
  });

  it("does not match an adjacent 10-minute-grid reading when last week is missing the exact hovered time", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[
          dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유" }),
          dailyPoint("2026-07-15T10:15:00", { "MMCA-SPACE-2001": "보통" }),
        ]}
        // Gap at the exact hovered minute (10:00) — nearest last-week
        // readings are one grid step (10 minutes) away in each direction.
        // A same-time match must not fall back to either of these.
        lastWeekDaily={[
          dailyPoint("2026-07-08T09:50:00", { "MMCA-SPACE-2001": "붐빔" }),
          dailyPoint("2026-07-08T10:10:00", { "MMCA-SPACE-2001": "약간 붐빔" }),
        ]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    const svg = screen.getByTestId("mmca-room-chart");
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 480, height: 200, right: 480, bottom: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const hoverTarget = svg.querySelector('rect[fill="transparent"]') as SVGRectElement;

    // Left edge — nearest point is the 10:00 reading.
    fireEvent.mouseMove(hoverTarget, { clientX: 0, clientY: 0 });

    const tooltip = within(screen.getByTestId("mmca-room-chart-tooltip"));
    expect(tooltip.getByText(/^여유$/)).toBeInTheDocument();
    expect(tooltip.queryByText(/지난주/)).not.toBeInTheDocument();
  });

  it("shows the standalone '지난주' tooltip when hovering with only last-week data", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom({ congestion_nm: null, observed_at: null })}
        daily={[]}
        lastWeekDaily={[
          dailyPoint("2026-07-08T10:00:00", { "MMCA-SPACE-2001": "여유" }),
          dailyPoint("2026-07-08T10:30:00", { "MMCA-SPACE-2001": "보통" }),
        ]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    const svg = screen.getByTestId("mmca-room-chart");
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 480, height: 200, right: 480, bottom: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const hoverTarget = svg.querySelector('rect[fill="transparent"]') as SVGRectElement;

    fireEvent.mouseMove(hoverTarget, { clientX: 0, clientY: 0 });

    const tooltip = within(screen.getByTestId("mmca-room-chart-tooltip"));
    expect(tooltip.getByText(/지난주/)).toBeInTheDocument();
    expect(tooltip.queryByText(/\(지난주/)).not.toBeInTheDocument();
  });

  it("shows the standalone '지난주' tooltip over a time slot today hasn't reached yet, even though today has earlier data", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        // Today has one reading at 10:00. Last week has a 10:00 reading and
        // a 15:00 reading. Hovering near 15:00 must be closer to last
        // week's 15:00 point than to today's only (10:00) point, so it
        // must show the standalone last-week tooltip, not re-anchor to
        // today's 10:00 value.
        daily={[dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유" })]}
        lastWeekDaily={[
          dailyPoint("2026-07-08T10:00:00", { "MMCA-SPACE-2001": "붐빔" }),
          dailyPoint("2026-07-08T15:00:00", { "MMCA-SPACE-2001": "보통" }),
        ]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    const svg = screen.getByTestId("mmca-room-chart");
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 480, height: 200, right: 480, bottom: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const hoverTarget = svg.querySelector('rect[fill="transparent"]') as SVGRectElement;

    // clientX 300 = the 15:00 point's exact x position on this fixture's
    // axis (OPEN 10:00/600min, CLOSE 18:00/1080min) — 300 away from
    // today's only 10:00 point (x 0), 0 away from last week's 15:00 point.
    fireEvent.mouseMove(hoverTarget, { clientX: 300, clientY: 0 });

    const tooltip = within(screen.getByTestId("mmca-room-chart-tooltip"));
    expect(tooltip.getByText(/지난주/)).toBeInTheDocument();
    expect(tooltip.queryByText(/\(지난주/)).not.toBeInTheDocument();
  });
});

describe("MmcaRoomChartCard freshness badge", () => {
  function renderWithReading(observedAt: string | null) {
    render(
      <MmcaRoomChartCard
        room={makeRoom({ observed_at: observedAt })}
        daily={null}
        lastWeekDaily={null}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );
  }

  it("keeps the live badge for a recent reading", () => {
    renderWithReading("2026-07-15T14:18:00"); // 12분 전, 임계값 25분 이내
    expect(screen.getByText("실시간")).toBeInTheDocument();
    // 점은 신선도만 말한다 — 이 방의 등급이 무엇이든 신선하면 초록이다.
    expect(screen.getByTestId("freshness-dot")).toHaveStyle({ backgroundColor: "#34C759" });
  });

  it("says the reading has gone stale instead of claiming it is live", () => {
    renderWithReading("2026-07-15T13:50:00"); // 40분 전, 임계값 초과
    expect(screen.getByText("갱신 지연")).toBeInTheDocument();
    expect(screen.queryByText("실시간")).not.toBeInTheDocument();
    expect(screen.getByTestId("freshness-dot")).toHaveStyle({ backgroundColor: "#FF9F0A" });
  });

  it("does not claim live when today has no reading at all", () => {
    renderWithReading(null);
    expect(screen.queryByText("실시간")).not.toBeInTheDocument();
  });
});

describe("MmcaRoomChartCard past-day view", () => {
  function renderPastDay() {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[
          dailyPoint("2026-07-11T11:00:00", { "MMCA-SPACE-2001": "여유" }),
          dailyPoint("2026-07-11T14:00:00", { "MMCA-SPACE-2001": "붐빔" }),
        ]}
        lastWeekDaily={null}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        viewDate="2026-07-11"
        isOpenToday
      />
    );
  }

  it("drops the live badge and the current grade", () => {
    // 미래 탭에서는 지난주 같은 요일의 실제 기록을 대리로 그린다. 지나간 날의
    // 곡선 옆에 "실시간"이나 현재 등급을 놓으면 무엇을 보는지 알 수 없다.
    renderPastDay();

    expect(screen.getAllByText(/7\/11\(토\)/).length).toBeGreaterThan(0);
    expect(screen.queryByText("실시간")).not.toBeInTheDocument();
    expect(screen.queryByText("갱신 지연")).not.toBeInTheDocument();
    expect(screen.queryByText("약간 붐빔")).not.toBeInTheDocument();
  });

  it("draws the curve in the last-week grey, not the today blue", () => {
    // 오늘 차트의 회색 비교선과 같은 뜻이므로 색도 같아야 한다.
    renderPastDay();

    expect(screen.getByTestId("mmca-room-chart-line")).toHaveAttribute("stroke", "#D1D1D1");
  });

  it("labels the legend by the drawn date, not by today", () => {
    renderPastDay();

    expect(screen.queryByText(/오늘$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/지난주/)).not.toBeInTheDocument();
    expect(screen.getByTestId("mmca-room-chart")).toBeInTheDocument();
  });
});

describe("MmcaRoomChartCard 예측 점선", () => {
  it("draws a dashed prediction line", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[]}
        prediction={prediction([
          ["2026-07-15T14:30:00", 2],
          ["2026-07-15T16:00:00", 3],
        ])}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    const line = screen.getByTestId("mmca-room-chart-prediction-line");
    expect(line).toHaveAttribute("stroke-dasharray");
    // 실선과 같은 파랑 — 같은 축의 같은 대상이고 확정/예측만 다르다.
    expect(line).toHaveAttribute("stroke", "#0071E3");
  });

  it("does not fill an area under the prediction", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[]}
        prediction={prediction([
          ["2026-07-15T14:30:00", 2],
          ["2026-07-15T16:00:00", 3],
        ])}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    // 실선의 그라디언트 면은 "쌓인 사실"을 뜻한다. 예측에 같은 면을 주면
    // 확정된 것처럼 읽힌다.
    expect(screen.getByTestId("mmca-room-chart-prediction-line")).toHaveAttribute("fill", "none");
    expect(screen.queryByTestId("mmca-room-chart-prediction-area")).not.toBeInTheDocument();
  });

  it("renders the chart normally when there is no prediction", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[
          dailyPoint("2026-07-15T14:00:00", { "MMCA-SPACE-2001": "보통" }),
          dailyPoint("2026-07-15T14:30:00", { "MMCA-SPACE-2001": "약간 붐빔" }),
        ]}
        prediction={null}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    expect(screen.getByTestId("mmca-room-chart")).toBeInTheDocument();
    expect(
      screen.queryByTestId("mmca-room-chart-prediction-line")
    ).not.toBeInTheDocument();
  });

  it("skips a single-point prediction — one point cannot make a path", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[]}
        prediction={prediction([["2026-07-15T14:30:00", 2]])}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    expect(
      screen.queryByTestId("mmca-room-chart-prediction-line")
    ).not.toBeInTheDocument();
  });

  it("clips prediction points outside business hours", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[]}
        prediction={prediction([
          ["2026-07-15T14:30:00", 2],
          ["2026-07-15T16:00:00", 3],
          ["2026-07-15T20:00:00", 3], // CLOSE(18:00) 밖 — 잘려야 한다
        ])}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    const d = screen.getByTestId("mmca-room-chart-prediction-line").getAttribute("d")!;
    // smoothPath 는 점 N개에서 C 세그먼트를 N-1개 낸다. 20:00 이 잘리면 2점이
    // 남아 C 가 정확히 1개다. (좌표를 정규식으로 파싱하지 않는다 — smoothPath
    // 는 쉼표와 공백을 섞어 출력해서 오파싱하기 쉽다.)
    expect((d.match(/C/g) ?? []).length).toBe(1);
  });

  it("draws the dashed line on top of the solid one", () => {
    const { container } = render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[
          dailyPoint("2026-07-15T14:00:00", { "MMCA-SPACE-2001": "보통" }),
          dailyPoint("2026-07-15T14:30:00", { "MMCA-SPACE-2001": "약간 붐빔" }),
        ]}
        prediction={prediction([
          ["2026-07-15T14:30:00", 2],
          ["2026-07-15T16:00:00", 3],
        ])}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    // SVG 는 그린 순서대로 겹친다 — 예측선이 실선보다 뒤에 와야 위에 보인다.
    const paths = Array.from(container.querySelectorAll("path"));
    const solid = paths.findIndex((p) => p.dataset.testid === "mmca-room-chart-line");
    const dashed = paths.findIndex((p) => p.dataset.testid === "mmca-room-chart-prediction-line");
    expect(solid).toBeGreaterThanOrEqual(0);
    expect(dashed).toBeGreaterThan(solid);
  });

  it("joins the dashed line's first point to the solid line's last point", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[
          dailyPoint("2026-07-15T14:00:00", { "MMCA-SPACE-2001": "보통" }),
          dailyPoint("2026-07-15T14:30:00", { "MMCA-SPACE-2001": "약간 붐빔" }),
        ]}
        // 예측의 첫 점이 실선의 마지막 판독(14:30, 약간 붐빔=tier 2)과
        // 정확히 같다 — 이음매가 이 기능의 전제다.
        prediction={prediction([
          ["2026-07-15T14:30:00", 2],
          ["2026-07-15T16:00:00", 3],
        ])}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    const solidD = screen.getByTestId("mmca-room-chart-line").getAttribute("d") ?? "";
    const dashedD = screen.getByTestId("mmca-room-chart-prediction-line").getAttribute("d") ?? "";

    // solidD 는 "...C cp1x cp1y, cp2x cp2y, LASTX LASTY" 로 끝난다 — 마지막
    // 좌표쌍은 끝에서 가장 가까운 쉼표 뒤에 온다. dashedD 는 "M X Y ..." 로
    // 시작한다. smoothPath 가 쉼표와 공백을 섞어 써서 전체를 정규식으로 잘라
    // 읽으면 오파싱하기 쉬우니, 이 두 토큰만 짚는다.
    const solidEnd = solidD.match(/,\s*(-?[\d.]+)\s+(-?[\d.]+)$/);
    const dashedStart = dashedD.match(/^M\s+(-?[\d.]+)\s+(-?[\d.]+)/);
    expect(solidEnd).not.toBeNull();
    expect(dashedStart).not.toBeNull();
    expect(Number(dashedStart![1])).toBe(Number(solidEnd![1]));
    expect(Number(dashedStart![2])).toBe(Number(solidEnd![2]));
  });

  it("re-anchors a stale prediction seam to the solid line's real last point", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[
          dailyPoint("2026-07-15T15:00:00", { "MMCA-SPACE-2001": "보통" }),
          dailyPoint("2026-07-15T15:30:00", { "MMCA-SPACE-2001": "약간 붐빔" }),
        ]}
        // /mmca/prediction 은 60초 캐시, /mmca/daily 는 캐시가 없다 — 최대 한
        // 폴링만큼 예측이 낡아, 이음매(15:20)가 실선의 실제 마지막 판독
        // (15:30)보다 한 그리드 스텝 뒤처진 상황을 흉내낸다.
        prediction={prediction([
          ["2026-07-15T15:20:00", 1],
          ["2026-07-15T16:00:00", 3],
        ])}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    const solidD = screen.getByTestId("mmca-room-chart-line").getAttribute("d") ?? "";
    const dashedD = screen.getByTestId("mmca-room-chart-prediction-line").getAttribute("d") ?? "";

    const solidEnd = solidD.match(/,\s*(-?[\d.]+)\s+(-?[\d.]+)$/);
    const dashedStart = dashedD.match(/^M\s+(-?[\d.]+)\s+(-?[\d.]+)/);
    expect(solidEnd).not.toBeNull();
    expect(dashedStart).not.toBeNull();
    // 점선은 낡은 15:20 이 아니라 실선의 실제 마지막 점(15:30)에서 시작한다.
    expect(Number(dashedStart![1])).toBe(Number(solidEnd![1]));
    expect(Number(dashedStart![2])).toBe(Number(solidEnd![2]));
    // 15:20 이 이음매 뒤에 별도 점으로 끼어들지 않는다 — 남는 점은 15:30(이음매)
    // 과 16:00 뿐이라 세그먼트("C")는 정확히 1개다. 15:20 이 살아남으면
    // (재이음 없이 그대로 붙거나, 걸러지지 않고 끼어들면) 2개가 된다.
    expect((dashedD.match(/C/g) ?? []).length).toBe(1);
  });

  it("labels the prediction in the legend, noting when today anchors it", () => {
    const { rerender } = render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[]}
        prediction={prediction([
          ["2026-07-15T14:30:00", 2],
          ["2026-07-15T16:00:00", 3],
        ])}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    expect(screen.getByText("예측 (오늘 반영)")).toBeInTheDocument();

    rerender(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[]}
        prediction={prediction(
          [
            ["2026-07-15T14:30:00", 2],
            ["2026-07-15T16:00:00", 3],
          ],
          { anchored: false }
        )}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    expect(screen.getByText("예측")).toBeInTheDocument();
    expect(screen.queryByText("예측 (오늘 반영)")).not.toBeInTheDocument();
  });

  it("keeps the whole future-tab curve — the D−7 proxy line must not re-anchor it", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        // MmcaPage 는 미래 탭에서 chartDate(=D−7)를 viewDate 로 넘긴다 — 그래서
        // daily 는 오늘의 판독이 아니라 지난주 같은 요일의 대리 기록이고,
        // 늦은 시각(17:50)까지 이미 다 차 있다.
        viewDate="2026-07-08"
        daily={[
          dailyPoint("2026-07-08T10:00:00", { "MMCA-SPACE-2001": "여유" }),
          dailyPoint("2026-07-08T14:00:00", { "MMCA-SPACE-2001": "보통" }),
          dailyPoint("2026-07-08T17:50:00", { "MMCA-SPACE-2001": "붐빔" }),
        ]}
        // 예측은 미래 날짜의 하루 전체를 덮는다.
        prediction={prediction([
          ["2026-07-22T10:00:00", 0],
          ["2026-07-22T12:00:00", 1],
          ["2026-07-22T14:00:00", 2],
          ["2026-07-22T16:00:00", 3],
        ])}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    const dashedD = screen
      .getByTestId("mmca-room-chart-prediction-line")
      .getAttribute("d") ?? "";
    const dashedStart = dashedD.match(/^M\s+(-?[\d.]+)\s+(-?[\d.]+)/);
    expect(dashedStart).not.toBeNull();
    // 점선은 예측의 첫 점(OPEN 10:00 → x 0)에서 시작한다. 실선의 마지막 판독
    // (17:50 → x 470)로 재이음되면 10:00~17:00 이 전부 걸러져 점이 하나만 남고
    // 곡선이 아예 사라진다.
    expect(Number(dashedStart![1])).toBe(0);
    // 네 점이 모두 살아남아 C 세그먼트는 3개다.
    expect((dashedD.match(/C/g) ?? []).length).toBe(3);
  });
});

describe("MmcaRoomChartCard hover (x 기준)", () => {
  // OPEN 10:00~CLOSE 18:00(480분)을 480px 에 그리므로 1분 = 1px 이다.
  function hoverAtMinute(minutes: number) {
    const svg = screen.getByTestId("mmca-room-chart");
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 480, height: 200, right: 480, bottom: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const hoverTarget = svg.querySelector('rect[fill="transparent"]') as SVGRectElement;
    fireEvent.mouseMove(hoverTarget, { clientX: minutes - OPEN, clientY: 0 });
  }

  const TODAY_WITH_PREDICTION = {
    room: makeRoom(),
    daily: [
      dailyPoint("2026-07-15T14:00:00", { "MMCA-SPACE-2001": "보통" }),
      dailyPoint("2026-07-15T14:30:00", { "MMCA-SPACE-2001": "약간 붐빔" }),
    ],
    lastWeekDaily: [
      dailyPoint("2026-07-08T14:00:00", { "MMCA-SPACE-2001": "여유" }),
      dailyPoint("2026-07-08T14:30:00", { "MMCA-SPACE-2001": "여유" }),
      dailyPoint("2026-07-08T16:00:00", { "MMCA-SPACE-2001": "보통" }),
    ],
    prediction: prediction([
      ["2026-07-15T14:30:00", 2],
      ["2026-07-15T16:00:00", 3],
    ]),
    open: OPEN,
    close: CLOSE,
    nowMinutes: WITHIN_HOURS,
    now: NOW,
    isOpenToday: true,
  };

  it("실측이 있는 x 에서는 실측과 지난주만 말한다 — 예측은 끼지 않는다", () => {
    render(<MmcaRoomChartCard {...TODAY_WITH_PREDICTION} />);

    hoverAtMinute(14 * 60);

    const tooltip = within(screen.getByTestId("mmca-room-chart-tooltip"));
    expect(tooltip.getByText("14:00")).toBeInTheDocument();
    expect(tooltip.getByText(/^보통$/)).toBeInTheDocument();
    expect(tooltip.getByText(/\(지난주 여유\)/)).toBeInTheDocument();
    expect(tooltip.queryByText(/예측/)).not.toBeInTheDocument();
  });

  it("오늘 실측이 끝난 뒤의 x 에서는 예측을 말한다", () => {
    render(<MmcaRoomChartCard {...TODAY_WITH_PREDICTION} />);

    // 16:00 — 실측은 14:30 에서 끝났고 예측의 마지막 점(붐빔)이 여기다.
    hoverAtMinute(16 * 60);

    const tooltip = within(screen.getByTestId("mmca-room-chart-tooltip"));
    expect(tooltip.getByText("16:00")).toBeInTheDocument();
    expect(tooltip.getByText(/예측/)).toBeInTheDocument();
    expect(tooltip.getByText(/^붐빔$/)).toBeInTheDocument();
    expect(tooltip.getByText(/\(지난주 보통\)/)).toBeInTheDocument();
    // 실측 계열의 마지막 값(약간 붐빔)을 주값으로 내밀지 않는다.
    expect(tooltip.queryByText(/^약간 붐빔$/)).not.toBeInTheDocument();
  });

  it("이음매(예측 첫 점 == 실측 마지막 판독)에서는 실측만 말한다", () => {
    render(<MmcaRoomChartCard {...TODAY_WITH_PREDICTION} />);

    hoverAtMinute(14 * 60 + 30);

    const tooltip = within(screen.getByTestId("mmca-room-chart-tooltip"));
    expect(tooltip.getByText(/^약간 붐빔$/)).toBeInTheDocument();
    // 값이 확정된 자리에 나란히 놓인 추정치는 잡음이다.
    expect(tooltip.queryByText(/예측/)).not.toBeInTheDocument();
  });

  // MmcaPage 는 미래 탭에서 chartDate(=D−7)를 viewDate 로 넘기고 lastWeekDaily
  // 를 null 로 둔다 — daily 는 오늘의 판독이 아니라 지난주 같은 요일의 대리
  // 기록이라 하루가 다 차 있고, 그 회색 곡선이 이 탭의 비교 시리즈다.
  const FUTURE_TAB = {
    room: makeRoom(),
    viewDate: "2026-07-08",
    daily: [
      dailyPoint("2026-07-08T10:00:00", { "MMCA-SPACE-2001": "여유" }),
      dailyPoint("2026-07-08T12:00:00", { "MMCA-SPACE-2001": "붐빔" }),
      dailyPoint("2026-07-08T14:00:00", { "MMCA-SPACE-2001": "붐빔" }),
    ],
    lastWeekDaily: null,
    prediction: prediction([
      ["2026-07-22T10:00:00", 0],
      ["2026-07-22T12:00:00", 1],
      ["2026-07-22T14:00:00", 2],
      ["2026-07-22T16:00:00", 3],
    ]),
    open: OPEN,
    close: CLOSE,
    nowMinutes: WITHIN_HOURS,
    now: NOW,
    isOpenToday: true,
  };

  it("미래 탭에서는 D−7 대리 기록이 예측을 가리지 않는다", () => {
    render(<MmcaRoomChartCard {...FUTURE_TAB} />);

    // 대리 기록이 붐빔인 12:00 을 짚는다 — 실측 억제를 isTodayView 로 가두지
    // 않으면 여기서 예측이 사라진다.
    hoverAtMinute(12 * 60);

    const tooltip = within(screen.getByTestId("mmca-room-chart-tooltip"));
    expect(tooltip.getByText(/예측/)).toBeInTheDocument();
    expect(tooltip.getByText(/^보통$/)).toBeInTheDocument();
  });

  it("미래 탭의 괄호는 D−7 대리 기록으로 채운다 — 비교 시리즈가 탭마다 다른 prop 에 있다", () => {
    render(<MmcaRoomChartCard {...FUTURE_TAB} />);

    hoverAtMinute(12 * 60);

    // 회색 곡선에 마커를 찍어놓고 툴팁은 예측만 말하면, 마커와 툴팁이 커서
    // 아래에 무엇이 있는지를 두고 서로 다른 말을 한다.
    const tooltip = within(screen.getByTestId("mmca-room-chart-tooltip"));
    expect(tooltip.getByText(/예측/)).toBeInTheDocument();
    expect(tooltip.getByText(/\(지난주 붐빔\)/)).toBeInTheDocument();
  });

  it("시간 단위 예측 점 사이를 짚어도 값이 나온다 — 선형 보간", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유" })]}
        prediction={prediction([
          ["2026-07-15T16:00:00", 1],
          ["2026-07-15T17:00:00", 3],
        ])}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    // 16:30 — 양 끝(보통, 붐빔) 어디에도 없는 중간값 tier 2.0 이 나와야 한다.
    hoverAtMinute(16 * 60 + 30);

    const tooltip = within(screen.getByTestId("mmca-room-chart-tooltip"));
    expect(tooltip.getByText("16:30")).toBeInTheDocument();
    expect(tooltip.getByText(/예측/)).toBeInTheDocument();
    expect(tooltip.getByText(/^약간 붐빔$/)).toBeInTheDocument();
  });

  it("지난주만 있는 x 에서는 지난주만 말한다", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom({ congestion_nm: null, observed_at: null })}
        daily={[]}
        lastWeekDaily={[
          dailyPoint("2026-07-08T12:00:00", { "MMCA-SPACE-2001": "보통" }),
          dailyPoint("2026-07-08T13:00:00", { "MMCA-SPACE-2001": "붐빔" }),
        ]}
        // 예측은 오후만 덮는다 — 12:00 은 예측 구간 밖이다.
        prediction={prediction([
          ["2026-07-15T14:00:00", 2],
          ["2026-07-15T16:00:00", 3],
        ])}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    hoverAtMinute(12 * 60);

    const tooltip = within(screen.getByTestId("mmca-room-chart-tooltip"));
    expect(tooltip.getByText(/지난주/)).toBeInTheDocument();
    expect(tooltip.getByText(/^보통$/)).toBeInTheDocument();
    expect(tooltip.queryByText(/\(지난주/)).not.toBeInTheDocument();
    expect(tooltip.queryByText(/예측/)).not.toBeInTheDocument();
  });

  it("어느 계열도 값이 없는 x 에서는 툴팁을 아예 그리지 않는다", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom({ congestion_nm: null, observed_at: null })}
        daily={[]}
        lastWeekDaily={[dailyPoint("2026-07-08T10:00:00", { "MMCA-SPACE-2001": "여유" })]}
        prediction={prediction([
          ["2026-07-15T15:00:00", 2],
          ["2026-07-15T16:00:00", 3],
        ])}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    // 12:00 — 지난주는 두 시간 떨어져 있고 예측 구간(15:00~16:00)도 아니다.
    hoverAtMinute(12 * 60);

    // 빈 껍데기도, "정보 없음" 줄도 놓지 않는다.
    expect(screen.queryByTestId("mmca-room-chart-tooltip")).not.toBeInTheDocument();
  });

  it("예측 구간의 마지막 점을 지난 x 에는 예측값이 없다", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom({ congestion_nm: null, observed_at: null })}
        daily={[]}
        lastWeekDaily={[dailyPoint("2026-07-08T17:00:00", { "MMCA-SPACE-2001": "보통" })]}
        prediction={prediction([
          ["2026-07-15T15:00:00", 2],
          ["2026-07-15T16:00:00", 3],
        ])}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    // 17:00 — 예측의 마지막 점(16:00)보다 뒤다. 마지막 점의 값을 오른쪽으로
    // 무한히 끌고 가면 안 된다.
    hoverAtMinute(17 * 60);

    const tooltip = within(screen.getByTestId("mmca-room-chart-tooltip"));
    expect(tooltip.getByText(/지난주/)).toBeInTheDocument();
    expect(tooltip.queryByText(/예측/)).not.toBeInTheDocument();
  });

  it("시계는 커서의 x 가 아니라 걸린 판독 자신의 시각을 적는다", () => {
    render(<MmcaRoomChartCard {...TODAY_WITH_PREDICTION} />);

    // 14:32 를 짚으면 매칭 창(5분) 안의 14:30 판독이 걸린다 — 등급은 14:30 것
    // 이므로 시계도 14:30 이라야 한다.
    hoverAtMinute(14 * 60 + 32);

    const tooltip = within(screen.getByTestId("mmca-room-chart-tooltip"));
    expect(tooltip.getByText("14:30")).toBeInTheDocument();
    expect(tooltip.queryByText("14:32")).not.toBeInTheDocument();
  });

  it("값이 있는 계열마다 자기 y 에 마커를 하나씩 찍는다", () => {
    const { container } = render(<MmcaRoomChartCard {...TODAY_WITH_PREDICTION} />);

    // 14:00 — 오늘은 보통(tier 1), 지난주는 여유(tier 0).
    hoverAtMinute(14 * 60);

    // r=4 는 hover 마커만 쓴다 (실시간 글로우는 r=14 / r=4.5).
    const markers = Array.from(container.querySelectorAll('circle[r="4"]'));
    expect(markers).toHaveLength(2);
    expect(new Set(markers.map((c) => c.getAttribute("cy"))).size).toBe(2);
  });
});
