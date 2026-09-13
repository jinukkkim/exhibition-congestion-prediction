import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as api from "../src/api/mmca";
import { MmcaQuietHoursPage } from "../src/pages/MmcaQuietHoursPage";

// 과천관은 월요일 휴관이라 백엔드가 그 요일 칸을 아예 내려보내지 않는다.
const PROFILE = {
  status: "ready" as const,
  since: "2026-07-26",
  until: "2026-09-13",
  samples: 20538,
  cells: [
    { weekday: 1, hour: 10, rank: 0.21 },
    { weekday: 1, hour: 11, rank: 1.4 },
    { weekday: 6, hour: 16, rank: 2.34 },
  ],
  rooms: [
    {
      space_code: "MMCA-SPACE-2001",
      space_nm: "1전시실",
      cells: [{ weekday: 1, hour: 10, rank: 0.0 }],
    },
    {
      space_code: "MMCA-SPACE-2003",
      space_nm: "3전시실",
      cells: [{ weekday: 6, hour: 16, rank: 3.0 }],
    },
  ],
};

function renderPage() {
  render(
    <MemoryRouter>
      <MmcaQuietHoursPage venue="gwacheon" />
    </MemoryRouter>
  );
}

function venueRow(weekday: string): (string | null)[] {
  const table = screen.getAllByRole("table")[0];
  const row = within(table)
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryByRole("rowheader", { name: weekday }));
  return within(row!)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);
}

describe("MmcaQuietHoursPage", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("leads with a sentence that needs no hedge", async () => {
    // 서울시 쪽은 생활인구라 "일대는" 이라고 물러서야 했다. 이쪽 값은 전시실
    // 혼잡도 그 자체라 관을 바로 주어로 쓴다.
    vi.spyOn(api, "fetchMmcaWeeklyProfile").mockResolvedValue(PROFILE);
    renderPage();

    expect(
      await screen.findByText(
        "국립현대미술관 과천관은 화요일 오전 10시가 가장 한산하고, 일요일 오후 4시가 가장 붐빕니다."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/일대는/)).toBeNull();
  });

  it("names each cell with a congestion level, not a number", async () => {
    vi.spyOn(api, "fetchMmcaWeeklyProfile").mockResolvedValue(PROFILE);
    renderPage();
    await screen.findAllByRole("table");

    // 0.21 → 여유, 1.4 → 보통, 2.34 → 약간 붐빔. 소수는 관람객에게 뜻이 없다.
    expect(venueRow("화")).toEqual(["여유", "보통", ""]);
    expect(venueRow("일")).toEqual(["", "", "약간 붐빔"]);
  });

  it("leaves the closed weekday blank", async () => {
    // 과천관 월요일 판독은 공휴일 하루뿐이라 백엔드가 그 요일을 통째로 뺀다.
    // 화면에서는 빈 행으로 남아야 한다 — 행이 사라지면 요일 순서가 흔들린다.
    vi.spyOn(api, "fetchMmcaWeeklyProfile").mockResolvedValue(PROFILE);
    renderPage();
    await screen.findAllByRole("table");

    expect(venueRow("월")).toEqual(["", "", ""]);
  });

  it("keeps the per-room grids behind a disclosure", async () => {
    vi.spyOn(api, "fetchMmcaWeeklyProfile").mockResolvedValue(PROFILE);
    renderPage();

    // 관 한 장 + 방 두 장.
    await waitFor(() => expect(screen.getAllByRole("table")).toHaveLength(3));
    expect(screen.getByText("전시실별로 보기 (2)")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "1전시실" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "3전시실" })).toBeInTheDocument();
  });

  it("discloses which rooms the venue average is made of", async () => {
    // 어느 방이 혼잡도를 주는지는 전시 일정이 정한다 — 밝혀 적지 않으면 관
    // 평균이 무엇의 평균인지 알 수 없다.
    vi.spyOn(api, "fetchMmcaWeeklyProfile").mockResolvedValue(PROFILE);
    renderPage();

    expect(await screen.findByText(/1전시실 · 3전시실/)).toBeInTheDocument();
    expect(screen.getByText(/전시 일정에 따라 달라짐/)).toBeInTheDocument();
    expect(screen.getByText(/판독 20,538건/)).toBeInTheDocument();
  });

  it("polls its way out of the collecting state", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, "fetchMmcaWeeklyProfile")
      .mockResolvedValueOnce({
        status: "collecting",
        since: null,
        until: null,
        samples: 0,
        cells: [],
        rooms: [],
      })
      .mockResolvedValue(PROFILE);
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("아직 집계할 판독이 모이지 않았습니다.")).toBeInTheDocument()
    );

    await vi.advanceTimersByTimeAsync(60_000);

    await waitFor(() => expect(screen.getAllByRole("table").length).toBeGreaterThan(0));
  });
});
