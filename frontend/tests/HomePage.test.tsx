import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as congestionApi from "../src/api/congestion";
import type { CurrentCongestion } from "../src/api/congestion";
import * as mmcaApi from "../src/api/mmca";
import type { MmcaRoomStatus } from "../src/api/mmca";
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
    vi.spyOn(mmcaApi, "fetchMmcaRooms").mockResolvedValue([
      makeRoom({ space_code: "MMCA-SPACE-1001", congestion_nm: "여유" }),
      makeRoom({ space_code: "MMCA-SPACE-1002", congestion_nm: "여유" }),
      makeRoom({ space_code: "MMCA-SPACE-1003", congestion_nm: "보통" }),
    ]);
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

  it("links to the raw collection log", async () => {
    // 관 페이지에서 표를 내린 대신 여기서만 들어갈 수 있으므로, 링크가 사라지면
    // 수집한 데이터를 화면에서 볼 방법이 없어진다.
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: /수집 원본 데이터/ })).toHaveAttribute(
      "href",
      "/logs"
    );
  });

  it("answers from the clock instead of flashing a loading placeholder", async () => {
    // 다른 페이지에서 홈으로 돌아오면 컴포넌트가 새로 마운트되어 응답을 다시
    // 기다린다. 영업시간 밖이라는 사실은 시계만으로 알 수 있으므로, 그 왕복
    // 동안 "불러오는 중"을 먼저 보여줄 이유가 없다.
    vi.setSystemTime(new Date("2026-08-20T07:00:00")); // 목요일 07:00, 두 관 모두 개관 전
    vi.spyOn(congestionApi, "fetchCurrent").mockReturnValue(new Promise(() => {}));
    vi.spyOn(mmcaApi, "fetchMmcaRooms").mockReturnValue(new Promise(() => {}));

    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: /국립중앙박물관/ })).toHaveTextContent("영업 전");
    expect(screen.getByRole("link", { name: /국립현대미술관 서울관/ })).toHaveTextContent("영업 전");
    expect(screen.queryByText("불러오는 중")).not.toBeInTheDocument();
  });

  it("keeps MMCA venues clickable while they are only temporarily inactive", async () => {
    // 카드가 값을 못 보여주는 것과 갈 곳이 없는 것은 다르다 — "영업 전"·"정보
    // 없음" 은 곧 값이 돌아오는 상태이고, 그 페이지엔 지난주 곡선 등 볼 것이
    // 남아 있다. 라벨을 보고 링크를 떼면 그 길이 막힌다.
    vi.setSystemTime(new Date("2026-08-20T07:00:00")); // 개관 전 — 모든 관이 inactive
    vi.spyOn(mmcaApi, "fetchMmcaRooms").mockRejectedValue(new Error("network error"));

    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    for (const [name, path] of [
      ["국립현대미술관 서울관", "/venues/mmca-seoul"],
      ["국립현대미술관 과천관", "/venues/mmca-gwacheon"],
      ["국립현대미술관 덕수궁관", "/venues/mmca-deoksugung"],
    ] as const) {
      const card = screen.getByRole("link", { name: new RegExp(name) });
      expect(card).toHaveAttribute("href", path);
      expect(card).toHaveTextContent("영업 전");
    }
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
