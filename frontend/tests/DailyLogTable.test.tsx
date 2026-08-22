import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DailyLogTable } from "../src/components/DailyLogTable";
import * as api from "../src/api/congestion";
import type { RawLogPoint } from "../src/api/congestion";

// No @types/node in this project; declare just enough of the Node global to
// read/write TZ for the timezone-pinned test below.
declare const process: { env: Record<string, string | undefined> };

function makeRow(observedAt: string, congestLevel = "여유"): RawLogPoint {
  return {
    observed_at: observedAt,
    fields: { AREA_CONGEST_LVL: congestLevel, AREA_PPLTN_MIN: 800, AREA_PPLTN_MAX: 1000 },
  };
}

describe("DailyLogTable", () => {
  it("renders rows for the fetched day", async () => {
    vi.spyOn(api, "fetchDailyRaw").mockResolvedValue([
      {
        observed_at: "2026-07-16T09:00:00",
        fields: {
          AREA_CONGEST_LVL: "여유",
          MALE_PPLTN_RATE: 51.8,
          // DB 컬럼으로 승격한 적 없는 필드 — raw_response 에서 그대로 흘러온다.
          TEMP: "30.2",
          // 0 은 값이다. falsy 로 묶어 비우면 안 된다.
          PM10: 0,
        },
      },
    ]);

    render(<DailyLogTable />);

    await waitFor(() => expect(screen.getByText("여유")).toBeInTheDocument());
    expect(screen.getByText("09:00")).toBeInTheDocument();
    expect(screen.getByText("51.8")).toBeInTheDocument();
  });

  it("makes a column out of every field the response carries, named as the API names it", async () => {
    // 컬럼 목록을 코드에 박아두지 않는 이유 — 서울시가 필드를 늘리면 코드를 안
    // 고쳐도 표에 나타나야 한다.
    vi.spyOn(api, "fetchDailyRaw").mockResolvedValue([
      {
        observed_at: "2026-07-16T09:00:00",
        fields: { AREA_CONGEST_LVL: "여유", TEMP: "30.2", PM10: 0 },
      },
    ]);

    render(<DailyLogTable />);

    await waitFor(() => expect(screen.getByText("여유")).toBeInTheDocument());
    expect(screen.getByRole("columnheader", { name: "TEMP" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "PM10" })).toBeInTheDocument();
    expect(screen.getByText("30.2")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("explains a column it knows and leaves one it does not alone", async () => {
    vi.spyOn(api, "fetchDailyRaw").mockResolvedValue([
      {
        observed_at: "2026-07-16T09:00:00",
        fields: { AREA_PPLTN_MIN: 800, FUTURE_FIELD: "x" },
      },
    ]);

    render(<DailyLogTable />);

    const known = await waitFor(() =>
      screen.getByRole("columnheader", { name: "AREA_PPLTN_MIN" })
    );
    expect(known.getAttribute("title")).toContain("하한");
    expect(known).toHaveTextContent("ⓘ");

    // 설명이 없는 필드도 열로는 나온다 — 설명 사전이 컬럼 목록을 좌우하면
    // 응답에서 컬럼을 만드는 성질이 깨진다.
    const unknown = screen.getByRole("columnheader", { name: "FUTURE_FIELD" });
    expect(unknown).not.toHaveAttribute("title");
    expect(unknown).not.toHaveTextContent("ⓘ");
  });

  it("shows an empty-state message when there is no data for the day", async () => {
    vi.spyOn(api, "fetchDailyRaw").mockResolvedValue([]);

    render(<DailyLogTable />);

    await waitFor(() => expect(screen.getByText(/데이터 없음/)).toBeInTheDocument());
  });

  it("disables the next-day button when viewing today", async () => {
    vi.spyOn(api, "fetchDailyRaw").mockResolvedValue([]);

    render(<DailyLogTable />);

    await waitFor(() => screen.getByText(/데이터 없음/));
    expect(screen.getByRole("button", { name: /다음 날짜/ })).toBeDisabled();
  });

  it("re-fetches for the previous day when the previous button is clicked", async () => {
    const fetchRawMock = vi.spyOn(api, "fetchDailyRaw").mockResolvedValue([]);

    render(<DailyLogTable />);
    await waitFor(() => expect(fetchRawMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /이전 날짜/ }));

    await waitFor(() => expect(fetchRawMock).toHaveBeenCalledTimes(2));
    const firstCallDate = fetchRawMock.mock.calls[0][0];
    const secondCallDate = fetchRawMock.mock.calls[1][0];
    expect(secondCallDate < firstCallDate).toBe(true);
  });

  it("shows the most recent reading first", async () => {
    vi.spyOn(api, "fetchDailyRaw").mockResolvedValue([
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
    vi.spyOn(api, "fetchDailyRaw").mockResolvedValue([]);

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
    let resolveFirst: (rows: RawLogPoint[]) => void = () => {};
    let resolveSecond: (rows: RawLogPoint[]) => void = () => {};

    const fetchRawMock = vi
      .spyOn(api, "fetchDailyRaw")
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));

    render(<DailyLogTable />);
    await waitFor(() => expect(fetchRawMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /이전 날짜/ }));
    await waitFor(() => expect(fetchRawMock).toHaveBeenCalledTimes(2));

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
      const fetchRawMock = vi.spyOn(api, "fetchDailyRaw").mockResolvedValue([]);

      const today = new Date();
      const todayLocal = localDateString(today);
      const yesterdayLocal = localDateString(new Date(today.getTime() - 24 * 60 * 60 * 1000));

      render(<DailyLogTable />);
      await waitFor(() => expect(fetchRawMock).toHaveBeenCalledTimes(1));
      expect(screen.getByText(todayLocal)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /이전 날짜/ }));
      await waitFor(() => expect(fetchRawMock).toHaveBeenCalledTimes(2));
      expect(screen.getByText(yesterdayLocal)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /다음 날짜/ }));
      await waitFor(() => expect(fetchRawMock).toHaveBeenCalledTimes(3));
      expect(screen.getByText(todayLocal)).toBeInTheDocument();
    });
  });
});
