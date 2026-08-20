import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as congestionApi from "../src/api/congestion";
import type { CurrentCongestion } from "../src/api/congestion";
import * as mmcaApi from "../src/api/mmca";
import type { MmcaRoomStatus, MmcaVenue } from "../src/api/mmca";
import { HomePage } from "../src/pages/HomePage";

function makeRoom(overrides: Partial<MmcaRoomStatus> = {}): MmcaRoomStatus {
  return {
    space_code: "MMCA-SPACE-1001",
    space_nm: "1전시실",
    congestion_nm: "여유",
    observed_at: "2026-08-20T14:20:00",
    ...overrides,
  };
}

describe("HomePage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 카드 내용이 개·폐관 판정에 걸리므로 시각을 고정한다 — 안 하면
    // 테스트가 실행 시간대에 따라 붙었다 떨어진다.
    vi.setSystemTime(new Date("2026-08-20T14:20:00")); // 목요일, 두 관 모두 영업 중
    vi.spyOn(congestionApi, "fetchCurrent").mockResolvedValue({
      observed_at: "2026-08-20T14:20:00",
      congest_level: "보통",
      population_avg: 1240.4,
    });
    vi.spyOn(mmcaApi, "fetchMmcaRooms").mockImplementation((venue: MmcaVenue) =>
      Promise.resolve(
        venue === "deoksugung"
          ? [makeRoom({ space_code: "MMCA-SPACE-4001", congestion_nm: null, observed_at: null })]
          : [
              makeRoom({ space_code: "MMCA-SPACE-1001", congestion_nm: "여유" }),
              makeRoom({ space_code: "MMCA-SPACE-1002", congestion_nm: "여유" }),
              makeRoom({ space_code: "MMCA-SPACE-1003", congestion_nm: "보통" }),
            ]
      )
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders a link to each venue page", async () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: /국립중앙박물관/ })).toHaveAttribute(
      "href",
      "/venues/national-museum"
    );
    expect(screen.getByRole("link", { name: /국립현대미술관 서울관/ })).toHaveAttribute(
      "href",
      "/venues/mmca-seoul"
    );
    expect(screen.getByRole("link", { name: /국립현대미술관 과천관/ })).toHaveAttribute(
      "href",
      "/venues/mmca-gwacheon"
    );
    expect(screen.getByRole("link", { name: /국립현대미술관 덕수궁관/ })).toHaveAttribute(
      "href",
      "/venues/mmca-deoksugung"
    );
  });

  it("shows the national museum level with its population", async () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    // MMCA 카드도 "보통" 레벨을 쓰므로 카드 범위로 좁혀서 본다.
    const museumCard = screen.getByRole("link", { name: /국립중앙박물관/ });
    await waitFor(() => expect(museumCard).toHaveTextContent("1,240명"));
    expect(museumCard).toHaveTextContent("보통");
    expect(museumCard).toHaveTextContent("14:20 기준");
  });

  it("shows per-level room counts for an MMCA venue", async () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    const seoulCard = screen.getByRole("link", { name: /국립현대미술관 서울관/ });
    // 여유 2 · 보통 1 — 개수까지 붙은 문자열로 봐야 카운트가 빠져도 잡힌다.
    await waitFor(() => expect(seoulCard).toHaveTextContent("여유2"));
    expect(seoulCard).toHaveTextContent("보통1");
    expect(seoulCard).toHaveTextContent("14:20 기준");
  });

  it("shows the service-pending state for Deoksugung", async () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("서비스 예정")).toBeInTheDocument());
  });

  it("ignores a slow response from an earlier poll", async () => {
    // 폴링은 이전 tick의 요청을 취소하지 않으므로, 느린 tick N 응답이 tick N+1
    // 뒤에 도착하면 화면이 과거 값으로 되돌아갈 수 있다.
    let resolveStale: ((value: CurrentCongestion) => void) | undefined;
    const stalePending = new Promise<CurrentCongestion>((resolve) => {
      resolveStale = resolve;
    });
    vi.spyOn(congestionApi, "fetchCurrent")
      .mockReturnValueOnce(stalePending)
      .mockResolvedValue({
        observed_at: "2026-08-20T14:21:00",
        congest_level: "붐빔",
        population_avg: 3000,
      });

    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    const museumCard = screen.getByRole("link", { name: /국립중앙박물관/ });
    await vi.advanceTimersByTimeAsync(60_000); // 다음 tick이 먼저 도착
    await waitFor(() => expect(museumCard).toHaveTextContent("붐빔"));

    // act로 감싸야 React가 늦게 도착한 응답의 상태 갱신을 실제로 DOM까지 흘린다
    // — 이걸 빼면 갱신이 스케줄만 되고 남아 통과하는 무력한 테스트가 된다.
    await act(async () => {
      resolveStale?.({
        observed_at: "2026-08-20T14:20:00",
        congest_level: "여유",
        population_avg: 100,
      });
    });

    expect(museumCard).toHaveTextContent("붐빔");
    expect(museumCard).not.toHaveTextContent("여유");
  });

  it("falls back to an unavailable label only for the venue whose fetch failed", async () => {
    vi.spyOn(congestionApi, "fetchCurrent").mockRejectedValue(new Error("network error"));

    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("정보 없음")).toBeInTheDocument());
    // 국중박만 실패했으므로 MMCA 카드는 그대로 그려진다
    const seoulCard = screen.getByRole("link", { name: /국립현대미술관 서울관/ });
    expect(seoulCard).toHaveTextContent("여유");
  });
});
