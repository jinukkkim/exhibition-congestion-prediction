# MMCA 예측 차트 (파란 점선) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MMCA 전시실 차트에 파란 점선 예측선을 추가한다 — 오늘 탭은 마지막 실측점에서 이어지고, 미래 탭은 회색 지난주선과 함께 점선만 그린다.

**Architecture:** 최근 14일 `(방, 요일, 시각)` 평균 등급 프로파일을 요청 시점에 SQL로 집계하고, 오늘 탭에서는 최근 120분 실측과의 편차만큼 곡선을 평행이동한 뒤, 마지막 실측점에서 90분에 걸쳐 프로파일로 선형 전이한다. 학습·배치·모델 파일이 없다 — 카운팅과 산수뿐이다.

**Tech Stack:** FastAPI + SQLAlchemy + Redis (백엔드), React + SVG + Vitest (프론트), pytest

**Spec:** `docs/superpowers/specs/2026-08-26-mmca-prediction-chart-design.md`

## Global Constraints

- 네 상수는 실측으로 확정된 값이다. 임의로 바꾸지 말 것:
  `PROFILE_WINDOW_DAYS = 14`, `ANCHOR_WINDOW_MINUTES = 120`, `RAMP_MINUTES = 90`, 편차 클램프 없음.
- 등급 순서는 `["여유", "보통", "약간 붐빔", "붐빔"]` (0~3). 프론트 `MmcaRoomChartCard.tsx`의 `TIERS`와 동일해야 한다.
- `observed_at`은 항상 Asia/Seoul 벽시계로 저장된 naive datetime이다. 프로덕션은 `Etc/UTC`라 naive `datetime.now()`를 쓰면 KST 오전 내내 전날로 떨어진다. 반드시 `ZoneInfo("Asia/Seoul")`로 고정할 것.
- `congestion_nm is None`은 "전시 없음"이며 혼잡도 0이 아니다. 프로파일·편차 계산에서 **제외**한다.
- 예측선은 `CHART_BLUE` + `strokeDasharray="5 5"`. 새 색 토큰을 만들지 않는다.
- 예측에는 **면(area)을 채우지 않는다.**
- UI에 정확도 숫자를 적지 않는다.
- 커밋 메시지에 Claude/Anthropic 공동 저자 트레일러를 넣지 않는다 (`CLAUDE.md`).

## File Structure

| 파일 | 책임 |
|---|---|
| `backend/app/prediction/mmca.py` (신규) | 프로파일 집계, 오늘 편차, 램프 곡선. 순수 함수만 — 세션/캐시를 모른다 |
| `backend/app/schemas.py` (수정) | `MmcaPredictionPoint`, `MmcaRoomPrediction` |
| `backend/app/cache.py` (수정) | `set_mmca_prediction` / `get_mmca_prediction` |
| `backend/app/routes/mmca.py` (수정) | `GET /mmca/prediction` — DB 조회 + 캐시 + 조립 |
| `backend/tests/test_prediction_mmca.py` (신규) | 순수 함수 단위 테스트 |
| `backend/tests/test_routes_mmca_prediction.py` (신규) | 라우트 테스트 |
| `backend/scripts/backtest_mmca_prediction.py` (신규) | 롤링 오리진 백테스트. CI 아님 |
| `frontend/src/api/mmca.ts` (수정) | 타입 + `fetchMmcaPrediction` |
| `frontend/src/pages/MmcaPage.tsx` (수정) | 예측 폴링, 방별 분배, 낡은 주석 수정 |
| `frontend/src/components/MmcaRoomChartCard.tsx` (수정) | 점선 렌더 |
| `frontend/tests/MmcaRoomChartCard.test.tsx` (수정) | 점선 테스트 |

---

### Task 1: 프로파일 집계

**Files:**
- Create: `backend/app/prediction/mmca.py`
- Test: `backend/tests/test_prediction_mmca.py`

**Interfaces:**
- Consumes: `app.models.RawMmcaCongestion`
- Produces:
  - `CONGESTION_RANKS: dict[str, int]`, `RANK_LABELS: list[str]`
  - `PROFILE_WINDOW_DAYS: int`, `ANCHOR_WINDOW_MINUTES: int`, `RAMP_MINUTES: int`, `MIN_ANCHOR_OBSERVATIONS: int`, `MIN_SAMPLE_DAYS: int`
  - `build_profile(rows) -> dict[tuple[str, int, int], float]`
  - `sample_days(rows) -> dict[str, int]`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/tests/test_prediction_mmca.py`:

```python
from datetime import datetime

from app.prediction.mmca import (
    MIN_SAMPLE_DAYS,
    build_profile,
    sample_days,
)


class Row:
    """RawMmcaCongestion 스텁 — 순수 함수는 ORM 인스턴스를 요구하지 않는다."""

    def __init__(self, space_code: str, observed_at: str, congestion_nm: str | None):
        self.space_code = space_code
        self.observed_at = datetime.fromisoformat(observed_at)
        self.congestion_nm = congestion_nm


def test_build_profile_averages_ranks_per_room_weekday_hour():
    # 2026-08-01 은 토요일(weekday=5)
    rows = [
        Row("A", "2026-08-01T15:00:00", "붐빔"),        # rank 3
        Row("A", "2026-08-01T15:10:00", "약간 붐빔"),   # rank 2
        Row("A", "2026-08-08T15:00:00", "붐빔"),        # rank 3
    ]

    profile = build_profile(rows)

    assert profile[("A", 5, 15)] == (3 + 2 + 3) / 3


def test_build_profile_skips_rows_with_no_exhibition():
    rows = [
        Row("A", "2026-08-01T15:00:00", "여유"),
        Row("A", "2026-08-01T15:10:00", None),
    ]

    profile = build_profile(rows)

    # None 은 "전시 없음"이고 혼잡도 0 이 아니다 — 평균에 섞이면 안 된다.
    assert profile[("A", 5, 15)] == 0.0


def test_build_profile_separates_rooms_and_hours():
    rows = [
        Row("A", "2026-08-01T15:00:00", "붐빔"),
        Row("B", "2026-08-01T15:00:00", "여유"),
        Row("A", "2026-08-01T16:00:00", "보통"),
    ]

    profile = build_profile(rows)

    assert profile[("A", 5, 15)] == 3.0
    assert profile[("B", 5, 15)] == 0.0
    assert profile[("A", 5, 16)] == 1.0


def test_sample_days_counts_distinct_dates_per_room():
    rows = [
        Row("A", "2026-08-01T15:00:00", "여유"),
        Row("A", "2026-08-01T16:00:00", "보통"),   # 같은 날 — 1일로 센다
        Row("A", "2026-08-02T15:00:00", "여유"),
        Row("B", "2026-08-01T15:00:00", "여유"),
    ]

    assert sample_days(rows) == {"A": 2, "B": 1}


def test_sample_days_ignores_rows_with_no_exhibition():
    rows = [
        Row("A", "2026-08-01T15:00:00", "여유"),
        Row("A", "2026-08-02T15:00:00", None),
    ]

    assert sample_days(rows) == {"A": 1}


def test_min_sample_days_is_three():
    # 전시 교체 직후 재개된 방을 걸러내는 게이트. 스펙 확정값.
    assert MIN_SAMPLE_DAYS == 3
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && .venv/bin/python -m pytest tests/test_prediction_mmca.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.prediction.mmca'`

- [ ] **Step 3: 최소 구현을 쓴다**

