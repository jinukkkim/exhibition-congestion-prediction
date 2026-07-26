# MMCA 폴링 로그 표 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MMCA 3개 관(서울/과천/덕수궁) 페이지 각각에, 하루치 폴링 로그를 "시각 1행 · 전시실별 컬럼"으로 피벗한 표를 카드 그리드 아래에 추가한다.

**Architecture:** 백엔드에 `GET /mmca/daily?venue&date` 신규 엔드포인트를 추가해 `raw_mmca_congestion`을 분 단위로 그룹핑·피벗한다. 프론트는 `DailyLogTable`과 같은 날짜 네비게이션 UX를 재사용하되(날짜 유틸을 공용 모듈로 추출), 컬럼은 관마다 다른 전시실 수에 맞춰 응답 데이터에서 동적으로 뽑는 신규 컴포넌트 `MmcaDailyLogTable`을 만든다. 기존 `MmcaPage`(3관 공용)에 삽입해 라우팅 변경 없이 3관 모두 적용한다.

**Tech Stack:** 기존과 동일 — FastAPI, SQLAlchemy, pytest / React, Vite, TypeScript, Vitest, Playwright. 신규 의존성 없음.

## Global Constraints

- 표는 폴링 로그 전체를 보여준다 — 시각 1행, 전시실은 가로 컬럼으로 피벗한다.
- 그룹핑은 `observed_at`을 분 단위로 내림(`replace(second=0, microsecond=0)`)해서 한다. 배치가 분 경계를 넘길 수 있다는 한계는 `ponytail:` 주석으로 남긴다(고치지 않는다).
- 전시실 컬럼 순서/개수는 항상 `settings.mmca_venue_space_codes[venue]` 순서로 고정 — 특정 전시실이 그 폴링에서 누락됐으면 `null`로 채운다.
- 카드 그리드(`RoomCongestionCard`)는 그대로 두고, 표는 그 아래에 추가한다 — 대체하지 않는다.
- `EARLIEST_DATE` 같은 관별 하드코딩 상수는 두지 않는다 — "다음 날짜" 버튼만 오늘 이후로 못 가게 막고, "이전 날짜"는 항상 활성 상태로 둔다. 데이터 없는 날은 "데이터 없음"으로 자연스럽게 표시한다.
- `raw_response`는 이번 응답 스키마에 포함하지 않는다.
- 이 작업은 `feat/mmca-daily-log-table` 브랜치(이미 `develop`에서 분기되어 있음)에서 진행한다. `develop`/`main`에 직접 커밋하지 않는다(CLAUDE.md 브랜치 정책).

---

## File Structure

```
backend/
  app/
    schemas.py       (수정) — MmcaDailyRoom, MmcaDailyLogPoint 추가
    routes/mmca.py    (수정) — GET /mmca/daily 추가
  tests/
    test_routes_mmca.py  (수정) — 신규 엔드포인트 테스트 추가

frontend/
  src/
    lib/
      date.ts             (신규) — todayString, shiftDate (DailyLogTable에서 추출)
    components/
      DailyLogTable.tsx        (수정) — lib/date.ts의 유틸 사용하도록 변경
      MmcaDailyLogTable.tsx    (신규) — 관별 동적 컬럼 피벗 표
    pages/
      NationalMuseumPage.tsx   (수정) — todayString import 경로 변경
      MmcaPage.tsx              (수정) — MmcaDailyLogTable 삽입
    api/
      mmca.ts   (수정) — MmcaDailyRoom, MmcaDailyLogPoint, fetchMmcaDaily 추가
  tests/
    MmcaDailyLogTable.test.tsx  (신규)
    MmcaPage.test.tsx            (수정) — fetchMmcaDaily 기본 mock 추가
  e2e/
    congestion.spec.ts           (수정) — /mmca/daily 목 응답 추가
```

---

## Task 1: 백엔드 — `GET /mmca/daily` 엔드포인트

**Files:**
- Modify: `backend/app/schemas.py`
- Modify: `backend/app/routes/mmca.py`
- Test: `backend/tests/test_routes_mmca.py`

