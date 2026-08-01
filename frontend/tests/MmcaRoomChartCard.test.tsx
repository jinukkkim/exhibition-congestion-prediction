import { fireEvent, render, screen } from "@testing-library/react";
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

describe("MmcaRoomChartCard", () => {
  it("renders the room name and current status headline when open", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
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
        isOpenToday={false}
      />
    );

    // A closed weekly day (e.g. Deoksugung on Monday) is not the same thing
    // as "outside hours today" — it must not claim hours it doesn't have.
    expect(screen.getByText("휴관일입니다")).toBeInTheDocument();
    expect(screen.getByText("휴관일")).toBeInTheDocument();
    expect(screen.getByText("오늘은 휴관일입니다")).toBeInTheDocument();
    expect(screen.queryByText(/오늘 영업시간/)).not.toBeInTheDocument();
    expect(screen.queryByText("영업 시간이 아닙니다")).not.toBeInTheDocument();
  });

  it("falls back to the space code as the title when the room has no name yet", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom({ space_nm: null })}
        daily={[]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        isOpenToday
      />
    );

    expect(screen.getByText("MMCA-SPACE-2001")).toBeInTheDocument();
  });

  it("shows '서비스 예정' instead of the chart for a disabled room, keeping the title", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom({ space_code: "MMCA-SPACE-2008", space_nm: "1층 어린이미술관", congestion_nm: "여유" })}
        daily={[]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        isOpenToday
      />
    );

    expect(screen.getByText("1층 어린이미술관")).toBeInTheDocument();
    expect(screen.getByText("서비스 예정")).toBeInTheDocument();
    expect(screen.queryByText("여유")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mmca-room-chart")).not.toBeInTheDocument();
  });

  it("shows '정보 없음' when open but the room has no current status yet", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom({ congestion_nm: null })}
        daily={[]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
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
    };

    const { container, rerender } = render(<MmcaRoomChartCard {...props} isOpenToday />);
    // Glow renders as two circles (soft glow + white ring dot).
    expect(container.querySelectorAll("circle")).toHaveLength(2);

    rerender(<MmcaRoomChartCard {...props} isOpenToday={false} />);
    expect(container.querySelectorAll("circle")).toHaveLength(0);
  });
});
