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
