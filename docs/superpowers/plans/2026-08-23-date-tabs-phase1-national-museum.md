# 날짜별 차트 조회 1단계 — 국립중앙박물관 예측 탭 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 국립중앙박물관 페이지의 예측 카드에 오늘부터 6일 뒤까지의 날짜 탭을 두고, 선택한 날의 시간대별 예상 곡선을 보여준다.

**Architecture:** 예측 모델의 피처가 `[weekday, hour, is_holiday]`뿐이라 미래 날짜도 그대로 예측할 수 있다. 하루 한 번 도는 배치가 7일치 커브를 미리 계산해 Redis에 담고, 라우트는 요청 시점에 과거가 된 항목만 걸러 내려보낸다. 프론트는 탭으로 커브를 골라 기존 곡선 렌더에 넘긴다.

**Tech Stack:** FastAPI, APScheduler, Redis(fakeredis for tests), scikit-learn, pytest / React 18, TypeScript, Vitest + @testing-library/react

**Spec:** `docs/superpowers/specs/2026-08-23-date-tabs-design.md`

## Global Constraints

- 탭 기간은 **오늘 + 6일 = 최대 7개**. 모델 피처가 요일·공휴일뿐이라 8일째부터는 곡선이 반복되므로 늘리지 않는다.
- 응답의 `curve` 필드를 **삭제하지 않는다**. `deploy/deploy.sh`가 백엔드를 먼저 재시작하고 프론트 번들을 마지막에 발행하므로 "구 프론트 + 신 백엔드" 구간이 존재한다.
- 공휴일 판정은 `backend/app/prediction/model.py`의 `_KR_HOLIDAYS`를 그대로 쓴다. 새로 만들지 않는다 — 피처와 표시의 판정 출처가 갈리면 안 된다.
- 시각은 항상 `Asia/Seoul` 기준. 프로덕션 서버는 `Etc/UTC`이므로 naive `datetime.now()`는 날짜를 하루 어긋나게 만든다.
- 커밋 메시지는 Conventional Commits (`CLAUDE.md`): `type(scope): subject`, scope는 `be`/`fe`, subject는 영어 소문자 명령형, 마침표 없음.
- 브랜치는 이미 `feat/date-tabs`. `main`/`develop`에 직접 커밋 금지.
- 실행: 백엔드 `cd backend && .venv/bin/python -m pytest -q`, 프론트 `cd frontend && npm test`, 타입 `cd frontend && npm run type-check`.
- MMCA는 이 계획의 범위가 아니다 (2단계).

---

### Task 1: 배치가 7일치 커브를 계산한다

**Files:**
- Modify: `backend/app/prediction/batch.py` (14행 `run_daily_batch` 시그니처, 53-70행 커브·결과 생성)
- Test: `backend/tests/test_batch.py`

**Interfaces:**
- Consumes: 기존 `predict_baseline(baseline, weekday, hour)`, `predict_model(model, ts)`
- Produces:
  - `run_daily_batch(session_factory=SessionLocal, today: date | None = None) -> dict`
  - `status == "ready"`일 때 결과 dict에 `days` 추가:
    ```python
    {
      "days": [
        {"date": "2026-08-23", "is_holiday": False,
         "curve": [{"hour": 0, "baseline": 800.0, "model": 812.3}, ...]},  # 24개
        ...  # 7개
      ]
    }
    ```
  - `curve`는 `days[0]["curve"]`와 같은 리스트를 유지 (하위 호환)
  - `status == "collecting"`일 때는 `days`를 넣지 않는다

`today`를 인자로 받는 이유: `session_factory`가 이미 같은 목적의 테스트 이음새이고, 자정 경계에서 흔들리지 않는 단정을 쓰려면 날짜를 고정할 수 있어야 한다. 스케줄러는 인자 없이 호출한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_batch.py` 파일 끝에 추가한다. `_seed`와 `session_factory`는 이미 파일 상단에 있다.

```python
def test_run_daily_batch_builds_a_curve_for_today_and_the_next_six_days(session_factory):
    _seed(session_factory, 20)

    result = run_daily_batch(session_factory, today=date(2026, 8, 23))

    assert result["status"] == "ready"
    assert [day["date"] for day in result["days"]] == [
        "2026-08-23",
        "2026-08-24",
        "2026-08-25",
        "2026-08-26",
        "2026-08-27",
        "2026-08-28",
        "2026-08-29",
    ]
    for day in result["days"]:
        assert [point["hour"] for point in day["curve"]] == list(range(24))