**Interfaces:**
- Consumes: `app.config.settings.mmca_venue_space_codes: dict[str, list[str]]` (기존), `app.models.RawMmcaCongestion`(기존, 필드: `observed_at`, `space_code`, `space_nm`, `congestion_nm`)
- Produces: `GET /mmca/daily?venue={str}&date={YYYY-MM-DD 선택}` → `list[MmcaDailyLogPoint]`. `MmcaDailyLogPoint = {observed_at: str, rooms: list[MmcaDailyRoom]}`, `MmcaDailyRoom = {space_code: str, space_nm: str | None, congestion_nm: str | None}`. `venue` 미상이면 400, `date` 형식 오류면 400. 이후 프론트 Task(Task 3)가 이 응답 모양을 그대로 소비한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_routes_mmca.py` 맨 끝에 추가:

```python
def test_mmca_daily_returns_400_for_unknown_venue(client):
    test_client, _ = client
    response = test_client.get("/mmca/daily?venue=busan")
    assert response.status_code == 400


def test_mmca_daily_returns_400_for_malformed_date(client):
    test_client, _ = client
    response = test_client.get("/mmca/daily?venue=seoul&date=not-a-date")
    assert response.status_code == 400


def test_mmca_daily_returns_empty_list_when_no_data(client):
    test_client, _ = client
    response = test_client.get("/mmca/daily?venue=seoul&date=2026-07-16")
    assert response.status_code == 200
    assert response.json() == []


def test_mmca_daily_pivots_rooms_from_one_poll_into_one_row(client):
    test_client, session_factory = client

    with session_factory() as session:
        session.add_all(
            [
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 25, 15, 0, 3),
                    space_code="MMCA-SPACE-1001",
                    space_nm="1전시실",
                    congestion_nm="여유",
                ),
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 25, 15, 0, 7),
                    space_code="MMCA-SPACE-1002",
                    space_nm="2전시실",
                    congestion_nm="보통",
                ),
            ]
        )
        session.commit()

    response = test_client.get("/mmca/daily?venue=seoul&date=2026-07-25")
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["observed_at"] == "2026-07-25T15:00:00"
    assert len(body[0]["rooms"]) == 8  # seoul has 8 space codes

    rooms = {r["space_code"]: r for r in body[0]["rooms"]}
    assert rooms["MMCA-SPACE-1001"]["congestion_nm"] == "여유"
    assert rooms["MMCA-SPACE-1002"]["congestion_nm"] == "보통"


def test_mmca_daily_fills_null_for_rooms_missing_from_a_poll(client):
    test_client, session_factory = client

    with session_factory() as session:
        session.add(
            RawMmcaCongestion(
                observed_at=datetime(2026, 7, 25, 15, 0, 3),
                space_code="MMCA-SPACE-1001",
                space_nm="1전시실",
                congestion_nm="여유",
            )
        )
        session.commit()

    response = test_client.get("/mmca/daily?venue=seoul&date=2026-07-25")
    body = response.json()
    missing = next(r for r in body[0]["rooms"] if r["space_code"] == "MMCA-SPACE-1002")
    assert missing["congestion_nm"] is None
    assert missing["space_nm"] is None


def test_mmca_daily_separates_different_poll_times_into_separate_rows(client):
    test_client, session_factory = client

    with session_factory() as session:
        session.add_all(
            [
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 25, 15, 0, 3),
                    space_code="MMCA-SPACE-1001",
                    congestion_nm="여유",
                ),
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 25, 15, 15, 5),
                    space_code="MMCA-SPACE-1001",
                    congestion_nm="보통",
                ),
            ]
        )
        session.commit()

    response = test_client.get("/mmca/daily?venue=seoul&date=2026-07-25")
    body = response.json()
    assert len(body) == 2
    assert body[0]["observed_at"] == "2026-07-25T15:00:00"
    assert body[1]["observed_at"] == "2026-07-25T15:15:00"


def test_mmca_daily_filters_by_venue(client):
    test_client, session_factory = client

    with session_factory() as session:
        session.add_all(
            [
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 25, 15, 0, 3),
                    space_code="MMCA-SPACE-1001",
                    congestion_nm="여유",
                ),
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 25, 15, 0, 3),
                    space_code="MMCA-SPACE-2001",
                    congestion_nm="보통",
                ),
            ]
        )
        session.commit()

    # deoksugung's only code is MMCA-SPACE-4001 — neither seoul nor
    # gwacheon rows should leak into its result.
    response = test_client.get("/mmca/daily?venue=deoksugung&date=2026-07-25")
    assert response.json() == []
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_routes_mmca.py -v`
Expected: 새로 추가한 6개 테스트가 FAIL — `404 Not Found` (엔드포인트 없음)

- [ ] **Step 3: 최소 구현**

`backend/app/schemas.py` 맨 끝에 추가:

```python
class MmcaDailyRoom(BaseModel):
    space_code: str
    space_nm: str | None
    congestion_nm: str | None


