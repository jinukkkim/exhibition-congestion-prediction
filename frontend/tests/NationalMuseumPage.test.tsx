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

  it("names the venue in the heading, without the home page branding", async () => {
    // 홈과 글자 하나까지 같은 h1 을 쓰던 탓에 상세 페이지가 어느 관인지 말하지
    // 못했다. eyebrow 도 홈의 브랜딩이라 다른 상세 페이지에는 없다.
    renderPage();

    expect(screen.getByRole("heading", { name: "국립중앙박물관" })).toBeInTheDocument();
    expect(screen.queryByText("전시 혼잡도 예측")).not.toBeInTheDocument();
    expect(screen.queryByText("Exhibition · Seoul")).not.toBeInTheDocument();
  });

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

  it("keeps the card working, minus the dashed line, when only the prediction fetch fails", async () => {
    // 예측은 없어도 실측 곡선이 온전히 읽힌다 — 카드를 에러로 바꾸지 않는다.
    vi.spyOn(api, "fetchPrediction").mockRejectedValue(new Error("network error"));

    renderPage();

    await waitFor(() => expect(screen.getByText("보통")).toBeInTheDocument());
    expect(screen.queryByTestId("sparkline-prediction-line")).not.toBeInTheDocument();
    expect(screen.queryByText(/불러오지 못했습니다/)).not.toBeInTheDocument();
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

  it("moves the one card to the chosen date — 예측은 그 날짜, 실선은 D−7", async () => {
    render(
      <MemoryRouter>
        <NationalMuseumPage />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
    fireEvent.click(screen.getByRole("tab", { name: "토 8/22" }));

    // 실선은 고른 날짜 -7 의 실제 기록(여기서는 빈 응답이라 안 그려진다),
    // 점선은 고른 날짜의 예측 — 한 카드 안 같은 축에 함께 있다.
    await waitFor(() => expect(api.fetchDaily).toHaveBeenCalledWith("2026-08-15"));
    expect(screen.getByTestId("sparkline-prediction-line")).toBeInTheDocument();
    expect(screen.getByText("예측")).toBeInTheDocument();
    expect(screen.queryByText(/시간대별 예측/)).not.toBeInTheDocument();
  });

  it("shows the business hours once in the header and keeps them on the selected date", async () => {
    // 영업시간은 관 단위 값이라 카드가 아니라 헤더에 한 줄만 둔다. 한 주 전체를
    // 한 줄로 접으므로 탭을 옮겨도 바뀌지 않는다 — 요일별 폐관 시각은 괄호 안에
    // 이미 다 적혀 있다.
    render(
      <MemoryRouter>
        <NationalMuseumPage />
      </MemoryRouter>
    );

    const line = "09:30~17:30 (수·토 21:00까지)";
    expect(screen.getAllByText(line)).toHaveLength(1);

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
    fireEvent.click(screen.getByRole("tab", { name: "토 8/22" }));

    await waitFor(() => expect(screen.getByRole("tab", { name: "토 8/22" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.getAllByText(line)).toHaveLength(1);
  });

  it("draws the prediction as a dashed line inside the congestion chart, not in a card of its own", async () => {
    // 별도 예측 카드가 사라졌다 — MAE 숫자도 함께 (값은 응답에 그대로 남아 있다).
    render(
      <MemoryRouter>
        <NationalMuseumPage />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByTestId("sparkline-prediction-line")).toBeInTheDocument());
    expect(screen.getAllByTestId("history-sparkline")).toHaveLength(1);
    expect(screen.queryByText(/95\.2/)).not.toBeInTheDocument();
    expect(screen.queryByText(/120\.5/)).not.toBeInTheDocument();
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
