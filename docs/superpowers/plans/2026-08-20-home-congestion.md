# 홈 화면 혼잡도 노출 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 홈 카드에 관별 현재 혼잡도(국립중앙박물관은 레벨+인원수, MMCA 3관은 레벨별 방 개수)와 기준 시각을 노출한다.

**Architecture:** 프론트엔드 전용. 기존 `GET /congestion/current`와 `GET /mmca/rooms?venue=`를 홈에서 관별로 독립 호출하고, 표시 상태 판정은 순수 함수 `lib/venueSummary.ts`로 분리해 시각·데이터 조합을 테스트로 고정한다. 개·폐관 판정은 `CongestionCard`에 박혀 있던 함수를 lib으로 끌어내 홈과 공유한다.

**Tech Stack:** React 18, TypeScript, Vite, Tailwind, Vitest + @testing-library/react

**Spec:** `docs/superpowers/specs/2026-08-20-home-congestion-design.md`

## Global Constraints

- 백엔드(`backend/`) 파일은 건드리지 않는다. 새 엔드포인트·스키마 없음.
- 새 npm 의존성 없음.
- 커밋 메시지는 Conventional Commits (`CONTRIBUTING.md`): `type(scope): subject`, scope는 `fe`, subject는 소문자 명령형, 마침표 없음.
- 브랜치는 이미 `feat/home-congestion`. `main`/`develop`에 직접 커밋 금지.
- 표시 문구는 스펙에 적힌 그대로 쓴다: `불러오는 중`, `정보 없음`, `서비스 예정`, `휴관일`, `운영 전`, `운영 종료`, `집계 중`.
- 무데이터 카드는 `opacity-60`으로 흐리게 하되 `Link`는 유지한다.
- 테스트 실행: `cd frontend && npm test`. 타입 검사: `cd frontend && npm run type-check`. 둘 다 통과해야 커밋한다.
- 시각에 따라 분기하는 테스트는 반드시 `vi.setSystemTime()`으로 시각을 고정한다 (`tests/MmcaPage.test.tsx`의 기존 패턴).

---

### Task 1: 국립중앙박물관 영업시간을 lib으로 추출

`CongestionCard.tsx`에 private으로 있는 개·폐관 판정을 lib으로 옮긴다. 홈도 같은 판정을 해야 하므로 사본을 두 벌 만들지 않기 위한 이동이며, 로직 변경은 없다.

**Files:**
- Create: `frontend/src/lib/nationalMuseumBusinessHours.ts`
- Modify: `frontend/src/components/CongestionCard.tsx` (11-17행 삭제, import 추가, 181행 호출 이름 변경)
- Test: `frontend/tests/nationalMuseumBusinessHours.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `nationalMuseumBusinessHours(date: Date): { open: number; close: number }` — `open`/`close`는 자정 기준 분(minute of day). 항상 `open = 570` (09:30), `close`는 수·토 `1260` (21:00), 그 외 `1050` (17:30).

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/tests/nationalMuseumBusinessHours.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { nationalMuseumBusinessHours } from "../src/lib/nationalMuseumBusinessHours";

describe("nationalMuseumBusinessHours", () => {
  it("closes at 21:00 on Wednesday and Saturday", () => {
    // 2026-08-19 수요일, 2026-08-22 토요일
    expect(nationalMuseumBusinessHours(new Date("2026-08-19T12:00:00"))).toEqual({
      open: 9 * 60 + 30,
      close: 21 * 60,
    });
    expect(nationalMuseumBusinessHours(new Date("2026-08-22T12:00:00"))).toEqual({
      open: 9 * 60 + 30,
      close: 21 * 60,
    });
  });

  it("closes at 17:30 on other days", () => {
    // 2026-08-20 목요일
    expect(nationalMuseumBusinessHours(new Date("2026-08-20T12:00:00"))).toEqual({
      open: 9 * 60 + 30,
      close: 17 * 60 + 30,
    });
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd frontend && npx vitest run tests/nationalMuseumBusinessHours.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/nationalMuseumBusinessHours"`

- [ ] **Step 3: lib 파일 생성**

`frontend/src/lib/nationalMuseumBusinessHours.ts` — `CongestionCard.tsx` 11-17행에 있던 내용을 주석까지 그대로 옮긴다:

```ts
const OPEN_MINUTES = 9 * 60 + 30; // 09:30, every day
const LONG_CLOSE_DAYS = new Set([3, 6]); // Wed, Sat: 21:00 close; other days: 17:30

export function nationalMuseumBusinessHours(date: Date): { open: number; close: number } {
  const close = LONG_CLOSE_DAYS.has(date.getDay()) ? 21 * 60 : 17 * 60 + 30;
  return { open: OPEN_MINUTES, close };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run tests/nationalMuseumBusinessHours.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: CongestionCard가 lib을 쓰도록 변경**

`frontend/src/components/CongestionCard.tsx`:

1. 6행 `import { statusOf } from "../lib/status";` 아래(import 블록 마지막)에 추가:

```ts
import { nationalMuseumBusinessHours } from "../lib/nationalMuseumBusinessHours";
```

(import 순서는 기존 파일이 경로 알파벳순이므로 `../lib/date` 다음, `../lib/status` 앞에 넣는다.)

2. 11-17행의 `OPEN_MINUTES`, `LONG_CLOSE_DAYS`, `businessHours` 정의를 삭제한다. 삭제 대상은 정확히 이 블록:

```ts
const OPEN_MINUTES = 9 * 60 + 30; // 09:30, every day
const LONG_CLOSE_DAYS = new Set([3, 6]); // Wed, Sat: 21:00 close; other days: 17:30

function businessHours(date: Date): { open: number; close: number } {
  const close = LONG_CLOSE_DAYS.has(date.getDay()) ? 21 * 60 : 17 * 60 + 30;
  return { open: OPEN_MINUTES, close };
}
```

3. 181행의 호출을 바꾼다:

```ts
  const { open, close } = nationalMuseumBusinessHours(now);
```

- [ ] **Step 6: 전체 테스트와 타입 검사**

Run: `cd frontend && npm test && npm run type-check`
Expected: 전부 PASS. 특히 `tests/CongestionCard.test.tsx`가 그대로 통과해야 한다 — 이동이 동작을 바꾸지 않았다는 회귀 증거다.

- [ ] **Step 7: 커밋**

```bash
git add frontend/src/lib/nationalMuseumBusinessHours.ts frontend/src/components/CongestionCard.tsx frontend/tests/nationalMuseumBusinessHours.test.ts
git commit -m "refactor(fe): extract national museum business hours into lib"
```

---

### Task 2: 혼잡도 레벨 순서 노출 + 국립중앙박물관 요약 함수

`VenueSummary` 타입과 국립중앙박물관용 판정을 만든다. MMCA 판정은 Task 3.

**Files:**
- Create: `frontend/src/lib/venueSummary.ts`
- Modify: `frontend/src/lib/status.ts` (파일 끝에 한 줄 추가)
- Test: `frontend/tests/venueSummary.test.ts`

**Interfaces:**
- Consumes: `nationalMuseumBusinessHours(date)` (Task 1), 기존 `CurrentCongestion` (`src/api/congestion.ts`: `observed_at: string`, `congest_level: string`, `population_avg: number`)
- Produces:
  - `STATUS_LEVELS: string[]` (`src/lib/status.ts`) — `["여유", "보통", "약간 붐빔", "붐빔"]`
  - `VenueSummary` 판별 유니온:
    ```ts
    | { kind: "inactive"; label: string }
    | { kind: "level"; level: string; population: number; observedAt: string }
    | { kind: "counts"; counts: { level: string; count: number }[]; observedAt: string }
    ```
  - `nationalMuseumSummary(current: CurrentCongestion | null, now: Date): VenueSummary`

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/tests/venueSummary.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { CurrentCongestion } from "../src/api/congestion";
import { STATUS_LEVELS } from "../src/lib/status";
import { nationalMuseumSummary } from "../src/lib/venueSummary";

const CURRENT: CurrentCongestion = {
  observed_at: "2026-08-20T14:20:00",
  congest_level: "보통",
  population_avg: 1240.4,
};

// 2026-08-20은 목요일 → 09:30-17:30
const THURSDAY_MIDDAY = new Date("2026-08-20T14:20:00");

describe("STATUS_LEVELS", () => {
  it("lists levels from least to most crowded", () => {
    expect(STATUS_LEVELS).toEqual(["여유", "보통", "약간 붐빔", "붐빔"]);
  });
});

describe("nationalMuseumSummary", () => {
  it("shows the level and population during business hours", () => {
    expect(nationalMuseumSummary(CURRENT, THURSDAY_MIDDAY)).toEqual({
      kind: "level",
      level: "보통",
      population: 1240.4,
      observedAt: "2026-08-20T14:20:00",
    });
  });

  it("reports loading while there is no data yet", () => {
    expect(nationalMuseumSummary(null, THURSDAY_MIDDAY)).toEqual({
      kind: "inactive",
      label: "불러오는 중",
    });
  });

  it("reports before-open and after-close instead of a stale level", () => {
    expect(nationalMuseumSummary(CURRENT, new Date("2026-08-20T09:00:00"))).toEqual({
      kind: "inactive",
      label: "운영 전",
    });
    expect(nationalMuseumSummary(CURRENT, new Date("2026-08-20T18:00:00"))).toEqual({
      kind: "inactive",
      label: "운영 종료",
    });
  });

  it("still shows the level at the exact open and close minute", () => {
    expect(nationalMuseumSummary(CURRENT, new Date("2026-08-20T09:30:00")).kind).toBe("level");
    expect(nationalMuseumSummary(CURRENT, new Date("2026-08-20T17:30:00")).kind).toBe("level");
  });

  it("keeps the long Wednesday hours open past 17:30", () => {
    // 2026-08-19 수요일 → 21:00 폐관
    expect(nationalMuseumSummary(CURRENT, new Date("2026-08-19T19:00:00")).kind).toBe("level");
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd frontend && npx vitest run tests/venueSummary.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/venueSummary"`

