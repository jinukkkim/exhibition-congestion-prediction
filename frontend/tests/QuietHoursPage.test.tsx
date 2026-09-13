import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as api from "../src/api/congestion";
import { QuietHoursPage } from "../src/pages/QuietHoursPage";

// 월요일은 평일이라 10~11시만, 수요일은 야간개장이라 20시까지 — 백엔드
// _full_hour_open 이 내려보내는 모양 그대로다.
const PROFILE = {
  status: "ready" as const,
  since: "2026-07-16",
  until: "2026-09-09",
  samples: 5757,
  cells: [
    { weekday: 0, hour: 10, population_avg: 2000 },
    { weekday: 0, hour: 11, population_avg: 2953 },
    { weekday: 2, hour: 20, population_avg: 1250 },
  ],
};

// 요일 한 줄의 칸 내용. 빈 칸은 "" 로 나오므로 어느 시각이 비어 있는지가 그대로
// 드러난다.
function rowCells(weekday: string): (string | null)[] {
  const row = screen
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryByRole("rowheader", { name: weekday }));
  return within(row!)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);
}

function renderPage() {
  render(
    <MemoryRouter>
      <QuietHoursPage />
    </MemoryRouter>
  );
}

describe("QuietHoursPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leads with the sentence a search engine can read", async () => {
    vi.spyOn(api, "fetchWeeklyProfile").mockResolvedValue(PROFILE);
    renderPage();

    expect(
      await screen.findByText(
        "국립중앙박물관 일대는 수요일 오후 8시가 가장 한산하고, 월요일 오전 11시가 가장 붐빕니다."
      )
    ).toBeInTheDocument();
    // 명세표는 기간과 표본 수를 함께 적는다 — n 없는 집계는 신뢰도를 가늠할 수 없다.
    expect(screen.getByText(/2026-07-16 ~ 2026-09-09/)).toBeInTheDocument();
    expect(screen.getByText(/판독 5,757건/)).toBeInTheDocument();
  });

  it("leaves the hours a weekday never opens blank", async () => {
    vi.spyOn(api, "fetchWeeklyProfile").mockResolvedValue(PROFILE);
    renderPage();
    await screen.findByRole("table");

    // 열은 값이 있는 시각의 합집합(10·11·20시)이고, 각 요일은 그중 자기가 여는
    // 시각만 채운다 — 야간개장이 있는 수요일에만 20시 칸이 선다.
    expect(rowCells("월")).toEqual(["2,000", "2,953", ""]);
    expect(rowCells("수")).toEqual(["", "", "1,250"]);
  });

  it("says it is still collecting rather than drawing an empty grid", async () => {
    vi.spyOn(api, "fetchWeeklyProfile").mockResolvedValue({
      status: "collecting",
      since: null,
      until: null,
      samples: 0,
      cells: [],
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("아직 집계할 판독이 모이지 않았습니다.")).toBeInTheDocument()
    );
    expect(screen.queryByRole("table")).toBeNull();
  });
});
