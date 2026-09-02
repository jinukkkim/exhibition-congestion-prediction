import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MmcaRoomInactiveCard } from "../src/components/MmcaRoomInactiveCard";
import type { MmcaRoomStatus } from "../src/api/mmca";

function makeRoom(overrides: Partial<MmcaRoomStatus> = {}): MmcaRoomStatus {
  return {
    space_code: "MMCA-SPACE-2008",
    space_nm: "1층 어린이미술관",
    congestion_nm: null,
    observed_at: null,
    ...overrides,
  };
}

describe("MmcaRoomInactiveCard", () => {
  it("renders the room title and the given reason", () => {
    render(<MmcaRoomInactiveCard room={makeRoom()} exhibitionTitle={null} reason="오늘 정보 없음" />);

    expect(screen.getByText("1층 어린이미술관")).toBeInTheDocument();
    expect(screen.getByText("오늘 정보 없음")).toBeInTheDocument();
  });

  it("falls back to the space code as the title when the room has no name yet", () => {
    render(
      <MmcaRoomInactiveCard
        room={makeRoom({ space_nm: null })}
        exhibitionTitle={null}
        reason="오늘 정보 없음"
      />
    );

    expect(screen.getByText("MMCA-SPACE-2008")).toBeInTheDocument();
    expect(screen.getByText("오늘 정보 없음")).toBeInTheDocument();
  });

  it("shows the exhibition running in a room that has no reading of its own", () => {
    // 혼잡도 API 는 전시가 걸친 방 중 한 곳만 보고한다 — 나머지 방은 축소
    // 카드로 남지만 전시는 실제로 열려 있다.
    render(
      <MmcaRoomInactiveCard
        room={makeRoom({ space_code: "MMCA-SPACE-1004", space_nm: "4전시실" })}
        exhibitionTitle="서도호"
        reason="오늘 정보 없음"
      />
    );

    expect(screen.getByText("서도호")).toBeInTheDocument();
  });
});
