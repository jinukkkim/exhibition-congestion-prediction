# MMCA 전체 전시실 그래프 확대 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 서울관 8실·과천관 8실·덕수궁관 1실, 총 17개 전시실 전부를 곡선 그래프 카드(`MmcaRoomChartCard`)로 렌더링한다. 작은 상태 카드는 완전히 제거.

**Architecture:** `MmcaRoomChartCard`를 순수 렌더 컴포넌트로 바꾼다(자체 fetch 제거, `daily`/`open`/`close`/`isOpen`을 prop으로 받음). `MmcaPage`가 `/mmca/daily`를 페이지당 한 번만 fetch해서 모든 카드에 내려주고, `mmcaBusinessHours`를 관 인자를 받도록 확장해 덕수궁 월요일 휴무를 반영한다. 방 개수에 따라 2열/1열 레이아웃을 고른다.

**Tech Stack:** 기존과 동일 — React, TypeScript, Vitest, Playwright. 신규 의존성 없음.

## Global Constraints

- 모든 전시실이 곡선 그래프 카드다 — 계단형(step) 코드 경로는 삭제한다.
- `MmcaRoomChartCard`는 자체적으로 데이터를 fetch하지 않는다 — `daily`를 prop으로만 받는다. `/mmca/daily`는 `MmcaPage`가 페이지당 정확히 한 번만 fetch한다(카드 개수와 무관).
- `mmcaBusinessHours`는 `(venue, date)`를 받아 `{ open, close, isOpenToday }`를 반환한다. 덕수궁만 월요일 휴무(`Date.getDay() === 1`), 서울·과천은 휴무일 없음 — 백엔드 `collector.py`의 `_VENUE_CLOSED_DAYS`와 동일한 규칙.
- 레이아웃: 방이 2개 이상이면 `lg:grid-cols-2`, 1개면 그리드 없이 전체 폭.
- `RoomCongestionCard` 컴포넌트와 그 테스트는 삭제한다 — 삭제 전에 다른 곳에서 안 쓰는지 반드시 grep으로 재확인한다.
- 백엔드 변경 없음.
- 이 작업은 `feat/mmca-gwacheon-room-graphs` 브랜치(이미 `develop`에서 분기)에서 계속한다. `develop`/`main`에 직접 커밋하지 않는다.

---

## File Structure

```
frontend/
  src/
    lib/
      mmcaBusinessHours.ts        (수정) — venue 인자 추가, isOpenToday 반환
    components/
      MmcaRoomChartCard.tsx        (수정) — 순수 렌더 컴포넌트로 재작성, 계단형 삭제
      RoomCongestionCard.tsx       (삭제)
    pages/
      MmcaPage.tsx                  (수정) — daily 1회 fetch, 전 전시실 렌더, 레이아웃 분기
    App.tsx                         (수정) — heroSpaceCodes prop 제거
  tests/
    mmcaBusinessHours.test.ts    (신규)
    MmcaRoomChartCard.test.tsx   (전면 재작성)
    MmcaPage.test.tsx             (전면 재작성)
    RoomCongestionCard.test.tsx  (삭제)
  e2e/
    congestion.spec.ts            (수정) — 카드 개수 어서션 조정
```

---

## Task 1: `mmcaBusinessHours` 관별 휴무일 지원

**Files:**
- Modify: `frontend/src/lib/mmcaBusinessHours.ts`
- Create: `frontend/tests/mmcaBusinessHours.test.ts`

**Interfaces:**
- Consumes: `type MmcaVenue`(기존 `../api/mmca`)
- Produces: `export function mmcaBusinessHours(venue: MmcaVenue, date: Date): { open: number; close: number; isOpenToday: boolean }`. Task 2(간접, prop 타입)·Task 3이 이 시그니처를 그대로 소비한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/tests/mmcaBusinessHours.test.ts` 신규 생성:

```ts
import { describe, expect, it } from "vitest";

import { mmcaBusinessHours } from "../src/lib/mmcaBusinessHours";