class MmcaDailyLogPoint(BaseModel):
    observed_at: str
    rooms: list[MmcaDailyRoom]
```

`backend/app/routes/mmca.py` 전체 교체:

```python
from collections import defaultdict
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func

from app.config import settings
from app.db import SessionLocal
from app.models import RawMmcaCongestion
from app.schemas import MmcaDailyLogPoint, MmcaDailyRoom, MmcaRoomStatus

router = APIRouter()


@router.get("/mmca/rooms", response_model=list[MmcaRoomStatus])
def mmca_rooms(venue: str) -> list[MmcaRoomStatus]:
    codes = settings.mmca_venue_space_codes.get(venue)
    if codes is None:
        raise HTTPException(status_code=400, detail=f"unknown venue: {venue}")

    with SessionLocal() as session:
        latest_ids = [
            row[0]
            for row in session.query(func.max(RawMmcaCongestion.id))
            .filter(RawMmcaCongestion.space_code.in_(codes))
            .group_by(RawMmcaCongestion.space_code)
            .all()
        ]
        rows = (
            session.query(RawMmcaCongestion)
            .filter(RawMmcaCongestion.id.in_(latest_ids))
            .order_by(RawMmcaCongestion.space_code)
            .all()
        )

    if not rows:
        raise HTTPException(status_code=503, detail="no MMCA congestion data yet")

    return [
        MmcaRoomStatus(
            space_code=row.space_code,
            space_nm=row.space_nm,
            congestion_nm=row.congestion_nm,
            observed_at=row.observed_at.isoformat(),
        )
        for row in rows
    ]


@router.get("/mmca/daily", response_model=list[MmcaDailyLogPoint])
def mmca_daily(venue: str, date: str | None = Query(default=None)) -> list[MmcaDailyLogPoint]:
    codes = settings.mmca_venue_space_codes.get(venue)
    if codes is None:
        raise HTTPException(status_code=400, detail=f"unknown venue: {venue}")

    if date is None:
        day_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    else:
        try:
            day_start = datetime.strptime(date, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="date must be in YYYY-MM-DD format")
    day_end = day_start + timedelta(days=1)

    with SessionLocal() as session:
        rows = (
            session.query(RawMmcaCongestion)
            .filter(
                RawMmcaCongestion.space_code.in_(codes),
                RawMmcaCongestion.observed_at >= day_start,
                RawMmcaCongestion.observed_at < day_end,
            )
            .order_by(RawMmcaCongestion.observed_at.asc())
            .all()
        )

    # ponytail: assumes one poll batch finishes within the same minute it
    # starts (true today — an 8-room batch takes ~4s). If room counts grow
    # enough to push a batch past a minute boundary, switch to a real
    # batch_id instead of bucketing by minute.
    buckets: dict[datetime, dict[str, RawMmcaCongestion]] = defaultdict(dict)
    for row in rows:
        bucket_key = row.observed_at.replace(second=0, microsecond=0)
        buckets[bucket_key][row.space_code] = row

    return [
        MmcaDailyLogPoint(
            observed_at=bucket_time.isoformat(),
            rooms=[
                MmcaDailyRoom(
                    space_code=code,
                    space_nm=buckets[bucket_time][code].space_nm if code in buckets[bucket_time] else None,
                    congestion_nm=buckets[bucket_time][code].congestion_nm
                    if code in buckets[bucket_time]
                    else None,
                )
                for code in codes
            ],
        )
        for bucket_time in sorted(buckets)
    ]
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_routes_mmca.py -v`
Expected: 전체 PASS

- [ ] **Step 5: 전체 백엔드 스위트 회귀 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/ -q`
Expected: 전체 PASS (기존 테스트 회귀 없음)

- [ ] **Step 6: 커밋**

