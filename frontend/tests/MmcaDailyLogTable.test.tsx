import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MmcaDailyLogTable } from "../src/components/MmcaDailyLogTable";
import { todayString } from "../src/lib/date";
import * as api from "../src/api/mmca";
import type { MmcaDailyLogPoint, MmcaDailyRoom } from "../src/api/mmca";

// Mirrors the MMCA earliestDate in venues.ts. Written out by hand rather than
// imported: reading it from the source under test would let a wrong value there
// agree with itself and pass.
const EARLIEST_DATE = "2026-07-26";

function makeRow(observedAt: string, rooms: MmcaDailyRoom[]): MmcaDailyLogPoint {
  return { observed_at: observedAt, rooms };
}

describe("MmcaDailyLogTable", () => {
  it("renders a column per room and colors cells by congestion", async () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([
      makeRow("2026-07-25T15:00:00", [
        { space_code: "MMCA-SPACE-1001", space_nm: "1전시실", congestion_nm: "여유" },
        { space_code: "MMCA-SPACE-1002", space_nm: "2전시실", congestion_nm: "보통" },
      ]),
    ]);

    render(<MmcaDailyLogTable venue="seoul" />);

    await waitFor(() => expect(screen.getByText("1전시실")).toBeInTheDocument());
    expect(screen.getByText("2전시실")).toBeInTheDocument();
    expect(screen.getByText("15:00")).toBeInTheDocument();
    expect(screen.getByText("여유")).toBeInTheDocument();
    expect(screen.getByText("보통")).toBeInTheDocument();
  });

  it("falls back to the space code as a header when space_nm is null", async () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([
      makeRow("2026-07-25T15:00:00", [
        { space_code: "MMCA-SPACE-4001", space_nm: null, congestion_nm: null },
      ]),
    ]);

    render(<MmcaDailyLogTable venue="deoksugung" />);

    await waitFor(() => expect(screen.getByText("MMCA-SPACE-4001")).toBeInTheDocument());
  });

  it("shows an empty-state message when there is no data for the day", async () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);

    render(<MmcaDailyLogTable venue="seoul" />);

    await waitFor(() => expect(screen.getByText(/데이터 없음/)).toBeInTheDocument());
  });

  it("disables the next-day button when viewing today", async () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);

    render(<MmcaDailyLogTable venue="seoul" />);

    await waitFor(() => screen.getByText(/데이터 없음/));
    expect(screen.getByRole("button", { name: /다음 날짜/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /이전 날짜/ })).not.toBeDisabled();
  });

  it("disables the previous-day button at the venue's first collection date", async () => {
    // 경계가 없으면 수집을 시작하기도 전의 날짜로 끝없이 넘어간다 — 눌러도
    // "데이터 없음"만 나오고, 얼마나 더 가야 무엇이 있는지 알 길도 없다.
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);

    render(<MmcaDailyLogTable venue="seoul" />);
    await waitFor(() => screen.getByText(/데이터 없음/));

    const prevButton = screen.getByRole("button", { name: /이전 날짜/ });
    // Count the clicks from todayString() — the same Asia/Seoul clock the
    // component starts from. `new Date()` would count days in the runner's
    // zone, and CI runs in UTC, which sits a day behind Seoul for nine hours
    // out of every twenty-four; the walk would stop a day short. Parsing both
    // ends as UTC keeps the subtraction itself free of the runner's zone.
    const daysToEarliest = Math.round(
      (Date.parse(`${todayString()}T00:00:00Z`) - Date.parse(`${EARLIEST_DATE}T00:00:00Z`)) /
        86_400_000
    );

    for (let i = 0; i < daysToEarliest; i++) {
      fireEvent.click(prevButton);
      await waitFor(() => screen.getByText(/데이터 없음/));
    }

    expect(screen.getByText(EARLIEST_DATE)).toBeInTheDocument();
    expect(prevButton).toBeDisabled();
  });

  it("stops later than the Seoul table does — the two collectors started ten days apart", async () => {
    // 한 값을 두 표가 나눠 쓰면 늦게 시작한 관이 있지도 않은 열흘을 넘겨보게
    // 된다. 관별 경계가 실제로 지켜지는지 확인한다.
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);

    render(<MmcaDailyLogTable venue="gwacheon" />);
    await waitFor(() => screen.getByText(/데이터 없음/));

    const prevButton = screen.getByRole("button", { name: /이전 날짜/ });
    const daysToEarliest = Math.round(
      (Date.parse(`${todayString()}T00:00:00Z`) - Date.parse(`${EARLIEST_DATE}T00:00:00Z`)) /
        86_400_000
    );

    // 국립중앙박물관 경계(2026-07-16)까지 가려면 열흘이 더 필요하다. 그만큼
    // 눌러도 표는 MMCA 시작일에 그대로 서 있어야 한다.
    for (let i = 0; i < daysToEarliest + 10; i++) {
      fireEvent.click(prevButton);
      await waitFor(() => screen.getByText(/데이터 없음/));
    }

    expect(screen.getByText(EARLIEST_DATE)).toBeInTheDocument();
  });

  it("re-fetches for the previous day with the venue prop when the previous button is clicked", async () => {
    const fetchMmcaDailyMock = vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);

    render(<MmcaDailyLogTable venue="gwacheon" />);
    await waitFor(() => expect(fetchMmcaDailyMock).toHaveBeenCalledTimes(1));
    expect(fetchMmcaDailyMock.mock.calls[0][0]).toBe("gwacheon");

    fireEvent.click(screen.getByRole("button", { name: /이전 날짜/ }));

    await waitFor(() => expect(fetchMmcaDailyMock).toHaveBeenCalledTimes(2));
    const firstCallDate = fetchMmcaDailyMock.mock.calls[0][1];
    const secondCallDate = fetchMmcaDailyMock.mock.calls[1][1];
    expect(secondCallDate < firstCallDate).toBe(true);
  });

  it("shows the most recent reading first", async () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([
      makeRow("2026-07-25T15:00:00", [
        { space_code: "MMCA-SPACE-1001", space_nm: "1전시실", congestion_nm: "여유" },
      ]),
      makeRow("2026-07-25T15:15:00", [
        { space_code: "MMCA-SPACE-1001", space_nm: "1전시실", congestion_nm: "보통" },
      ]),
    ]);

    render(<MmcaDailyLogTable venue="seoul" />);
    await waitFor(() => expect(screen.getByText("15:15")).toBeInTheDocument());

    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("15:15");
    expect(rows[2]).toHaveTextContent("15:00");
  });

  it("ignores a stale response that resolves after a newer request", async () => {
    let resolveFirst: (rows: MmcaDailyLogPoint[]) => void = () => {};
    let resolveSecond: (rows: MmcaDailyLogPoint[]) => void = () => {};

    const fetchMmcaDailyMock = vi
      .spyOn(api, "fetchMmcaDaily")
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));

    render(<MmcaDailyLogTable venue="seoul" />);
    await waitFor(() => expect(fetchMmcaDailyMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /이전 날짜/ }));
    await waitFor(() => expect(fetchMmcaDailyMock).toHaveBeenCalledTimes(2));

    resolveSecond([
      makeRow("2026-07-24T09:00:00", [
        { space_code: "MMCA-SPACE-1001", space_nm: "1전시실", congestion_nm: "여유" },
      ]),
    ]);
    await waitFor(() => expect(screen.getByText("09:00")).toBeInTheDocument());

    resolveFirst([
      makeRow("2026-07-25T15:00:00", [
        { space_code: "MMCA-SPACE-1001", space_nm: "1전시실", congestion_nm: "보통" },
      ]),
    ]);
    await waitFor(() => expect(screen.getByText("09:00")).toBeInTheDocument());
    expect(screen.queryByText("15:00")).not.toBeInTheDocument();
  });
});