`backend/app/prediction/mmca.py`:

```python
"""MMCA 순서형 혼잡도 예측.

서울시 쪽(`baseline.py`, `model.py`, `batch.py`)과 공유하는 것이 없다 — 그쪽은
연속값 `population_avg` 전용이고 이쪽은 4단계 순서형 전용이다. 학습 모델이
없는 것은 게을러서가 아니라 측정 결과다: 학습 기간을 7일→21일로 늘렸을 때
이득이 +8.4%p → +8.5%p로 평평했고, 순서형 기대값(45.2%)은 최빈값(57.7%)보다
나빴다. 근거는 스펙 문서의 "근거" 절에 있다.
"""

from collections import defaultdict
from datetime import date, datetime

# 프론트 MmcaRoomChartCard.tsx 의 TIERS 와 같은 순서여야 한다.
RANK_LABELS: list[str] = ["여유", "보통", "약간 붐빔", "붐빔"]
CONGESTION_RANKS: dict[str, int] = {label: i for i, label in enumerate(RANK_LABELS)}

# 아래 넷은 롤링 오리진으로 확정된 값이다. 임의로 바꾸지 말 것 —
# scripts/backtest_mmca_prediction.py 를 돌려서 근거를 다시 만든 뒤에 바꾼다.
PROFILE_WINDOW_DAYS = 14      # 7일 63.5% / 14일 64.0% / 21일 63.4% / 28일 63.4%
ANCHOR_WINDOW_MINUTES = 120   # 오전고정 59.7% / 60분 63.7% / 120분 64.0% / 오늘전체 63.0%
RAMP_MINUTES = 90             # 램프없음 59.2% / 30분 62.7% / 90분 64.0% / 180분 63.1%
MIN_ANCHOR_OBSERVATIONS = 3
MIN_SAMPLE_DAYS = 3


def build_profile(rows) -> dict[tuple[str, int, int], float]:
    """(방, 요일, 시각) -> 평균 등급(0.0~3.0).

    최빈값이 아니라 평균인 이유: 평행이동이 연속값 산술을 요구하고, 차트의
    yOf(tier) 가 이미 소수를 받는다. 평균 기반 + 평행이동(47.4%)이 최빈값
    단독(44.8%)을 이겼다.
    """
    buckets: dict[tuple[str, int, int], list[int]] = defaultdict(list)
    for row in rows:
        if row.congestion_nm is None:
            continue
        rank = CONGESTION_RANKS.get(row.congestion_nm)
        if rank is None:
            continue
        key = (row.space_code, row.observed_at.weekday(), row.observed_at.hour)
        buckets[key].append(rank)
    return {key: sum(values) / len(values) for key, values in buckets.items()}


def sample_days(rows) -> dict[str, int]:
    """방별로 판독이 있는 날의 수. 방 단위 값이며 셀 단위가 아니다.

    셀 단위로 게이트하면 안 된다 — 14일 창에서 (방, 요일, 시각) 셀 하나의
    독립일수는 구조적으로 2일이라 전부 걸러진다.
    """
    days: dict[str, set[date]] = defaultdict(set)
    for row in rows:
        if row.congestion_nm is None:
            continue
        days[row.space_code].add(row.observed_at.date())
    return {code: len(dates) for code, dates in days.items()}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd backend && .venv/bin/python -m pytest tests/test_prediction_mmca.py -v`
Expected: PASS (6 passed)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/prediction/mmca.py backend/tests/test_prediction_mmca.py
git commit -m "feat(prediction): MMCA 요일x시간 프로파일 집계

최근 14일 (방, 요일, 시각) 평균 등급을 낸다. 최빈값이 아니라 평균인 이유는
평행이동이 연속값 산술을 요구하기 때문이다.

방 단위 sample_days 도 함께 낸다 - 셀 단위로 게이트하면 14일 창에서 셀당
독립일수가 2일이라 전부 걸러진다."
```

---

### Task 2: 오늘 편차 (평행이동량)

**Files:**
- Modify: `backend/app/prediction/mmca.py`
- Test: `backend/tests/test_prediction_mmca.py`

**Interfaces:**
- Consumes: `build_profile`, `ANCHOR_WINDOW_MINUTES`, `MIN_ANCHOR_OBSERVATIONS` (Task 1)
- Produces: `today_shift(profile, rows, now) -> dict[str, float]`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/tests/test_prediction_mmca.py`에 추가 (import 줄에 `today_shift` 추가):

```python
def test_today_shift_is_observed_minus_profile_on_the_same_timestamps():
    # 토요일 15시 프로파일이 2.0 인데 오늘 실측이 1.0 이면 편차 -1.0
    profile = {("A", 5, 15): 2.0}
    rows = [
        Row("A", "2026-08-01T15:00:00", "보통"),      # rank 1
        Row("A", "2026-08-01T15:10:00", "보통"),      # rank 1
        Row("A", "2026-08-01T15:20:00", "보통"),      # rank 1
    ]

    shift = today_shift(profile, rows, now=datetime.fromisoformat("2026-08-01T15:20:00"))

    assert shift == {"A": -1.0}


def test_today_shift_uses_only_the_last_120_minutes():
    # 12시 셀은 프로파일 0.0, 15시 셀은 2.0.
    # now=15:20 이면 12:00 판독은 200분 전이라 앵커 창(120분) 밖이다.
    profile = {("A", 5, 12): 0.0, ("A", 5, 15): 2.0}
    rows = [
        Row("A", "2026-08-01T12:00:00", "붐빔"),      # 창 밖 — 무시돼야 한다
        Row("A", "2026-08-01T15:00:00", "보통"),      # rank 1
        Row("A", "2026-08-01T15:10:00", "보통"),
        Row("A", "2026-08-01T15:20:00", "보통"),
    ]

    shift = today_shift(profile, rows, now=datetime.fromisoformat("2026-08-01T15:20:00"))

    # 창 안 판독만 쓰면 (1+1+1)/3 - 2.0 = -1.0
    assert shift == {"A": -1.0}


def test_today_shift_omits_rooms_below_the_minimum_observations():
    profile = {("A", 5, 15): 2.0}
    rows = [
        Row("A", "2026-08-01T15:00:00", "보통"),
        Row("A", "2026-08-01T15:10:00", "보통"),
    ]

    shift = today_shift(profile, rows, now=datetime.fromisoformat("2026-08-01T15:10:00"))

    # 2개는 MIN_ANCHOR_OBSERVATIONS(3) 미만 — 개관 직후 편차는 노이즈다.
    assert shift == {}


def test_today_shift_omits_rooms_whose_cells_are_missing_from_the_profile():
    profile: dict[tuple[str, int, int], float] = {}
    rows = [
        Row("A", "2026-08-01T15:00:00", "보통"),
        Row("A", "2026-08-01T15:10:00", "보통"),
        Row("A", "2026-08-01T15:20:00", "보통"),
    ]

    shift = today_shift(profile, rows, now=datetime.fromisoformat("2026-08-01T15:20:00"))

    # 비교 기준이 없으면 편차를 만들 수 없다.
    assert shift == {}


def test_today_shift_is_not_clamped():
    # 클램프는 측정에서 손해였다(없음 64.0% / ±1.0 63.3% / ±0.5 61.9%).
    profile = {("A", 5, 15): 0.0}
    rows = [
        Row("A", "2026-08-01T15:00:00", "붐빔"),
        Row("A", "2026-08-01T15:10:00", "붐빔"),
        Row("A", "2026-08-01T15:20:00", "붐빔"),
    ]

    shift = today_shift(profile, rows, now=datetime.fromisoformat("2026-08-01T15:20:00"))

    assert shift == {"A": 3.0}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && .venv/bin/python -m pytest tests/test_prediction_mmca.py -v`