```bash
git add backend/app/schemas.py backend/app/routes/mmca.py backend/tests/test_routes_mmca.py
git commit -m "feat(be): add GET /mmca/daily pivoted polling log endpoint"
```

---

## Task 2: 프론트엔드 — 날짜 유틸 공용화

기존 `DailyLogTable.tsx`에 갇혀 있는 로컬-캘린더 날짜 계산(`todayString`, `shiftDate`)을 `MmcaDailyLogTable`도 그대로 써야 한다. 이 로직은 예전에 UTC 오프바이원 버그가 있었던 곳이라(커밋 `32f99cf`), 복붙 대신 공용 모듈로 추출해 두 컴포넌트가 같은 구현을 공유하게 한다.

**Files:**
- Create: `frontend/src/lib/date.ts`
- Modify: `frontend/src/components/DailyLogTable.tsx`
- Modify: `frontend/src/pages/NationalMuseumPage.tsx`
- Test: 기존 `frontend/tests/DailyLogTable.test.tsx` (수정 없음, 회귀 확인용으로만 재실행)

**Interfaces:**
- Produces: `frontend/src/lib/date.ts`에서 `export function todayString(): string`, `export function shiftDate(date: string, days: number): string`. Task 4가 이 두 함수를 그대로 가져다 쓴다.

- [ ] **Step 1: 공용 모듈 작성**

`frontend/src/lib/date.ts` 신규 생성:

```ts
function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function todayString(): string {
  return formatDate(new Date());
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return formatDate(d);
}
```

- [ ] **Step 2: `DailyLogTable.tsx`가 공용 모듈을 쓰도록 변경**

`frontend/src/components/DailyLogTable.tsx`에서 다음 블록(로컬 `formatDate`/`todayString`/`shiftDate` 정의 전체)을:

```ts
function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function todayString(): string {
  return formatDate(new Date());
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return formatDate(d);
}
```

다음으로 교체:

```ts
import { shiftDate, todayString } from "../lib/date";
```

(파일 맨 위 기존 `import { useEffect, useState } from "react";` 아래, `import { fetchDaily, ... } from "../api/congestion";` 위에 추가)

- [ ] **Step 3: `NationalMuseumPage.tsx`의 import 경로 수정**

`frontend/src/pages/NationalMuseumPage.tsx`:

```ts
import { DailyLogTable, todayString } from "../components/DailyLogTable";
```

를

```ts
import { DailyLogTable } from "../components/DailyLogTable";
import { todayString } from "../lib/date";
```

로 교체 (두 줄, import 순서상 `../components/DailyLogTable` 다음에 `../lib/date`를 추가).

- [ ] **Step 4: 타입체크 + 기존 테스트로 회귀 확인**

Run: `cd frontend && npm run type-check 2>&1 | grep -v ExpectStatic`
Expected: `date.ts`/`DailyLogTable.tsx`/`NationalMuseumPage.tsx` 관련 새 에러 없음 (기존에 있던 `ExpectStatic` 관련 에러는 이 작업과 무관하니 무시)

Run: `cd frontend && npx vitest run tests/DailyLogTable.test.tsx`
Expected: 기존 테스트 전부 PASS (동작 변경 없이 위치만 옮겼으므로 그대로 통과해야 함)

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/lib/date.ts frontend/src/components/DailyLogTable.tsx frontend/src/pages/NationalMuseumPage.tsx
git commit -m "refactor(fe): extract local-calendar date utils into lib/date"
```

---

## Task 3: 프론트엔드 — `fetchMmcaDaily` API 클라이언트

**Files:**
- Modify: `frontend/src/api/mmca.ts`

**Interfaces:**
- Consumes: 없음 (순수 fetch 래퍼)
- Produces: `export interface MmcaDailyRoom { space_code: string; space_nm: string | null; congestion_nm: string | null }`, `export interface MmcaDailyLogPoint { observed_at: string; rooms: MmcaDailyRoom[] }`, `export function fetchMmcaDaily(venue: MmcaVenue, date: string): Promise<MmcaDailyLogPoint[]>`. Task 4·5가 이 세 export를 그대로 가져다 쓴다.

- [ ] **Step 1: 타입 + 함수 추가**

`frontend/src/api/mmca.ts` 맨 끝에 추가:

```ts
export interface MmcaDailyRoom {
  space_code: string;
  space_nm: string | null;
  congestion_nm: string | null;
}

