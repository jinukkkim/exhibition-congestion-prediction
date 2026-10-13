import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as analyticsApi from "../src/api/analytics";
import type { Pageview, VisitStats } from "../src/api/analytics";
import { VisitorsPage } from "../src/pages/VisitorsPage";

function pv(overrides: Partial<Pageview>): Pageview {
  return {
    at: "2026-09-07T14:20:00+09:00",
    path: "/",
    visitor: "aaaaaa",
    device: "desktop",
    browser: "Chrome",
    os: "macOS",
    referrer: "www.google.com",
    utm: {},
    ...overrides,
  };
}

const STATS: VisitStats = {
  start: "2026-09-01T00:00:00+09:00",
  previous_start: "2026-08-25T00:00:00+09:00",
  coverage_start: "2026-08-20T08:00:00+09:00",
  pageviews: [
    // 직전 기간: 방문자 2, 페이지뷰 2
    pv({ at: "2026-08-26T10:00:00+09:00", visitor: "p1" }),
    pv({ at: "2026-08-27T10:00:00+09:00", visitor: "p2" }),
    // 이번 기간: 방문자 3, 페이지뷰 4
    pv({ visitor: "93345f" }),
    pv({ visitor: "93345f", path: "/logs", referrer: null }),
    pv({
      visitor: "b2b2b2",
      path: "/venues/mmca-seoul",
      device: "mobile",
      browser: "Safari",
      os: "iOS",
      referrer: "직접 방문",
      utm: { source: "instagram" },
    }),
    pv({ visitor: "c3c3c3", device: "mobile", browser: "Safari", os: "iOS" }),
  ],
  recent: [
    { ...pv({ visitor: "93345f", path: "/logs", referrer: null }), kind: "human" },
    {
      ...pv({ at: "2026-09-07T03:11:00+09:00", visitor: "57a58d", device: "mobile" }),
      kind: "unconfirmed",
    },
    { ...pv({ at: "2026-09-07T01:00:00+09:00", visitor: "e1e1e1" }), kind: "self" },
  ],
  excluded: { bots: 21, unconfirmed: 9, self: 4 },
};

function tile(label: string): string {
  return screen.getByRole("button", { name: new RegExp(label) }).textContent ?? "";
}

function panel(name: string) {
  return within(screen.getByRole("region", { name }));
}

function visit(search = "") {
  window.history.pushState({}, "", `/visitors${search}`);
  render(
    <BrowserRouter>
      <VisitorsPage />
    </BrowserRouter>
  );
}

describe("VisitorsPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T15:00:00+09:00"));
    vi.spyOn(analyticsApi, "fetchVisits").mockResolvedValue(STATS);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.history.pushState({}, "", "/");
  });

  it("asks for 7 days when the URL says nothing", async () => {
    visit();

    await waitFor(() => expect(analyticsApi.fetchVisits).toHaveBeenCalledWith(7));
  });

  it("takes the range from the URL and follows the picker", async () => {
    visit("?days=30");

    await waitFor(() => expect(analyticsApi.fetchVisits).toHaveBeenCalledWith(30));

    fireEvent.change(screen.getByLabelText("기간"), { target: { value: "1" } });

    await waitFor(() => expect(analyticsApi.fetchVisits).toHaveBeenCalledWith(1));
  });

  it("falls back to 7 days for a range it does not offer", async () => {
    visit("?days=9999");

    await waitFor(() => expect(analyticsApi.fetchVisits).toHaveBeenCalledWith(7));
  });

  it("totals the period's visitors and views against the period before", async () => {
    visit();

    await waitFor(() => expect(tile("방문자")).toContain("3"));
    expect(tile("방문자")).toContain("50%");
    expect(tile("페이지뷰")).toContain("4");
    expect(tile("페이지뷰")).toContain("100%");
  });

  it("does not compare against a period the log no longer reaches", async () => {
    vi.spyOn(analyticsApi, "fetchVisits").mockResolvedValue({
      ...STATS,
      coverage_start: "2026-08-30T00:00:00+09:00",
    });

    visit();

    await waitFor(() => expect(tile("방문자")).toContain("3"));
    expect(tile("방문자")).not.toContain("%");
  });

  it("breaks pages down by visitors and switches tabs", async () => {
    visit();

    await waitFor(() => expect(panel("페이지").getByText("/")).toBeInTheDocument());
    expect(panel("페이지").getByText("/").closest("button")?.textContent).toContain("2");

    fireEvent.click(panel("페이지").getByRole("tab", { name: "라우트" }));

    expect(panel("페이지").getByText("/venues/[venue]")).toBeInTheDocument();
  });

  it("leaves our own pages out of the referrers", async () => {
    visit();

    await waitFor(() => expect(panel("유입 경로").getByText("www.google.com")).toBeInTheDocument());
    expect(panel("유입 경로").getByText("www.google.com").closest("button")?.textContent).toContain(
      "2"
    );
  });

  it("filters everything by a clicked row and puts the filter in the URL", async () => {
    visit();

    await waitFor(() => expect(panel("기기").getByText("모바일")).toBeInTheDocument());
    fireEvent.click(panel("기기").getByText("모바일"));

    expect(window.location.search).toContain("device=mobile");
    expect(tile("방문자")).toContain("2");
    expect(tile("페이지뷰")).toContain("2");
    expect(panel("페이지").queryByText("/logs")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "기기 필터 해제" }));

    expect(window.location.search).not.toContain("device");
    expect(tile("페이지뷰")).toContain("4");
  });

  it("reads filters off the URL", async () => {
    visit("?utm_source=instagram");

    await waitFor(() => expect(tile("페이지뷰")).toContain("1"));
    expect(screen.getByText("instagram")).toBeInTheDocument();
  });

  it("lists recent visits with what each one was, and what was left out", async () => {
    visit();

    await waitFor(() => expect(screen.getByText("57a58d")).toBeInTheDocument());
    const table = within(screen.getByRole("table", { name: "최근 방문" }));
    expect(table.getByText("93345f").closest("tr")?.textContent).toContain("사람");
    expect(table.getByText("57a58d").closest("tr")?.textContent).toContain("미확인");
    expect(table.getByText("57a58d").closest("tr")?.textContent).toContain("09-07 03:11");
    expect(table.getByText("e1e1e1").closest("tr")?.textContent).toContain("나");
    expect(screen.getByText(/나 4/)).toBeInTheDocument();
    expect(screen.getByText(/봇 21/)).toBeInTheDocument();
    expect(screen.getByText(/미확인 9/)).toBeInTheDocument();
  });

  it("says so when nothing could be fetched", async () => {
    vi.spyOn(analyticsApi, "fetchVisits").mockRejectedValue(new Error("nope"));

    visit();

    await waitFor(() =>
      expect(screen.getByText("집계를 불러오지 못했습니다.")).toBeInTheDocument()
    );
  });
});