def test_seven_day_window_never_repeats_a_weekday(session_factory):
    """피처가 요일·공휴일뿐이라 같은 요일이 두 번 들어오면 곡선이 그대로 중복된다."""
    _seed(session_factory, 20)

    result = run_daily_batch(session_factory, today=date(2026, 8, 23))

    weekdays = [date.fromisoformat(day["date"]).weekday() for day in result["days"]]
    assert sorted(weekdays) == list(range(7))


def test_curve_field_still_holds_today(session_factory):
    """배포 중 '구 프론트 + 신 백엔드' 구간이 curve 를 읽는다."""
    _seed(session_factory, 20)

    result = run_daily_batch(session_factory, today=date(2026, 8, 23))

    assert result["curve"] == result["days"][0]["curve"]


def test_holiday_flag_follows_the_calendar(session_factory):
    """2026-10-03 은 개천절, 10-04 는 평일 일요일."""
    _seed(session_factory, 20)

    result = run_daily_batch(session_factory, today=date(2026, 10, 3))
    flags = {day["date"]: day["is_holiday"] for day in result["days"]}

    assert flags["2026-10-03"] is True
    assert flags["2026-10-04"] is False


def test_collecting_result_has_no_days(session_factory):
    _seed(session_factory, 3)

    result = run_daily_batch(session_factory, today=date(2026, 8, 23))

    assert result["status"] == "collecting"
    assert "days" not in result
```

파일 상단 import에 `date`를 더한다:

```python
from datetime import date, datetime, timedelta
```

그리고 `run_daily_batch` import가 없으면 추가한다 (기존 테스트가 이미 쓰고 있으므로 있을 것이다):

```python
from app.prediction.batch import run_daily_batch
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_batch.py -q`
Expected: FAIL — `run_daily_batch() got an unexpected keyword argument 'today'`

- [ ] **Step 3: 배치 구현**

`backend/app/prediction/batch.py`:

1. 상단 import를 바꾼다:

```python
from datetime import date, datetime, time, timedelta
```

`model.py`의 공휴일 목록을 가져온다 (파일 상단 import 블록에서 기존
`predict_model, train_model` 줄에 더한다):

```python
from app.prediction.model import _KR_HOLIDAYS, predict_model, train_model
```

2. 시그니처를 바꾼다:

```python
def run_daily_batch(session_factory=SessionLocal, today: date | None = None) -> dict:
```

3. 53-62행의 `today` 계산과 `curve` 생성을 아래로 교체한다. 기존 코드는 이 블록이다:

```python
    today = datetime.now(_SEOUL_TZ).replace(tzinfo=None)
    curve = [
        {
            "hour": hour,
            "baseline": predict_baseline(baseline, today.weekday(), hour),
            "model": predict_model(model, today.replace(hour=hour)),
        }
        for hour in range(24)
    ]
```

새 코드:

```python
    # weekday() 로 어느 날의 baseline 을 쓸지 고르고, observed_at 이 KST 벽시계이므로
    # 이쪽도 KST 여야 한다 — 프로덕션은 Etc/UTC 라 naive now() 는 KST 오전 내내
    # 전날로 떨어진다.
    first_day = today or datetime.now(_SEOUL_TZ).date()

    def day_curve(day: date) -> list[dict]:
        return [
            {
                "hour": hour,
                "baseline": predict_baseline(baseline, day.weekday(), hour),
                "model": predict_model(model, datetime.combine(day, time(hour=hour))),
            }
            for hour in range(24)
        ]

    # 오늘 + 6일. 피처가 (weekday, hour, is_holiday) 뿐이라 8일째부터는 곡선이
    # 그대로 반복되므로 7일이 중복 없는 최대치다.
    days = []
    for offset in range(7):
        day = first_day + timedelta(days=offset)
        days.append(
            {
                "date": day.isoformat(),
                "is_holiday": day in _KR_HOLIDAYS,
                "curve": day_curve(day),
            }
        )