export interface MmcaDailyLogPoint {
  observed_at: string;
  rooms: MmcaDailyRoom[];
}

export async function fetchMmcaDaily(venue: MmcaVenue, date: string): Promise<MmcaDailyLogPoint[]> {
  const res = await fetch(`/mmca/daily?venue=${venue}&date=${date}`);
  if (!res.ok) {
    throw new Error(`failed to fetch MMCA daily log: ${res.status}`);
  }
  return res.json();
}
```

- [ ] **Step 2: 타입체크**

Run: `cd frontend && npm run type-check 2>&1 | grep -v ExpectStatic`
Expected: `mmca.ts` 관련 새 에러 없음

- [ ] **Step 3: 커밋**

```bash
git add frontend/src/api/mmca.ts
git commit -m "feat(fe): add fetchMmcaDaily API client"
```

---

## Task 4: 프론트엔드 — `MmcaDailyLogTable` 컴포넌트

**Files:**
- Create: `frontend/src/components/MmcaDailyLogTable.tsx`
- Test: `frontend/tests/MmcaDailyLogTable.test.tsx`

**Interfaces:**
- Consumes: `fetchMmcaDaily(venue: MmcaVenue, date: string): Promise<MmcaDailyLogPoint[]>`, `type MmcaDailyLogPoint`(Task 3), `todayString(): string` / `shiftDate(date: string, days: number): string`(Task 2), `statusOf(level: string): StatusTokens`(기존 `../lib/status`)
- Produces: `export function MmcaDailyLogTable({ venue }: { venue: MmcaVenue }): JSX.Element`. Task 5가 이 컴포넌트를 `MmcaPage`에 삽입한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/tests/MmcaDailyLogTable.test.tsx` 신규 생성:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MmcaDailyLogTable } from "../src/components/MmcaDailyLogTable";
import * as api from "../src/api/mmca";
import type { MmcaDailyLogPoint, MmcaDailyRoom } from "../src/api/mmca";

function makeRow(observedAt: string, rooms: MmcaDailyRoom[]): MmcaDailyLogPoint {
  return { observed_at: observedAt, rooms };
}

