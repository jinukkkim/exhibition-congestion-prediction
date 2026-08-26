"""MMCA 순서형 혼잡도 예측.

서울시 쪽(`baseline.py`, `model.py`, `batch.py`)과 공유하는 것이 없다 — 그쪽은
연속값 `population_avg` 전용이고 이쪽은 4단계 순서형 전용이다. 학습 모델이
없는 것은 게을러서가 아니라 측정 결과다: 학습 기간을 7일→21일로 늘렸을 때
이득이 +8.4%p → +8.5%p로 평평했고, 순서형 기대값(45.2%)은 최빈값(57.7%)보다
나빴다. 근거는 스펙 문서의 "근거" 절에 있다.
"""

from collections import defaultdict
from collections.abc import Sequence
from datetime import date, datetime
from typing import NamedTuple

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


def today_shift(
    profile: dict[tuple[str, int, int], float],
    rows,
    now: datetime,
    anchor_minutes: int = ANCHOR_WINDOW_MINUTES,
) -> dict[str, float]:
    """방별 평행이동량 = (최근 120분 실측 평균) − (같은 시각들의 프로파일 평균).

    `anchor_minutes` 는 백테스트가 창 길이를 스윕하기 위한 것이다 — 프로덕션은
    기본값을 쓴다. 스크립트가 로직을 재구현하면 근거가 프로덕션 코드와 갈라진다.

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
        if not 0 <= age_minutes <= anchor_minutes:
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


class CurvePoint(NamedTuple):
    minutes: int   # 자정부터의 분 — 프론트 minutesOfDay 와 같은 단위
    tier: float    # 0.0~3.0, 곡선을 그리는 값
    label: str     # round(tier) 의 등급명, 툴팁용


def _clamp_tier(value: float) -> float:
    return max(0.0, min(3.0, value))


def predict_tier(
    cell: float,
    shift: float,
    current: int | None,
    minutes_ahead: int,
    ramp_minutes: int = RAMP_MINUTES,
) -> float:
    """한 시점의 예측 등급. `curve` 와 백테스트 스크립트가 공유하는 프리미티브.

    `current` 가 None 이면 램프가 없다(미래 날짜) — 평행이동한 프로파일 그대로.
    있으면 마지막 실측값에서 `ramp_minutes` 에 걸쳐 프로파일로 선형 전이한다.

    별도 함수인 이유: scripts/backtest_mmca_prediction.py 가 이 식을 스윕해야
    하고, 스크립트가 재구현하면 근거가 프로덕션 코드와 갈라진다.
    """
    anchored = _clamp_tier(cell + shift)
    if current is None:
        return anchored
    weight = 1.0 if ramp_minutes == 0 else min(1.0, minutes_ahead / ramp_minutes)
    return _clamp_tier((1 - weight) * current + weight * anchored)


def curve(
    profile: dict[tuple[str, int, int], float],
    space_code: str,
    day: date,
    hours: Sequence[int],
    shift: float = 0.0,
    last: tuple[int, int] | None = None,
    ramp_minutes: int = RAMP_MINUTES,
) -> list[CurvePoint]:
    """예측 곡선. `last` 가 있으면 그 점에서 출발해 90분에 걸쳐 프로파일로 전이한다.

    램프는 장식이 아니다. 없이 곧바로 프로파일 값으로 점프하면 근거리 정확도가
    77.3% → 59.0% 로 18%p 떨어진다. 30분 이내에서는 "직전 값 유지"가 프로파일
    보다 훨씬 강하고(+25.6%p vs +8.6%p), 두 방법의 실측 교차점이 90분이다.

    `ramp_minutes` 는 백테스트가 램프 길이를 스윕하기 위한 것이다 — 프로덕션은
    기본값을 쓴다. 0 을 주면 램프 없음(즉시 프로파일로 점프)이 된다.
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
        points.append(
            point(
                minutes,
                predict_tier(
                    cell,
                    shift,
                    None if last is None else last[1],
                    0 if last is None else minutes - last[0],
                    ramp_minutes=ramp_minutes,
                ),
            )
        )

    return points
