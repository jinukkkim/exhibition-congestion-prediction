import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MmcaPage } from "../src/pages/MmcaPage";
import * as api from "../src/api/mmca";
import type { MmcaDailyLogPoint, MmcaRoomStatus } from "../src/api/mmca";
import { shiftDate, todayString } from "../src/lib/date";

function makeRoom(overrides: Partial<MmcaRoomStatus> = {}): MmcaRoomStatus {
  return {
    space_code: "MMCA-SPACE-1001",
    space_nm: "1전시실",
    congestion_nm: "여유",
    // 고정 시각(2026-07-28T11:00)과 같은 날의 최근 판독 — /mmca/rooms 는
    // 당일 판독만 반환하므로 며칠 전 날짜는 실제로 올 수 없는 값이고,
    // 신선도 배지가 그걸 지연으로 보는 것이 옳다.
    observed_at: "2026-07-28T10:55:00",
    ...overrides,
  };
}

describe("MmcaPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Card size depends on the clock (before open / open / after close), so
    // pin it — otherwise these tests pass or fail by time of day.
    vi.setSystemTime(new Date("2026-07-28T11:00:00")); // Tuesday, within 10:00-18:00
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
        <MmcaPage venue="seoul" />
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
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("불러오지 못했습니다.")).toBeInTheDocument());
  });

  it("polls rooms again after 60 seconds", async () => {
    const fetchMmcaRooms = vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
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
        <MmcaPage venue="seoul" />
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
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() => expect(fetchMmcaRooms).toHaveBeenCalledTimes(1));
    // 2: the page's own today + last-week daily fetches. The date-navigable
    // log view moved to /logs, so its independent fetch is no longer here.
    await waitFor(() => expect(fetchMmcaDaily).toHaveBeenCalledTimes(2));

    unmount();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMmcaRooms).toHaveBeenCalledTimes(1);
    expect(fetchMmcaDaily).toHaveBeenCalledTimes(2);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("fetches rooms and daily data for the venue prop, shows that venue name as heading", async () => {
    const fetchMmcaRooms = vi
      .spyOn(api, "fetchMmcaRooms")
      .mockResolvedValue([makeRoom({ space_code: "MMCA-SPACE-2001" })]);

    render(
      <MemoryRouter>
        <MmcaPage venue="gwacheon" />
      </MemoryRouter>
    );

    await waitFor(() => expect(fetchMmcaRooms).toHaveBeenCalledWith("gwacheon"));
    expect(
      screen.getByRole("heading", { name: "국립현대미술관 과천관" })
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
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByTestId("mmca-room-chart")).toHaveLength(3));
    // 3 chart cards, but only two fetches — today + last week — this is the
    // fix for the pre-expansion N-cards-N-requests problem: the count does
    // not scale with the number of rooms.
    expect(fetchMmcaDaily).toHaveBeenCalledTimes(2);
  });

  it("renders a single-column layout when the venue has only one room", async () => {
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);

    const { container } = render(
      <MemoryRouter>
        <MmcaPage venue="deoksugung" />
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
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByTestId("mmca-room-chart")).toHaveLength(2));
    expect(container.querySelector("section")?.className).toMatch(/lg:grid-cols-2/);
  });

  it("collapses Deoksugung's rooms on a Monday, but not other venues'", async () => {
    vi.setSystemTime(new Date("2026-07-27T11:00:00")); // Monday, within 10:00-18:00
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);

    const { unmount } = render(
      <MemoryRouter>
        <MmcaPage venue="deoksugung" />
      </MemoryRouter>
    );

    // A closed day follows the before-opening rule: no last-week curve (the
    // previous Monday was closed too) → small card, never mind the stale
    // congestion_nm the rooms endpoint still returns. The label says why.
    await waitFor(() => expect(screen.getByText("휴관일")).toBeInTheDocument());
    expect(screen.queryByText("오늘 정보 없음")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mmca-room-chart")).not.toBeInTheDocument();
    unmount();

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
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
        <MmcaPage venue="gwacheon" />
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
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([
      {
        observed_at: "2026-07-28T10:10:00",
        rooms: [{ space_code: "MMCA-SPACE-1002", space_nm: "2전시실", congestion_nm: null }],
      },
    ]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByTestId("mmca-room-chart")).toHaveLength(1));
    expect(screen.getByText("오늘 정보 없음")).toBeInTheDocument();
    expect(screen.getAllByText("2전시실").length).toBeGreaterThan(0);
  });

  it("before opening, keeps a full-size card only for rooms with last week's data", async () => {
    vi.setSystemTime(new Date("2026-07-28T09:00:00")); // Tuesday, before 10:00 open
    vi.spyOn(api, "fetchMmcaDaily").mockImplementation(async (_venue, date) =>
      date === "2026-07-21" // last Tuesday
        ? [
            {
              observed_at: "2026-07-21T14:00:00",
              rooms: [{ space_code: "MMCA-SPACE-1001", space_nm: "1전시실", congestion_nm: "여유" }],
            },
          ]
        : []
    );
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([
      makeRoom({ congestion_nm: null, observed_at: null }),
      makeRoom({
        space_code: "MMCA-SPACE-1002",
        space_nm: "2전시실",
        congestion_nm: null,
        observed_at: null,
      }),
    ]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    // 1전시실 has last week's curve → full card; 2전시실 has nothing → small.
    await waitFor(() => expect(screen.getByText("오늘 정보 없음")).toBeInTheDocument());
    expect(screen.getAllByTestId("mmca-room-chart")).toHaveLength(1);
    expect(screen.getByText("1전시실")).toBeInTheDocument();
  });

  it("follows the before-opening rule until the collector's first poll lands", async () => {
    vi.setSystemTime(new Date("2026-07-28T10:05:00")); // Tuesday, open (10:00) but before the 10:10 first poll
    vi.spyOn(api, "fetchMmcaDaily").mockImplementation(async (_venue, date) =>
      date === "2026-07-21" // last Tuesday
        ? [
            {
              observed_at: "2026-07-21T14:00:00",
              rooms: [{ space_code: "MMCA-SPACE-1001", space_nm: "1전시실", congestion_nm: "여유" }],
            },
          ]
        : []
    );
    // /mmca/rooms and /mmca/daily read the same today-scoped rows, so before
    // the day's first poll every room is null in both — the clock is what
    // tells us this is "not polled yet" rather than "no data all day".
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([
      makeRoom({ congestion_nm: null, observed_at: null }),
      makeRoom({
        space_code: "MMCA-SPACE-1002",
        space_nm: "2전시실",
        congestion_nm: null,
        observed_at: null,
      }),
    ]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("오늘 정보 없음")).toBeInTheDocument());
    expect(screen.getAllByTestId("mmca-room-chart")).toHaveLength(1);
    expect(screen.getByText("1전시실")).toBeInTheDocument();
  });

  it("keeps cards full-size while the deciding fetch is still in flight", async () => {
    vi.setSystemTime(new Date("2026-07-28T09:00:00")); // before open → last week decides
    vi.spyOn(api, "fetchMmcaDaily").mockImplementation(
      () => new Promise<MmcaDailyLogPoint[]>(() => {}) // never settles
    );
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom({ congestion_nm: null, observed_at: null })]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    // No data yet ≠ no data: shrinking here would flash small → full once the
    // fetch lands.
    await waitFor(() => expect(screen.getByTestId("mmca-room-chart")).toBeInTheDocument());
    expect(screen.queryByText("오늘 정보 없음")).not.toBeInTheDocument();
  });

  it("after closing, keeps a full-size card only for rooms with today's log", async () => {
    vi.setSystemTime(new Date("2026-07-28T19:00:00")); // Tuesday, past the 18:00 close
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([
      {
        observed_at: "2026-07-28T14:00:00",
        rooms: [
          { space_code: "MMCA-SPACE-1001", space_nm: "1전시실", congestion_nm: "여유" },
          { space_code: "MMCA-SPACE-1002", space_nm: "2전시실", congestion_nm: null },
        ],
      },
    ]);
    // /mmca/rooms is day-scoped (backend routes/mmca.py), so after close it
    // still reports today's last reading — null here only for the room that
    // was never read today, matching its empty daily log.
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([
      makeRoom({ congestion_nm: "여유" }),
      makeRoom({
        space_code: "MMCA-SPACE-1002",
        space_nm: "2전시실",
        congestion_nm: null,
        observed_at: null,
      }),
    ]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("오늘 정보 없음")).toBeInTheDocument());
    expect(screen.getAllByTestId("mmca-room-chart")).toHaveLength(1);
  });

  it("keeps the full chart card for a room that had real data earlier today even though its latest poll is null", async () => {
    vi.setSystemTime(new Date("2026-07-28T15:00:00")); // Tuesday, well within hours
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([
      {
        observed_at: "2026-07-28T11:00:00",
        rooms: [{ space_code: "MMCA-SPACE-1001", space_nm: "1전시실", congestion_nm: "여유" }],
      },
    ]);
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom({ congestion_nm: null, observed_at: null })]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByTestId("mmca-room-chart")).toBeInTheDocument());
    expect(screen.queryByText("오늘 정보 없음")).not.toBeInTheDocument();
  });

  it("fetches last week's daily data once per venue, separate from the 60s poll", async () => {
    const fetchMmcaDaily = vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    const today = todayString();
    const lastWeek = shiftDate(today, -7);

    await waitFor(() => expect(fetchMmcaDaily).toHaveBeenCalledWith("seoul", lastWeek));
    // Today + last week, fixed regardless of room count (see the "fetches
    // daily data exactly once" test below).
    expect(fetchMmcaDaily).toHaveBeenCalledTimes(2);
    expect(fetchMmcaDaily.mock.calls.filter(([, date]) => date === lastWeek)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);

    // The page's own "today" effect re-polls on the interval (pre-existing
    // behavior, unchanged by this task) — but the last-week fetch must not
    // join it.
    expect(fetchMmcaDaily.mock.calls.filter(([, date]) => date === lastWeek)).toHaveLength(1);
  });

  it("notes a failed trend fetch once for the venue, not once per room card", async () => {
    // 오늘/지난주 로그는 전시실 전체가 공유하는 fetch 한 건이다. 실패해도 방
    // 카드는 빈 SVG 만 그린 채 조용히 남으므로 안내가 필요하지만, 방마다
    // 같은 문구를 반복하면 실패 하나를 여러 건처럼 보이게 한다.
    vi.spyOn(api, "fetchMmcaDaily").mockRejectedValue(new Error("network error"));
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([
      makeRoom(),
      makeRoom({ space_code: "MMCA-SPACE-1002", space_nm: "2전시실", congestion_nm: "보통" }),
    ]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() =>
      expect(screen.getAllByText(/추이를 불러오지 못했습니다/)).toHaveLength(1)
    );
    // 방 카드 자체는 현재 상태를 계속 보여준다
    expect(screen.getByText("1전시실")).toBeInTheDocument();
    expect(screen.getAllByTestId("mmca-room-chart")).toHaveLength(2);
  });

  it("retries last week's daily data on the next tick when it fails", async () => {
    const today = todayString();
    const lastWeek = shiftDate(today, -7);
    // 한 번 실패하면 재시도가 없어 회색 비교선이 그 페이지 세션 내내 사라졌다.
    let lastWeekSucceeded = false;
    const fetchMmcaDaily = vi
      .spyOn(api, "fetchMmcaDaily")
      .mockImplementation((_venue, date) =>
        date === lastWeek && !lastWeekSucceeded
          ? Promise.reject(new Error("network error"))
          : Promise.resolve([])
      );
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() =>
      expect(fetchMmcaDaily.mock.calls.filter(([, date]) => date === lastWeek)).toHaveLength(1)
    );

    lastWeekSucceeded = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMmcaDaily.mock.calls.filter(([, date]) => date === lastWeek)).toHaveLength(2);

    // 성공한 뒤에는 다시 조르지 않는다
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMmcaDaily.mock.calls.filter(([, date]) => date === lastWeek)).toHaveLength(2);
  });
});