- [ ] **Step 3: `STATUS_LEVELS` 추가**

`frontend/src/lib/status.ts` 파일 끝, `statusOf` 함수 아래에 추가:

```ts
// 혼잡도 낮은 순 → 높은 순. STATUS의 정의 순서를 그대로 따라가므로 레벨 목록이
// 두 군데로 갈라지지 않는다 (문자열 키 객체의 키 순서는 삽입 순서).
export const STATUS_LEVELS = Object.keys(STATUS);
```

- [ ] **Step 4: `venueSummary.ts` 생성**

`frontend/src/lib/venueSummary.ts`:

```ts
import type { CurrentCongestion } from "../api/congestion";
import { nationalMuseumBusinessHours } from "./nationalMuseumBusinessHours";

export type VenueSummary =
  | { kind: "inactive"; label: string }
  | { kind: "level"; level: string; population: number; observedAt: string }
  | { kind: "counts"; counts: { level: string; count: number }[]; observedAt: string };

function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

// 운영시간 밖에서는 레벨을 감춘다 — /congestion/current는 폐관 뒤에도 마지막
// 판독을 계속 돌려주므로, 그대로 적으면 밤에도 지금 값인 것처럼 읽힌다.
// (CongestionCard의 openBadge와 같은 판정)
function closedLabel(now: Date, open: number, close: number): string | null {
  const nowMinutes = minutesOfDay(now);
  if (nowMinutes < open) return "운영 전";
  if (nowMinutes > close) return "운영 종료";
  return null;
}

export function nationalMuseumSummary(
  current: CurrentCongestion | null,
  now: Date
): VenueSummary {
  if (current === null) return { kind: "inactive", label: "불러오는 중" };

  const { open, close } = nationalMuseumBusinessHours(now);
  const closed = closedLabel(now, open, close);
  if (closed) return { kind: "inactive", label: closed };

  return {
    kind: "level",
    level: current.congest_level,
    population: current.population_avg,
    observedAt: current.observed_at,
  };
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd frontend && npx vitest run tests/venueSummary.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/lib/venueSummary.ts frontend/src/lib/status.ts frontend/tests/venueSummary.test.ts
git commit -m "feat(fe): add national museum venue summary for the home cards"
```

---

### Task 3: MMCA 관 요약 함수

MMCA 관은 방 목록을 레벨별 개수로 접는다. 판정 순서와 제외 규칙이 이 태스크의 전부다.

**Files:**
- Modify: `frontend/src/lib/venueSummary.ts` (`mmcaSummary` 추가)
- Modify: `frontend/tests/venueSummary.test.ts` (`describe("mmcaSummary")` 추가)

