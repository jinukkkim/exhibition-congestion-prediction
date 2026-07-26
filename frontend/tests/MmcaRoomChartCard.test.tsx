import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MmcaRoomChartCard } from "../src/components/MmcaRoomChartCard";
import * as api from "../src/api/mmca";
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

describe("MmcaRoomChartCard", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-15T14:30:00")); // Wed, within 10:00-21:00
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders the room name and current status headline", async () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);

    render(<MmcaRoomChartCard venue="gwacheon" spaceCode="MMCA-SPACE-2001" room={makeRoom()} />);

    expect(screen.getByText("1전시실")).toBeInTheDocument();
    expect(screen.getByText("약간 붐빔")).toBeInTheDocument();
  });

  it("shows '영업 시간이 아닙니다' outside business hours", async () => {
    vi.setSystemTime(new Date("2026-07-16T20:00:00")); // Thu closes at 18:00
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);

    render(<MmcaRoomChartCard venue="gwacheon" spaceCode="MMCA-SPACE-2001" room={makeRoom()} />);

    expect(screen.getByText("영업 시간이 아닙니다")).toBeInTheDocument();
    expect(screen.queryByText("약간 붐빔")).not.toBeInTheDocument();
  });

  it("shows '정보 없음' when open but no current room status yet", () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);

    render(<MmcaRoomChartCard venue="gwacheon" spaceCode="MMCA-SPACE-2001" room={undefined} />);

    expect(screen.getByText("정보 없음")).toBeInTheDocument();
  });

  it("draws a step line through today's readings for just this room", async () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([
      dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유", "MMCA-SPACE-2008": "보통" }),
      dailyPoint("2026-07-15T10:15:00", { "MMCA-SPACE-2001": "붐빔", "MMCA-SPACE-2008": "여유" }),
    ]);

    render(<MmcaRoomChartCard venue="gwacheon" spaceCode="MMCA-SPACE-2001" room={makeRoom()} />);

    await waitFor(() => expect(screen.getByTestId("mmca-room-chart-line")).toBeInTheDocument());
    const d = screen.getByTestId("mmca-room-chart-line").getAttribute("d") ?? "";
    // Step path, never a curve: no Bezier command, and exactly one "L L" hop
    // (2 L commands) for the 2-point mock data.
    expect(d).not.toMatch(/C/);
    expect(d.match(/L/g)).toHaveLength(2);
  });

  it("skips points where this room's reading is null", async () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([
      dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유" }),
      dailyPoint("2026-07-15T10:15:00", { "MMCA-SPACE-2001": null }),
      dailyPoint("2026-07-15T10:30:00", { "MMCA-SPACE-2001": "보통" }),
    ]);

    render(<MmcaRoomChartCard venue="gwacheon" spaceCode="MMCA-SPACE-2001" room={makeRoom()} />);

    // The null point must be dropped, not crash the path — 2 valid points remain.
    await waitFor(() => expect(screen.getByTestId("mmca-room-chart-line")).toBeInTheDocument());
    const d = screen.getByTestId("mmca-room-chart-line").getAttribute("d") ?? "";
    // 2 valid points → 2 L commands; a spurious 3rd (from the null point
    // being plotted instead of skipped) would produce 4.
    expect(d.match(/L/g)).toHaveLength(2);
  });

  it("shows the live glow marker only when open", async () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([
      dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유" }),
      dailyPoint("2026-07-15T14:15:00", { "MMCA-SPACE-2001": "붐빔" }),
    ]);

    const { container } = render(
      <MmcaRoomChartCard venue="gwacheon" spaceCode="MMCA-SPACE-2001" room={makeRoom()} />
    );

    // Glow renders as two circles (soft glow + white ring dot).
    await waitFor(() => expect(container.querySelectorAll("circle")).toHaveLength(2));
  });

  it("shows no glow marker outside business hours", async () => {
    vi.setSystemTime(new Date("2026-07-16T20:00:00")); // Thu closes at 18:00
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([
      dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유" }),
      dailyPoint("2026-07-15T14:15:00", { "MMCA-SPACE-2001": "붐빔" }),
    ]);

    const { container } = render(
      <MmcaRoomChartCard venue="gwacheon" spaceCode="MMCA-SPACE-2001" room={makeRoom()} />
    );

    await waitFor(() => expect(container.querySelectorAll("circle")).toHaveLength(0));
  });

  it("fetches with the venue prop and today's date", async () => {
    const fetchMmcaDailyMock = vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);

    render(<MmcaRoomChartCard venue="gwacheon" spaceCode="MMCA-SPACE-2001" room={makeRoom()} />);

    await waitFor(() => expect(fetchMmcaDailyMock).toHaveBeenCalledWith("gwacheon", "2026-07-15"));
  });
});