Expected: FAIL — `ImportError: cannot import name 'today_shift'`

- [ ] **Step 3: 최소 구현을 쓴다**

`backend/app/prediction/mmca.py`에 추가:

```python
def today_shift(
    profile: dict[tuple[str, int, int], float],
    rows,
    now: datetime,
) -> dict[str, float]:
    """방별 평행이동량 = (최근 120분 실측 평균) − (같은 시각들의 프로파일 평균).

    두 평균을 **같은 시각 집합** 위에서 잡는 것이 핵심이다. 시간대마다
    프로파일 수준이 크게 다르므로(10시 −1.0 → 15시 +0.9), 집합이 어긋나면
    편차가 시간대 효과를 잘못 빨아들인다.

    계수는 1.0 고정이다 — 데이터에서 추정하면 창별로 1.05/1.02/0.10/0.52/0.50
    으로 흔들리고, 1.0 고정이 추정값보다 성능이 좋았다. 클램프도 하지 않는다.
    """
    observed: dict[str, list[int]] = defaultdict(list)
    expected: dict[str, list[float]] = defaultdict(list)

    for row in rows:
        if row.congestion_nm is None:
            continue
        rank = CONGESTION_RANKS.get(row.congestion_nm)
        if rank is None:
            continue
        age_minutes = (now - row.observed_at).total_seconds() / 60
        if not 0 <= age_minutes <= ANCHOR_WINDOW_MINUTES:
            continue
        cell = profile.get((row.space_code, row.observed_at.weekday(), row.observed_at.hour))
        if cell is None:
            # 비교 기준이 없는 판독은 양쪽 평균에서 함께 빠져야 한다.
            continue
        observed[row.space_code].append(rank)
        expected[row.space_code].append(cell)

    return {
        code: sum(values) / len(values) - sum(expected[code]) / len(expected[code])
        for code, values in observed.items()
        if len(values) >= MIN_ANCHOR_OBSERVATIONS
    }
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd backend && .venv/bin/python -m pytest tests/test_prediction_mmca.py -v`
Expected: PASS (11 passed)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/prediction/mmca.py backend/tests/test_prediction_mmca.py
git commit -m "feat(prediction): 오늘 편차로 프로파일 곡선을 평행이동

최근 120분 실측과 같은 시각들의 프로파일 평균 차이를 낸다. 두 평균을 같은
시각 집합에서 잡아야 편차가 시간대 효과를 빨아들이지 않는다.

계수는 1.0 고정이고 클램프하지 않는다 - 둘 다 측정 결과다."
```

---

### Task 3: 램프 곡선

**Files:**
- Modify: `backend/app/prediction/mmca.py`
- Test: `backend/tests/test_prediction_mmca.py`

**Interfaces:**
- Consumes: `build_profile`, `today_shift`, `RAMP_MINUTES`, `RANK_LABELS` (Task 1·2)
- Produces:
  - `CurvePoint` — `NamedTuple(minutes: int, tier: float, label: str)`
  - `curve(profile, space_code, day, hours, shift=0.0, last=None) -> list[CurvePoint]`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/tests/test_prediction_mmca.py`에 추가 (import 줄에 `RAMP_MINUTES`, `curve` 추가):

```python
from datetime import date


def test_curve_without_last_reading_is_the_shifted_profile():
    # 미래 날짜 — 실측도 편차도 없다.
    profile = {("A", 5, 14): 1.0, ("A", 5, 15): 2.0}

    points = curve(profile, "A", date(2026, 8, 1), hours=[14, 15])

    assert [(p.minutes, p.tier) for p in points] == [(14 * 60, 1.0), (15 * 60, 2.0)]
    assert [p.label for p in points] == ["보통", "약간 붐빔"]


def test_curve_applies_the_shift():
    profile = {("A", 5, 15): 2.0}

    points = curve(profile, "A", date(2026, 8, 1), hours=[15], shift=-1.0)

    assert points[0].tier == 1.0


def test_curve_starts_at_the_last_reading_so_the_dashes_join_the_solid_line():
    profile = {("A", 5, 15): 3.0}
    # 마지막 실측: 14:30 에 여유(0)
    points = curve(profile, "A", date(2026, 8, 1), hours=[15], last=(14 * 60 + 30, 0))

    # 첫 점은 정확히 마지막 실측점이어야 한다 — 이음매가 없어야 한다.
    assert points[0].minutes == 14 * 60 + 30
    assert points[0].tier == 0.0


def test_curve_ramps_linearly_over_90_minutes():
    profile = {("A", 5, 15): 3.0, ("A", 5, 16): 3.0}
    # 마지막 실측 14:30 여유(0). 15:00 은 30분 뒤 → w = 30/90 = 1/3
    # 16:00 은 90분 뒤 → w = 1.0 (프로파일 그대로)
    points = curve(profile, "A", date(2026, 8, 1), hours=[15, 16], last=(14 * 60 + 30, 0))

    by_minutes = {p.minutes: p.tier for p in points}
    assert by_minutes[15 * 60] == (1 - 1 / 3) * 0 + (1 / 3) * 3.0
    assert by_minutes[16 * 60] == 3.0


def test_curve_drops_hours_at_or_before_the_last_reading():
    profile = {("A", 5, 13): 1.0, ("A", 5, 15): 2.0}

    points = curve(profile, "A", date(2026, 8, 1), hours=[13, 15], last=(14 * 60, 0))

    # 13시는 이미 실선이 그린 구간이다 — 점선이 겹쳐 그리면 안 된다.
    assert [p.minutes for p in points] == [14 * 60, 15 * 60]


def test_curve_skips_hours_missing_from_the_profile():
    profile = {("A", 5, 15): 2.0}

    points = curve(profile, "A", date(2026, 8, 1), hours=[14, 15, 16])

    assert [p.minutes for p in points] == [15 * 60]


def test_curve_clamps_into_the_tier_range():
    profile = {("A", 5, 15): 3.0}

    points = curve(profile, "A", date(2026, 8, 1), hours=[15], shift=2.0)

    # 3.0 + 2.0 = 5.0 → 3.0 으로 잘린다. 라벨도 범위를 벗어나면 안 된다.
    assert points[0].tier == 3.0
    assert points[0].label == "붐빔"


def test_curve_clamps_negative_shift():
    profile = {("A", 5, 15): 1.0}

    points = curve(profile, "A", date(2026, 8, 1), hours=[15], shift=-3.0)

    assert points[0].tier == 0.0
    assert points[0].label == "여유"


def test_ramp_minutes_is_ninety():
    # 실측 최적값. 30분은 근거리에서 지속성보다 나쁘고, 180분은 원거리에서 나쁘다.
    assert RAMP_MINUTES == 90
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && .venv/bin/python -m pytest tests/test_prediction_mmca.py -v`
Expected: FAIL — `ImportError: cannot import name 'curve'`

- [ ] **Step 3: 최소 구현을 쓴다**

`backend/app/prediction/mmca.py`의 import를 `from typing import NamedTuple`, `from collections.abc import Sequence`로 보강하고 추가:

