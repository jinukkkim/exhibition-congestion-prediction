import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DailyLogTable } from "../src/components/DailyLogTable";
import * as api from "../src/api/congestion";

describe("DailyLogTable", () => {
  it("renders rows for the fetched day", async () => {
    vi.spyOn(api, "fetchDaily").mockResolvedValue([
      {
        observed_at: "2026-07-16T09:00:00",
        congest_level: "여유",
        population_min: 800,
        population_max: 1000,
        male_ppltn_rate: 51.8,
        female_ppltn_rate: 48.2,
        ppltn_rate_0: null,
        ppltn_rate_10: null,
        ppltn_rate_20: null,
        ppltn_rate_30: null,
        ppltn_rate_40: null,
        ppltn_rate_50: null,
        ppltn_rate_60: null,
        ppltn_rate_70: null,
        resnt_ppltn_rate: 45.1,
        non_resnt_ppltn_rate: 54.9,
      },
    ]);

    render(<DailyLogTable />);

    await waitFor(() => expect(screen.getByText("여유")).toBeInTheDocument());
    expect(screen.getByText("09:00")).toBeInTheDocument();
    expect(screen.getByText("51.8")).toBeInTheDocument();
  });

  it("shows an empty-state message when there is no data for the day", async () => {
    vi.spyOn(api, "fetchDaily").mockResolvedValue([]);

    render(<DailyLogTable />);

    await waitFor(() => expect(screen.getByText(/데이터 없음/)).toBeInTheDocument());
  });

  it("disables the next-day button when viewing today", async () => {
    vi.spyOn(api, "fetchDaily").mockResolvedValue([]);

    render(<DailyLogTable />);

    await waitFor(() => screen.getByText(/데이터 없음/));
    expect(screen.getByRole("button", { name: /다음 날짜/ })).toBeDisabled();
  });

  it("re-fetches for the previous day when the previous button is clicked", async () => {
    const fetchDailyMock = vi.spyOn(api, "fetchDaily").mockResolvedValue([]);

    render(<DailyLogTable />);
    await waitFor(() => expect(fetchDailyMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /이전 날짜/ }));

    await waitFor(() => expect(fetchDailyMock).toHaveBeenCalledTimes(2));
    const firstCallDate = fetchDailyMock.mock.calls[0][0];
    const secondCallDate = fetchDailyMock.mock.calls[1][0];
    expect(secondCallDate < firstCallDate).toBe(true);
  });
});