describe("mmcaBusinessHours", () => {
  it("returns 10:00-18:00 on a normal day", () => {
    // 2026-07-28 is a Tuesday
    const { open, close, isOpenToday } = mmcaBusinessHours("seoul", new Date("2026-07-28T12:00:00"));
    expect(open).toBe(10 * 60);
    expect(close).toBe(18 * 60);
    expect(isOpenToday).toBe(true);
  });

  it("returns 10:00-21:00 on Wednesday/Saturday", () => {
    // 2026-07-29 is a Wednesday
    expect(mmcaBusinessHours("gwacheon", new Date("2026-07-29T12:00:00")).close).toBe(21 * 60);
    // 2026-08-01 is a Saturday
    expect(mmcaBusinessHours("gwacheon", new Date("2026-08-01T12:00:00")).close).toBe(21 * 60);
  });

  it("marks Deoksugung closed on Monday but open on other days", () => {
    // 2026-07-27 is a Monday
    expect(mmcaBusinessHours("deoksugung", new Date("2026-07-27T12:00:00")).isOpenToday).toBe(false);
    // 2026-07-28 is a Tuesday
    expect(mmcaBusinessHours("deoksugung", new Date("2026-07-28T12:00:00")).isOpenToday).toBe(true);
  });

  it("does not mark Seoul or Gwacheon closed on Monday", () => {
    expect(mmcaBusinessHours("seoul", new Date("2026-07-27T12:00:00")).isOpenToday).toBe(true);
    expect(mmcaBusinessHours("gwacheon", new Date("2026-07-27T12:00:00")).isOpenToday).toBe(true);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run tests/mmcaBusinessHours.test.ts`
Expected: FAIL — `mmcaBusinessHours`가 아직 `venue` 인자·`isOpenToday`를 안 받/안 줌 (타입 에러 또는 `isOpenToday` undefined)

- [ ] **Step 3: 구현**

`frontend/src/lib/mmcaBusinessHours.ts` 전체 교체:

```ts
import type { MmcaVenue } from "../api/mmca";

const OPEN_MINUTES = 10 * 60; // 10:00, every day
const LONG_CLOSE_DAYS = new Set([3, 6]); // Wed, Sat: 21:00 close; other days: 18:00

// Same rule as the backend's collector.py _VENUE_CLOSED_DAYS — Deoksugung is
// inside the palace grounds and closed on Mondays; Seoul/Gwacheon have no
// closed days. JS Date.getDay(): Sun=0, Mon=1 (the backend's Python
// datetime.weekday() is Mon=0, a different convention — this is the same
// real-world rule translated to JS's convention, not a copy of the value).
const VENUE_CLOSED_DAYS: Partial<Record<MmcaVenue, Set<number>>> = {
  deoksugung: new Set([1]),
};

export function mmcaBusinessHours(
  venue: MmcaVenue,
  date: Date
): { open: number; close: number; isOpenToday: boolean } {
  const close = LONG_CLOSE_DAYS.has(date.getDay()) ? 21 * 60 : 18 * 60;
  const isOpenToday = !VENUE_CLOSED_DAYS[venue]?.has(date.getDay());
  return { open: OPEN_MINUTES, close, isOpenToday };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run tests/mmcaBusinessHours.test.ts`
Expected: 전체 PASS

- [ ] **Step 5: 타입체크**

Run: `cd frontend && npm run type-check 2>&1 | grep -v ExpectStatic`
Expected: 새 에러 없음 (기존 `ExpectStatic` 에러는 무관하니 무시). 이 시점엔 `MmcaRoomChartCard.tsx`가 아직 옛 시그니처(`mmcaBusinessHours(date)`)를 안 쓰므로 에러 없어야 함 — 만약 이 파일이 여전히 옛 시그니처로 호출 중이라 에러가 나면, Task 2에서 곧 고쳐지니 무시하고 다음 단계로 진행.

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/lib/mmcaBusinessHours.ts frontend/tests/mmcaBusinessHours.test.ts
git commit -m "feat(fe): add venue-aware closed days to mmcaBusinessHours"
```

---

## Task 2: `MmcaRoomChartCard` 순수 렌더 컴포넌트로 재작성

**Files:**
- Modify: `frontend/src/components/MmcaRoomChartCard.tsx`
- Modify: `frontend/tests/MmcaRoomChartCard.test.tsx`

**Interfaces:**
- Consumes: `type MmcaDailyLogPoint`, `type MmcaRoomStatus`(기존 `../api/mmca`), `statusOf`(기존 `../lib/status`)
- Produces: `export function MmcaRoomChartCard({ spaceCode, room, daily, open, close, nowMinutes, isOpen }: { spaceCode: string; room: MmcaRoomStatus | undefined; daily: MmcaDailyLogPoint[] | null; open: number; close: number; nowMinutes: number; isOpen: boolean }): JSX.Element`. `venue`/`curve` prop 제거됨 — Task 3이 이 새 시그니처로 호출한다.

- [ ] **Step 1: 실패하는 테스트로 전체 교체**

`frontend/tests/MmcaRoomChartCard.test.tsx` 전체 교체:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MmcaRoomChartCard } from "../src/components/MmcaRoomChartCard";
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

const OPEN = 10 * 60;
const CLOSE = 18 * 60;
const WITHIN_HOURS = 14 * 60 + 30; // 14:30

describe("MmcaRoomChartCard", () => {
  it("renders the room name and current status headline when open", () => {
    render(
      <MmcaRoomChartCard
        spaceCode="MMCA-SPACE-2001"
        room={makeRoom()}
        daily={[]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        isOpen
      />
    );

    expect(screen.getByText("1전시실")).toBeInTheDocument();
    expect(screen.getByText("약간 붐빔")).toBeInTheDocument();
  });

  it("shows '영업 시간이 아닙니다' when isOpen is false", () => {
    render(
      <MmcaRoomChartCard
        spaceCode="MMCA-SPACE-2001"
        room={makeRoom()}
        daily={[]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={20 * 60}
        isOpen={false}
      />
    );

    expect(screen.getByText("영업 시간이 아닙니다")).toBeInTheDocument();
    expect(screen.queryByText("약간 붐빔")).not.toBeInTheDocument();
  });

  it("shows '정보 없음' when open but no current room status yet", () => {
    render(
      <MmcaRoomChartCard
        spaceCode="MMCA-SPACE-2001"
        room={undefined}
        daily={[]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        isOpen
      />
    );

    expect(screen.getByText("정보 없음")).toBeInTheDocument();
  });

  it("draws a smoothed curve through today's readings for just this room", () => {
    render(
      <MmcaRoomChartCard
        spaceCode="MMCA-SPACE-2001"
        room={makeRoom()}
        daily={[
          dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유", "MMCA-SPACE-2008": "보통" }),
          dailyPoint("2026-07-15T10:15:00", { "MMCA-SPACE-2001": "붐빔", "MMCA-SPACE-2008": "여유" }),
        ]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        isOpen
      />
    );

    const line = screen.getByTestId("mmca-room-chart-line");
    const d = line.getAttribute("d") ?? "";
    expect(d).toMatch(/C/);
    expect(line.getAttribute("stroke")).toBe("#0071E3");
  });

  it("skips points where this room's reading is null", () => {
    render(
      <MmcaRoomChartCard
        spaceCode="MMCA-SPACE-2001"
        room={makeRoom()}
        daily={[
          dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유" }),
          dailyPoint("2026-07-15T10:15:00", { "MMCA-SPACE-2001": null }),
          dailyPoint("2026-07-15T10:30:00", { "MMCA-SPACE-2001": "보통" }),
        ]}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        isOpen
      />
    );

    // 2 valid points (null dropped) → exactly one Bezier "C" segment; a
    // spurious 3rd point would produce two.
    const d = screen.getByTestId("mmca-room-chart-line").getAttribute("d") ?? "";
    expect(d.match(/C/g)).toHaveLength(1);
  });

  it("shows the live glow marker only when isOpen is true", () => {
    const props = {
      spaceCode: "MMCA-SPACE-2001",
      room: makeRoom(),
      daily: [
        dailyPoint("2026-07-15T10:00:00", { "MMCA-SPACE-2001": "여유" }),
        dailyPoint("2026-07-15T14:15:00", { "MMCA-SPACE-2001": "붐빔" }),
      ],
      open: OPEN,
      close: CLOSE,
      nowMinutes: WITHIN_HOURS,
    };

    const { container, rerender } = render(<MmcaRoomChartCard {...props} isOpen />);
    // Glow renders as two circles (soft glow + white ring dot).
    expect(container.querySelectorAll("circle")).toHaveLength(2);

    rerender(<MmcaRoomChartCard {...props} isOpen={false} />);
    expect(container.querySelectorAll("circle")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run tests/MmcaRoomChartCard.test.tsx`
Expected: FAIL — 컴포넌트가 아직 `venue`/`curve` prop을 요구하고 `daily`/`open`/`close`/`nowMinutes`/`isOpen`을 안 받음 (타입 에러 또는 런타임 실패)

- [ ] **Step 3: 구현**

`frontend/src/components/MmcaRoomChartCard.tsx` 전체 교체:

```tsx
import { useRef, useState, type MouseEvent } from "react";

import type { MmcaDailyLogPoint, MmcaRoomStatus } from "../api/mmca";
import { statusOf } from "../lib/status";

const CHART_WIDTH = 480;
const CHART_HEIGHT = 200;
const TIERS = ["여유", "보통", "약간 붐빔", "붐빔"];

// Deliberately not tied to congestion status (that palette is reserved for
// the headline word/badge, where color = meaning). The chart itself is a
// single visual treatment regardless of value — sky blue fading into the
// app's accent blue.
const CHART_SKY = "#5AC8FA";
const CHART_BLUE = "#0071E3";

// Several helpers here (tick math, xOf, chart dimensions, most of the JSX
// shell) are duplicated from CongestionCard.tsx rather than shared — they're
// pure and value-free so sharing wouldn't add venue-specific conditionals,
// but extracting them touches a file this task didn't otherwise need to
// touch. Revisit if a third consumer appears.
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
type XY = { x: number; y: number };

function xOf(minutes: number, open: number, close: number): number {
  return ((minutes - open) / (close - open || 1)) * CHART_WIDTH;
}

function yOf(tier: number): number {
  return CHART_HEIGHT - 24 - (tier / (TIERS.length - 1)) * (CHART_HEIGHT - 48);
}

function toXY(points: Point[], open: number, close: number): XY[] {
  return points.map((p) => ({ x: xOf(p.minutes, open, close), y: yOf(p.tier) }));
}

// Centripetal Catmull-Rom -> cubic Bezier, ported from CongestionCard.tsx.
function smoothPath(xy: XY[]): string {
  const dist = (a: XY, b: XY) => Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)) || 1e-6;
  let d = `M ${xy[0].x} ${xy[0].y}`;
  for (let i = 0; i < xy.length - 1; i++) {
    const p0 = xy[i - 1] ?? xy[i];
    const p1 = xy[i];
    const p2 = xy[i + 1];
    const p3 = xy[i + 2] ?? p2;

    const t0 = 0;
    const t1 = t0 + dist(p0, p1);
    const t2 = t1 + dist(p1, p2);
    const t3 = t2 + dist(p2, p3);

    const m1x = (t2 - t1) * ((p1.x - p0.x) / (t1 - t0) - (p2.x - p0.x) / (t2 - t0) + (p2.x - p1.x) / (t2 - t1));
    const m1y = (t2 - t1) * ((p1.y - p0.y) / (t1 - t0) - (p2.y - p0.y) / (t2 - t0) + (p2.y - p1.y) / (t2 - t1));
    const m2x = (t2 - t1) * ((p2.x - p1.x) / (t2 - t1) - (p3.x - p1.x) / (t3 - t1) + (p3.x - p2.x) / (t3 - t2));
    const m2y = (t2 - t1) * ((p2.y - p1.y) / (t2 - t1) - (p3.y - p1.y) / (t3 - t1) + (p3.y - p2.y) / (t3 - t2));

    const cp1x = p1.x + m1x / 3;
    const cp1y = p1.y + m1y / 3;
    const cp2x = p2.x - m2x / 3;
    const cp2y = p2.y - m2y / 3;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function areaPath(xy: XY[], linePath: string): string {
  const first = xy[0];
  const last = xy[xy.length - 1];
  return `M ${first.x} ${CHART_HEIGHT} L ${first.x} ${first.y} ${linePath.slice(linePath.indexOf("C"))} L ${last.x} ${CHART_HEIGHT} Z`;
}

export function MmcaRoomChartCard({
  spaceCode,
  room,
  daily,
  open,
  close,
  nowMinutes,
  isOpen,
}: {
  spaceCode: string;
  room: MmcaRoomStatus | undefined;
  daily: MmcaDailyLogPoint[] | null;
  open: number;
  close: number;
  nowMinutes: number;
  isOpen: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

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
  const xy = toXY(points, open, close);
  const linePath = points.length > 1 ? smoothPath(xy) : "";
  const areaD = points.length > 1 ? areaPath(xy, linePath) : "";
  const lastPoint = points[points.length - 1];

  const title = room?.space_nm ?? spaceCode;
  const currentLabel = room?.congestion_nm;
  const currentStatus = statusOf(currentLabel ?? "");
  const openBadge = isOpen ? "실시간" : nowMinutes < open ? "영업 전" : "영업 종료";

  function handleHoverMove(event: MouseEvent<SVGRectElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * CHART_WIDTH;

    let nearest: number | null = null;
    let nearestDist = Infinity;
    points.forEach((p, i) => {
      const dist = Math.abs(xOf(p.minutes, open, close) - svgX);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
    });
    setHoverIndex(nearest);
  }

  const hoverPoint = hoverIndex !== null ? points[hoverIndex] : undefined;

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
            ref={svgRef}
            data-testid="mmca-room-chart"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            className="w-full overflow-visible"
          >
            {linePath && (
              <>
                <defs>
                  <linearGradient id={`fill-${spaceCode}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART_SKY} stopOpacity="0.32" />
                    <stop offset="100%" stopColor={CHART_BLUE} stopOpacity="0" />
                  </linearGradient>
                  {isOpen && (
                    <radialGradient id={`glow-${spaceCode}`}>
                      <stop offset="0%" stopColor={CHART_BLUE} stopOpacity="0.5" />
                      <stop offset="100%" stopColor={CHART_BLUE} stopOpacity="0" />
                    </radialGradient>
                  )}
                </defs>
                <path d={areaD} fill={`url(#fill-${spaceCode})`} />
                <path
                  data-testid="mmca-room-chart-line"
                  d={linePath}
                  fill="none"
                  stroke={CHART_BLUE}
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
                      stroke={CHART_BLUE}
                      strokeWidth={2.5}
                    />
                  </>
                )}
                {hoverPoint && (
                  <>
                    <line
                      x1={xOf(hoverPoint.minutes, open, close)}
                      y1={0}
                      x2={xOf(hoverPoint.minutes, open, close)}
                      y2={CHART_HEIGHT}
                      stroke="#D2D2D7"
                      strokeWidth={1}
                    />
                    <circle
                      cx={xOf(hoverPoint.minutes, open, close)}
                      cy={yOf(hoverPoint.tier)}
                      r={4}
                      fill="#FFFFFF"
                      stroke={CHART_BLUE}
                      strokeWidth={2}
                    />
                  </>
                )}
                <rect
                  x={0}
                  y={0}
                  width={CHART_WIDTH}
                  height={CHART_HEIGHT}
                  fill="transparent"
                  onMouseMove={handleHoverMove}
                  onMouseLeave={() => setHoverIndex(null)}
                />
              </>
            )}
          </svg>
          {hoverPoint && (
            <div
              className="pointer-events-none absolute -top-2 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-hairline/60 bg-white/95 px-2.5 py-1.5 text-[11px] shadow-apple backdrop-blur-xl"
              style={{
                left: `${Math.min(Math.max((xOf(hoverPoint.minutes, open, close) / CHART_WIDTH) * 100, 14), 86)}%`,
              }}
            >
              <span className="font-mono tabular-nums text-ink-soft">{formatMinutes(hoverPoint.minutes)}</span>
              <span className="mx-1 text-ink-soft">·</span>
              <span className="font-semibold" style={{ color: statusOf(hoverPoint.label).text }}>
                {hoverPoint.label}
              </span>
            </div>
          )}
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

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run tests/MmcaRoomChartCard.test.tsx`
Expected: 전체 PASS

- [ ] **Step 5: 타입체크**

Run: `cd frontend && npm run type-check 2>&1 | grep -v ExpectStatic`
Expected: `MmcaRoomChartCard.tsx` 자체는 에러 없음. `MmcaPage.tsx`가 아직 옛 prop으로 이 컴포넌트를 호출하고 있어 그쪽에서 에러가 날 수 있는데, Task 3에서 고쳐지니 무시하고 진행.

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/components/MmcaRoomChartCard.tsx frontend/tests/MmcaRoomChartCard.test.tsx
git commit -m "refactor(fe): make MmcaRoomChartCard a pure render component, curve-only"
```

---

## Task 3: `MmcaPage` 재작성 — 전 전시실 렌더 + daily 1회 fetch + 레이아웃

**Files:**
- Modify: `frontend/src/pages/MmcaPage.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/tests/MmcaPage.test.tsx`

**Interfaces:**
- Consumes: `MmcaRoomChartCard({ spaceCode, room, daily, open, close, nowMinutes, isOpen })`(Task 2), `mmcaBusinessHours(venue, date)`(Task 1), `fetchMmcaDaily(venue, date)`/`fetchMmcaRooms(venue)`(기존 `../api/mmca`), `todayString()`(기존 `../lib/date`)

- [ ] **Step 1: `MmcaPage.tsx` 전체 교체**

```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  fetchMmcaDaily,
  fetchMmcaRooms,
  type MmcaDailyLogPoint,
  type MmcaRoomStatus,
  type MmcaVenue,
} from "../api/mmca";
import { MmcaDailyLogTable } from "../components/MmcaDailyLogTable";
import { MmcaRoomChartCard } from "../components/MmcaRoomChartCard";
import { todayString } from "../lib/date";
import { mmcaBusinessHours } from "../lib/mmcaBusinessHours";

const POLL_INTERVAL_MS = 60_000;

export function MmcaPage({ venue, title }: { venue: MmcaVenue; title: string }) {
  const [rooms, setRooms] = useState<MmcaRoomStatus[] | null>(null);
  const [daily, setDaily] = useState<MmcaDailyLogPoint[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let ignore = false;

    function load() {
      fetchMmcaRooms(venue)
        .then((data) => {
          if (ignore) return;
          setRooms(data);
          setError(false);
        })
        .catch(() => {
          if (!ignore) setError(true);
        });
    }

    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      ignore = true;
      clearInterval(timer);
    };
  }, [venue]);

  useEffect(() => {
    let ignore = false;

    function load() {
      fetchMmcaDaily(venue, todayString())
        .then((data) => {
          if (!ignore) setDaily(data);
        })
        .catch(() => {
          // Silently retry — keep showing whatever we already have rather
          // than blanking every card on one failed poll.
        });
    }

    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      ignore = true;
      clearInterval(timer);
    };
  }, [venue]);

  const now = new Date();
  const { open, close, isOpenToday } = mmcaBusinessHours(venue, now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const isOpen = isOpenToday && nowMinutes >= open && nowMinutes <= close;

  return (
    <div className="min-h-screen bg-canvas">
      <main className="mx-auto max-w-[1400px] px-6 py-16 sm:px-10 lg:px-16">
        <header className="mb-12 border-b border-hairline/70 pb-8">
          <Link
            to="/"
            className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-soft hover:text-accent"
          >
            ← 미술관 선택
          </Link>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            {title}
          </h1>
        </header>

        {rooms === null && !error && <p className="text-sm text-ink-soft">불러오는 중...</p>}
        {error && rooms === null && (
          <p className="text-sm text-ink-soft">불러오지 못했습니다.</p>
        )}
        {rooms && (
          <section className={`grid gap-6${rooms.length > 1 ? " lg:grid-cols-2" : ""}`}>
            {rooms.map((room) => (
              <MmcaRoomChartCard
                key={room.space_code}
                spaceCode={room.space_code}
                room={room}
                daily={daily}
                open={open}
                close={close}
                nowMinutes={nowMinutes}
                isOpen={isOpen}
              />
            ))}
          </section>
        )}

        <section className="mt-6">
          <MmcaDailyLogTable venue={venue} />
        </section>
      </main>
    </div>
  );
}
```

- [ ] **Step 2: `App.tsx`에서 `heroSpaceCodes` prop 제거**

`frontend/src/App.tsx`에서 세 MMCA `<Route>` 전부를:

```tsx
        <Route
          path="/venues/mmca-seoul"
          element={<MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />}
        />
        <Route
          path="/venues/mmca-gwacheon"
          element={<MmcaPage venue="gwacheon" title="국립현대미술관 과천관 혼잡도" />}
        />
        <Route
          path="/venues/mmca-deoksugung"
          element={<MmcaPage venue="deoksugung" title="국립현대미술관 덕수궁관 혼잡도" />}
        />
```

로 교체 (과천 라우트에 있던 `heroSpaceCodes={["MMCA-SPACE-2001", "MMCA-SPACE-2008"]}` 제거 — 이제 모든 전시실이 자동으로 그래프가 되므로 라우트에서 특정 space_code를 지정할 필요가 없다).

- [ ] **Step 3: `MmcaPage.test.tsx` 전체 교체**

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MmcaPage } from "../src/pages/MmcaPage";
import * as api from "../src/api/mmca";
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

describe("MmcaPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders a chart card per room after loading", async () => {
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([
      makeRoom(),
      makeRoom({ space_code: "MMCA-SPACE-1002", space_nm: "2전시실", congestion_nm: "보통" }),
    ]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("1전시실")).toBeInTheDocument());
    expect(screen.getByText("2전시실")).toBeInTheDocument();
    expect(screen.getAllByTestId("mmca-room-chart")).toHaveLength(2);
  });

  it("shows an error message when the fetch fails before anything loads", async () => {
    vi.spyOn(api, "fetchMmcaRooms").mockRejectedValue(new Error("network error"));

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("불러오지 못했습니다.")).toBeInTheDocument());
  });

  it("polls rooms again after 60 seconds", async () => {
    const fetchMmcaRooms = vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(fetchMmcaRooms).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMmcaRooms).toHaveBeenCalledTimes(2);
  });

  it("keeps showing stale data when a poll fails after an initial success", async () => {
    const fetchMmcaRooms = vi
      .spyOn(api, "fetchMmcaRooms")
      .mockResolvedValueOnce([makeRoom()])
      .mockRejectedValueOnce(new Error("network error"));

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("1전시실")).toBeInTheDocument());

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMmcaRooms).toHaveBeenCalledTimes(2);
    expect(screen.getByText("1전시실")).toBeInTheDocument();
    expect(screen.queryByText("불러오지 못했습니다.")).not.toBeInTheDocument();
  });

  it("stops polling and ignores in-flight responses after unmount", async () => {
    const fetchMmcaRooms = vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);
    const fetchMmcaDaily = vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(fetchMmcaRooms).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fetchMmcaDaily).toHaveBeenCalledTimes(1));

    unmount();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMmcaRooms).toHaveBeenCalledTimes(1);
    expect(fetchMmcaDaily).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("fetches rooms and daily data for the venue prop, shows the title prop as heading", async () => {
    const fetchMmcaRooms = vi
      .spyOn(api, "fetchMmcaRooms")
      .mockResolvedValue([makeRoom({ space_code: "MMCA-SPACE-2001" })]);

    render(
      <MemoryRouter>
        <MmcaPage venue="gwacheon" title="국립현대미술관 과천관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(fetchMmcaRooms).toHaveBeenCalledWith("gwacheon"));
    expect(
      screen.getByRole("heading", { name: "국립현대미술관 과천관 혼잡도" })
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(vi.mocked(api.fetchMmcaDaily)).toHaveBeenCalledWith("gwacheon", expect.any(String))
    );
  });

  it("fetches daily data exactly once regardless of how many rooms there are", async () => {
    const fetchMmcaDaily = vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([
      makeRoom({ space_code: "MMCA-SPACE-1001", space_nm: "1전시실" }),
      makeRoom({ space_code: "MMCA-SPACE-1002", space_nm: "2전시실" }),
      makeRoom({ space_code: "MMCA-SPACE-1003", space_nm: "3전시실" }),
    ]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByTestId("mmca-room-chart")).toHaveLength(3));
    // 3 chart cards, but only one page-level fetch — this is the fix for
    // the pre-expansion N-cards-N-requests problem.
    expect(fetchMmcaDaily).toHaveBeenCalledTimes(1);
  });

  it("renders a single-column layout when the venue has only one room", async () => {
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);

    const { container } = render(
      <MemoryRouter>
        <MmcaPage venue="deoksugung" title="국립현대미술관 덕수궁관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByTestId("mmca-room-chart")).toBeInTheDocument());
    expect(container.querySelector("section")?.className).not.toMatch(/lg:grid-cols-2/);
  });

  it("renders a two-column layout when the venue has more than one room", async () => {
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([
      makeRoom(),
      makeRoom({ space_code: "MMCA-SPACE-1002", space_nm: "2전시실" }),
    ]);

    const { container } = render(
      <MemoryRouter>
        <MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByTestId("mmca-room-chart")).toHaveLength(2));
    expect(container.querySelector("section")?.className).toMatch(/lg:grid-cols-2/);
  });
});
```

- [ ] **Step 4: 프론트 전체 테스트 실행**

Run: `cd frontend && npm run test`
Expected: 전체 PASS (`RoomCongestionCard.test.tsx`는 아직 Task 4에서 안 지웠으니 그대로 통과하는 상태여야 함 — 이 파일은 `MmcaPage.tsx`와 무관하게 독립적으로 `RoomCongestionCard` 컴포넌트만 테스트하므로 영향 없음)

- [ ] **Step 5: 타입체크**

Run: `cd frontend && npm run type-check 2>&1 | grep -v ExpectStatic`
Expected: 새 에러 없음

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/pages/MmcaPage.tsx frontend/src/App.tsx frontend/tests/MmcaPage.test.tsx
git commit -m "feat(fe): render every MMCA room as a chart card, fetch daily data once per page"
```

---

## Task 4: `RoomCongestionCard` 삭제 + e2e 조정 + 전체 회귀 + PR

**Files:**
- Delete: `frontend/src/components/RoomCongestionCard.tsx`
- Delete: `frontend/tests/RoomCongestionCard.test.tsx`
- Modify: `frontend/e2e/congestion.spec.ts`

- [ ] **Step 1: 다른 곳에서 안 쓰는지 최종 확인**

Run: `cd frontend && grep -rn "RoomCongestionCard" src tests e2e`
Expected: `frontend/src/components/RoomCongestionCard.tsx`와 `frontend/tests/RoomCongestionCard.test.tsx` 자기 자신의 정의/테스트 외에는 아무 결과도 없어야 함(Task 3에서 이미 `MmcaPage.tsx`의 참조를 제거했으므로). 다른 참조가 나오면 멈추고 보고 — 삭제하지 않는다.

- [ ] **Step 2: 삭제**

```bash
git rm frontend/src/components/RoomCongestionCard.tsx frontend/tests/RoomCongestionCard.test.tsx
```

- [ ] **Step 3: 프론트 전체 테스트 + 타입체크**

Run: `cd frontend && npm run test && npm run type-check 2>&1 | grep -v ExpectStatic`
Expected: 전체 PASS, 새 타입 에러 없음

- [ ] **Step 4: e2e 카드 개수 어서션 조정**

`frontend/e2e/congestion.spec.ts`에서:

```ts
  await page.getByRole("link", { name: "국립현대미술관 과천관" }).click();
  await expect(page).toHaveURL(/\/venues\/mmca-gwacheon$/);
  await expect(page.getByText("1전시실")).toBeVisible();
  await expect(page.getByTestId("mmca-room-chart")).toHaveCount(2);
```

를

```ts
  await page.getByRole("link", { name: "국립현대미술관 과천관" }).click();
  await expect(page).toHaveURL(/\/venues\/mmca-gwacheon$/);
  await expect(page.getByText("1전시실")).toBeVisible();
  // The shared /mmca/rooms mock returns exactly one room for every venue,
  // so every venue page now renders exactly one chart card.
  await expect(page.getByTestId("mmca-room-chart")).toHaveCount(1);
```

로 교체.

- [ ] **Step 5: e2e 실행**

Run: `cd frontend && npx playwright test e2e/congestion.spec.ts --retries=0`
Expected: 전체 PASS

- [ ] **Step 6: 실제 dev 서버로 라이브 확인**

Run: `cd frontend && npm run dev` (백엔드도 필요 시 `cd backend && .venv/bin/uvicorn app.main:app --reload`)
`/venues/mmca-seoul`, `/venues/mmca-gwacheon`(8실, 2열), `/venues/mmca-deoksugung`(1실, 전체 폭) 방문해 육안 확인.

- [ ] **Step 7: 브랜치 push + PR 생성**

```bash
git push -u origin feat/mmca-gwacheon-room-graphs
gh pr create --base develop --title "feat(mmca): show every room as a curve chart across all three venues" --body "$(cat <<'EOF'
## 설명

과천관 1전시실/어린이미술관으로 곡선 vs 계단형을 비교해본 뒤 곡선으로 확정, 서울관·과천관·덕수궁관 17개 전시실 전부에 동일한 곡선 그래프 카드를 적용.

## 구현 내용

- `MmcaRoomChartCard`를 순수 렌더 컴포넌트로 재작성 — 더 이상 자체적으로 `/mmca/daily`를 fetch하지 않고 `daily`/`open`/`close`/`nowMinutes`/`isOpen`을 prop으로 받음
- `MmcaPage`가 `/mmca/daily`를 페이지당 한 번만 fetch해 모든 카드에 전달 — 전시실 8개 페이지에서 동일 요청이 8번 나가던 문제 해소
- `mmcaBusinessHours(venue, date)`로 관 인자 추가, 덕수궁 월요일 휴무를 프론트에도 반영(백엔드 `_VENUE_CLOSED_DAYS`와 동일 규칙)
- 레이아웃: 전시실 2개 이상이면 2열, 1개(덕수궁)면 전체 폭 1열
- 계단형(step) 경로 계산 코드 제거 — 전부 곡선으로 통일되어 죽은 코드가 됨
- 작은 상태 카드(`RoomCongestionCard`) 및 그 테스트 삭제

## 테스트

- 프론트: `vitest` 전체 통과
- e2e: 3관 페이지 방문 + 카드 렌더링 확인
- 실제 dev 서버로 8실(2열)·1실(전체 폭) 레이아웃 육안 확인
EOF
)"
```

- [ ] **Step 8: PR URL 보고**

`gh pr create` 출력의 URL을 사용자에게 보고한다.