```

4. 결과 dict에 `days`를 넣고 `curve`를 `days[0]`에서 가져온다. 기존:

```python
    result = {
        "status": "ready",
        "baseline_mae": mean(baseline_errors),
        "model_mae": mean(model_errors),
        "curve": curve,
    }
```

새 코드:

```python
    result = {
        "status": "ready",
        "baseline_mae": mean(baseline_errors),
        "model_mae": mean(model_errors),
        # 배포 중 "구 프론트 + 신 백엔드" 구간이 이 필드를 읽는다. days[0] 과 같은
        # 리스트이며, 프론트가 days 를 쓰게 된 뒤에도 지우지 않는다.
        "curve": days[0]["curve"],
        "days": days,
    }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_batch.py -q`
Expected: PASS (기존 3건 + 신규 5건 = 8건)

- [ ] **Step 5: 백엔드 전체 테스트**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: 전부 PASS

- [ ] **Step 6: 커밋**

```bash
git add backend/app/prediction/batch.py backend/tests/test_batch.py
git commit -m "feat(be): build prediction curves for today and the next six days"
```

---

### Task 2: 라우트가 과거 날짜를 걸러내고 `curve`를 정렬한다

**Files:**
- Modify: `backend/app/routes/prediction.py` (전체 13행)
- Test: `backend/tests/test_routes_prediction.py`

**Interfaces:**
- Consumes: Task 1이 만든 `days` 구조, 기존 `get_prediction()`
- Produces: `GET /congestion/prediction` 응답. `days`가 있으면 `date >= 오늘(KST)`인 항목만 남기고, `curve`를 남은 첫 항목의 커브로 맞춘다. `days`가 없는 페이로드는 손대지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_routes_prediction.py` 파일 끝에 추가한다.

```python
def test_prediction_drops_days_that_are_already_past(monkeypatch):
    """배치는 하루 한 번 돈다. 실행에 실패하거나 자정 직후 창에서는 저장된 첫
    항목이 어제가 되므로, 응답에서 걸러낸다."""
    from datetime import date

    from app.cache import set_prediction
    from app.main import app
    import app.routes.prediction as route_module

    def fake_today():
        return date(2026, 8, 24)

    monkeypatch.setattr(route_module, "_today_seoul", fake_today)

    set_prediction(
        {
            "status": "ready",
            "baseline_mae": 100.0,
            "model_mae": 80.0,
            "curve": [{"hour": 0, "baseline": 1.0, "model": 1.0}],
            "days": [
                {"date": "2026-08-23", "is_holiday": False,
                 "curve": [{"hour": 0, "baseline": 1.0, "model": 1.0}]},
                {"date": "2026-08-24", "is_holiday": False,
                 "curve": [{"hour": 0, "baseline": 2.0, "model": 2.0}]},
            ],
        }
    )

    body = TestClient(app).get("/congestion/prediction").json()

    assert [day["date"] for day in body["days"]] == ["2026-08-24"]
    # 하위 호환 필드도 남은 첫 항목에 맞춰야 한다 — 구 프론트가 어제 커브를
    # 오늘로 그리게 되기 때문이다.
    assert body["curve"] == [{"hour": 0, "baseline": 2.0, "model": 2.0}]


def test_prediction_leaves_a_payload_without_days_untouched():
    """days 를 담기 전 배치가 남긴 캐시가 TTL 안에 남아 있을 수 있다."""
    from app.cache import set_prediction
    from app.main import app

    cached = {"status": "ready", "baseline_mae": 100.0, "model_mae": 80.0, "curve": []}
    set_prediction(cached)

    body = TestClient(app).get("/congestion/prediction").json()

    assert body == cached
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_routes_prediction.py -q`
Expected: FAIL — `AttributeError: <module 'app.routes.prediction'> has no attribute '_today_seoul'`

- [ ] **Step 3: 라우트 구현**

`backend/app/routes/prediction.py` 전체를 교체한다:

```python
from datetime import date, datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter

from app.cache import get_prediction

router = APIRouter()

# 커브에 박힌 날짜는 KST 기준이다 (batch.py 와 같은 기준). 프로덕션 서버는
# Etc/UTC 라 naive now() 는 KST 오전 내내 전날로 떨어진다.
_SEOUL_TZ = ZoneInfo("Asia/Seoul")


def _today_seoul() -> date:
    return datetime.now(_SEOUL_TZ).date()


@router.get("/congestion/prediction")
def prediction() -> dict:
    cached = get_prediction()
    if cached is None:
        return {"status": "collecting", "days_collected": 0}

    days = cached.get("days")
    if not days:
        return cached

    # 배치는 하루 한 번 돌고 저장한 목록은 다음 실행까지 남는다. 실행이 밀리거나
    # 실패하면 첫 항목이 어제가 되므로, 오늘 이후만 내려보낸다. 탭이 7개보다
    # 적어지는 것이 틀린 날짜를 오늘로 제시하는 것보다 낫다.
    today = _today_seoul().isoformat()
    upcoming = [day for day in days if day["date"] >= today]

    result = {**cached, "days": upcoming}
    if upcoming:
        result["curve"] = upcoming[0]["curve"]
    return result
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_routes_prediction.py -q`
Expected: PASS (기존 2건 + 신규 2건 = 4건)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/routes/prediction.py backend/tests/test_routes_prediction.py
git commit -m "feat(be): serve only upcoming days from the prediction payload"
```

---

### Task 3: 배치 시각을 자정 직후로 옮긴다

**Files:**
- Modify: `backend/app/scheduler.py` (56-60행 `daily_batch` job)
- Test: `backend/tests/test_scheduler.py` (134행 `test_daily_batch_fires_at_3am_seoul_not_server_time`)

**Interfaces:**
- Consumes: 없음
- Produces: 없음 (스케줄만 바뀐다)

기존 테스트는 PR #43(스케줄이 서버 로컬 시간으로 해석되어 "새벽 3시"가 KST 정오에 돌던 버그)의 회귀 방어다. **삭제하지 않고 숫자와 이름만 바꾼다** — KST와 UTC를 둘 다 단정해야 그 목적이 유지된다.

- [ ] **Step 1: 테스트를 새 시각으로 바꾼다**

`backend/tests/test_scheduler.py`의 134행 함수 전체를 아래로 교체한다:

```python
def test_daily_batch_fires_just_after_midnight_seoul_not_server_time():
    """Production runs on Etc/UTC, where an unpinned cron put this at noon KST.

    Asserted through the trigger's own resolution rather than the configured
    timezone, so it still holds if the jobs ever move to per-trigger zones.

    00:02 rather than midnight: the collectors run on */5 and */10, so every
    multiple-of-five minute fires a full-table-scan batch alongside an insert.
    """
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo

    from app.scheduler import build_scheduler

    seoul = ZoneInfo("Asia/Seoul")
    scheduler = build_scheduler()
    trigger = {job.id: job.trigger for job in scheduler.get_jobs()}["daily_batch"]

    # Midnight KST on a fixed date, expressed in UTC so the host's own zone
    # can't leak into the fixture.
    previous = datetime(2026, 8, 12, 15, 0, tzinfo=timezone.utc)
    fire = trigger.get_next_fire_time(None, previous)

    assert fire.astimezone(seoul).hour == 0
    assert fire.astimezone(seoul).minute == 2
    assert fire.astimezone(timezone.utc).hour == 15  # 00:02 KST == 15:02 UTC


def test_daily_batch_does_not_collide_with_the_collector_grid():
    """수집기가 */5, MMCA 가 */10 이라 5의 배수 분은 동시 발사된다."""
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo

    from app.scheduler import build_scheduler

    seoul = ZoneInfo("Asia/Seoul")
    trigger = {
        job.id: job.trigger for job in build_scheduler().get_jobs()
    }["daily_batch"]

    previous = datetime(2026, 8, 12, 15, 0, tzinfo=timezone.utc)
    fire = trigger.get_next_fire_time(None, previous)

    assert fire.astimezone(seoul).minute % 5 != 0
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_scheduler.py -q`
Expected: FAIL — 2건. `assert 3 == 0` (현재 03:00)과 `assert 0 % 5 != 0`

- [ ] **Step 3: 스케줄 변경**

`backend/app/scheduler.py`의 `daily_batch` job에서 trigger 한 줄을 바꾼다. 기존:

```python
        trigger=CronTrigger(hour=3, minute=0, timezone=_SEOUL_TZ),
