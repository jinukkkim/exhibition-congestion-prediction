import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MmcaRoomChartCard } from "../src/components/MmcaRoomChartCard";
import type { MmcaDailyLogPoint, MmcaRoomStatus } from "../src/api/mmca";

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

    // Nearest interactive point is the real 10:10 reading, never the
    // decorative 10:00 one — it isn't part of the hover-eligible point set.
    expect(screen.getByText("10:10")).toBeInTheDocument();
    expect(screen.queryByText("10:00")).not.toBeInTheDocument();
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
