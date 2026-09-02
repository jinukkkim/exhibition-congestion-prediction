import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    // 덕수궁관만 첫 판독 전 상태로 둔다 — 관마다 응답이 따로 온다는 것을
    // 라우팅 테스트에서도 지킨다.
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

  it("routes the Deoksugung page to its own page like the other MMCA venues", async () => {
    // 수집 대상이 되기 전에는 이 주소가 홈으로 돌아갔다 — 북마크·방문기록으로
    // 들어온 사람이 이제 관 페이지에 닿는지가 이 관을 켠 것의 결과다.
    visit("/venues/mmca-deoksugung");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "국립현대미술관 덕수궁관" })
      ).toBeInTheDocument()
    );
    expect(window.location.pathname).toBe("/venues/mmca-deoksugung");
  });

  it("gives each route its own document title and updates it on navigation", async () => {
    // 클라이언트 라우팅이라 제목은 저절로 바뀌지 않는다 — 탭·북마크·방문기록이
    // 라우트마다 구분되려면 각 페이지가 자기 제목을 써야 한다.
    visit("/venues/mmca-seoul");
    await waitFor(() => expect(document.title).toBe("국립현대미술관 서울관 · 전시 혼잡도 예측"));

    fireEvent.click(screen.getByRole("link", { name: /전체 보기/ }));
    await waitFor(() => expect(document.title).toBe("전시 혼잡도 예측"));
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

  it("sends an address that matches no route back to the picker", async () => {
    // 맞는 라우트가 하나도 없으면 Routes 는 아무것도 그리지 않는다 — 오타 하나,
    // 옛 링크 하나로 #root 가 통째로 비고 돌아갈 링크조차 남지 않는다.
    visit("/venues/does-not-exist");

    await waitFor(() => expect(screen.getByText("전시 혼잡도 예측")).toBeInTheDocument());
    expect(window.location.pathname).toBe("/");
  });
});