**Interfaces:**
- Consumes: `VenueSummary`, `minutesOfDay`, `closedLabel` (Task 2, 같은 파일 내부), `STATUS_LEVELS` (Task 2), 기존 `mmcaBusinessHours(venue, date): { open, close, isOpenToday }` (`src/lib/mmcaBusinessHours.ts`), 기존 `DISABLED_MMCA_SPACE_CODES: Set<string>` (`src/lib/mmcaDisabledRooms.ts`), 기존 `MmcaRoomStatus` (`space_code: string`, `space_nm: string | null`, `congestion_nm: string | null`, `observed_at: string | null`)
- Produces: `mmcaSummary(venue: MmcaVenue, rooms: MmcaRoomStatus[] | null, now: Date): VenueSummary`

판정 순서 (위에서 먼저 걸리는 것이 이긴다):

| 조건 | 결과 |
| --- | --- |
| `rooms === null` | `불러오는 중` |
| disabled 아닌 방이 0개 | `서비스 예정` |
| `!isOpenToday` | `휴관일` |
| `now < open` / `now > close` | `운영 전` / `운영 종료` |
| 판독(`congestion_nm != null`) 있는 활성 방이 0개 | `집계 중` |
| 그 외 | `counts` |

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/tests/venueSummary.test.ts` 끝에 추가한다. 파일 상단 import에 `mmcaSummary`, `MmcaRoomStatus`를 더한다:

```ts
import type { MmcaRoomStatus } from "../src/api/mmca";
import { mmcaSummary, nationalMuseumSummary } from "../src/lib/venueSummary";
```

그리고 아래 블록을 파일 끝에 붙인다:

```ts
function makeRoom(overrides: Partial<MmcaRoomStatus> = {}): MmcaRoomStatus {
  return {
    space_code: "MMCA-SPACE-1001",
    space_nm: "1전시실",
    congestion_nm: "여유",
    observed_at: "2026-08-20T14:20:00",
    ...overrides,
  };
}

// MMCA 운영시간은 10:00-18:00 (수·토는 21:00), 2026-08-20은 목요일
const MMCA_MIDDAY = new Date("2026-08-20T14:20:00");