```

새 코드:

```python
        # 자정 직후 — 배치가 만드는 것이 "오늘부터 7일의 커브"이므로 하루가
        # 시작될 때 도는 것이 맞다. 03:00 이던 동안에는 자정~03:00 에 들어온
        # 사람에게 목록의 첫 항목이 어제였다. 정각이 아닌 이유는 수집기가
        # */5, MMCA 가 */10 이라 5의 배수 분에 동시 발사되기 때문이다.
        trigger=CronTrigger(hour=0, minute=2, timezone=_SEOUL_TZ),
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_scheduler.py -q`
Expected: PASS

- [ ] **Step 5: 백엔드 전체 테스트**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: 전부 PASS

- [ ] **Step 6: 커밋**

```bash
git add backend/app/scheduler.py backend/tests/test_scheduler.py
git commit -m "fix(be): run the prediction batch just after midnight"
```

---

### Task 4: `upcomingDates` 와 `DateTabs`

**Files:**
- Modify: `frontend/src/lib/date.ts` (파일 끝에 함수 추가)
- Create: `frontend/src/components/DateTabs.tsx`
- Test: `frontend/tests/date.test.ts` (신규), `frontend/tests/DateTabs.test.tsx` (신규)

**Interfaces:**
- Consumes: 기존 `shiftDate(date: string, days: number): string`, `todayString(): string`, `monthDayWeekday(date: string): string` (모두 `src/lib/date.ts`)
- Produces:
  - `upcomingDates(from: string, count: number): string[]` — `from`부터 하루씩 `count`개
  - `DateTabs({ dates, selected, onSelect }): JSX.Element`
    ```ts
    dates: string[];              // "YYYY-MM-DD", 오늘부터 순서대로
    selected: string;
    onSelect: (date: string) => void;
    ```
    첫 항목은 `오늘 (일)`, 나머지는 `월 8/24` 형태. `role="tablist"` / `role="tab"` + `aria-selected`.

- [ ] **Step 1: `upcomingDates` 실패 테스트 작성**

`frontend/tests/date.test.ts` (신규):

```ts
import { describe, expect, it } from "vitest";

import { monthDay, monthDayWeekday, upcomingDates, weekdayKo } from "../src/lib/date";

describe("upcomingDates", () => {
  it("lists the given day and the following ones in order", () => {
    expect(upcomingDates("2026-08-23", 7)).toEqual([
      "2026-08-23",
      "2026-08-24",
      "2026-08-25",
      "2026-08-26",
      "2026-08-27",
      "2026-08-28",
      "2026-08-29",
    ]);
  });

  it("crosses a month boundary", () => {
    expect(upcomingDates("2026-08-30", 3)).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
    ]);
  });
});

describe("monthDay / weekdayKo / monthDayWeekday", () => {
  it("splits the pieces the tab strip reorders", () => {
    // 2026-08-24 는 월요일
    expect(monthDay("2026-08-24")).toBe("8/24");
    expect(weekdayKo("2026-08-24")).toBe("월");
  });

  it("keeps the combined format unchanged for existing callers", () => {
    expect(monthDayWeekday("2026-08-24")).toBe("8/24(월)");
  });
});
```

`date.test.ts` 상단 import를 늘린다:

```ts
import { monthDay, monthDayWeekday, upcomingDates, weekdayKo } from "../src/lib/date";
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run tests/date.test.ts`
Expected: FAIL — `upcomingDates` export 없음

- [ ] **Step 3: `upcomingDates` 와 표시 헬퍼 구현**

`frontend/src/lib/date.ts`에서 기존 `monthDayWeekday`를 아래 셋으로 바꾼다.
탭 라벨이 `월 8/24`처럼 요일과 날짜의 순서를 바꿔 쓰므로, `"8/24(월)"` 문자열을
다시 잘라 쓰지 않도록 조각을 각각 내보낸다. 기존 코드:

```ts
export function monthDayWeekday(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAY_KO[d.getDay()]})`;
}
```

