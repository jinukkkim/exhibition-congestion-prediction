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
    in_window_counts: dict[str, int] = defaultdict(int)

    for row in rows:
        if row.congestion_nm is None:
            continue
        rank = CONGESTION_RANKS.get(row.congestion_nm)
        if rank is None:
            continue
        age_minutes = (now - row.observed_at).total_seconds() / 60
        if not 0 <= age_minutes <= anchor_minutes:
            continue
        # 게이트는 창 안의 판독 개수로 잰다 — 프로파일 셀 유무와 무관하다.
        # 셀이 없어 평균에서 빠지는 판독도 "오늘 이 방이 열려 있었다"는
        # 신호이므로, 게이트를 (양쪽 평균에 쓰인) usable 개수로 잡으면
        # 개관 초반 셀 미스만으로 방 전체가 부당하게 걸러진다.
        in_window_counts[row.space_code] += 1
        cell = profile.get((row.space_code, row.observed_at.weekday(), row.observed_at.hour))
        if cell is None:
            # 비교 기준이 없는 판독은 양쪽 평균에서 함께 빠져야 한다.
            continue
        observed[row.space_code].append(rank)
        expected[row.space_code].append(cell)

    return {
        code: sum(values) / len(values) - sum(expected[code]) / len(expected[code])
        for code, values in observed.items()
        if in_window_counts[code] >= MIN_ANCHOR_OBSERVATIONS
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
