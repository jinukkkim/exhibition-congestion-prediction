# MMCA 과천관 전시실별 혼잡도 그래프 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 과천관 페이지에서 1전시실(`MMCA-SPACE-2001`)과 1층 어린이미술관(`MMCA-SPACE-2008`)을 국중박 `CongestionCard`와 같은 형식(영업시간 x축, 실시간 배지, 영업 전/후 안내)의 계단형 그래프 카드로 절반씩 나란히 보여주고, 나머지 6개 전시실은 기존 소형 카드로 그 아래에 둔다.

**Architecture:** 신규 컴포넌트 `MmcaRoomChartCard`가 기존 `GET /mmca/daily` 응답에서 특정 전시실 하나만 뽑아 계단형 SVG를 그린다(백엔드 변경 없음). `MmcaPage`에 `heroSpaceCodes?: string[]` prop을 추가해 지정된 전시실을 소형 그리드에서 빼고 위쪽에 큰 카드로 렌더링한다. `App.tsx`의 과천관 라우트에서만 이 prop을 넘긴다.

**Tech Stack:** 기존과 동일 — React, TypeScript, Vitest, Playwright. 신규 의존성 없음.

## Global Constraints

- 차트는 계단형(step)이다 — 곡선 아님. 값이 바뀌는 시점에만 수직으로 변하고 그 사이는 평평하게 유지한다.
- 리샘플링/버킷팅 없음 — `/mmca/daily`가 이미 15분 그리드로 주는 값을 그대로 점으로 사용한다.
- 그래프는 "오늘"만 고정 표시한다(날짜 이동 없음) — 과거 조회는 기존 `MmcaDailyLogTable`이 담당.
- 새 백엔드 엔드포인트를 만들지 않는다 — 기존 `GET /mmca/daily?venue&date`를 그대로 쓰고, 클라이언트에서 해당 `space_code` 하나만 필터링한다.
- 영업시간은 과천관 전용 신규 함수 `mmcaBusinessHours`로 정의한다(10:00 오픈, 수/토 21:00 마감, 그 외 18:00 마감) — 기존 국중박 `CongestionCard`의 `businessHours`와 공유하지 않는다(값이 다르고, 관별 예외가 늘어날수록 억지 공유가 손해).
- 이번 범위는 과천관의 두 전시실(`MMCA-SPACE-2001`, `MMCA-SPACE-2008`)뿐이다 — 서울관·덕수궁관, 과천관의 나머지 6개 전시실은 건드리지 않는다. 확장 가능하도록 `heroSpaceCodes` prop으로 파라미터화해 열어둔다.
- 이 작업은 `feat/mmca-gwacheon-room-graphs` 브랜치(이미 `develop`에서 분기)에서 진행한다. `develop`/`main`에 직접 커밋하지 않는다.

---

## File Structure

```
frontend/
  src/
    lib/
      mmcaBusinessHours.ts       (신규) — 과천관 영업시간(10:00 오픈, 18:00/21:00 마감)
    components/
      MmcaRoomChartCard.tsx       (신규) — 전시실 하나의 계단형 혼잡도 그래프 카드
    pages/
      MmcaPage.tsx                 (수정) — heroSpaceCodes prop, 히어로 카드 행 + 그리드 제외
    App.tsx                        (수정) — 과천관 라우트에 heroSpaceCodes 전달
  tests/
    MmcaRoomChartCard.test.tsx   (신규)
    MmcaPage.test.tsx             (수정)
  e2e/
    congestion.spec.ts            (수정)
```

---

## Task 1: `mmcaBusinessHours` 유틸 + `MmcaRoomChartCard` 컴포넌트

**Files:**
- Create: `frontend/src/lib/mmcaBusinessHours.ts`
- Create: `frontend/src/components/MmcaRoomChartCard.tsx`
- Test: `frontend/tests/MmcaRoomChartCard.test.tsx`