새 코드:

```ts
export function monthDay(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function weekdayKo(date: string): string {
  return WEEKDAY_KO[new Date(`${date}T00:00:00`).getDay()];
}

export function monthDayWeekday(date: string): string {
  return `${monthDay(date)}(${weekdayKo(date)})`;
}

// 날짜 탭용. shiftDate 를 그대로 써서 월·연 경계 계산을 한곳에 둔다.
export function upcomingDates(from: string, count: number): string[] {
  return Array.from({ length: count }, (_, offset) => shiftDate(from, offset));
}
```

`monthDayWeekday`의 반환값은 그대로이므로 기존 호출부(`CongestionCard`,
`MmcaRoomChartCard`)는 손대지 않는다.

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run tests/date.test.ts`
Expected: PASS (4건)

- [ ] **Step 5: `DateTabs` 실패 테스트 작성**

`frontend/tests/DateTabs.test.tsx` (신규):

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DateTabs } from "../src/components/DateTabs";

const DATES = ["2026-08-23", "2026-08-24", "2026-08-25"];

describe("DateTabs", () => {
  it("labels the first date as today and the rest by weekday and date", () => {
    render(<DateTabs dates={DATES} selected={DATES[0]} onSelect={() => {}} />);

    // 2026-08-23 은 일요일, 24 는 월요일
    expect(screen.getByRole("tab", { name: "오늘 (일)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "월 8/24" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "화 8/25" })).toBeInTheDocument();
  });

  it("marks only the selected tab as selected", () => {
    render(<DateTabs dates={DATES} selected={DATES[1]} onSelect={() => {}} />);

    expect(screen.getByRole("tab", { name: "월 8/24" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: "오늘 (일)" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
  });

  it("reports the clicked date", () => {
    const onSelect = vi.fn();
    render(<DateTabs dates={DATES} selected={DATES[0]} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("tab", { name: "화 8/25" }));

    expect(onSelect).toHaveBeenCalledWith("2026-08-25");
  });
});
```

- [ ] **Step 6: 실패 확인**

Run: `cd frontend && npx vitest run tests/DateTabs.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/components/DateTabs"`

- [ ] **Step 7: `DateTabs` 구현**

`frontend/src/components/DateTabs.tsx` (신규):

```tsx
import { monthDay, weekdayKo } from "../lib/date";

// 탭에서는 요일이 먼저 읽히는 편이 고르기 쉬워 "월 8/24" 순서로 쓴다.
function tabLabel(date: string, isFirst: boolean): string {
  return isFirst ? `오늘 (${weekdayKo(date)})` : `${weekdayKo(date)} ${monthDay(date)}`;
}

export function DateTabs({
  dates,
  selected,
  onSelect,
}: {
  dates: string[];
  selected: string;
  onSelect: (date: string) => void;
}) {
  return (
    <div role="tablist" className="flex flex-wrap gap-1.5">
      {dates.map((date, index) => {
        const isSelected = date === selected;
        return (
          <button
            key={date}
            type="button"
            role="tab"
            aria-selected={isSelected}
            onClick={() => onSelect(date)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${
              isSelected
                ? "bg-ink text-white"
                : "text-ink-soft hover:bg-ink/5 hover:text-ink"
            }`}
          >
            {tabLabel(date, index === 0)}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 8: 통과 확인**

Run: `cd frontend && npx vitest run tests/DateTabs.test.tsx tests/date.test.ts`
Expected: PASS (7건)

- [ ] **Step 9: 타입 검사와 커밋**

Run: `cd frontend && npm run type-check`
Expected: 에러 없음

```bash
git add frontend/src/lib/date.ts frontend/src/components/DateTabs.tsx frontend/tests/date.test.ts frontend/tests/DateTabs.test.tsx
git commit -m "feat(fe): add a date tab strip and upcoming-date helper"
```

---

### Task 5: 예측 카드에 날짜 탭 배선

