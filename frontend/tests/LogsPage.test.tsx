import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as congestionApi from "../src/api/congestion";
import * as mmcaApi from "../src/api/mmca";
import { LogsPage } from "../src/pages/LogsPage";

function visit(search: string) {
  window.history.pushState({}, "", `/logs${search}`);
  render(
    <BrowserRouter>
      <LogsPage />
    </BrowserRouter>
  );
}

describe("LogsPage", () => {
  beforeEach(() => {
    vi.spyOn(congestionApi, "fetchDailyRaw").mockResolvedValue([
      { observed_at: "2026-08-20T09:00:00", fields: { AREA_CONGEST_LVL: "여유" } },
    ]);
    vi.spyOn(mmcaApi, "fetchMmcaDaily").mockResolvedValue([
      {
        observed_at: "2026-08-20T10:00:00",
        rooms: [{ space_code: "MMCA-SPACE-1001", space_nm: "1전시실", congestion_nm: "보통" }],
      },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.pushState({}, "", "/");
  });

  it("shows the national museum log when no venue is given", async () => {
    visit("");

    await waitFor(() => expect(screen.getByText("여유")).toBeInTheDocument());
    expect(congestionApi.fetchDailyRaw).toHaveBeenCalled();
    expect(mmcaApi.fetchMmcaDaily).not.toHaveBeenCalled();
  });

  it("shows the venue named in the query string", async () => {
    visit("?venue=mmca-seoul");

    await waitFor(() => expect(screen.getByText("1전시실")).toBeInTheDocument());
    expect(mmcaApi.fetchMmcaDaily).toHaveBeenCalledWith("seoul", expect.any(String));
    expect(congestionApi.fetchDailyRaw).not.toHaveBeenCalled();
  });

  it("keeps the chosen venue in the URL so a reload and a shared link land on it", async () => {
    visit("");
    await waitFor(() => expect(screen.getByText("여유")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "국립현대미술관 과천관" }));

    await waitFor(() => expect(window.location.search).toBe("?venue=mmca-gwacheon"));
    expect(mmcaApi.fetchMmcaDaily).toHaveBeenCalledWith("gwacheon", expect.any(String));
  });

  it("falls back to the first venue for a venue it does not know", async () => {
    // 오래된 링크에 404 를 주는 대신 무언가를 보여준다.
    visit("?venue=made-up");

    await waitFor(() => expect(screen.getByText("여유")).toBeInTheDocument());
  });

  it("has a tab for every venue", async () => {
    // 덕수궁관은 수집 대상이 아닌 동안 탭에서 빠져 있었다 — 켠 뒤에도 빠져
    // 있으면 그 관의 원본 데이터를 화면에서 볼 방법이 없다.
    visit("");
    await waitFor(() => expect(screen.getByText("여유")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: /덕수궁/ })).toBeInTheDocument();
  });
});
