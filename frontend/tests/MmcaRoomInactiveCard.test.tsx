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
    render(<MmcaRoomInactiveCard room={makeRoom()} reason="서비스 예정" />);

    expect(screen.getByText("1층 어린이미술관")).toBeInTheDocument();
    expect(screen.getByText("서비스 예정")).toBeInTheDocument();
  });

  it("falls back to the space code as the title when the room has no name yet", () => {
    render(<MmcaRoomInactiveCard room={makeRoom({ space_nm: null })} reason="오늘 정보 없음" />);

    expect(screen.getByText("MMCA-SPACE-2008")).toBeInTheDocument();
    expect(screen.getByText("오늘 정보 없음")).toBeInTheDocument();
  });
});
