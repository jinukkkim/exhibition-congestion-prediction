import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as congestionApi from "../src/api/congestion";
import * as mmcaApi from "../src/api/mmca";
import App from "../src/App";

function visit(path: string) {
  window.history.pushState({}, "", path);
  render(<App />);
}

describe("App routing", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-20T14:20:00")); // 목요일 영업 중
    vi.stubGlobal(
      "EventSource",
      class {
        onmessage: ((event: MessageEvent) => void) | null = null;
        close() {}
      }
    );
    vi.spyOn(congestionApi, "fetchCurrent").mockResolvedValue({
      observed_at: "2026-08-20T14:20:00",
      congest_level: "보통",
      population_avg: 1240,
    });
    vi.spyOn(congestionApi, "fetchPrediction").mockResolvedValue({ status: "collecting", days_collected: 3 });
    vi.spyOn(congestionApi, "fetchDaily").mockResolvedValue([]);
    // 관별로 실제로 올 수 있는 응답을 준다 — 빈 배열은 "전 객실 disabled"로
    // 읽혀 서울·과천까지 서비스 예정이 되어버린다.
    vi.spyOn(mmcaApi, "fetchMmcaRooms").mockImplementation((venue) =>
      Promise.resolve(
        venue === "deoksugung"
          ? [
              {
                space_code: "MMCA-SPACE-4001",
                space_nm: "덕수궁관",
                congestion_nm: null,
                observed_at: null,
              },
            ]
          : [
              {
                space_code: "MMCA-SPACE-1001",
                space_nm: "1전시실",
                congestion_nm: "여유",
                observed_at: "2026-08-20T14:20:00",
              },
            ]
      )
    );
    vi.spyOn(mmcaApi, "fetchMmcaDaily").mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.pushState({}, "", "/");
  });

  it("sends a direct visit to the Deoksugung page back to the picker", async () => {
    // 카드에서 갈 수 없게 막아도 북마크·방문기록으로는 도달할 수 있다. 그 페이지는
    // 채워질 일이 없는 빈 껍데기이므로 홈으로 돌려보내고, 홈 카드가 이유를 말한다.
    visit("/venues/mmca-deoksugung");

    await waitFor(() => expect(screen.getByText("전시 혼잡도 예측")).toBeInTheDocument());
    expect(window.location.pathname).toBe("/");
    expect(screen.getByText("서비스 예정")).toBeInTheDocument();
    // 덕수궁관 카드가 홈에 이름 그대로 있으므로, 상세 페이지가 아니라는 것은
    // heading 으로만 물을 수 있다.
    expect(
      screen.queryByRole("heading", { name: "국립현대미술관 덕수궁관" })
    ).not.toBeInTheDocument();
  });

  it("still routes the other MMCA venues to their own page", async () => {
    visit("/venues/mmca-seoul");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "국립현대미술관 서울관" })
      ).toBeInTheDocument()
    );
    expect(window.location.pathname).toBe("/venues/mmca-seoul");
  });
});
