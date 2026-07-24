import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RoomCongestionCard } from "../src/components/RoomCongestionCard";
import type { MmcaRoomStatus } from "../src/api/mmca";

function makeRoom(overrides: Partial<MmcaRoomStatus> = {}): MmcaRoomStatus {
  return {
    space_code: "MMCA-SPACE-1001",
    space_nm: "1전시실",
    congestion_nm: "여유",
    observed_at: "2026-07-24T10:00:00",
    ...overrides,
  };
}

describe("RoomCongestionCard", () => {
  it("renders the room name, congestion level, and last-updated time", () => {
    render(<RoomCongestionCard room={makeRoom()} />);

    expect(screen.getByText("1전시실")).toBeInTheDocument();
    expect(screen.getByText("여유")).toBeInTheDocument();
    expect(screen.getByText(/10:00/)).toBeInTheDocument();
  });

  it("shows a fallback when congestion_nm is missing", () => {
    render(<RoomCongestionCard room={makeRoom({ congestion_nm: null })} />);

    expect(screen.getByText("정보 없음")).toBeInTheDocument();
  });

  it("falls back to the space code when space_nm is missing", () => {
    render(<RoomCongestionCard room={makeRoom({ space_nm: null })} />);

    expect(screen.getByText("MMCA-SPACE-1001")).toBeInTheDocument();
  });
});