```python
class CurvePoint(NamedTuple):
    minutes: int   # 자정부터의 분 — 프론트 minutesOfDay 와 같은 단위
    tier: float    # 0.0~3.0, 곡선을 그리는 값
    label: str     # round(tier) 의 등급명, 툴팁용


def _clamp_tier(value: float) -> float:
    return max(0.0, min(3.0, value))


def curve(
    profile: dict[tuple[str, int, int], float],
    space_code: str,
    day: date,
    hours: Sequence[int],
    shift: float = 0.0,
    last: tuple[int, int] | None = None,
) -> list[CurvePoint]:
    """예측 곡선. `last` 가 있으면 그 점에서 출발해 90분에 걸쳐 프로파일로 전이한다.

    램프는 장식이 아니다. 없이 곧바로 프로파일 값으로 점프하면 근거리 정확도가
    77.3% → 59.0% 로 18%p 떨어진다. 30분 이내에서는 "직전 값 유지"가 프로파일
    보다 훨씬 강하고(+25.6%p vs +8.6%p), 두 방법의 실측 교차점이 90분이다.
    """

    def point(minutes: int, tier: float) -> CurvePoint:
        tier = _clamp_tier(tier)
        return CurvePoint(minutes=minutes, tier=tier, label=RANK_LABELS[round(tier)])

    points: list[CurvePoint] = []
    if last is not None:
        last_minutes, last_rank = last
        # 실선의 끝점을 그대로 첫 점으로 둔다 — 이음매를 없앤다.
        points.append(point(last_minutes, float(last_rank)))

    for hour in hours:
        minutes = hour * 60
        if last is not None and minutes <= last[0]:
            # 이미 실선이 그린 구간 — 점선이 겹치지 않는다.
            continue
        cell = profile.get((space_code, day.weekday(), hour))
        if cell is None:
            continue
        anchored = _clamp_tier(cell + shift)
        if last is None:
            points.append(point(minutes, anchored))
            continue
        weight = min(1.0, (minutes - last[0]) / RAMP_MINUTES)
        points.append(point(minutes, (1 - weight) * last[1] + weight * anchored))

    return points
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd backend && .venv/bin/python -m pytest tests/test_prediction_mmca.py -v`
Expected: PASS (20 passed)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/prediction/mmca.py backend/tests/test_prediction_mmca.py
git commit -m "feat(prediction): 90분 램프로 실측점에서 프로파일로 전이

점선의 첫 점을 마지막 실측점으로 두어 실선과의 이음매를 없애고, 90분에 걸쳐
평행이동한 프로파일로 선형 전이한다.

램프는 장식이 아니다 - 없이 곧바로 프로파일로 점프하면 근거리 정확도가
77.3%에서 59.0%로 떨어진다."
```

---

### Task 4: 스키마 · 캐시 · 라우트

**Files:**
- Modify: `backend/app/schemas.py`
- Modify: `backend/app/cache.py`
- Modify: `backend/app/routes/mmca.py`
- Test: `backend/tests/test_routes_mmca_prediction.py` (create)

**Interfaces:**
- Consumes: `build_profile`, `sample_days`, `today_shift`, `curve`, `CurvePoint`, `PROFILE_WINDOW_DAYS`, `MIN_SAMPLE_DAYS`, `CONGESTION_RANKS` (Task 1~3)
- Produces:
  - `schemas.MmcaPredictionPoint(observed_at: str, tier: float, label: str)`
  - `schemas.MmcaRoomPrediction(space_code, space_nm, anchored, sample_days, points)`
  - `cache.set_mmca_prediction(venue, day, payload, ttl)` / `cache.get_mmca_prediction(venue, day)`
  - `GET /mmca/prediction?venue=&date=`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/tests/test_routes_mmca_prediction.py`:

```python
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import fakeredis
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base
from app.models import RawMmcaCongestion

# app/routes/mmca.py 의 _SEOUL_TZ 와 같은 기준. CI 는 UTC 라 naive now() 를
# 쓰면 KST 오전 내내 날짜가 하루 어긋난다.
_SEOUL_TZ = ZoneInfo("Asia/Seoul")


@pytest.fixture
def client(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    import app.cache
    import app.routes.mmca

    monkeypatch.setattr(app.cache, "r", fakeredis.FakeRedis(decode_responses=True))
    monkeypatch.setattr(app.routes.mmca, "SessionLocal", Session)

    from app.main import app as fastapi_app

    yield TestClient(fastapi_app), Session


def _seed(Session, *, space_code="MMCA-SPACE-2001", days=14, hour=15, level="붐빔"):
    """오늘 이전 `days` 일 동안 매일 같은 시각에 같은 등급을 심는다."""
    today = datetime.now(_SEOUL_TZ).replace(tzinfo=None).date()
    with Session() as session:
        for offset in range(1, days + 1):
            day = today - timedelta(days=offset)
            for minute in (0, 10, 20):
                session.add(
                    RawMmcaCongestion(
                        observed_at=datetime.combine(day, datetime.min.time()).replace(
                            hour=hour, minute=minute
                        ),
                        space_code=space_code,
                        space_nm="1전시실",
                        congestion_nm=level,
                    )
                )
        session.commit()
    return today


def test_unknown_venue_is_rejected(client):
    api, _ = client

    response = api.get("/mmca/prediction?venue=nowhere")

    assert response.status_code == 400


def test_no_data_returns_an_empty_list_not_an_error(client):
    api, _ = client

    response = api.get("/mmca/prediction?venue=gwacheon")

    # 예측할 데이터가 없는 것은 오류가 아니다 — /mmca/rooms 처럼 503 을 내면
    # 프론트가 차트 전체를 에러로 바꾼다.
    assert response.status_code == 200
    assert response.json() == []


def test_rooms_below_the_sample_day_gate_are_omitted(client):
    api, Session = client
    _seed(Session, days=2)

    response = api.get("/mmca/prediction?venue=gwacheon")

    assert response.status_code == 200
    assert response.json() == []


def test_future_date_returns_the_unanchored_profile(client):
    api, Session = client
    today = _seed(Session, days=14, hour=15, level="붐빔")
    target = today + timedelta(days=1)

    response = api.get(f"/mmca/prediction?venue=gwacheon&date={target.isoformat()}")

    body = response.json()
    assert len(body) == 1
    room = body[0]
    assert room["space_code"] == "MMCA-SPACE-2001"
    assert room["anchored"] is False
    assert room["sample_days"] == 14
    # 14일 내내 붐빔이었으니 프로파일은 3.0
    point = next(p for p in room["points"] if p["observed_at"].endswith("T15:00:00"))
    assert point["tier"] == 3.0
    assert point["label"] == "붐빔"


def test_todays_curve_is_anchored_to_todays_readings(client):
    api, Session = client
    today = _seed(Session, days=14, hour=15, level="붐빔")
    # 오늘 같은 시각에 여유가 3개 — 프로파일(3.0)보다 훨씬 한산하다.
    with Session() as session:
        for minute in (0, 10, 20):
            session.add(
                RawMmcaCongestion(
                    observed_at=datetime.combine(today, datetime.min.time()).replace(
                        hour=15, minute=minute
                    ),
                    space_code="MMCA-SPACE-2001",
                    space_nm="1전시실",
                    congestion_nm="여유",
                )
            )
        session.commit()

    response = api.get(f"/mmca/prediction?venue=gwacheon&date={today.isoformat()}")

    room = response.json()[0]
    assert room["anchored"] is True
    # 첫 점은 마지막 실측점(15:20 여유)이어야 한다 — 실선과의 이음매.
    assert room["points"][0]["observed_at"].endswith("T15:20:00")
    assert room["points"][0]["tier"] == 0.0
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && .venv/bin/python -m pytest tests/test_routes_mmca_prediction.py -v`
Expected: FAIL — 404 (라우트 없음)

