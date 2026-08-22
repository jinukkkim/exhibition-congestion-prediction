import { describe, expect, it } from "vitest";

import { MMCA_STALE_MINUTES, SEOUL_STALE_MINUTES, isStale } from "../src/lib/freshness";

const NOW = new Date("2026-08-22T14:00:00");

describe("isStale", () => {
  it("treats a reading within the window as fresh", () => {
    expect(isStale("2026-08-22T13:20:00", NOW, 45)).toBe(false);
  });

  it("treats a reading past the window as stale", () => {
    expect(isStale("2026-08-22T13:10:00", NOW, 45)).toBe(true);
  });

  it("counts the boundary minute as still fresh", () => {
    expect(isStale("2026-08-22T13:15:00", NOW, 45)).toBe(false);
  });

  it("treats a missing reading as stale", () => {
    expect(isStale(null, NOW, 45)).toBe(true);
  });

  it("treats a future timestamp as fresh rather than wrapping around", () => {
    // 서버 시계가 앞서 있으면 음수 나이가 나온다. 그걸 stale 로 뒤집으면
    // 안 되고, 그대로 신선한 것으로 본다.
    expect(isStale("2026-08-22T14:30:00", NOW, 45)).toBe(false);
  });
});

describe("thresholds", () => {
  it("gives Seoul room for its upstream publication lag", () => {
    // 국중박 observed_at 은 서울 API 의 PPLTN_TIME(상류 발행 측정 시각)이라
    // 정상 수집 중에도 30분가량 낡아 있다. MMCA 는 폴링 시각을 그대로 쓰므로
    // 그 여유가 필요 없다. backend/app/routes/health.py 의 짝과 같은 값.
    expect(SEOUL_STALE_MINUTES).toBe(45);
    expect(MMCA_STALE_MINUTES).toBe(25);
  });
});