describe("MmcaPage date tabs", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-28T11:00:00")); // 화요일, 10:00-18:00 안
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows seven tabs starting at today", async () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(7));
    // 고정 시각 2026-07-28 화요일
    expect(screen.getByRole("tab", { name: "오늘 7/28" })).toHaveAttribute("aria-selected", "true");
  });

  it("draws the chosen date minus seven days", async () => {
    // MMCA 는 예측 모델이 없어 지난주 같은 요일의 실제 기록을 대리로 쓴다.
    // 판독이 없으면 방이 작은 비활성 카드로 접히므로, 그 날짜의 행을 준다.
    const fetchMmcaDaily = vi
      .spyOn(api, "fetchMmcaDaily")
      .mockImplementation((_venue, date) =>
        Promise.resolve(
          date === "2026-07-25"
            ? [
                {
                  observed_at: "2026-07-25T11:00:00",
                  rooms: [
                    { space_code: "MMCA-SPACE-1001", space_nm: "1전시실", congestion_nm: "여유" },
                  ],
                },
                {
                  observed_at: "2026-07-25T14:00:00",
                  rooms: [
                    { space_code: "MMCA-SPACE-1001", space_nm: "1전시실", congestion_nm: "붐빔" },
                  ],
                },
              ]
            : []
        )
      );
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(7));
    fireEvent.click(screen.getByRole("tab", { name: "토 8/1" }));

    // 8/1 - 7 = 7/25
    await waitFor(() => expect(fetchMmcaDaily).toHaveBeenCalledWith("seoul", "2026-07-25"));
    expect(screen.getAllByText(/7\/25\(토\)/).length).toBeGreaterThan(0);
  });

  it("drops the live badge on a future tab", async () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(7));
    expect(screen.getByText("실시간")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "토 8/1" }));

    await waitFor(() => expect(screen.queryByText("실시간")).not.toBeInTheDocument());
  });
});