- [ ] **Step 3: 스키마를 추가한다**

`backend/app/schemas.py`의 `MmcaDailyLogPoint` 아래에 추가:

```python
class MmcaPredictionPoint(BaseModel):
    # /mmca/daily 와 같은 형태 — 프론트가 minutesOfDay 를 그대로 재사용한다.
    observed_at: str
    # 0.0~3.0. 정수가 아닌 이유는 평행이동과 램프가 소수를 만들고, 차트의
    # yOf(tier) 가 이미 소수를 받기 때문이다.
    tier: float
    label: str


class MmcaRoomPrediction(BaseModel):
    space_code: str
    space_nm: str | None
    # 오늘 실측으로 곡선을 평행이동했는지. 미래 날짜와 개관 직후에는 False.
    anchored: bool
    # 14일 창 안에서 판독이 있는 날의 수. 방 단위이며 셀 단위가 아니다.
    sample_days: int
    points: list[MmcaPredictionPoint]
```

- [ ] **Step 4: 캐시 헬퍼를 추가한다**

`backend/app/cache.py`에 추가:

```python
# 오늘 곡선은 최근 120분 실측에 매달려 있어 판독마다 바뀐다. 프론트가 60초로
# 폴링하므로(MmcaPage 의 POLL_INTERVAL_MS) TTL 도 60초로 맞춘다 — 수집 주기인
# 600초로 잡으면 새 판독이 들어와도 최대 10분간 곡선이 안 움직인다.
MMCA_PREDICTION_TTL_TODAY_SECONDS = 60
# 미래 날짜는 편차가 없어 하루 안에서 정적이다.
MMCA_PREDICTION_TTL_FUTURE_SECONDS = 3600


def set_mmca_prediction(venue: str, day: str, payload: list[dict], ttl: int) -> None:
    r.set(f"mmca:prediction:{venue}:{day}", json.dumps(payload), ex=ttl)


def get_mmca_prediction(venue: str, day: str) -> list[dict] | None:
    raw = r.get(f"mmca:prediction:{venue}:{day}")
    return json.loads(raw) if raw else None
```

- [ ] **Step 5: 라우트를 추가한다**

`backend/app/routes/mmca.py` — import에 아래를 더한다 (`datetime`, `timedelta`,
`Query`, `MMCA_SPACE_NAMES`, `settings`, `SessionLocal`, `RawMmcaCongestion`은
이미 이 파일에 있다):

```python
from app.cache import (
    MMCA_PREDICTION_TTL_FUTURE_SECONDS,
    MMCA_PREDICTION_TTL_TODAY_SECONDS,
    get_mmca_prediction,
    set_mmca_prediction,
)
from app.prediction.mmca import (
    CONGESTION_RANKS,
    MIN_SAMPLE_DAYS,
    PROFILE_WINDOW_DAYS,
    build_profile,
    curve,
    sample_days,
    today_shift,
)
from app.schemas import MmcaPredictionPoint, MmcaRoomPrediction
```

파일 끝에 추가:

```python
# 영업시간의 최대 범위. 수/토는 21시 폐관, 그 외는 18시다. 여기서 좁히지 않고
# 프로파일에 셀이 있는 시각만 나가게 둔다 — 화요일 19시 셀은 애초에 없으므로
# 자기 제한적이고, 최종 클립은 프론트의 open/close 가 한다.
_PREDICTION_HOURS = range(10, 22)


@router.get("/mmca/prediction", response_model=list[MmcaRoomPrediction])
def mmca_prediction(
    venue: str, date: str | None = Query(default=None)
) -> list[MmcaRoomPrediction]:
    codes = settings.mmca_venue_space_codes.get(venue)
    if codes is None:
        raise HTTPException(status_code=400, detail=f"unknown venue: {venue}")

    now = datetime.now(_SEOUL_TZ).replace(tzinfo=None)
    if date is None:
        target = now.date()
    else:
        try:
            target = datetime.strptime(date, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(status_code=400, detail="date must be in YYYY-MM-DD format")

    cached = get_mmca_prediction(venue, target.isoformat())
    if cached is not None:
        return [MmcaRoomPrediction(**room) for room in cached]

    is_today = target == now.date()
    window_start = now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(
        days=PROFILE_WINDOW_DAYS
    )
    day_start = datetime.combine(now.date(), datetime.min.time())

    with SessionLocal() as session:
        profile_rows = (
            session.query(RawMmcaCongestion)
            .filter(
                RawMmcaCongestion.space_code.in_(codes),
                RawMmcaCongestion.observed_at >= window_start,
                RawMmcaCongestion.observed_at < day_start,
                RawMmcaCongestion.congestion_nm.isnot(None),
            )
            .all()
        )
        today_rows = (
            session.query(RawMmcaCongestion)
            .filter(
                RawMmcaCongestion.space_code.in_(codes),
                RawMmcaCongestion.observed_at >= day_start,
                RawMmcaCongestion.congestion_nm.isnot(None),
            )
            .order_by(RawMmcaCongestion.observed_at.asc())
            .all()
            if is_today
            else []
        )

    profile = build_profile(profile_rows)
    days_by_code = sample_days(profile_rows)
    shifts = today_shift(profile, today_rows, now=now) if is_today else {}

    latest: dict[str, tuple[int, int]] = {}
    for row in today_rows:
        rank = CONGESTION_RANKS.get(row.congestion_nm)
        if rank is None:
            continue
        latest[row.space_code] = (row.observed_at.hour * 60 + row.observed_at.minute, rank)

    names = {row.space_code: row.space_nm for row in profile_rows if row.space_nm}
    result: list[MmcaRoomPrediction] = []
    for code in sorted(codes):
        if days_by_code.get(code, 0) < MIN_SAMPLE_DAYS:
            continue
        shift = shifts.get(code)
        points = curve(
            profile,
            code,
            target,
            hours=_PREDICTION_HOURS,
            shift=shift or 0.0,
            last=latest.get(code) if is_today else None,
        )
        if not points:
            continue
        result.append(
            MmcaRoomPrediction(
                space_code=code,
                space_nm=names.get(code) or MMCA_SPACE_NAMES.get(code),
                anchored=shift is not None,
                sample_days=days_by_code[code],
                points=[
                    MmcaPredictionPoint(
                        observed_at=datetime.combine(
                            target, datetime.min.time()
                        ).replace(hour=p.minutes // 60, minute=p.minutes % 60).isoformat(),
                        tier=p.tier,
                        label=p.label,
                    )
                    for p in points
                ],
            )
        )

    set_mmca_prediction(
        venue,
        target.isoformat(),
        [room.model_dump() for room in result],
        MMCA_PREDICTION_TTL_TODAY_SECONDS if is_today else MMCA_PREDICTION_TTL_FUTURE_SECONDS,
    )
    return result
```

- [ ] **Step 6: 통과를 확인한다**

Run: `cd backend && .venv/bin/python -m pytest tests/test_routes_mmca_prediction.py -v`
Expected: PASS (5 passed)

