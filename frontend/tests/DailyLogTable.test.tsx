import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DailyLogTable } from "../src/components/DailyLogTable";
import * as api from "../src/api/congestion";
import type { DailyLogPoint } from "../src/api/congestion";

// No @types/node in this project; declare just enough of the Node global to
// read/write TZ for the timezone-pinned test below.
declare const process: { env: Record<string, string | undefined> };

function makeRow(observedAt: string, congestLevel = "여유"): DailyLogPoint {
  return {
    observed_at: observedAt,
    congest_level: congestLevel,
    population_min: 800,
    population_max: 1000,
    male_ppltn_rate: null,
    female_ppltn_rate: null,
    ppltn_rate_0: null,
    ppltn_rate_10: null,
    ppltn_rate_20: null,
    ppltn_rate_30: null,
    ppltn_rate_40: null,
    ppltn_rate_50: null,
    ppltn_rate_60: null,
    ppltn_rate_70: null,
    resnt_ppltn_rate: null,
    non_resnt_ppltn_rate: null,
  };
}

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

  it("shows the most recent reading first", async () => {
    vi.spyOn(api, "fetchDaily").mockResolvedValue([
      makeRow("2026-07-16T08:00:00"),
      makeRow("2026-07-16T09:00:00"),
    ]);

    render(<DailyLogTable />);
    await waitFor(() => expect(screen.getByText("09:00")).toBeInTheDocument());

    const rows = screen.getAllByRole("row");
    // rows[0] is the header row; the newest reading (09:00) must render first.
    expect(rows[1]).toHaveTextContent("09:00");
    expect(rows[2]).toHaveTextContent("08:00");
  });

  it("disables the previous-day button at the earliest collection date", async () => {
    vi.spyOn(api, "fetchDaily").mockResolvedValue([]);

    render(<DailyLogTable />);
    await waitFor(() => screen.getByText(/데이터 없음/));

    const prevButton = screen.getByRole("button", { name: /이전 날짜/ });
    const earliest = new Date("2026-07-15T00:00:00");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const daysToEarliest = Math.round((today.getTime() - earliest.getTime()) / 86_400_000);

    for (let i = 0; i < daysToEarliest; i++) {
      fireEvent.click(prevButton);
      await waitFor(() => screen.getByText(/데이터 없음/));
    }

    expect(screen.getByText("2026-07-15")).toBeInTheDocument();
    expect(prevButton).toBeDisabled();
  });

  it("ignores a stale response that resolves after a newer request", async () => {
    let resolveFirst: (rows: DailyLogPoint[]) => void = () => {};
    let resolveSecond: (rows: DailyLogPoint[]) => void = () => {};

    const fetchDailyMock = vi
      .spyOn(api, "fetchDaily")
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));

    render(<DailyLogTable />);
    await waitFor(() => expect(fetchDailyMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /이전 날짜/ }));
    await waitFor(() => expect(fetchDailyMock).toHaveBeenCalledTimes(2));

    // The newer (second) request resolves first...
    resolveSecond([makeRow("2026-07-15T05:00:00")]);
    await waitFor(() => expect(screen.getByText("05:00")).toBeInTheDocument());

    // ...then the stale (first) request resolves late. It must be ignored.
    resolveFirst([makeRow("2026-07-16T09:00:00")]);
    await waitFor(() => expect(screen.getByText("05:00")).toBeInTheDocument());
    expect(screen.queryByText("09:00")).not.toBeInTheDocument();
  });

  describe("in a UTC+9 (KST) timezone", () => {
    let originalTz: string | undefined;

    beforeEach(() => {
      originalTz = process.env.TZ;
      process.env.TZ = "Asia/Seoul";
    });

    afterEach(() => {
      process.env.TZ = originalTz;
    });

    // Independent oracle for "local calendar date" — deliberately does not
    // reuse the component's toISOString()-free formatting logic, so this
    // test fails against the old UTC-based implementation and passes
    // against the local-date fix.
    function localDateString(d: Date): string {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }

    it("navigates by exactly one local calendar day, not a UTC day", async () => {
      const fetchDailyMock = vi.spyOn(api, "fetchDaily").mockResolvedValue([]);

      const today = new Date();
      const todayLocal = localDateString(today);
      const yesterdayLocal = localDateString(new Date(today.getTime() - 24 * 60 * 60 * 1000));

      render(<DailyLogTable />);
      await waitFor(() => expect(fetchDailyMock).toHaveBeenCalledTimes(1));
      expect(screen.getByText(todayLocal)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /이전 날짜/ }));
      await waitFor(() => expect(fetchDailyMock).toHaveBeenCalledTimes(2));
      expect(screen.getByText(yesterdayLocal)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /다음 날짜/ }));
      await waitFor(() => expect(fetchDailyMock).toHaveBeenCalledTimes(3));
      expect(screen.getByText(todayLocal)).toBeInTheDocument();
    });
  });
});
