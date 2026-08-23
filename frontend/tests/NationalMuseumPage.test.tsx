import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../src/api/congestion";
import { NationalMuseumPage } from "../src/pages/NationalMuseumPage";

const CURRENT = {
  observed_at: "2026-08-20T14:20:00",
  congest_level: "보통",
  population_avg: 1240,
};

function curveOf(value: number) {
  return Array.from({ length: 24 }, (_, hour) => ({ hour, baseline: value, model: value + 10 }));
}

// 2026-08-20 목요일 기준 오늘 + 2일
const READY_PREDICTION = {
  status: "ready" as const,
  baseline_mae: 120.5,
  model_mae: 95.2,
  curve: curveOf(1000),
  days: [
    { date: "2026-08-20", is_holiday: false, curve: curveOf(1000) },
    { date: "2026-08-21", is_holiday: false, curve: curveOf(2000) },
    { date: "2026-08-22", is_holiday: false, curve: curveOf(3000) },
  ],
};

describe("NationalMuseumPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 혼잡도 카드가 영업시간 판정에 걸리므로 시각을 고정한다 (목요일 14:20).
    vi.setSystemTime(new Date("2026-08-20T14:20:00"));
    // EventSource는 jsdom에 없다. SSE는 이 테스트의 대상이 아니므로 no-op으로 둔다.
    vi.stubGlobal(
      "EventSource",
      class {
        onmessage: ((event: MessageEvent) => void) | null = null;
        close() {}
      }
    );
    vi.spyOn(api, "fetchCurrent").mockResolvedValue(CURRENT);
    vi.spyOn(api, "fetchPrediction").mockResolvedValue(READY_PREDICTION);
    vi.spyOn(api, "fetchDaily").mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function renderPage() {
    render(
      <MemoryRouter>
        <NationalMuseumPage />
      </MemoryRouter>
    );
  }

  it("renders the current level once loaded", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("보통")).toBeInTheDocument());
  });

  it("does not show a page-level live badge that nothing can falsify", async () => {
    // 헤더의 하드코딩된 초록 점은 스트림·수집 상태와 무관하게 항상 떠 있었다.
    // 신선도 판정을 든 카드 배지가 있으므로 중복이기도 하다.
    renderPage();

    await waitFor(() => expect(screen.getByText("보통")).toBeInTheDocument());
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
  });

  it("shows the failure in the congestion card instead of a permanent loading state", async () => {
    vi.spyOn(api, "fetchCurrent").mockRejectedValue(new Error("network error"));

    renderPage();

    await waitFor(() => expect(screen.getByText(/불러오지 못했습니다/)).toBeInTheDocument());
    expect(screen.queryByText(/불러오는 중/)).not.toBeInTheDocument();
  });

  it("keeps the other cards working when only the prediction fetch fails", async () => {
    vi.spyOn(api, "fetchPrediction").mockRejectedValue(new Error("network error"));

    renderPage();

    await waitFor(() => expect(screen.getByText(/불러오지 못했습니다/)).toBeInTheDocument());
    // 혼잡도 카드는 그대로 그려진다
    expect(screen.getByText("보통")).toBeInTheDocument();
  });

  it("notes the trend failure without blanking the level that did load", async () => {
    vi.spyOn(api, "fetchDaily").mockRejectedValue(new Error("network error"));

    renderPage();

    await waitFor(() => expect(screen.getByText(/추이를 불러오지 못했습니다/)).toBeInTheDocument());
    // 현재 혼잡도는 살아 있다 — 추이 실패가 카드 전체를 에러로 바꾸지 않음
    expect(screen.getByText("보통")).toBeInTheDocument();
  });

  it("retries a failed fetch on the next tick", async () => {
    vi.spyOn(api, "fetchCurrent")
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValue(CURRENT);

    renderPage();

    await waitFor(() => expect(screen.getByText(/불러오지 못했습니다/)).toBeInTheDocument());
    await vi.advanceTimersByTimeAsync(60_000);

    await waitFor(() => expect(screen.getByText("보통")).toBeInTheDocument());
    expect(screen.queryByText(/불러오지 못했습니다/)).not.toBeInTheDocument();
  });

  it("keeps polling today's log so the sparkline grows while the tab stays open", async () => {
    renderPage();

    await waitFor(() => expect(api.fetchDaily).toHaveBeenCalled());
    const todayCallsBefore = vi
      .mocked(api.fetchDaily)
      .mock.calls.filter(([date]) => date === "2026-08-20").length;

    await vi.advanceTimersByTimeAsync(60_000);

    const todayCallsAfter = vi
      .mocked(api.fetchDaily)
      .mock.calls.filter(([date]) => date === "2026-08-20").length;
    expect(todayCallsAfter).toBe(todayCallsBefore + 1);
  });

  it("stops refetching last week's log once it has arrived", async () => {
    renderPage();

    await waitFor(() => expect(api.fetchDaily).toHaveBeenCalledWith("2026-08-13"));
    await vi.advanceTimersByTimeAsync(180_000);

    const lastWeekCalls = vi
      .mocked(api.fetchDaily)
      .mock.calls.filter(([date]) => date === "2026-08-13").length;
    expect(lastWeekCalls).toBe(1);
  });
});

describe("NationalMuseumPage date tabs", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-20T14:20:00"));
    vi.stubGlobal(
      "EventSource",
      class {
        onmessage: ((event: MessageEvent) => void) | null = null;
        close() {}
      }
    );
    vi.spyOn(api, "fetchCurrent").mockResolvedValue(CURRENT);
    vi.spyOn(api, "fetchPrediction").mockResolvedValue(READY_PREDICTION);
    vi.spyOn(api, "fetchDaily").mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows one tab per day from the payload", async () => {
    // 탭 날짜는 응답의 days 를 따른다 — 프론트가 따로 만들면 배치 실패로 백엔드가
    // 걸러낸 결과와 어긋난다.
    render(
      <MemoryRouter>
        <NationalMuseumPage />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
    expect(screen.getByRole("tab", { name: "오늘 8/20" })).toHaveAttribute("aria-selected", "true");
  });

  it("moves both cards to the chosen date", async () => {
    render(
      <MemoryRouter>
        <NationalMuseumPage />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
    fireEvent.click(screen.getByRole("tab", { name: "토 8/22" }));

    // 오른쪽 예측 카드는 고른 날짜, 왼쪽 혼잡도 카드는 그 날짜 -7 의 실제
    await waitFor(() =>
      expect(screen.getByText(/8\/22\(토\)의 시간대별 예측/)).toBeInTheDocument()
    );
    expect(api.fetchDaily).toHaveBeenCalledWith("2026-08-15");
  });

  it("keeps the live headline only on the today tab", async () => {
    render(
      <MemoryRouter>
        <NationalMuseumPage />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("보통")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "토 8/22" }));

    await waitFor(() => expect(screen.queryByText("보통")).not.toBeInTheDocument());
    expect(screen.queryByText("실시간")).not.toBeInTheDocument();
  });
});