- [ ] **Step 7: 전체 백엔드 스위트를 돌린다**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: 기존 테스트가 전부 그대로 통과한다 (회귀 없음)

- [ ] **Step 8: 커밋**

```bash
git add backend/app/schemas.py backend/app/cache.py backend/app/routes/mmca.py \
        backend/tests/test_routes_mmca_prediction.py
git commit -m "feat(api): GET /mmca/prediction

요청 시점에 집계한다 - 14일 x 15실이면 ~1만 행으로 SQLite에서 사소하고,
오늘 편차는 10분마다 바뀌어 일 1회 배치와 맞지 않는다.

TTL을 날짜로 가른다: 오늘 60초(프론트 폴 주기와 동일), 미래 3600초.
데이터가 없으면 503이 아니라 빈 배열이다 - 예측 없음은 오류가 아니다."
```

---

### Task 5: 프론트 API 계층과 페이지 배선

**Files:**
- Modify: `frontend/src/api/mmca.ts`
- Modify: `frontend/src/pages/MmcaPage.tsx:33-36` (낡은 주석), `:57-72` (폴링 추가)
- Test: `frontend/tests/MmcaPage.test.tsx`

**Interfaces:**
- Consumes: `GET /mmca/prediction` (Task 4)
- Produces:
  - `MmcaPredictionPoint`, `MmcaRoomPrediction` 타입
  - `fetchMmcaPrediction(venue, date) -> Promise<MmcaRoomPrediction[]>`
  - `MmcaRoomChartCard`에 `prediction` prop 전달

- [ ] **Step 1: 실패하는 테스트를 쓴다**

먼저 `frontend/tests/MmcaPage.test.tsx`를 읽어 이 파일이 이미 쓰는 fetch 목
방식을 확인한다 — `/mmca/rooms`와 `/mmca/daily`가 이미 목킹돼 있고, 새 요청이
그 목을 통과하지 못하면 기존 테스트가 깨진다. **기존 목에 `/mmca/prediction`
분기를 먼저 더한 뒤** 아래 테스트를 추가한다.

필요한 import: `waitFor`(`@testing-library/react`), `vi`(`vitest`),
`todayString`(`../src/lib/date`). 이미 있으면 다시 넣지 않는다.

```typescript
it("fetches the prediction for the selected date, not the last-week proxy date", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      calls.push(url);
      if (url.includes("/mmca/prediction")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      if (url.includes("/mmca/rooms")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    })
  );

  render(<MmcaPage venue="gwacheon" />);
  await waitFor(() => expect(calls.some((c) => c.includes("/mmca/prediction"))).toBe(true));

  // chartDate 는 미래 탭에서 D-7 로 옮겨진 값이다. 예측은 selectedDate 를
  // 써야 한다 — chartDate 를 쓰면 D-7 의 예측을 그린다.
  const predictionCall = calls.find((c) => c.includes("/mmca/prediction"))!;
  expect(predictionCall).toContain(`date=${todayString()}`);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd frontend && npx vitest run tests/MmcaPage.test.tsx`
Expected: FAIL — `/mmca/prediction` 요청이 없다

- [ ] **Step 3: API 계층을 추가한다**

`frontend/src/api/mmca.ts` 끝에 추가:

```typescript
export interface MmcaPredictionPoint {
  observed_at: string;
  // 0.0~3.0 의 소수. 평행이동과 90분 램프가 등급 사이 값을 만들고, 차트의
  // yOf 가 이미 소수를 받는다 — 반올림하면 정보가 줄어든다.
  tier: number;
  label: string;
}

export interface MmcaRoomPrediction {
  space_code: string;
  space_nm: string | null;
  anchored: boolean;
  sample_days: number;
  points: MmcaPredictionPoint[];
}

export async function fetchMmcaPrediction(
  venue: MmcaVenue,
  date: string
): Promise<MmcaRoomPrediction[]> {
  const res = await fetch(`/mmca/prediction?venue=${venue}&date=${date}`);
  if (!res.ok) {
    throw new Error(`failed to fetch MMCA prediction: ${res.status}`);
  }
  return res.json();
}
```

- [ ] **Step 4: 페이지를 배선한다**

`frontend/src/pages/MmcaPage.tsx` — 낡은 주석(33~36행)을 교체한다:

```typescript
  // 미래 탭의 회색선은 지난주 같은 요일의 실제 기록이다(대리값). 그 위에
  // 파란 점선으로 예측을 겹친다 — 예측은 selectedDate 기준이고, chartDate 는
  // 회색선을 가져오는 날짜(미래 탭에서 D-7)라 예측에 쓰면 안 된다.
  const chartDate = selectedDate === today ? today : shiftDate(selectedDate, -7);
```

`lastWeekPoll` 아래에 폴링을 추가한다:

```typescript
  // 오늘 탭은 곡선이 최근 120분 실측에 매달려 있어 판독마다 바뀌므로 계속
  // 폴링한다. 미래 탭은 편차가 없어 정적이라 한 번 받고 멈춘다.
  const predictionPoll = usePolledFetch(
    () => fetchMmcaPrediction(venue, selectedDate),
    { intervalMs: POLL_INTERVAL_MS, stopWhenLoaded: !isTodayTab },
    [venue, selectedDate]
  );
```

`daily` 등을 꺼내는 곳 아래에 추가:

```typescript
  // 예측은 없어도 차트가 그려져야 한다 — trendError 에 넣지 않는다.
  const predictionByCode = new Map(
    (predictionPoll.data ?? []).map((room) => [room.space_code, room])
  );
```

`MmcaRoomChartCard`에 prop을 넘긴다 (159~165행 근처):

```typescript
                prediction={predictionByCode.get(room.space_code) ?? null}
```

import에 `fetchMmcaPrediction`과 `type MmcaRoomPrediction`을 추가한다.

- [ ] **Step 5: 통과를 확인한다**

Run: `cd frontend && npx vitest run tests/MmcaPage.test.tsx`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/api/mmca.ts frontend/src/pages/MmcaPage.tsx frontend/tests/MmcaPage.test.tsx
git commit -m "feat(fe): MMCA 예측을 받아 방별로 분배

예측은 selectedDate 기준이다 - chartDate 는 미래 탭에서 D-7 로 옮겨진 값이라
그걸 쓰면 D-7 의 예측을 그린다.

MMCA 에 예측 모델이 없다던 주석을 고친다."
```

---

### Task 6: 점선 렌더

**Files:**
- Modify: `frontend/src/components/MmcaRoomChartCard.tsx`
- Test: `frontend/tests/MmcaRoomChartCard.test.tsx`

**Interfaces:**
- Consumes: `MmcaRoomPrediction` (Task 5)
- Produces: `data-testid="mmca-room-chart-prediction-line"`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`frontend/tests/MmcaRoomChartCard.test.tsx`에 추가:

```typescript
import type { MmcaRoomPrediction } from "../src/api/mmca";

function prediction(
  points: [string, number][],
  overrides: Partial<MmcaRoomPrediction> = {}
): MmcaRoomPrediction {
  return {
    space_code: "MMCA-SPACE-2001",
    space_nm: "1전시실",
    anchored: true,
    sample_days: 14,
    points: points.map(([observed_at, tier]) => ({
      observed_at,
      tier,
      label: ["여유", "보통", "약간 붐빔", "붐빔"][Math.round(tier)],
    })),
    ...overrides,
  };
}