> **설계 변경됨 (2026-08-23).** 탭을 예측 카드 안에 두면 왼쪽은 오늘, 오른쪽은
> 선택 날짜인 화면이 만들어진다. 탭을 헤더와 카드 그리드 사이(페이지 레벨)로
> 올리고 두 카드가 함께 그 날짜를 말하도록 바꿨다. 실제 구현은 스펙의
> "`NationalMuseumPage` — 탭은 페이지 레벨" 절을 따랐다. 아래 단계는 탭을
> 카드 안에 두던 원안이며 기록으로 남긴다.

**Files:**
- Modify: `frontend/src/api/congestion.ts` (`PredictionResult` 타입)
- Modify: `frontend/src/components/PredictionChart.tsx`
- Test: `frontend/tests/PredictionChart.test.tsx`

**Interfaces:**
- Consumes: `DateTabs`(Task 4), Task 2가 내려주는 `days`
- Produces: 사용자에게 보이는 날짜별 예측 카드. 후속 태스크 없음.

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/tests/PredictionChart.test.tsx` 파일 끝에 추가한다. 기존 테스트가 쓰는 `render`, `screen`은 이미 import 되어 있고, `fireEvent`를 상단 import에 더한다:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
```

추가할 케이스:

```tsx
function curveOf(value: number) {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    baseline: value,
    model: value + 10,
  }));
}

const READY_WITH_DAYS = {
  status: "ready" as const,
  baseline_mae: 120.5,
  model_mae: 95.2,
  curve: curveOf(1000),
  days: [
    { date: "2026-08-23", is_holiday: false, curve: curveOf(1000) },
    { date: "2026-08-24", is_holiday: false, curve: curveOf(2000) },
  ],
};

describe("PredictionChart date tabs", () => {
  it("renders one tab per day and starts on today", () => {
    render(<PredictionChart prediction={READY_WITH_DAYS} />);

    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "오늘 (일)" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByText(/오늘의 시간대별 예측/)).toBeInTheDocument();
  });

  it("draws the selected day's curve", () => {
    render(<PredictionChart prediction={READY_WITH_DAYS} />);

    const before = screen.getByTestId("prediction-svg").innerHTML;
    fireEvent.click(screen.getByRole("tab", { name: "월 8/24" }));

    expect(screen.getByTestId("prediction-svg").innerHTML).not.toBe(before);
    expect(screen.getByText(/8\/24\(월\)의 시간대별 예측/)).toBeInTheDocument();
  });

  it("falls back to the legacy curve when the payload has no days", () => {
    // days 를 담기 전 배치가 남긴 캐시가 TTL 안에 남아 있을 수 있다.
    render(
      <PredictionChart
        prediction={{
          status: "ready",
          baseline_mae: 120.5,
          model_mae: 95.2,
          curve: curveOf(1000),
        }}
      />
    );

    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByTestId("prediction-svg")).toBeInTheDocument();
  });

  it("keeps rendering when the selected day disappears from a later payload", () => {
    // 자정을 넘겨 폴링이 갱신되면 어제였던 항목이 사라진다. 없는 날짜를 선택한
    // 상태로 빈 차트를 그리지 않고 첫 항목으로 돌아가야 한다.
    const { rerender } = render(<PredictionChart prediction={READY_WITH_DAYS} />);

    fireEvent.click(screen.getByRole("tab", { name: "월 8/24" }));
    rerender(
      <PredictionChart
        prediction={{
          ...READY_WITH_DAYS,
          days: [{ date: "2026-08-25", is_holiday: false, curve: curveOf(3000) }],
        }}
      />
    );

    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "오늘 (화)" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run tests/PredictionChart.test.tsx`
Expected: FAIL — 4건. `Unable to find an accessible element with the role "tab"` 등

- [ ] **Step 3: 타입 추가**

`frontend/src/api/congestion.ts`의 `PredictionResult` 위에 추가하고 필드를 더한다. 기존:

```ts
export interface PredictionResult {
  status: "collecting" | "ready";
  days_collected?: number;
  baseline_mae?: number;
  model_mae?: number;
  curve?: PredictionCurvePoint[];
}
```

새 코드:

```ts
export interface PredictionDay {
  date: string;
  is_holiday: boolean;
  curve: PredictionCurvePoint[];
}

export interface PredictionResult {
  status: "collecting" | "ready";
  days_collected?: number;
  baseline_mae?: number;
  model_mae?: number;
  // days 를 담기 전 배치가 남긴 캐시가 TTL(24시간) 안에 남아 있을 수 있고,
  // 배포 중에도 구 백엔드 응답을 받을 수 있어 둘 다 optional 이다.
  curve?: PredictionCurvePoint[];
  days?: PredictionDay[];
}
```

- [ ] **Step 4: `PredictionChart` 배선**

`frontend/src/components/PredictionChart.tsx`:

1. import를 바꾼다:

```tsx
import { useState } from "react";

import type { PredictionResult } from "../api/congestion";
import { DateTabs } from "./DateTabs";
import { monthDayWeekday } from "../lib/date";
```

2. 컴포넌트 함수 첫 줄(구조 분해 직후, `if (!prediction)` **앞**)에 상태를
선언한다. 훅은 조기 반환보다 앞에 있어야 하고, `if (!prediction)`과 `collecting`
분기가 그 아래에 있다:

```tsx
  const [selected, setSelected] = useState<string | null>(null);
```

3. `collecting` 분기 **뒤**의 `const curve = prediction.curve ?? [];` 한 줄을
아래로 교체한다:

```tsx
  const days = prediction.days ?? [];
  // 선택 상태를 effect 로 되돌리지 않고 매 렌더에 검증한다. 자정을 넘겨 폴링이
  // 갱신되면 어제였던 항목이 사라지므로, 없는 날짜가 선택된 채로 빈 차트를
  // 그리는 상태가 생기지 않는다.
  const activeDate =
    selected !== null && days.some((day) => day.date === selected)
      ? selected
      : days[0]?.date;
  const activeDay = days.find((day) => day.date === activeDate);
  // days 가 없는 응답(구 백엔드, 또는 days 도입 전 캐시)에서는 기존 curve 로 떨어진다.
  const curve = activeDay?.curve ?? prediction.curve ?? [];
  const isFutureDay = activeDate !== undefined && activeDate !== days[0]?.date;
```

4. 카드 제목을 선택 날짜에 맞추고 탭을 넣는다. 기존:

```tsx
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-soft">
        오늘의 시간대별 예측
      </p>
```

새 코드:

```tsx
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-soft">
          {isFutureDay && activeDate ? monthDayWeekday(activeDate) : "오늘"}의 시간대별 예측
        </p>
        {activeDate !== undefined && days.length > 0 && (
          <DateTabs
            dates={days.map((day) => day.date)}
            selected={activeDate}
            onSelect={setSelected}
          />
        )}
      </div>
```

`isFutureDay && activeDate`로 좁혀서 `as` 캐스트를 쓰지 않는다 — 캐스트는
타입 검사를 끄는 것이고, 여기서는 좁히기로 충분하다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd frontend && npx vitest run tests/PredictionChart.test.tsx`
Expected: PASS (기존 4건 + 신규 4건 = 8건)

- [ ] **Step 6: 전체 검증**

Run: `cd frontend && npm test && npm run type-check && npm run build`
Expected: 전부 PASS. e2e도 확인한다: `cd frontend && npx playwright test` — 기존 e2e가 `prediction-svg`를 보므로 통과해야 한다.

- [ ] **Step 7: 커밋**

```bash
git add frontend/src/api/congestion.ts frontend/src/components/PredictionChart.tsx frontend/tests/PredictionChart.test.tsx
git commit -m "feat(fe): pick a prediction day with date tabs"
```

---

## 마무리 확인

- [ ] `cd backend && .venv/bin/python -m pytest -q` — 전부 통과
- [ ] `cd frontend && npm test && npm run type-check && npm run build` — 전부 통과
- [ ] `cd frontend && npx playwright test` — 2건 통과
- [ ] `git log --oneline develop..HEAD` — 커밋이 태스크 단위로 쪼개져 있고 Claude co-author 트레일러가 없음
- [ ] 2단계(MMCA 과거 대리값 탭)는 이 계획의 범위가 아니다 — 별 PR
