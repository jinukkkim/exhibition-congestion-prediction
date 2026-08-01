import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MmcaPage } from "../src/pages/MmcaPage";
import * as api from "../src/api/mmca";
import type { MmcaRoomStatus } from "../src/api/mmca";

function makeRoom(overrides: Partial<MmcaRoomStatus> = {}): MmcaRoomStatus {
  return {
    space_code: "MMCA-SPACE-1001",
    space_nm: "1전시실",
    congestion_nm: "여유",
    observed_at: "2026-07-24T10:00:00",
    ...overrides,
  };
}

describe("MmcaPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders a chart card per room after loading", async () => {
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([
      makeRoom(),
      makeRoom({ space_code: "MMCA-SPACE-1002", space_nm: "2전시실", congestion_nm: "보통" }),
    ]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("1전시실")).toBeInTheDocument());
    expect(screen.getByText("2전시실")).toBeInTheDocument();
    expect(screen.getAllByTestId("mmca-room-chart")).toHaveLength(2);
  });

  it("shows an error message when the fetch fails before anything loads", async () => {
    vi.spyOn(api, "fetchMmcaRooms").mockRejectedValue(new Error("network error"));

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("불러오지 못했습니다.")).toBeInTheDocument());
  });

  it("polls rooms again after 60 seconds", async () => {
    const fetchMmcaRooms = vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(fetchMmcaRooms).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMmcaRooms).toHaveBeenCalledTimes(2);
  });

  it("keeps showing stale data when a poll fails after an initial success", async () => {
    const fetchMmcaRooms = vi
      .spyOn(api, "fetchMmcaRooms")
      .mockResolvedValueOnce([makeRoom()])
      .mockRejectedValueOnce(new Error("network error"));

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("1전시실")).toBeInTheDocument());

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMmcaRooms).toHaveBeenCalledTimes(2);
    expect(screen.getByText("1전시실")).toBeInTheDocument();
    expect(screen.queryByText("불러오지 못했습니다.")).not.toBeInTheDocument();
  });

  it("stops polling and ignores in-flight responses after unmount", async () => {
    const fetchMmcaRooms = vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);
    const fetchMmcaDaily = vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(fetchMmcaRooms).toHaveBeenCalledTimes(1));
    // 2, not 1: MmcaPage's own daily fetch plus MmcaDailyLogTable's
    // independent daily fetch for its date-navigable log view.
    await waitFor(() => expect(fetchMmcaDaily).toHaveBeenCalledTimes(2));

    unmount();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMmcaRooms).toHaveBeenCalledTimes(1);
    expect(fetchMmcaDaily).toHaveBeenCalledTimes(2);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("fetches rooms and daily data for the venue prop, shows the title prop as heading", async () => {
    const fetchMmcaRooms = vi
      .spyOn(api, "fetchMmcaRooms")
      .mockResolvedValue([makeRoom({ space_code: "MMCA-SPACE-2001" })]);

    render(
      <MemoryRouter>
        <MmcaPage venue="gwacheon" title="국립현대미술관 과천관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(fetchMmcaRooms).toHaveBeenCalledWith("gwacheon"));
    expect(
      screen.getByRole("heading", { name: "국립현대미술관 과천관 혼잡도" })
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(vi.mocked(api.fetchMmcaDaily)).toHaveBeenCalledWith("gwacheon", expect.any(String))
    );
  });

  it("fetches daily data exactly once regardless of how many rooms there are", async () => {
    const fetchMmcaDaily = vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([
      makeRoom({ space_code: "MMCA-SPACE-1001", space_nm: "1전시실" }),
      makeRoom({ space_code: "MMCA-SPACE-1002", space_nm: "2전시실" }),
      makeRoom({ space_code: "MMCA-SPACE-1003", space_nm: "3전시실" }),
    ]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByTestId("mmca-room-chart")).toHaveLength(3));
    // 3 chart cards, but only one page-level fetch (plus the independent
    // fetch always made by MmcaDailyLogTable's own log view, fixed at 2
    // total) — this is the fix for the pre-expansion N-cards-N-requests
    // problem: the count does not scale with the number of rooms.
    expect(fetchMmcaDaily).toHaveBeenCalledTimes(2);
  });

  it("renders a single-column layout when the venue has only one room", async () => {
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);

    const { container } = render(
      <MemoryRouter>
        <MmcaPage venue="deoksugung" title="국립현대미술관 덕수궁관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByTestId("mmca-room-chart")).toBeInTheDocument());
    expect(container.querySelector("section")?.className).not.toMatch(/lg:grid-cols-2/);
  });

  it("renders a two-column layout when the venue has more than one room", async () => {
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([
      makeRoom(),
      makeRoom({ space_code: "MMCA-SPACE-1002", space_nm: "2전시실" }),
    ]);

    const { container } = render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByTestId("mmca-room-chart")).toHaveLength(2));
    expect(container.querySelector("section")?.className).toMatch(/lg:grid-cols-2/);
  });

  it("shows the closed-day state for Deoksugung on a Monday, but not for other venues", async () => {
    vi.setSystemTime(new Date("2026-07-27T11:00:00")); // Monday, within 10:00-18:00
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);

    const { unmount } = render(
      <MemoryRouter>
        <MmcaPage venue="deoksugung" title="국립현대미술관 덕수궁관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("휴관일입니다")).toBeInTheDocument());
    unmount();

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("실시간")).toBeInTheDocument());
    expect(screen.queryByText("휴관일입니다")).not.toBeInTheDocument();
  });

  it("groups permanently-disabled rooms into small inactive cards below the active grid", async () => {
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([
      makeRoom({ space_code: "MMCA-SPACE-2001" }),
      makeRoom({
        space_code: "MMCA-SPACE-2008",
        space_nm: "1층 어린이미술관",
        congestion_nm: null,
        observed_at: null,
      }),
    ]);

    const { container } = render(
      <MemoryRouter>
        <MmcaPage venue="gwacheon" title="국립현대미술관 과천관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByTestId("mmca-room-chart")).toHaveLength(1));
    expect(screen.getByText("서비스 예정")).toBeInTheDocument();
    expect(screen.getByText("1층 어린이미술관")).toBeInTheDocument();

    const sections = container.querySelectorAll("section");
    const inactiveSection = Array.from(sections).find((s) => s.textContent?.includes("서비스 예정"));
    expect(inactiveSection?.className).toMatch(/lg:grid-cols-6/);
  });

  it("groups open rooms with no data collected today into small inactive cards", async () => {
    vi.setSystemTime(new Date("2026-07-28T11:00:00")); // Tuesday, within 10:00-18:00
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([
      makeRoom(),
      makeRoom({
        space_code: "MMCA-SPACE-1002",
        space_nm: "2전시실",
        congestion_nm: null,
        observed_at: null,
      }),
    ]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByTestId("mmca-room-chart")).toHaveLength(1));
    expect(screen.getByText("오늘 정보 없음")).toBeInTheDocument();
    expect(screen.getByText("2전시실")).toBeInTheDocument();
  });

  it("keeps a full-size card for a no-data room when the venue isn't open yet", async () => {
    vi.setSystemTime(new Date("2026-07-28T09:00:00")); // Tuesday, before 10:00 open
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom({ congestion_nm: null, observed_at: null })]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByTestId("mmca-room-chart")).toBeInTheDocument());
    expect(screen.queryByText("오늘 정보 없음")).not.toBeInTheDocument();
  });
});