**Interfaces:**
- Consumes: `fetchMmcaDaily(venue: MmcaVenue, date: string): Promise<MmcaDailyLogPoint[]>`, `type MmcaDailyLogPoint`, `type MmcaRoomStatus`, `type MmcaVenue`(모두 기존 `../api/mmca`), `todayString(): string`(기존 `../lib/date`), `statusOf(level: string): StatusTokens`(기존 `../lib/status`)
- Produces: `export function mmcaBusinessHours(date: Date): { open: number; close: number }`(`lib/mmcaBusinessHours.ts`). `export function MmcaRoomChartCard({ venue, spaceCode, room }: { venue: MmcaVenue; spaceCode: string; room: MmcaRoomStatus | undefined }): JSX.Element`(`components/MmcaRoomChartCard.tsx`). Task 2가 이 컴포넌트를 `MmcaPage`에 삽입한다 — `room`은 `undefined`도 허용해야 한다(`rooms.find(...)`가 못 찾을 수 있음).

- [ ] **Step 1: 영업시간 유틸 작성**

`frontend/src/lib/mmcaBusinessHours.ts` 신규 생성:

```ts
const OPEN_MINUTES = 10 * 60; // 10:00, every day
const LONG_CLOSE_DAYS = new Set([3, 6]); // Wed, Sat: 21:00 close; other days: 18:00

export function mmcaBusinessHours(date: Date): { open: number; close: number } {
  const close = LONG_CLOSE_DAYS.has(date.getDay()) ? 21 * 60 : 18 * 60;
  return { open: OPEN_MINUTES, close };
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`frontend/tests/MmcaRoomChartCard.test.tsx` 신규 생성:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MmcaRoomChartCard } from "../src/components/MmcaRoomChartCard";
import * as api from "../src/api/mmca";
import type { MmcaDailyLogPoint, MmcaRoomStatus } from "../src/api/mmca";

function dailyPoint(observedAt: string, byCode: Record<string, string | null>): MmcaDailyLogPoint {
  return {
    observed_at: observedAt,
    rooms: Object.entries(byCode).map(([space_code, congestion_nm]) => ({
      space_code,
      space_nm: null,
      congestion_nm,
    })),
  };
}

function makeRoom(overrides: Partial<MmcaRoomStatus> = {}): MmcaRoomStatus {
  return {
    space_code: "MMCA-SPACE-2001",
    space_nm: "1전시실",
    congestion_nm: "약간 붐빔",
    observed_at: "2026-07-15T14:30:00",
    ...overrides,
  };
}

describe("MmcaRoomChartCard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T14:30:00")); // Wed, within 10:00-21:00
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders the room name and current status headline", async () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);

    render(<MmcaRoomChartCard venue="gwacheon" spaceCode="MMCA-SPACE-2001" room={makeRoom()} />);

    expect(screen.getByText("1전시실")).toBeInTheDocument();
    expect(screen.getByText("약간 붐빔")).toBeInTheDocument();
  });

  it("shows '영업 시간이 아닙니다' outside business hours", async () => {
    vi.setSystemTime(new Date("2026-07-16T20:00:00")); // Thu closes at 18:00
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);

    render(<MmcaRoomChartCard venue="gwacheon" spaceCode="MMCA-SPACE-2001" room={makeRoom()} />);

    expect(screen.getByText("영업 시간이 아닙니다")).toBeInTheDocument();
    expect(screen.queryByText("약간 붐빔")).not.toBeInTheDocument();
  });

  it("shows '정보 없음' when open but no current room status yet", () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);

    render(<MmcaRoomChartCard venue="gwacheon" spaceCode="MMCA-SPACE-2001" room={undefined} />);

    expect(screen.getByText("정보 없음")).toBeInTheDocument();
  });

  it("draws a step line through today's readings for just this room", async () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([
      dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유", "MMCA-SPACE-2008": "보통" }),
      dailyPoint("2026-07-15T10:15:00", { "MMCA-SPACE-2001": "붐빔", "MMCA-SPACE-2008": "여유" }),
    ]);

    render(<MmcaRoomChartCard venue="gwacheon" spaceCode="MMCA-SPACE-2001" room={makeRoom()} />);

    await waitFor(() => expect(screen.getByTestId("mmca-room-chart-line")).toBeInTheDocument());
  });

  it("skips points where this room's reading is null", async () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([
      dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유" }),
      dailyPoint("2026-07-15T10:15:00", { "MMCA-SPACE-2001": null }),
      dailyPoint("2026-07-15T10:30:00", { "MMCA-SPACE-2001": "보통" }),
    ]);

    render(<MmcaRoomChartCard venue="gwacheon" spaceCode="MMCA-SPACE-2001" room={makeRoom()} />);

    // The null point must be dropped, not crash the path — 2 valid points remain.
    await waitFor(() => expect(screen.getByTestId("mmca-room-chart-line")).toBeInTheDocument());
  });

  it("shows the live glow marker only when open", async () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([
      dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유" }),
      dailyPoint("2026-07-15T14:15:00", { "MMCA-SPACE-2001": "붐빔" }),
    ]);

    const { container } = render(
      <MmcaRoomChartCard venue="gwacheon" spaceCode="MMCA-SPACE-2001" room={makeRoom()} />
    );

    // Glow renders as two circles (soft glow + white ring dot).
    await waitFor(() => expect(container.querySelectorAll("circle")).toHaveLength(2));
  });

  it("fetches with the venue prop and today's date", async () => {
    const fetchMmcaDailyMock = vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);

    render(<MmcaRoomChartCard venue="gwacheon" spaceCode="MMCA-SPACE-2001" room={makeRoom()} />);

    await waitFor(() => expect(fetchMmcaDailyMock).toHaveBeenCalledWith("gwacheon", "2026-07-15"));
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd frontend && npx vitest run tests/MmcaRoomChartCard.test.tsx`
Expected: FAIL — `Cannot find module '../src/components/MmcaRoomChartCard'`

