import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as analyticsApi from "../src/api/analytics";
import type { VisitStats } from "../src/api/analytics";
import { VisitorsPage } from "../src/pages/VisitorsPage";

const STATS: VisitStats = {
  daily: [
    { date: "2026-09-06", views: 4, visitors: 3, unconfirmed: 7, bots: 12 },
    { date: "2026-09-07", views: 10, visitors: 6, unconfirmed: 2, bots: 9 },
  ],
  referrers: [
    { source: "www.google.com", views: 8 },
    { source: "직접 방문", views: 6 },
  ],
  devices: { mobile: 9, desktop: 5 },
  visits: [
    {
      at: "2026-09-07T14:20:00",
      path: "/logs",
      kind: "human",
      visitor: "93345f",
      device: "desktop",
      referrer: "직접 방문",
    },
    {
      at: "2026-09-07T03:11:00",
      path: "/",
      kind: "unconfirmed",
      visitor: "57a58d",
      device: "mobile",
      referrer: null,
    },
  ],
};

// 카드와 표의 숫자는 화면 곳곳에서 겹친다 (봇 9 와 모바일 9). 라벨이 있는
// 줄 안에서만 찾는다.
function metric(label: string): string {
  return screen.getByText(label).parentElement?.textContent ?? "";
}

function row(label: string): string {
  return screen.getByText(label).closest("tr")?.textContent ?? "";
}

// 표가 넷이라 "모바일" 같은 말은 두 표에 함께 나온다. 표 이름으로 좁힌다.
function rowIn(table: string, label: string): string {
  const scope = within(screen.getByRole("table", { name: table }));
  return scope.getByText(label).closest("tr")?.textContent ?? "";
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
    vi.spyOn(analyticsApi, "fetchVisits").mockResolvedValue(STATS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.pushState({}, "", "/");
  });

  it("asks for 30 days when the URL says nothing", async () => {
    visit();

    await waitFor(() => expect(analyticsApi.fetchVisits).toHaveBeenCalledWith(30));
  });

  it("takes the range from the URL and follows the buttons", async () => {
    visit("?days=7");

    await waitFor(() => expect(analyticsApi.fetchVisits).toHaveBeenCalledWith(7));

    fireEvent.click(screen.getByRole("button", { name: "90일" }));

    await waitFor(() => expect(analyticsApi.fetchVisits).toHaveBeenCalledWith(90));
  });

  it("falls back to 30 days for a range it does not offer", async () => {
    visit("?days=9999");

    await waitFor(() => expect(analyticsApi.fetchVisits).toHaveBeenCalledWith(30));
  });

  it("totals views over the window but reports visitors as a daily peak", async () => {
    visit();

    await waitFor(() => expect(metric("기간 방문")).toContain("14"));
    // 순방문자는 날짜별 집합이라 기간 합계가 의미가 없다 — 3 + 6 = 9 가 아니라
    // 하루 최다인 6 이 실려야 한다.
    expect(metric("하루 최다 순방문자")).toContain("6");
    expect(metric("봇 요청")).toContain("21");
  });

  it("lists each day, its referrers and the device split", async () => {
    visit();

    await waitFor(() => expect(row("2026-09-07")).toContain("10"));
    expect(row("2026-09-07")).toContain("6");
    expect(row("2026-09-06")).toContain("4");
    expect(row("www.google.com")).toContain("8");
    expect(rowIn("기기", "모바일")).toContain("9");
    expect(rowIn("기기", "데스크톱")).toContain("5");
  });

  it("lists each visit newest-first with what it was", async () => {
    visit();

    await waitFor(() => expect(screen.getByText("93345f")).toBeInTheDocument());
    expect(row("93345f")).toContain("사람");
    expect(row("93345f")).toContain("/logs");
    expect(row("93345f")).toContain("09-07 14:20");
    // 앱이 뜨지 않은 요청은 방문과 같은 표에 있되 다른 이름을 단다.
    expect(row("57a58d")).toContain("미확인");
    expect(rowIn("방문 목록", "57a58d")).toContain("모바일");
    // referrer 가 없는 줄도 칸을 비우지 않는다.
    expect(row("57a58d")).toContain("—");
  });

  it("shows the unconfirmed count next to the day's visits", async () => {
    visit();

    await waitFor(() => expect(row("2026-09-07")).toContain("10"));
    expect(row("2026-09-07")).toContain("2");
  });

  it("says so when nothing could be fetched", async () => {
    vi.spyOn(analyticsApi, "fetchVisits").mockRejectedValue(new Error("nope"));

    visit();

    await waitFor(() =>
      expect(screen.getByText("집계를 불러오지 못했습니다.")).toBeInTheDocument()
    );
  });
});