describe("mmcaSummary", () => {
  it("counts rooms per level, least crowded first", () => {
    const rooms = [
      makeRoom({ space_code: "MMCA-SPACE-1001", congestion_nm: "붐빔" }),
      makeRoom({ space_code: "MMCA-SPACE-1002", congestion_nm: "여유" }),
      makeRoom({ space_code: "MMCA-SPACE-1003", congestion_nm: "보통" }),
      makeRoom({ space_code: "MMCA-SPACE-1004", congestion_nm: "여유" }),
    ];

    expect(mmcaSummary("seoul", rooms, MMCA_MIDDAY)).toEqual({
      kind: "counts",
      counts: [
        { level: "여유", count: 2 },
        { level: "보통", count: 1 },
        { level: "붐빔", count: 1 },
      ],
      observedAt: "2026-08-20T14:20:00",
    });
  });

  it("appends unknown levels after the known ones", () => {
    const rooms = [
      makeRoom({ space_code: "MMCA-SPACE-1001", congestion_nm: "매우 붐빔" }),
      makeRoom({ space_code: "MMCA-SPACE-1002", congestion_nm: "여유" }),
    ];

    const summary = mmcaSummary("seoul", rooms, MMCA_MIDDAY);
    expect(summary.kind === "counts" && summary.counts).toEqual([
      { level: "여유", count: 1 },
      { level: "매우 붐빔", count: 1 },
    ]);
  });

  it("uses the newest observed_at among counted rooms", () => {
    const rooms = [
      makeRoom({ space_code: "MMCA-SPACE-1001", observed_at: "2026-08-20T14:10:00" }),
      makeRoom({ space_code: "MMCA-SPACE-1002", observed_at: "2026-08-20T14:20:00" }),
    ];

    const summary = mmcaSummary("seoul", rooms, MMCA_MIDDAY);
    expect(summary.kind === "counts" && summary.observedAt).toBe("2026-08-20T14:20:00");
  });

  it("excludes disabled rooms and rooms with no reading from the counts", () => {
    const rooms = [
      makeRoom({ space_code: "MMCA-SPACE-1001", congestion_nm: "여유" }),
      makeRoom({ space_code: "MMCA-SPACE-2008", congestion_nm: "붐빔" }), // disabled
      makeRoom({ space_code: "MMCA-SPACE-1002", congestion_nm: null, observed_at: null }),
    ];

    const summary = mmcaSummary("seoul", rooms, MMCA_MIDDAY);
    expect(summary.kind === "counts" && summary.counts).toEqual([{ level: "여유", count: 1 }]);
  });

  it("reports loading while there is no data yet", () => {
    expect(mmcaSummary("seoul", null, MMCA_MIDDAY)).toEqual({
      kind: "inactive",
      label: "불러오는 중",
    });
  });

  it("reports service-pending when every room is disabled", () => {
    // 덕수궁관은 MMCA-SPACE-4001 한 칸뿐이고 그 방이 disabled다
    const rooms = [makeRoom({ space_code: "MMCA-SPACE-4001", congestion_nm: null, observed_at: null })];

    expect(mmcaSummary("deoksugung", rooms, MMCA_MIDDAY)).toEqual({
      kind: "inactive",
      label: "서비스 예정",
    });
  });

  it("puts service-pending above the clock so night-time does not read as reopening", () => {
    const rooms = [makeRoom({ space_code: "MMCA-SPACE-4001", congestion_nm: null, observed_at: null })];

    expect(mmcaSummary("deoksugung", rooms, new Date("2026-08-20T23:00:00"))).toEqual({
      kind: "inactive",
      label: "서비스 예정",
    });
  });

  it("reports the Monday closure for Deoksugung", () => {
    // 2026-08-17은 월요일. disabled 방만 있으면 서비스 예정이 이기므로 활성 방을 쓴다.
    const rooms = [makeRoom({ space_code: "MMCA-SPACE-4002" })];

    expect(mmcaSummary("deoksugung", rooms, new Date("2026-08-17T14:00:00"))).toEqual({
      kind: "inactive",
      label: "휴관일",
    });
  });

  it("reports before-open and after-close", () => {
    const rooms = [makeRoom()];

    expect(mmcaSummary("seoul", rooms, new Date("2026-08-20T09:00:00"))).toEqual({
      kind: "inactive",
      label: "운영 전",
    });
    expect(mmcaSummary("seoul", rooms, new Date("2026-08-20T19:00:00"))).toEqual({
      kind: "inactive",
      label: "운영 종료",
    });
  });

  it("reports tallying while open but before the first poll of the day", () => {
    const rooms = [makeRoom({ congestion_nm: null, observed_at: null })];

    expect(mmcaSummary("seoul", rooms, new Date("2026-08-20T10:05:00"))).toEqual({
      kind: "inactive",
      label: "집계 중",
    });
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd frontend && npx vitest run tests/venueSummary.test.ts`
Expected: FAIL — `mmcaSummary is not a function` (또는 import 해결 실패)

- [ ] **Step 3: `mmcaSummary` 구현**

`frontend/src/lib/venueSummary.ts` — import 블록을 아래로 늘리고 (경로 알파벳순 유지):

```ts
import type { CurrentCongestion } from "../api/congestion";
import type { MmcaRoomStatus, MmcaVenue } from "../api/mmca";
import { mmcaBusinessHours } from "./mmcaBusinessHours";
import { DISABLED_MMCA_SPACE_CODES } from "./mmcaDisabledRooms";
import { nationalMuseumBusinessHours } from "./nationalMuseumBusinessHours";
import { STATUS_LEVELS } from "./status";
```

파일 끝에 추가:

```ts
export function mmcaSummary(
  venue: MmcaVenue,
  rooms: MmcaRoomStatus[] | null,
  now: Date
): VenueSummary {
  if (rooms === null) return { kind: "inactive", label: "불러오는 중" };

  const active = rooms.filter((room) => !DISABLED_MMCA_SPACE_CODES.has(room.space_code));
  // 시각 판정보다 위 — 덕수궁관은 시간과 무관하게 영구히 수집 대상이 아니므로,
  // 밤에 "운영 종료"로 적으면 아침에는 값이 나올 것처럼 읽힌다.
  if (active.length === 0) return { kind: "inactive", label: "서비스 예정" };

  const { open, close, isOpenToday } = mmcaBusinessHours(venue, now);
  if (!isOpenToday) return { kind: "inactive", label: "휴관일" };
  const closed = closedLabel(now, open, close);
  if (closed) return { kind: "inactive", label: closed };

  const read = active.filter(
    (room): room is MmcaRoomStatus & { congestion_nm: string; observed_at: string } =>
      room.congestion_nm !== null && room.observed_at !== null
  );
  // /mmca/rooms는 당일 판독만 돌려주고 수집기의 첫 폴은 개관 10분 뒤에 돈다
  // (backend/app/collector.py의 _COLLECTION_START) — 그 창은 오류가 아니다.
  if (read.length === 0) return { kind: "inactive", label: "집계 중" };

  const tally = new Map<string, number>();
  for (const room of read) {
    tally.set(room.congestion_nm, (tally.get(room.congestion_nm) ?? 0) + 1);
  }

  // 아는 레벨을 혼잡도순으로 먼저 쏟고, 목록에 없는 레벨은 등장 순서대로 뒤에
  // 붙인다 (statusOf가 회색 fallback으로 그려 준다).
  const unknown = [...tally.keys()].filter((level) => !STATUS_LEVELS.includes(level));
  const counts = [...STATUS_LEVELS, ...unknown]
    .filter((level) => tally.has(level))
    .map((level) => ({ level, count: tally.get(level) as number }));

  return {
    kind: "counts",
    counts,
    // ISO 문자열은 같은 포맷이면 사전순 = 시간순.
    observedAt: read.reduce(
      (latest, room) => (room.observed_at > latest ? room.observed_at : latest),
      read[0].observed_at
    ),
  };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run tests/venueSummary.test.ts`
Expected: PASS (16 tests — Task 2의 6개 + 이번 10개)

- [ ] **Step 5: 타입 검사**

Run: `cd frontend && npm run type-check`
Expected: 에러 없음

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/lib/venueSummary.ts frontend/tests/venueSummary.test.ts
git commit -m "feat(fe): summarize MMCA rooms into per-level counts"
```

---

### Task 4: 홈 카드에 요약 렌더 + 폴링

**Files:**
- Modify: `frontend/src/venues.ts` (`mmcaVenue` 필드 추가)
- Modify: `frontend/src/pages/HomePage.tsx` (전면 교체)
- Test: `frontend/tests/HomePage.test.tsx` (기존 링크 테스트 수정 + 렌더 테스트 추가)

**Interfaces:**
- Consumes: `nationalMuseumSummary(current, now)` (Task 2), `mmcaSummary(venue, rooms, now)` (Task 3), `VenueSummary` (Task 2), 기존 `statusOf(level): { core, text, wash }`, 기존 `fetchCurrent()`, `fetchMmcaRooms(venue)`
- Produces: 사용자에게 보이는 홈 카드. 후속 태스크 없음.

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/tests/HomePage.test.tsx` 전체를 아래로 교체한다. 기존 링크 테스트는 카드 안에 텍스트가 늘어 accessible name이 `"국립중앙박물관 보통 1,240명 14:20 기준"` 꼴로 바뀌므로 정규식 매칭으로 고친다.

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as congestionApi from "../src/api/congestion";
import * as mmcaApi from "../src/api/mmca";
import type { MmcaRoomStatus, MmcaVenue } from "../src/api/mmca";
import { HomePage } from "../src/pages/HomePage";

function makeRoom(overrides: Partial<MmcaRoomStatus> = {}): MmcaRoomStatus {
  return {
    space_code: "MMCA-SPACE-1001",
    space_nm: "1전시실",
    congestion_nm: "여유",
    observed_at: "2026-08-20T14:20:00",
    ...overrides,
  };
}

describe("HomePage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 카드 내용이 개·폐관 판정에 걸리므로 시각을 고정한다 — 안 하면
    // 테스트가 실행 시간대에 따라 붙었다 떨어진다.
    vi.setSystemTime(new Date("2026-08-20T14:20:00")); // 목요일, 두 관 모두 운영 중
    vi.spyOn(congestionApi, "fetchCurrent").mockResolvedValue({
      observed_at: "2026-08-20T14:20:00",
      congest_level: "보통",
      population_avg: 1240.4,
    });
    vi.spyOn(mmcaApi, "fetchMmcaRooms").mockImplementation((venue: MmcaVenue) =>
      Promise.resolve(
        venue === "deoksugung"
          ? [makeRoom({ space_code: "MMCA-SPACE-4001", congestion_nm: null, observed_at: null })]
          : [
              makeRoom({ space_code: "MMCA-SPACE-1001", congestion_nm: "여유" }),
              makeRoom({ space_code: "MMCA-SPACE-1002", congestion_nm: "여유" }),
              makeRoom({ space_code: "MMCA-SPACE-1003", congestion_nm: "보통" }),
            ]
      )
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders a link to each venue page", async () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: /국립중앙박물관/ })).toHaveAttribute(
      "href",
      "/venues/national-museum"
    );
    expect(screen.getByRole("link", { name: /국립현대미술관 서울관/ })).toHaveAttribute(
      "href",
      "/venues/mmca-seoul"
    );
    expect(screen.getByRole("link", { name: /국립현대미술관 과천관/ })).toHaveAttribute(
      "href",
      "/venues/mmca-gwacheon"
    );
    expect(screen.getByRole("link", { name: /국립현대미술관 덕수궁관/ })).toHaveAttribute(
      "href",
      "/venues/mmca-deoksugung"
    );
  });

  it("shows the national museum level with its population", async () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("보통")).toBeInTheDocument());
    expect(screen.getByText("1,240")).toBeInTheDocument();
    expect(screen.getAllByText("14:20 기준").length).toBeGreaterThan(0);
  });

  it("shows per-level room counts for an MMCA venue", async () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    const seoulCard = await screen.findByRole("link", { name: /국립현대미술관 서울관/ });
    expect(seoulCard).toHaveTextContent("여유");
    expect(seoulCard).toHaveTextContent("2");
    expect(seoulCard).toHaveTextContent("보통");
  });

  it("shows the service-pending state for Deoksugung", async () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("서비스 예정")).toBeInTheDocument());
  });

  it("falls back to an unavailable label only for the venue whose fetch failed", async () => {
    vi.spyOn(congestionApi, "fetchCurrent").mockRejectedValue(new Error("network error"));

    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("정보 없음")).toBeInTheDocument());
    // 국중박만 실패했으므로 MMCA 카드는 그대로 그려진다
    const seoulCard = screen.getByRole("link", { name: /국립현대미술관 서울관/ });
    expect(seoulCard).toHaveTextContent("여유");
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd frontend && npx vitest run tests/HomePage.test.tsx`
Expected: FAIL — 요약 텍스트가 없어 `Unable to find an element with the text: 보통` 등

- [ ] **Step 3: `venues.ts`에 `mmcaVenue` 추가**

`frontend/src/venues.ts` 전체를 교체:

```ts
import type { MmcaVenue } from "./api/mmca";

export interface Venue {
  id: string;
  name: string;
  path: string;
  // MMCA관이면 /mmca/rooms 파라미터. 없으면 국립중앙박물관
  // (/congestion/current) — 관 종류가 둘뿐이라 판별 유니온까지 갈 이유가 없다.
  mmcaVenue?: MmcaVenue;
}

export const VENUES: Venue[] = [
  { id: "national-museum", name: "국립중앙박물관", path: "/venues/national-museum" },
  {
    id: "mmca-seoul",
    name: "국립현대미술관 서울관",
    path: "/venues/mmca-seoul",
    mmcaVenue: "seoul",
  },
  {
    id: "mmca-gwacheon",
    name: "국립현대미술관 과천관",
    path: "/venues/mmca-gwacheon",
    mmcaVenue: "gwacheon",
  },
  {
    id: "mmca-deoksugung",
    name: "국립현대미술관 덕수궁관",
    path: "/venues/mmca-deoksugung",
    mmcaVenue: "deoksugung",
  },
];
```

- [ ] **Step 4: `HomePage.tsx` 구현**

`frontend/src/pages/HomePage.tsx` 전체를 교체:

```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { fetchCurrent } from "../api/congestion";
import { fetchMmcaRooms } from "../api/mmca";
import { statusOf } from "../lib/status";
import { mmcaSummary, nationalMuseumSummary, type VenueSummary } from "../lib/venueSummary";
import { VENUES } from "../venues";

const POLL_INTERVAL_MS = 60_000; // MmcaPage와 같은 주기

const LOADING: VenueSummary = { kind: "inactive", label: "불러오는 중" };

// 레벨 하나를 점 + 이름(+ MMCA는 방 개수)으로. 색은 상세 페이지와 같은 토큰.
function LevelText({ level, count }: { level: string; count?: number }) {
  const status = statusOf(level);
  return (
    <span
      className="flex items-center gap-1.5 text-lg font-semibold"
      style={{ color: status.text }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: status.core }} />
      {level}
      {count !== undefined && <span className="font-mono tabular-nums">{count}</span>}
    </span>
  );
}

export function HomePage() {
  const [summaries, setSummaries] = useState<Record<string, VenueSummary>>({});

  useEffect(() => {
    let ignore = false;

    function load() {
      const now = new Date();
      // 관별로 따로 띄운다 — allSettled로 묶으면 가장 느린 관이 나머지 세 카드의
      // 첫 렌더를 붙잡는다.
      for (const venue of VENUES) {
        const mmca = venue.mmcaVenue;
        const request = mmca
          ? fetchMmcaRooms(mmca).then((rooms) => mmcaSummary(mmca, rooms, now))
          : fetchCurrent().then((current) => nationalMuseumSummary(current, now));

        request
          .then((summary) => {
            if (!ignore) setSummaries((prev) => ({ ...prev, [venue.id]: summary }));
          })
          .catch(() => {
            // 한 관의 실패가 다른 카드를 비우지 않게 관별로 따로 처리한다.
            // 직전 요약이 있으면 그대로 두고 (다음 폴이 갱신한다), 처음부터
            // 못 받았을 때만 안내 문구로 떨어진다.
            if (!ignore) {
              setSummaries((prev) =>
                prev[venue.id]
                  ? prev
                  : { ...prev, [venue.id]: { kind: "inactive", label: "정보 없음" } }
              );
            }
          });
      }
    }

    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      ignore = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="min-h-screen bg-canvas">
      <main className="mx-auto max-w-[1400px] px-6 py-16 sm:px-10 lg:px-16">
        <header className="mb-12 border-b border-hairline/70 pb-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-soft">
            Exhibition · Seoul
          </p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            전시 혼잡도 예측
          </h1>
        </header>

        <section className="grid gap-6 sm:grid-cols-2">
          {VENUES.map((venue) => {
            const summary = summaries[venue.id] ?? LOADING;
            return (
              <Link
                key={venue.id}
                to={venue.path}
                className={`rounded-apple border border-hairline/60 bg-white/70 p-8 shadow-apple backdrop-blur-xl transition hover:border-accent/50${
                  summary.kind === "inactive" ? " opacity-60" : ""
                }`}
              >
                <span className="text-xl font-semibold text-ink">{venue.name}</span>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {summary.kind === "inactive" && (
                    <span className="text-lg text-ink-soft">{summary.label}</span>
                  )}
                  {summary.kind === "level" && (
                    <>
                      <LevelText level={summary.level} />
                      <span className="text-sm text-ink-soft">
                        <span className="font-mono tabular-nums">
                          {Math.round(summary.population).toLocaleString()}
                        </span>
                        명
                      </span>
                    </>
                  )}
                  {summary.kind === "counts" &&
                    summary.counts.map(({ level, count }) => (
                      <LevelText key={level} level={level} count={count} />
                    ))}
                </div>
                {summary.kind !== "inactive" && (
                  <p className="mt-1 text-[11px] text-ink-soft/70">
                    {summary.observedAt.slice(11, 16)} 기준
                  </p>
                )}
              </Link>
            );
          })}
        </section>
      </main>
    </div>
  );
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd frontend && npx vitest run tests/HomePage.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 6: 전체 테스트 + 타입 검사 + 빌드**

Run: `cd frontend && npm test && npm run type-check && npm run build`
Expected: 전부 PASS. `npm run build`까지 보는 이유는 `venues.ts`가 이제 `api/mmca`를 import해서 모듈 그래프가 바뀌기 때문이다.

- [ ] **Step 7: 커밋**

```bash
git add frontend/src/venues.ts frontend/src/pages/HomePage.tsx frontend/tests/HomePage.test.tsx
git commit -m "feat(fe): show per-venue congestion on the home cards"
```

---

## 마무리 확인

- [ ] `cd frontend && npm test` — 전 테스트 통과
- [ ] `cd frontend && npm run type-check` — 에러 없음
- [ ] `cd backend && python -m pytest -q` — 백엔드는 손대지 않았으므로 그대로 통과 (CI가 같이 도는 게이트라 미리 확인)
- [ ] `git log --oneline develop..HEAD` — 커밋이 태스크 단위로 쪼개져 있고 Claude co-author 트레일러가 없음