- [ ] **Step 4: 컴포넌트 구현**

`frontend/src/components/MmcaRoomChartCard.tsx` 신규 생성:

```tsx
import { useEffect, useState } from "react";

import { fetchMmcaDaily, type MmcaDailyLogPoint, type MmcaRoomStatus, type MmcaVenue } from "../api/mmca";
import { todayString } from "../lib/date";
import { mmcaBusinessHours } from "../lib/mmcaBusinessHours";
import { statusOf } from "../lib/status";

const CHART_WIDTH = 480;
const CHART_HEIGHT = 200;
const POLL_INTERVAL_MS = 60_000;
const TIERS = ["여유", "보통", "약간 붐빔", "붐빔"];

// Same tick-generation math as CongestionCard's hourlyTicks, duplicated
// rather than shared: the values (open/close) differ per venue and the
// two call sites have no other coupling — see design doc §3.2.
const MIN_GAP_MINUTES = 35;

function minutesOfDay(isoString: string): number {
  return Number(isoString.slice(11, 13)) * 60 + Number(isoString.slice(14, 16));
}

function formatMinutes(minutes: number): string {
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function tickLabel(minutes: number): string {
  return minutes % 60 === 0 ? String(minutes / 60) : formatMinutes(minutes);
}

function hourlyTicks(open: number, close: number): { minutes: number; label: string }[] {
  const ticks: number[] = [];
  const firstRoundHour = Math.ceil(open / 60) * 60;
  for (let m = firstRoundHour; m < close; m += 60) {
    if (m - open < MIN_GAP_MINUTES || close - m < MIN_GAP_MINUTES) continue;
    ticks.push(m);
  }
  return [
    { minutes: open, label: tickLabel(open) },
    ...ticks.map((minutes) => ({ minutes, label: tickLabel(minutes) })),
    { minutes: close, label: tickLabel(close) },
  ];
}

type Point = { minutes: number; tier: number; label: string };

function xOf(minutes: number, open: number, close: number): number {
  return ((minutes - open) / (close - open || 1)) * CHART_WIDTH;
}

function yOf(tier: number): number {
  return CHART_HEIGHT - 24 - (tier / (TIERS.length - 1)) * (CHART_HEIGHT - 48);
}

// Step path: horizontal hold at each value, vertical jump exactly at the
// change point. Unlike CongestionCard's smoothed curve, this is honest
// about categorical data — the value really did jump, not drift.
function stepPath(points: Point[], open: number, close: number): string {
  let d = `M ${xOf(points[0].minutes, open, close)} ${yOf(points[0].tier)}`;
  for (let i = 1; i < points.length; i++) {
    const x = xOf(points[i].minutes, open, close);
    const prevY = yOf(points[i - 1].tier);
    d += ` L ${x} ${prevY} L ${x} ${yOf(points[i].tier)}`;
  }
  return d;
}

function areaPath(points: Point[], open: number, close: number, linePath: string): string {
  const firstX = xOf(points[0].minutes, open, close);
  const lastX = xOf(points[points.length - 1].minutes, open, close);
  return `M ${firstX} ${CHART_HEIGHT} L ${firstX} ${yOf(points[0].tier)} ${linePath.slice(linePath.indexOf("L"))} L ${lastX} ${CHART_HEIGHT} Z`;
}

export function MmcaRoomChartCard({
  venue,
  spaceCode,
  room,
}: {
  venue: MmcaVenue;
  spaceCode: string;
  room: MmcaRoomStatus | undefined;
}) {
  const [daily, setDaily] = useState<MmcaDailyLogPoint[] | null>(null);

  useEffect(() => {
    let ignore = false;

    function load() {
      fetchMmcaDaily(venue, todayString())
        .then((data) => {
          if (!ignore) setDaily(data);
        })
        .catch(() => {
          // Silently retry, matching MmcaDailyLogTable — keep whatever we
          // already have rather than blanking the card.
        });
    }

    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      ignore = true;
      clearInterval(timer);
    };
  }, [venue, spaceCode]);

  const now = new Date();
  const { open, close } = mmcaBusinessHours(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const isOpen = nowMinutes >= open && nowMinutes <= close;
  const openBadge = isOpen ? "실시간" : nowMinutes < open ? "영업 전" : "영업 종료";

  const points: Point[] = (daily ?? [])
    .flatMap((row): Point[] => {
      const value = row.rooms.find((r) => r.space_code === spaceCode)?.congestion_nm;
      if (value == null) return [];
      const tier = TIERS.indexOf(value);
      if (tier === -1) return [];
      return [{ minutes: minutesOfDay(row.observed_at), tier, label: value }];
    })
    .filter((p) => p.minutes >= open && p.minutes <= close);

  const ticks = hourlyTicks(open, close);
  const linePath = points.length > 1 ? stepPath(points, open, close) : "";
  const areaD = points.length > 1 ? areaPath(points, open, close, linePath) : "";
  const lastPoint = points[points.length - 1];
  const lastStatus = lastPoint ? statusOf(lastPoint.label) : null;

  const title = room?.space_nm ?? spaceCode;
  const currentLabel = room?.congestion_nm;
  const currentStatus = statusOf(currentLabel ?? "");

  return (
    <div className="relative overflow-hidden rounded-apple border border-hairline/60 bg-white/70 p-8 shadow-apple backdrop-blur-xl motion-safe:animate-rise-in sm:p-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(120% 100% at 12% 0%, ${isOpen ? currentStatus.wash : "rgba(142,142,147,0.1)"}, transparent 60%)`,
        }}
      />

      <div className="relative">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-soft">{title}</p>
            <p className="mt-1 text-[11px] text-ink-soft/70">
              오늘 영업시간 {formatMinutes(open)}–{formatMinutes(close)}
            </p>
          </div>
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-ink-soft">
            <span
              className={`h-1.5 w-1.5 rounded-full ${isOpen ? "motion-safe:animate-pulse-live" : ""}`}
              style={{ backgroundColor: isOpen ? currentStatus.core : "#C7C7CC" }}
            />
            {openBadge}
          </span>
        </div>

        <div className="mt-4">
          {isOpen ? (
            currentLabel ? (
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="text-7xl font-bold tracking-tight text-ink">{currentLabel}</span>
                <span className="text-base text-ink-soft">{room?.observed_at.slice(11, 16)} 기준</span>
              </div>
            ) : (
              <span className="text-2xl font-semibold text-ink-soft">정보 없음</span>
            )
          ) : (
            <span className="text-2xl font-semibold text-ink-soft">영업 시간이 아닙니다</span>
          )}
        </div>

        <div className="relative mt-8">
          <svg
            data-testid="mmca-room-chart"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            className="w-full overflow-visible"
          >
            {linePath && lastStatus && (
              <>
                <defs>
                  <linearGradient id={`fill-${spaceCode}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={lastStatus.core} stopOpacity="0.22" />
                    <stop offset="100%" stopColor={lastStatus.core} stopOpacity="0" />
                  </linearGradient>
                  {isOpen && (
                    <radialGradient id={`glow-${spaceCode}`}>
                      <stop offset="0%" stopColor={lastStatus.core} stopOpacity="0.5" />
                      <stop offset="100%" stopColor={lastStatus.core} stopOpacity="0" />
                    </radialGradient>
                  )}
                </defs>
                <path d={areaD} fill={`url(#fill-${spaceCode})`} />
                <path
                  data-testid="mmca-room-chart-line"
                  d={linePath}
                  fill="none"
                  stroke={lastStatus.core}
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {isOpen && lastPoint && (
                  <>
                    <line
                      x1={xOf(lastPoint.minutes, open, close)}
                      y1={yOf(lastPoint.tier)}
                      x2={xOf(lastPoint.minutes, open, close)}
                      y2={CHART_HEIGHT}
                      stroke="#D2D2D7"
                      strokeWidth={1}
                      strokeDasharray="3 4"
                    />
                    <circle
                      cx={xOf(lastPoint.minutes, open, close)}
                      cy={yOf(lastPoint.tier)}
                      r={14}
                      fill={`url(#glow-${spaceCode})`}
                    />
                    <circle
                      cx={xOf(lastPoint.minutes, open, close)}
                      cy={yOf(lastPoint.tier)}
                      r={4.5}
                      fill="#FFFFFF"
                      stroke={lastStatus.core}
                      strokeWidth={2.5}
                    />
                  </>
                )}
              </>
            )}
          </svg>
          <div className="relative mt-2 h-4 text-[11px] font-mono text-ink-soft/70">
            {ticks.map((tick) => (
              <span
                key={tick.minutes}
                className="absolute -translate-x-1/2 tabular-nums"
                style={{ left: `${((tick.minutes - open) / (close - open)) * 100}%` }}
              >
                {tick.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd frontend && npx vitest run tests/MmcaRoomChartCard.test.tsx`
Expected: 전체 PASS

- [ ] **Step 6: 타입체크**

Run: `cd frontend && npm run type-check 2>&1 | grep -v ExpectStatic`
Expected: `MmcaRoomChartCard.tsx`/`mmcaBusinessHours.ts` 관련 새 에러 없음 (기존 `ExpectStatic` 에러는 이 작업과 무관하니 무시)

- [ ] **Step 7: 커밋**

```bash
git add frontend/src/lib/mmcaBusinessHours.ts frontend/src/components/MmcaRoomChartCard.tsx frontend/tests/MmcaRoomChartCard.test.tsx
git commit -m "feat(fe): add MmcaRoomChartCard step-chart congestion card"
```

---

## Task 2: `MmcaPage`에 히어로 카드 삽입 + 과천관 라우트 연결

**Files:**
- Modify: `frontend/src/pages/MmcaPage.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/tests/MmcaPage.test.tsx`
- Modify: `frontend/e2e/congestion.spec.ts`

**Interfaces:**
- Consumes: `MmcaRoomChartCard({ venue, spaceCode, room })`(Task 1)

- [ ] **Step 1: `MmcaPage.tsx`에 `heroSpaceCodes` prop과 히어로 카드 행 추가**

`frontend/src/pages/MmcaPage.tsx`에서:

```tsx
import { fetchMmcaRooms, type MmcaRoomStatus, type MmcaVenue } from "../api/mmca";
import { MmcaDailyLogTable } from "../components/MmcaDailyLogTable";
import { RoomCongestionCard } from "../components/RoomCongestionCard";

const POLL_INTERVAL_MS = 60_000;

export function MmcaPage({ venue, title }: { venue: MmcaVenue; title: string }) {
```

를

```tsx
import { fetchMmcaRooms, type MmcaRoomStatus, type MmcaVenue } from "../api/mmca";
import { MmcaDailyLogTable } from "../components/MmcaDailyLogTable";
import { MmcaRoomChartCard } from "../components/MmcaRoomChartCard";
import { RoomCongestionCard } from "../components/RoomCongestionCard";

const POLL_INTERVAL_MS = 60_000;

export function MmcaPage({
  venue,
  title,
  heroSpaceCodes = [],
}: {
  venue: MmcaVenue;
  title: string;
  heroSpaceCodes?: string[];
}) {
```

로 교체. 그리고:

```tsx
        {rooms === null && !error && <p className="text-sm text-ink-soft">불러오는 중...</p>}
        {error && rooms === null && (
          <p className="text-sm text-ink-soft">불러오지 못했습니다.</p>
        )}
        {rooms && (
          <section className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {rooms.map((room) => (
              <RoomCongestionCard key={room.space_code} room={room} />
            ))}
          </section>
        )}
```

를

```tsx
        {rooms === null && !error && <p className="text-sm text-ink-soft">불러오는 중...</p>}
        {error && rooms === null && (
          <p className="text-sm text-ink-soft">불러오지 못했습니다.</p>
        )}
        {rooms && heroSpaceCodes.length > 0 && (
          <section className="mb-6 grid gap-6 lg:grid-cols-2">
            {heroSpaceCodes.map((spaceCode) => (
              <MmcaRoomChartCard
                key={spaceCode}
                venue={venue}
                spaceCode={spaceCode}
                room={rooms.find((r) => r.space_code === spaceCode)}
              />
            ))}
          </section>
        )}
        {rooms && (
          <section className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {rooms
              .filter((room) => !heroSpaceCodes.includes(room.space_code))
              .map((room) => (
                <RoomCongestionCard key={room.space_code} room={room} />
              ))}
          </section>
        )}
```

로 교체 (`heroSpaceCodes` 기본값이 `[]`이라 서울관·덕수궁관은 `heroSpaceCodes.length > 0`이 항상 false, `filter`도 아무것도 안 걸러 기존 동작 그대로 유지).

- [ ] **Step 2: 과천관 라우트에만 `heroSpaceCodes` 전달**

`frontend/src/App.tsx`에서:

```tsx
        <Route
          path="/venues/mmca-gwacheon"
          element={<MmcaPage venue="gwacheon" title="국립현대미술관 과천관 혼잡도" />}
        />
```

를

```tsx
        <Route
          path="/venues/mmca-gwacheon"
          element={
            <MmcaPage
              venue="gwacheon"
              title="국립현대미술관 과천관 혼잡도"
              heroSpaceCodes={["MMCA-SPACE-2001", "MMCA-SPACE-2008"]}
            />
          }
        />
```

로 교체.

- [ ] **Step 3: `MmcaPage.test.tsx`에 히어로 카드 테스트 추가**

`frontend/tests/MmcaPage.test.tsx` 마지막 테스트("fetches rooms for the venue prop...") 뒤에 추가:

```tsx

  it("renders hero chart cards for heroSpaceCodes and excludes them from the small-card grid", async () => {
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([
      makeRoom({ space_code: "MMCA-SPACE-2001", space_nm: "1전시실" }),
      makeRoom({ space_code: "MMCA-SPACE-2002", space_nm: "2전시실" }),
    ]);

    render(
      <MemoryRouter>
        <MmcaPage
          venue="gwacheon"
          title="국립현대미술관 과천관 혼잡도"
          heroSpaceCodes={["MMCA-SPACE-2001"]}
        />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByTestId("mmca-room-chart")).toBeInTheDocument());
    // 1전시실 shows up once (in the hero card), not a second time in the small grid.
    expect(screen.getAllByText("1전시실")).toHaveLength(1);
    // 2전시실 wasn't in heroSpaceCodes — it still renders in the small grid.
    expect(screen.getByText("2전시실")).toBeInTheDocument();
  });
```

주의: 이 테스트는 `beforeEach`의 `vi.useFakeTimers({ shouldAdvanceTime: true })`(절대 시각 고정 없음)를 그대로 쓰므로, `MmcaRoomChartCard`가 내부적으로 렌더링하는 "영업 시간이 아닙니다"/상태 문구 등 **현재 시각에 의존하는 텍스트는 이 테스트에서 검증하지 않는다** — 그 부분은 이미 Task 1의 `MmcaRoomChartCard.test.tsx`가 시각을 고정해 결정론적으로 검증한다. 여기서는 배선(히어로 카드가 뜨는지, 그리드에서 빠지는지)만 확인한다.

- [ ] **Step 4: 프론트 전체 테스트 실행**

Run: `cd frontend && npm run test`
Expected: 전체 PASS

- [ ] **Step 5: 타입체크**

Run: `cd frontend && npm run type-check 2>&1 | grep -v ExpectStatic`
Expected: 새 에러 없음

- [ ] **Step 6: e2e에 과천관 히어로 카드 확인 한 줄 추가**

`frontend/e2e/congestion.spec.ts`에서 과천관 페이지 방문 부분:

```ts
  await page.getByRole("link", { name: "국립현대미술관 과천관" }).click();
  await expect(page).toHaveURL(/\/venues\/mmca-gwacheon$/);
  await expect(page.getByText("1전시실")).toBeVisible();
```

를

```ts
  await page.getByRole("link", { name: "국립현대미술관 과천관" }).click();
  await expect(page).toHaveURL(/\/venues\/mmca-gwacheon$/);
  await expect(page.getByText("1전시실")).toBeVisible();
  await expect(page.getAllByTestId("mmca-room-chart")).toHaveCount(2);
```

로 교체 (기존 `/mmca/rooms*`/`/mmca/daily*` 목 응답은 이미 있어 추가 목 불필요 — 히어로 카드는 실제 매칭 데이터가 없어도 `heroSpaceCodes`만큼 항상 렌더링된다).

- [ ] **Step 7: e2e 실행**

Run: `cd frontend && npx playwright test e2e/congestion.spec.ts -g "navigates from the home picker" --retries=0`
Expected: 과천관 스텝까지 PASS (마지막 국중박 재방문 스텝은 PR #21에서 이미 고쳐졌으니 함께 통과해야 함 — 실패하면 이번 변경과 무관한 회귀인지 먼저 확인)

- [ ] **Step 8: 커밋**

```bash
git add frontend/src/pages/MmcaPage.tsx frontend/src/App.tsx frontend/tests/MmcaPage.test.tsx frontend/e2e/congestion.spec.ts
git commit -m "feat(fe): show Gwacheon room-1 and 어린이미술관 as hero congestion charts"
```

---

## Task 3: 전체 회귀 확인 + PR

**Files:** 없음 (검증 + PR만)

- [ ] **Step 1: 프론트 유닛 전체 스위트**

Run: `cd frontend && npm run test`
Expected: 전체 PASS

- [ ] **Step 2: 타입체크**

Run: `cd frontend && npm run type-check 2>&1 | grep -v ExpectStatic`
Expected: 이번 작업으로 인한 새 에러 없음

- [ ] **Step 3: e2e 전체 스위트**

Run: `cd frontend && npx playwright test e2e/congestion.spec.ts --retries=0`
Expected: 전체 PASS

- [ ] **Step 4: 실제 개발 서버로 라이브 확인**

Run: `cd frontend && npm run dev` (백엔드도 함께 기동 필요 시 `cd backend && .venv/bin/uvicorn app.main:app --reload`)
`/venues/mmca-gwacheon` 방문해 1전시실·1층 어린이미술관 히어로 카드 2개가 절반씩 나란히, 그 아래 나머지 6개 전시실 소형 카드, 맨 아래 폴링 로그 표가 정상 렌더링되는지 육안 확인.

- [ ] **Step 5: 브랜치 push + PR 생성**

```bash
git push -u origin feat/mmca-gwacheon-room-graphs
gh pr create --base develop --title "feat(mmca): show Gwacheon room-1 and 어린이미술관 as step-chart cards" --body "$(cat <<'EOF'
## 설명

과천관 페이지에서 1전시실 · 1층 어린이미술관을 국중박 CongestionCard와 같은 형식(영업시간 x축, 실시간 배지, 영업 전/후 안내)의 계단형 그래프 카드로 절반씩 나란히 표시. 나머지 6개 전시실은 기존 소형 카드로 그대로 유지.

## 구현 내용

- 프론트: `MmcaRoomChartCard` 신규 — 기존 `GET /mmca/daily` 응답에서 전시실 하나만 뽑아 계단형(step) SVG 렌더링. 리샘플링 없음(이미 15분 그리드), 새 백엔드 변경 없음
- 프론트: `mmcaBusinessHours` 신규 — 과천관 영업시간(10:00 오픈, 수/토 21:00, 그 외 18:00 마감) 전용, 국중박 `CongestionCard`의 것과 공유하지 않음
- `MmcaPage`에 `heroSpaceCodes?: string[]` prop 추가 — 지정한 전시실만 히어로 카드로 빼고 소형 그리드에서 제외. 과천관 라우트에서만 `["MMCA-SPACE-2001", "MMCA-SPACE-2008"]` 전달, 서울관·덕수궁관은 기존 동작 그대로

## 테스트

- 프론트: `vitest` 전체 통과
- e2e: 과천관 페이지에서 히어로 카드 2개 렌더링 확인
- 실제 dev 서버로 레이아웃 육안 확인
EOF
)"
```

- [ ] **Step 6: PR URL 보고**

`gh pr create` 출력의 URL을 사용자에게 보고한다.