describe("MmcaDailyLogTable", () => {
  it("renders a column per room and colors cells by congestion", async () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([
      makeRow("2026-07-25T15:00:00", [
        { space_code: "MMCA-SPACE-1001", space_nm: "1전시실", congestion_nm: "여유" },
        { space_code: "MMCA-SPACE-1002", space_nm: "2전시실", congestion_nm: "보통" },
      ]),
    ]);

    render(<MmcaDailyLogTable venue="seoul" />);

    await waitFor(() => expect(screen.getByText("1전시실")).toBeInTheDocument());
    expect(screen.getByText("2전시실")).toBeInTheDocument();
    expect(screen.getByText("15:00")).toBeInTheDocument();
    expect(screen.getByText("여유")).toBeInTheDocument();
    expect(screen.getByText("보통")).toBeInTheDocument();
  });

  it("falls back to the space code as a header when space_nm is null", async () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([
      makeRow("2026-07-25T15:00:00", [
        { space_code: "MMCA-SPACE-4001", space_nm: null, congestion_nm: null },
      ]),
    ]);

    render(<MmcaDailyLogTable venue="deoksugung" />);

    await waitFor(() => expect(screen.getByText("MMCA-SPACE-4001")).toBeInTheDocument());
  });

  it("shows an empty-state message when there is no data for the day", async () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);

    render(<MmcaDailyLogTable venue="seoul" />);

    await waitFor(() => expect(screen.getByText(/데이터 없음/)).toBeInTheDocument());
  });

  it("disables the next-day button when viewing today, but never disables the previous-day button", async () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);

    render(<MmcaDailyLogTable venue="seoul" />);

    await waitFor(() => screen.getByText(/데이터 없음/));
    expect(screen.getByRole("button", { name: /다음 날짜/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /이전 날짜/ })).not.toBeDisabled();
  });

  it("re-fetches for the previous day with the venue prop when the previous button is clicked", async () => {
    const fetchMmcaDailyMock = vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);

    render(<MmcaDailyLogTable venue="gwacheon" />);
    await waitFor(() => expect(fetchMmcaDailyMock).toHaveBeenCalledTimes(1));
    expect(fetchMmcaDailyMock.mock.calls[0][0]).toBe("gwacheon");

    fireEvent.click(screen.getByRole("button", { name: /이전 날짜/ }));

    await waitFor(() => expect(fetchMmcaDailyMock).toHaveBeenCalledTimes(2));
    const firstCallDate = fetchMmcaDailyMock.mock.calls[0][1];
    const secondCallDate = fetchMmcaDailyMock.mock.calls[1][1];
    expect(secondCallDate < firstCallDate).toBe(true);
  });

  it("shows the most recent reading first", async () => {
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([
      makeRow("2026-07-25T15:00:00", [
        { space_code: "MMCA-SPACE-1001", space_nm: "1전시실", congestion_nm: "여유" },
      ]),
      makeRow("2026-07-25T15:15:00", [
        { space_code: "MMCA-SPACE-1001", space_nm: "1전시실", congestion_nm: "보통" },
      ]),
    ]);

    render(<MmcaDailyLogTable venue="seoul" />);
    await waitFor(() => expect(screen.getByText("15:15")).toBeInTheDocument());

    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("15:15");
    expect(rows[2]).toHaveTextContent("15:00");
  });

  it("ignores a stale response that resolves after a newer request", async () => {
    let resolveFirst: (rows: MmcaDailyLogPoint[]) => void = () => {};
    let resolveSecond: (rows: MmcaDailyLogPoint[]) => void = () => {};

    const fetchMmcaDailyMock = vi
      .spyOn(api, "fetchMmcaDaily")
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));

    render(<MmcaDailyLogTable venue="seoul" />);
    await waitFor(() => expect(fetchMmcaDailyMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /이전 날짜/ }));
    await waitFor(() => expect(fetchMmcaDailyMock).toHaveBeenCalledTimes(2));

    resolveSecond([
      makeRow("2026-07-24T09:00:00", [
        { space_code: "MMCA-SPACE-1001", space_nm: "1전시실", congestion_nm: "여유" },
      ]),
    ]);
    await waitFor(() => expect(screen.getByText("09:00")).toBeInTheDocument());

    resolveFirst([
      makeRow("2026-07-25T15:00:00", [
        { space_code: "MMCA-SPACE-1001", space_nm: "1전시실", congestion_nm: "보통" },
      ]),
    ]);
    await waitFor(() => expect(screen.getByText("09:00")).toBeInTheDocument());
    expect(screen.queryByText("15:00")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run tests/MmcaDailyLogTable.test.tsx`
Expected: FAIL — `Cannot find module '../src/components/MmcaDailyLogTable'`

- [ ] **Step 3: 최소 구현**

`frontend/src/components/MmcaDailyLogTable.tsx` 신규 생성:

```tsx
import { useEffect, useState } from "react";

import { fetchMmcaDaily, type MmcaDailyLogPoint, type MmcaVenue } from "../api/mmca";
import { shiftDate, todayString } from "../lib/date";
import { statusOf } from "../lib/status";

export function MmcaDailyLogTable({ venue }: { venue: MmcaVenue }) {
  const [selectedDate, setSelectedDate] = useState(todayString());
  const [rows, setRows] = useState<MmcaDailyLogPoint[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let ignore = false;
    setRows(null);
    setError(false);
    fetchMmcaDaily(venue, selectedDate)
      .then((data) => {
        if (!ignore) setRows(data);
      })
      .catch(() => {
        if (!ignore) setError(true);
      });
    return () => {
      ignore = true;
    };
  }, [venue, selectedDate]);

  const isToday = selectedDate === todayString();
  const displayRows = rows ? [...rows].reverse() : rows;
  const columns = rows && rows.length > 0 ? rows[0].rooms : [];

  return (
    <div className="overflow-hidden rounded-apple border border-hairline/60 bg-white/70 shadow-apple backdrop-blur-xl motion-safe:animate-rise-in">
      <div className="flex items-center justify-between border-b border-hairline/60 px-8 py-6">
        <button
          className="rounded-full px-3 py-1.5 text-sm font-medium text-ink-soft transition hover:bg-ink/5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          onClick={() => setSelectedDate((d) => shiftDate(d, -1))}
        >
          ← 이전 날짜
        </button>
        <span className="font-mono text-sm font-semibold tabular-nums text-ink">{selectedDate}</span>
        <button
          className="rounded-full px-3 py-1.5 text-sm font-medium text-ink-soft transition hover:bg-ink/5 hover:text-ink disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          disabled={isToday}
          onClick={() => setSelectedDate((d) => shiftDate(d, 1))}
        >
          다음 날짜 →
        </button>
      </div>

      {error && <p className="px-8 py-12 text-center text-sm text-ink-soft">불러오지 못했습니다.</p>}
      {!error && rows && rows.length === 0 && (
        <p className="px-8 py-12 text-center text-sm text-ink-soft">데이터 없음</p>
      )}
      {!error && displayRows && displayRows.length > 0 && (
        <div className="max-h-[28rem] overflow-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead className="sticky top-0 z-10 bg-white/85 backdrop-blur-xl">
              <tr>
                <th className="whitespace-nowrap border-b border-hairline/60 px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
                  시각
                </th>
                {columns.map((room) => (
                  <th
                    key={room.space_code}
                    className="whitespace-nowrap border-b border-hairline/60 px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-ink-soft"
                  >
                    {room.space_nm ?? room.space_code}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row) => (
                <tr key={row.observed_at} className="transition-colors hover:bg-ink/[0.03]">
                  <td className="whitespace-nowrap border-b border-hairline/40 px-4 py-2.5 font-mono tabular-nums text-ink">
                    {row.observed_at.slice(11, 16)}
                  </td>
                  {row.rooms.map((room) => (
                    <td
                      key={room.space_code}
                      className="whitespace-nowrap border-b border-hairline/40 px-4 py-2.5 font-mono tabular-nums text-ink"
                      style={{ color: statusOf(room.congestion_nm ?? "").text, fontWeight: 600 }}
                    >
                      {room.congestion_nm ?? "-"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run tests/MmcaDailyLogTable.test.tsx`
Expected: 전체 PASS

- [ ] **Step 5: 타입체크**

Run: `cd frontend && npm run type-check 2>&1 | grep -v ExpectStatic`
Expected: `MmcaDailyLogTable.tsx` 관련 새 에러 없음

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/components/MmcaDailyLogTable.tsx frontend/tests/MmcaDailyLogTable.test.tsx
git commit -m "feat(fe): add MmcaDailyLogTable pivot component"
```

---

## Task 5: `MmcaPage`에 삽입 + 기존 테스트/e2e 동기화

**Files:**
- Modify: `frontend/src/pages/MmcaPage.tsx`
- Modify: `frontend/tests/MmcaPage.test.tsx`
- Modify: `frontend/e2e/congestion.spec.ts`

**Interfaces:**
- Consumes: `MmcaDailyLogTable({ venue: MmcaVenue })`(Task 4), `fetchMmcaDaily`(Task 3, mock 대상)

- [ ] **Step 1: `MmcaPage.tsx`에 표 삽입**

`frontend/src/pages/MmcaPage.tsx`에서:

```tsx
import { fetchMmcaRooms, type MmcaRoomStatus, type MmcaVenue } from "../api/mmca";
import { RoomCongestionCard } from "../components/RoomCongestionCard";
```

를

```tsx
import { fetchMmcaRooms, type MmcaRoomStatus, type MmcaVenue } from "../api/mmca";
import { MmcaDailyLogTable } from "../components/MmcaDailyLogTable";
import { RoomCongestionCard } from "../components/RoomCongestionCard";
```

로 교체. 그리고:

```tsx
        {rooms && (
          <section className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {rooms.map((room) => (
              <RoomCongestionCard key={room.space_code} room={room} />
            ))}
          </section>
        )}
      </main>
```

를

```tsx
        {rooms && (
          <section className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {rooms.map((room) => (
              <RoomCongestionCard key={room.space_code} room={room} />
            ))}
          </section>
        )}

        <section className="mt-6">
          <MmcaDailyLogTable venue={venue} />
        </section>
      </main>
```

로 교체.

- [ ] **Step 2: 기존 `MmcaPage.test.tsx`가 깨지지 않도록 기본 mock 추가**

`MmcaDailyLogTable`도 마운트 시 `fetchMmcaDaily`를 호출하므로, mock 없이 두면 실제 `fetch`가 호출돼 기존 테스트가 깨진다. `frontend/tests/MmcaPage.test.tsx`에서:

```tsx
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
```

를

```tsx
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, "fetchMmcaDaily").mockResolvedValue([]);
  });
```

로 교체 (파일 상단에 이미 `import * as api from "../src/api/mmca";`가 있으므로 추가 import 불필요).

- [ ] **Step 3: 프론트 전체 테스트 실행**

Run: `cd frontend && npm run test`
Expected: 전체 PASS (기존 테스트 포함)

- [ ] **Step 4: e2e 목 응답에 `/mmca/daily` 추가**

`frontend/e2e/congestion.spec.ts`에서:

```ts
  await page.route("**/mmca/rooms*", (route) =>
    route.fulfill({
      json: [
        {
          space_code: "MMCA-SPACE-1001",
          space_nm: "1전시실",
          congestion_nm: "여유",
          observed_at: "2026-07-24T10:00:00",
        },
      ],
    })
  );
```

바로 다음 줄에 추가:

```ts
  await page.route("**/mmca/daily*", (route) => route.fulfill({ json: [] }));
```

- [ ] **Step 5: e2e 내비게이션 테스트 실행**

Run: `cd frontend && npx playwright test e2e/congestion.spec.ts -g "navigates from the home picker" --retries=0`
Expected: 서울/과천/덕수궁 페이지 이동 스텝까지 PASS. (마지막 국중박 재방문 스텝의 실패 여부는 이번 작업과 무관 — Task 6에서 전체 스위트로 별도 확인)

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/pages/MmcaPage.tsx frontend/tests/MmcaPage.test.tsx frontend/e2e/congestion.spec.ts
git commit -m "feat(fe): show MMCA daily polling log table on venue pages"
```

---

## Task 6: 전체 회귀 확인 + PR

**Files:** 없음 (검증 + PR만)

- [ ] **Step 1: 백엔드 전체 스위트**

Run: `cd backend && .venv/bin/python -m pytest tests/ -q`
Expected: 전체 PASS

- [ ] **Step 2: 프론트 유닛 전체 스위트**

Run: `cd frontend && npm run test`
Expected: 전체 PASS

- [ ] **Step 3: 프론트 타입체크**

Run: `cd frontend && npm run type-check 2>&1 | grep -v ExpectStatic`
Expected: 이번 작업으로 인한 새 에러 없음

- [ ] **Step 4: e2e 전체 스위트**

Run: `cd frontend && npx playwright test e2e/congestion.spec.ts --retries=0`
Expected: 전체 PASS (PR #21에서 이전 세션의 시계-고정 픽스가 이미 병합됐으므로, 국중박 재방문 스텝도 이번엔 통과해야 함 — 만약 여전히 실패하면 이번 작업과 무관한 회귀인지 먼저 확인)

- [ ] **Step 5: 브랜치 push + PR 생성**

```bash
git push -u origin feat/mmca-daily-log-table
gh pr create --base develop --title "feat(mmca): show pivoted daily polling log table on venue pages" --body "$(cat <<'EOF'
## 설명

MMCA 3개 관(서울/과천/덕수궁) 페이지에 하루치 폴링 로그를 표로 확인할 수 있게 추가

## 구현 내용

- 백엔드: `GET /mmca/daily?venue&date` 신규 — raw_mmca_congestion을 분 단위로 그룹핑해 전시실 컬럼으로 피벗 반환. 특정 전시실이 그 폴링에서 누락되면 null로 채움
- 프론트: 로컬 캘린더 날짜 유틸(`todayString`/`shiftDate`)을 `lib/date.ts`로 추출해 `DailyLogTable`/`MmcaDailyLogTable`이 공유
- 프론트: `MmcaDailyLogTable` 신규 — 관별로 동적 컬럼(1~8개), 이전/다음 날짜 네비게이션(다음 날짜만 오늘 이후로 제한)
- `MmcaPage`(3관 공용) 카드 그리드 아래에 삽입

## 테스트

- 백엔드: `pytest` 전체 통과
- 프론트: `vitest` 전체 통과
- e2e: 3관 페이지 이동 + 표 렌더링 확인
EOF
)"
```

- [ ] **Step 6: PR URL 보고**

`gh pr create` 출력의 URL을 사용자에게 보고한다.