describe("MmcaRoomChartCard 예측 점선", () => {
  it("draws a dashed prediction line", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[]}
        prediction={prediction([
          ["2026-07-15T14:30:00", 2],
          ["2026-07-15T16:00:00", 3],
        ])}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    const line = screen.getByTestId("mmca-room-chart-prediction-line");
    expect(line).toHaveAttribute("stroke-dasharray");
    // 실선과 같은 파랑 — 같은 축의 같은 대상이고 확정/예상만 다르다.
    expect(line).toHaveAttribute("stroke", "#0071E3");
  });

  it("does not fill an area under the prediction", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[]}
        prediction={prediction([
          ["2026-07-15T14:30:00", 2],
          ["2026-07-15T16:00:00", 3],
        ])}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    // 실선의 그라디언트 면은 "쌓인 사실"을 뜻한다. 예측에 같은 면을 주면
    // 확정된 것처럼 읽힌다.
    expect(screen.getByTestId("mmca-room-chart-prediction-line")).toHaveAttribute("fill", "none");
    expect(screen.queryByTestId("mmca-room-chart-prediction-area")).not.toBeInTheDocument();
  });

  it("renders the chart normally when there is no prediction", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[
          dailyPoint("2026-07-15T14:00:00", { "MMCA-SPACE-2001": "보통" }),
          dailyPoint("2026-07-15T14:30:00", { "MMCA-SPACE-2001": "약간 붐빔" }),
        ]}
        prediction={null}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    expect(screen.getByTestId("mmca-room-chart")).toBeInTheDocument();
    expect(
      screen.queryByTestId("mmca-room-chart-prediction-line")
    ).not.toBeInTheDocument();
  });

  it("skips a single-point prediction — one point cannot make a path", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[]}
        prediction={prediction([["2026-07-15T14:30:00", 2]])}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    expect(
      screen.queryByTestId("mmca-room-chart-prediction-line")
    ).not.toBeInTheDocument();
  });

  it("clips prediction points outside business hours", () => {
    render(
      <MmcaRoomChartCard
        room={makeRoom()}
        daily={[]}
        prediction={prediction([
          ["2026-07-15T14:30:00", 2],
          ["2026-07-15T16:00:00", 3],
          ["2026-07-15T20:00:00", 3], // CLOSE(18:00) 밖 — 잘려야 한다
        ])}
        open={OPEN}
        close={CLOSE}
        nowMinutes={WITHIN_HOURS}
        now={NOW}
        isOpenToday
      />
    );

    const d = screen.getByTestId("mmca-room-chart-prediction-line").getAttribute("d")!;
    // 20:00 이 살아 있으면 x 가 CHART_WIDTH(480) 를 넘는 좌표가 나온다.
    const xs = [...d.matchAll(/([\d.]+)\s[\d.]+/g)].map((m) => Number(m[1]));
    expect(Math.max(...xs)).toBeLessThanOrEqual(480);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd frontend && npx vitest run tests/MmcaRoomChartCard.test.tsx`
Expected: FAIL — `prediction` prop이 없고 testid를 찾지 못한다

- [ ] **Step 3: 컴포넌트를 수정한다**

`frontend/src/components/MmcaRoomChartCard.tsx`:

import에 타입을 더한다:

```typescript
import type { MmcaDailyLogPoint, MmcaRoomPrediction, MmcaRoomStatus } from "../api/mmca";
```

`roomPoints` 아래에 변환 함수를 더한다:

```typescript
// 예측 점은 이미 방별로 갈라져 있고 tier 가 소수다 — roomPoints 처럼 등급명을
// 인덱스로 되돌릴 필요가 없다.
function predictionPoints(
  prediction: MmcaRoomPrediction | null,
  open: number,
  close: number
): Point[] {
  return (prediction?.points ?? [])
    .map((p) => ({ minutes: minutesOfDay(p.observed_at), tier: p.tier, label: p.label }))
    .filter((p) => p.minutes >= open && p.minutes <= close);
}
```

props에 추가:

```typescript
  prediction = null,
```

```typescript
  prediction?: MmcaRoomPrediction | null;
```

`lastWeekLinePath` 계산 아래에 추가:

```typescript
  const predPoints = predictionPoints(prediction, open, close);
  const predXy = predPoints.length > 1 ? toXY(predPoints, open, close) : [];
  const predictionPath = predPoints.length > 1 ? smoothPath(predXy) : "";
```

`{linePath && (...)}` 블록 **뒤에** 렌더를 추가한다 (실선 위에 그려지도록):

```tsx
                {predictionPath && (
                  <path
                    data-testid="mmca-room-chart-prediction-line"
                    d={predictionPath}
                    fill="none"
                    stroke={CHART_BLUE}
                    strokeWidth={2.5}
                    strokeDasharray="5 5"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                )}
```

차트 표시 조건에 예측을 더한다 — 예측만 있어도 차트가 보여야 한다. `(linePath || lastWeekLinePath)`를 쓰는 **두 곳**(범례 래퍼, `<svg>` 내부 `<>` 게이트)을 모두 바꾼다:

```typescript
  const hasAnySeries = Boolean(linePath || lastWeekLinePath || predictionPath);
```

범례에 한 줄 추가한다 (`lastWeekLinePath` 범례 뒤):

```tsx
              {predictionPath && (
                <span className="flex items-center gap-1.5">
                  <span
                    className="h-0 w-3 border-t-2 border-dashed"
                    style={{ borderColor: CHART_BLUE }}
                  />
                  {prediction?.anchored ? "예상 (오늘 반영)" : "예상"}
                </span>
              )}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd frontend && npx vitest run tests/MmcaRoomChartCard.test.tsx`
Expected: PASS

- [ ] **Step 5: 전체 프론트 검사를 돌린다**

Run: `cd frontend && npm run type-check && npm test`
Expected: 타입 오류 없음, 전체 스위트 통과 (기존 테스트 회귀 없음)

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/components/MmcaRoomChartCard.tsx frontend/tests/MmcaRoomChartCard.test.tsx
git commit -m "feat(fe): 전시실 차트에 파란 점선 예측선

실선과 같은 CHART_BLUE 에 점선만 다르게 둔다 - 같은 축의 같은 대상이고
확정/예상만 다르기 때문이다. 새 색 토큰을 만들지 않는다.

면은 채우지 않는다. 실선의 그라디언트 면은 쌓인 사실을 뜻하므로 예측에 같은
면을 주면 확정된 것처럼 읽힌다."
```

---

### Task 7: 백테스트 스크립트

**Files:**
- Create: `backend/scripts/backtest_mmca_prediction.py`

**Interfaces:**
- Consumes: `build_profile`, `today_shift`, `curve`, 네 상수 (Task 1~3)
- Produces: 없음 (CLI 스크립트)

이 태스크는 TDD 대상이 아니다 — 검증 도구이며 프로덕션 경로가 아니다. CI에 넣지 않는다(프로덕션 DB 스냅샷이 필요하고 실행이 길다).

- [ ] **Step 1: 스크립트를 쓴다**

`backend/scripts/backtest_mmca_prediction.py`:

```python
"""MMCA 예측의 롤링 오리진 백테스트.

app/prediction/mmca.py 의 네 상수(PROFILE_WINDOW_DAYS / ANCHOR_WINDOW_MINUTES
/ RAMP_MINUTES / 클램프 없음)의 근거를 만드는 스크립트다. 상수를 바꾸려면
먼저 이걸 돌려서 새 근거를 만들 것.

스펙 문서의 수치가 이 스크립트의 출력이어야 한다:
  docs/superpowers/specs/2026-08-26-mmca-prediction-chart-design.md

  python scripts/backtest_mmca_prediction.py [congestion.db]

CI 에 넣지 않는다 — 프로덕션 스냅샷이 필요하고 실행이 길다.
"""

import sqlite3
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))

from app.prediction.mmca import (  # noqa: E402
    ANCHOR_WINDOW_MINUTES,
    CONGESTION_RANKS,
    MIN_ANCHOR_OBSERVATIONS,
    PROFILE_WINDOW_DAYS,
    RAMP_MINUTES,
)

HORIZONS = [10, 20, 30, 60, 90, 120]
TEST_LEN_DAYS = 5


def load(path: str) -> list[tuple[str, datetime, int]]:
    con = sqlite3.connect(path)
    rows = con.execute(
        "select space_code, observed_at, congestion_nm from raw_mmca_congestion "
        "where congestion_nm is not null order by observed_at"
    ).fetchall()
    out = []
    for code, raw, level in rows:
        rank = CONGESTION_RANKS.get(level)
        if rank is None:
            continue
        stamp = datetime.fromisoformat(raw).replace(second=0, microsecond=0)
        # 수집은 10분 그리드에 정렬돼 있다(scheduler.py). 초/마이크로초 편차를
        # 지워야 "정확히 h분 뒤" 조회가 성립한다.
        out.append((code, stamp.replace(minute=stamp.minute // 10 * 10), rank))
    return out


def evaluate(
    data,
    days: list[date],
    test_start: date,
    *,
    train_days: int = PROFILE_WINDOW_DAYS,
    anchor: int | None = ANCHOR_WINDOW_MINUTES,
    ramp: int = RAMP_MINUTES,
    use_shift: bool = True,
    clamp: float | None = None,
) -> tuple[int, int, float] | None:
    by_day: dict[tuple[str, date], dict[datetime, int]] = defaultdict(dict)
    for code, stamp, rank in data:
        by_day[(code, stamp.date())][stamp] = rank

    train = [d for d in data if test_start - timedelta(days=train_days) <= d[1].date() < test_start]
    test_days = [d for d in days if test_start <= d < test_start + timedelta(days=TEST_LEN_DAYS)]
    if len(train) < 300 or not test_days:
        return None

    cells: dict[tuple[str, int, int], list[int]] = defaultdict(list)
    for code, stamp, rank in train:
        cells[(code, stamp.weekday(), stamp.hour)].append(rank)
    profile = {key: sum(v) / len(v) for key, v in cells.items()}

    n = hit = 0
    mae = 0.0
    for (code, day), obs in by_day.items():
        if day not in test_days:
            continue
        times = sorted(obs)
        for i, now in enumerate(times):
            if anchor is None:
                seen = times[: i + 1]
            else:
                seen = [t for t in times[: i + 1] if (now - t).total_seconds() / 60 <= anchor]
            if len(seen) < MIN_ANCHOR_OBSERVATIONS:
                continue
            expected = [profile.get((code, day.weekday(), t.hour)) for t in seen]
            if any(e is None for e in expected):
                continue
            shift = 0.0
            if use_shift:
                shift = sum(obs[t] for t in seen) / len(seen) - sum(expected) / len(expected)
                if clamp is not None:
                    shift = max(-clamp, min(clamp, shift))
            current = obs[now]
            for horizon in HORIZONS:
                target = now + timedelta(minutes=horizon)
                cell = profile.get((code, day.weekday(), target.hour))
                if target not in obs or cell is None:
                    continue
                weight = 1.0 if ramp == 0 else min(1.0, horizon / ramp)
                anchored = max(0.0, min(3.0, cell + shift))
                value = (1 - weight) * current + weight * anchored
                n += 1
                hit += max(0, min(3, round(value))) == obs[target]
                mae += abs(value - obs[target])
    return (n, hit, mae) if n else None


def sweep(data, days, starts, label: str, variants: list[tuple[str, dict]]) -> None:
    print(f"\n{label}")
    print(f"  {'변형':<18}{'정확도':>9}{'MAE':>8}{'n':>9}")
    for name, kwargs in variants:
        total = [0, 0, 0.0]
        for start in starts:
            got = evaluate(data, days, start, **kwargs)
            if not got:
                continue
            total[0] += got[0]
            total[1] += got[1]
            total[2] += got[2]
        if not total[0]:
            print(f"  {name:<18}{'측정 불가':>9}")
            continue
        print(f"  {name:<18}{total[1] / total[0]:>8.1%}{total[2] / total[0]:>8.2f}{total[0]:>9}")


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else "congestion.db"
    data = load(path)
    days = sorted({stamp.date() for _, stamp, _ in data})
    print(f"데이터: {len(data)}행 / {len(days)}일 / {days[0]} ~ {days[-1]}")
    starts = [days[0] + timedelta(days=k) for k in (14, 17, 20, 23, 26)]

    sweep(data, days, starts, "① 앵커 창", [
        ("오늘 전체", {"anchor": None}),
        ("최근 60분", {"anchor": 60}),
        ("최근 120분", {"anchor": 120}),
        ("최근 240분", {"anchor": 240}),
    ])
    sweep(data, days, starts, "② 학습 창", [
        (f"{d}일", {"train_days": d}) for d in (7, 14, 21, 28)
    ])
    sweep(data, days, starts, "③ 램프 길이", [
        ("램프 없음", {"ramp": 0}),
        ("30분", {"ramp": 30}),
        ("90분", {"ramp": 90}),
        ("180분", {"ramp": 180}),
    ])
    sweep(data, days, starts, "④ 편차 클램프", [
        ("보정 없음", {"use_shift": False}),
        ("±0.5", {"clamp": 0.5}),
        ("±1.0", {"clamp": 1.0}),
        ("없음", {"clamp": None}),
    ])


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 프로덕션 스냅샷으로 돌려 스펙 수치를 재현한다**

Run: `cd backend && .venv/bin/python scripts/backtest_mmca_prediction.py congestion.db`

Expected: 스펙 문서의 표와 일치한다 — 앵커 120분 64.0%, 학습 14일 64.0%,
램프 90분 64.0%, 클램프 없음 64.0%가 각 스윕의 최고값. 각 항목의 최적값이
스펙과 다르면 **상수를 바꾸지 말고** 불일치를 보고할 것.

- [ ] **Step 3: 커밋**

```bash
git add backend/scripts/backtest_mmca_prediction.py
git commit -m "test(prediction): MMCA 예측 롤링 오리진 백테스트 스크립트

네 상수의 근거를 재생산한다. 상수를 바꾸려면 먼저 이걸 돌려 새 근거를
만들 것.

CI 에 넣지 않는다 - 프로덕션 스냅샷이 필요하고 실행이 길다."
```

---

## 최종 확인

- [ ] `cd backend && .venv/bin/python -m pytest -q` — 전부 통과
- [ ] `cd frontend && npm run type-check` — 오류 없음
- [ ] `cd frontend && npm test` — 전부 통과
- [ ] `docs/superpowers/specs/2026-08-26-mmca-prediction-chart-design.md`의 "적지 않는 것" 확인 — UI에 정확도 숫자가 없는지, 예측 면이 없는지
- [ ] PR 본문은 한국어로 작성한다. `CONTRIBUTING.md`를 먼저 읽는다
