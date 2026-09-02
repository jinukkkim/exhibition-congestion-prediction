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
    vi.spyOn(api, "fetchMmcaPrediction").mockResolvedValue([]);
    vi.spyOn(api, "fetchMmcaExhibitions").mockResolvedValue([]);
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

  it("shows the venue's business hours once in the header, not per room card", async () => {
    // 영업시간은 관 단위 값이라 방마다 같은 줄이 반복됐다. 헤더에 한 줄만 둔다.
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([
      makeRoom(),
      makeRoom({ space_code: "MMCA-SPACE-1002", space_nm: "2전시실", congestion_nm: "보통" }),
    ]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByTestId("mmca-room-chart")).toHaveLength(2));
    // 요일마다 다른 폐관 시각은 한 줄 안의 괄호가 말한다.
    expect(screen.getAllByText("10:00~18:00 (수·토 21:00까지)")).toHaveLength(1);
  });

  it("keeps the header's business hours put when the selected date changes", async () => {
    // 한 주를 한 줄로 접은 값이라 탭과 함께 바뀌지 않는다 — 수·토 21:00 은
    // 괄호 안에 늘 적혀 있으므로 탭을 옮겨 확인할 일이 없다.
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    const line = "10:00~18:00 (수·토 21:00까지)";
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(7));
    fireEvent.click(screen.getByRole("tab", { name: "수 7/29" }));

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "수 7/29" })).toHaveAttribute("aria-selected", "true")
    );
    expect(screen.getAllByText(line)).toHaveLength(1);
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
    // 요일 휴관도 관 단위 정보다 — 헤더의 영업시간 줄이 괄호로 알린다.
    expect(screen.getByText("10:00~18:00 (수·토 21:00까지, 월요일 휴무)")).toBeInTheDocument();
    expect(screen.queryByText("오늘 정보 없음")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mmca-room-chart")).not.toBeInTheDocument();
    unmount();

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("실시간")).toBeInTheDocument());
    expect(screen.queryByText(/휴무/)).not.toBeInTheDocument();
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
    // Tuesday, the opening minute itself — the collector's first poll runs now
    // and takes a few seconds, so nothing today has landed yet.
    vi.setSystemTime(new Date("2026-07-28T10:00:00"));
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
    vi.spyOn(api, "fetchMmcaPrediction").mockResolvedValue([]);
    vi.spyOn(api, "fetchMmcaExhibitions").mockResolvedValue([]);
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

  it("fetches the prediction for the selected date, not the last-week proxy date", async () => {
    // chartDate 는 미래 탭에서 D-7 로 옮겨진 값이다 — 회색 대리선을 가져올
    // 날짜다. 예측은 selectedDate 를 써야 한다. chartDate 를 쓰면 지나간 날의
    // 예측을 조르는 셈이고, 백엔드가 과거 날짜에 빈 배열을 내므로 증상은
    // 에러가 아니라 "미래 탭에 점선이 없다"로 나타난다.
    const fetchMmcaPrediction = vi.spyOn(api, "fetchMmcaPrediction").mockResolvedValue([]);
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() =>
      expect(fetchMmcaPrediction).toHaveBeenCalledWith("seoul", todayString())
    );

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(7));
    fireEvent.click(screen.getByRole("tab", { name: "토 8/1" }));

    await waitFor(() => expect(fetchMmcaPrediction).toHaveBeenCalledWith("seoul", "2026-08-01"));
    // 8/1 - 7 = 7/25 — 이 날짜로 물어본 적이 있으면 안 된다.
    expect(fetchMmcaPrediction.mock.calls.map(([, date]) => date)).not.toContain("2026-07-25");
  });

  it("keeps polling the prediction on the today tab, but stops on a future tab", async () => {
    // 오늘 곡선은 최근 120분 실측에 매달려 있어 판독마다 바뀐다. 미래 탭은
    // 편차가 없어 정적이다.
    const fetchMmcaPrediction = vi.spyOn(api, "fetchMmcaPrediction").mockResolvedValue([]);
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() => expect(fetchMmcaPrediction).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMmcaPrediction).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("tab", { name: "토 8/1" }));
    await waitFor(() => expect(fetchMmcaPrediction).toHaveBeenCalledWith("seoul", "2026-08-01"));

    const afterSwitch = fetchMmcaPrediction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetchMmcaPrediction).toHaveBeenCalledTimes(afterSwitch);
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

  it("lists the venue's running exhibitions once in the header", async () => {
    // 출처 API 가 전시실을 안 내려주므로 전시명은 방 카드가 아니라 헤더에
    // 관 단위로 한 번만 나온다.
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([
      makeRoom(),
      makeRoom({ space_code: "MMCA-SPACE-1002", space_nm: "2전시실", congestion_nm: "보통" }),
    ]);
    vi.spyOn(api, "fetchMmcaExhibitions").mockResolvedValue([
      { title: "서도호", start_date: "2026-08-27", end_date: "2027-02-09", space_codes: [] },
    ]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("서도호")).toBeInTheDocument());
    expect(screen.getAllByText("서도호")).toHaveLength(1);
    expect(screen.getByText("2026.08.27 – 2027.02.09")).toBeInTheDocument();
  });

  it("hides the exhibition section when the fetch fails", async () => {
    // 혼잡도는 전시 목록 없이도 온전히 읽혀야 한다.
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);
    vi.spyOn(api, "fetchMmcaExhibitions").mockRejectedValue(new Error("network error"));

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("1전시실")).toBeInTheDocument());
    expect(screen.queryByText("현재 전시")).not.toBeInTheDocument();
  });

  it("labels each room card with the exhibition running in it", async () => {
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([
      makeRoom(),
      makeRoom({ space_code: "MMCA-SPACE-1006", space_nm: "6전시실", congestion_nm: "보통" }),
    ]);
    vi.spyOn(api, "fetchMmcaExhibitions").mockResolvedValue([
      {
        title: "올해의 작가상 2026",
        start_date: "2026-07-24",
        end_date: "2026-12-06",
        space_codes: ["MMCA-SPACE-1001"],
      },
      {
        title: "이것은 개념미술이 (아니)다",
        start_date: "2026-06-19",
        end_date: "2026-10-11",
        space_codes: ["MMCA-SPACE-1006", "MMCA-SPACE-1007"],
      },
    ]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    // 헤더 목록에 한 번, 그 방 카드에 한 번.
    await waitFor(() => expect(screen.getAllByText("올해의 작가상 2026")).toHaveLength(2));
    expect(screen.getAllByText("이것은 개념미술이 (아니)다")).toHaveLength(2);
    // 1007 은 이 관에 카드가 없으므로 헤더에만 남는다.
    expect(screen.queryByText("7전시실")).not.toBeInTheDocument();
  });

  it("leaves a room card unlabelled when no exhibition maps to it", async () => {
    // 서울박스·교육동처럼 전시실이 아닌 공간의 전시는 space_codes 가 비어
    // 있어 헤더 목록에만 실린다.
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);
    vi.spyOn(api, "fetchMmcaExhibitions").mockResolvedValue([
      {
        title: "MMCA×LG OLED 시리즈 2026",
        start_date: "2026-07-31",
        end_date: "2026-11-29",
        space_codes: [],
      },
    ]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() =>
      expect(screen.getAllByText("MMCA×LG OLED 시리즈 2026")).toHaveLength(1)
    );
  });

  it("joins both exhibitions when two share a room", async () => {
    // 드물지만 있다 — 1년짜리 프로그램이 기획전과 같은 방을 쓰거나, 전시
    // 교체기에 며칠 겹친다. 하나만 남기면 그동안 카드가 거짓말을 한다.
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([
      makeRoom({ space_code: "MMCA-SPACE-1005", space_nm: "5전시실" }),
    ]);
    vi.spyOn(api, "fetchMmcaExhibitions").mockResolvedValue([
      {
        title: "현대차 시리즈 2021",
        start_date: "2021-09-03",
        end_date: "2022-02-20",
        space_codes: ["MMCA-SPACE-1005"],
      },
      {
        title: "다원예술 2021: 멀티버스",
        start_date: "2021-02-12",
        end_date: "2021-12-05",
        space_codes: ["MMCA-SPACE-1005"],
      },
    ]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() =>
      expect(
        screen.getByText("현대차 시리즈 2021 · 다원예술 2021: 멀티버스")
      ).toBeInTheDocument()
    );
  });
});
