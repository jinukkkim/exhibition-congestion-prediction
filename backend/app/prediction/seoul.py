"""서울시 혼잡도(연속값) 예측의 프리미티브.

MMCA 쪽(`mmca.py`)과 형태가 같다 — 이동 창 프로파일 + 오늘 실측 앵커 평행이동
+ 램프. 다만 이쪽은 4단계 순서형이 아니라 인구수 연속값이고 관이 하나뿐이라
방(space_code) 축이 없다. 그래서 공유하지 않고 따로 둔다.

GradientBoostingRegressor 를 걷어낸 이유는 측정 결과다: 피처가 (요일, 시각,
공휴일) 뿐이고 학습 창이 전체 기간이라 계절 수준 이동을 표현할 방법이 없었다.
2026년 8월 초(목 11~13시 3,292명)에서 9월(2,250명)로 내려온 뒤에도 전 기간
평균을 내놓아 영업시간 판독의 97%를 과대예측했다(평균 +416명).

아래 상수는 롤링 오리진으로 확정된 값이다. 임의로 바꾸지 말 것 —
scripts/backtest_seoul_prediction.py 를 돌려서 근거를 다시 만든 뒤에 바꾼다.
"""

from datetime import date, datetime
from typing import NamedTuple

PROFILE_WINDOW_DAYS = 7        # 7일 168 / 14일 173 / 21일 176 / 28일 180
# 온종일(= 가장 긴 영업일보다 길어 개장~현재 전체). 30분 177 / 60분 172 /
# 120분 172 / 240분 170 / 690분 168. MMCA 는 120분이 이겼다 — 그쪽은 4단계
# 순서형이라 최근 판독이 곧 신호지만, 이쪽 인구수는 밴드가 굵고 완만해서
# 짧은 창일수록 밴드 잡음만 크게 잡힌다.
ANCHOR_WINDOW_MINUTES = 690
# 90분과 180분이 동점이다(둘 다 MAE 168, 창별 승리 2:2). MMCA 와 같은 값으로
# 둔다 — 같은 모양의 두 예측이 서로 다른 램프를 쓸 이유가 없고, 180분은 오늘
# 마지막 실측을 3시간 붙들고 있어 곡선이 예측처럼 읽히지 않는다.
RAMP_MINUTES = 90
# 5분 수집이라 30분어치. 창 안에 판독이 이보다 적으면(수집 장애, 개장 직후)
# 앵커를 잡지 않는다 — 한두 판독의 잡음이 하루 곡선 전체를 밀어 올린다.
MIN_ANCHOR_OBSERVATIONS = 6


class Anchor(NamedTuple):
    """앵커 창의 (실측 평균, 같은 시각들의 프로파일 평균).

    두 평균을 **같은 시각 집합** 위에서 잡는 것이 핵심이다 (mmca.today_shift 와
    같은 이유): 시간대마다 수준이 크게 다르므로 집합이 어긋나면 편차가 시간대
    효과를 잘못 빨아들인다.

    차이를 어떻게 쓸지(덧셈/비율)는 predict_value 가 정한다 — 백테스트가 두
    방식을 같은 앵커 위에서 비교해야 하므로 여기서 고르지 않는다.
    """

    observed: float
    expected: float


def build_profile(rows) -> dict[tuple[int, int], float]:
    """(요일, 시각) -> 평균 인구수. 창 자르기는 호출자가 한다."""
    buckets: dict[tuple[int, int], list[float]] = {}
    for row in rows:
        buckets.setdefault((row.observed_at.weekday(), row.observed_at.hour), []).append(
            row.population_avg
        )
    return {key: sum(values) / len(values) for key, values in buckets.items()}


def today_anchor(
    profile: dict[tuple[int, int], float],
    rows,
    now: datetime,
    anchor_minutes: int = ANCHOR_WINDOW_MINUTES,
) -> Anchor | None:
    """최근 `anchor_minutes` 의 실측이 프로파일보다 얼마나 높은지/낮은지.

    `anchor_minutes` 는 백테스트가 창 길이를 스윕하기 위한 것이다 — 프로덕션은
    기본값을 쓴다. 스크립트가 로직을 재구현하면 근거가 프로덕션 코드와 갈라진다.
    """
    observed: list[float] = []
    expected: list[float] = []
    for row in rows:
        age_minutes = (now - row.observed_at).total_seconds() / 60
        if not 0 <= age_minutes <= anchor_minutes:
            continue
        cell = profile.get((row.observed_at.weekday(), row.observed_at.hour))
        if cell is None:
            # 비교 기준이 없는 판독은 양쪽 평균에서 함께 빠져야 한다.
            continue
        observed.append(row.population_avg)
        expected.append(cell)
    if len(observed) < MIN_ANCHOR_OBSERVATIONS:
        return None
    return Anchor(sum(observed) / len(observed), sum(expected) / len(expected))


def predict_value(
    cell: float,
    anchor: Anchor | None,
    current: float | None,
    minutes_ahead: int,
    ramp_minutes: int = RAMP_MINUTES,
    ratio: bool = True,
) -> float:
    """한 시점의 예측 인구수. `curve` 와 백테스트 스크립트가 공유하는 프리미티브.

    `anchor` 가 None 이면 프로파일 그대로다(미래 날짜, 또는 앵커 관측이 모자란
    이른 아침). `current` 가 None 이면 램프가 없다 — 출발할 실측이 없다.

    `ratio` 는 백테스트가 비율 보정과 덧셈 보정을 같은 앵커 위에서 비교하기
    위한 것이다 — 프로덕션은 기본값(비율)을 쓴다. 비율인 이유는 이 데이터의
    어긋남이 수준의 배율로 오기 때문이다: 성수기와 지금이 시간대별로 나란히
    30% 차이 나지, 온종일 같은 인원수만큼 차이 나지 않는다.
    """
    adjusted = cell
    if anchor is not None:
        if ratio:
            adjusted = cell * (anchor.observed / anchor.expected) if anchor.expected else cell
        else:
            adjusted = cell + (anchor.observed - anchor.expected)
    adjusted = max(0.0, adjusted)
    if current is None:
        return adjusted
    weight = 1.0 if ramp_minutes == 0 else min(1.0, minutes_ahead / ramp_minutes)
    return max(0.0, (1 - weight) * current + weight * adjusted)


# 프론트 nationalMuseumBusinessHours.ts 와 같은 표다 (그쪽은 getDay 라 수=3·토=6,
# 여기는 weekday 라 수=2·토=5).
OPEN_MINUTES = 9 * 60 + 30
_LONG_CLOSE_DAYS = {2, 5}  # 수·토는 21:00 폐관
LONGEST_DAY_MINUTES = 21 * 60 - OPEN_MINUTES  # 690 — ANCHOR_WINDOW_MINUTES 의 근거


def close_minutes(day: date) -> int:
    return 21 * 60 if day.weekday() in _LONG_CLOSE_DAYS else 17 * 60 + 30


def in_business_hours(stamp: datetime) -> bool:
    """수집기는 24시간 돌지만 예측은 영업시간만 본다.

    앵커를 심야 판독으로 잡으면 안 되기 때문이다 — 값이 낮고 평평한 구간이라
    비율이 낮 시간대를 대표하지 못한다. 백테스트도 같은 게이트로 측정했으므로
    (scripts/backtest_seoul_prediction.py) 여기서 넓히면 근거가 갈라진다.
    """
    minutes = stamp.hour * 60 + stamp.minute
    return OPEN_MINUTES <= minutes <= close_minutes(stamp.date())


def curve(
    profile: dict[tuple[int, int], float],
    day: date,
    anchor: Anchor | None = None,
    last: tuple[int, float] | None = None,
    ramp_minutes: int = RAMP_MINUTES,
) -> list[dict]:
    """하루치 정시 곡선. `last` 가 있으면 그 점에서 출발해 램프로 전이한다.

    `baseline` 은 보정 전 프로파일 값이다 — 페이로드의 필드 이름이 그것을 뜻해
    왔고, 앵커가 얼마나 밀었는지 응답만 보고도 읽힌다.

    실선이 이미 그린 구간(= `last` 이전)은 담지 않는다. 램프의 minutes_ahead 가
    음수가 되는 구간이기도 하다.
    """
    points: list[dict] = []
    for hour in range(24):
        cell = profile.get((day.weekday(), hour))
        if cell is None:
            continue
        minutes = hour * 60
        if last is not None and minutes <= last[0]:
            continue
        points.append(
            {
                "hour": hour,
                "baseline": cell,
                "model": predict_value(
                    cell,
                    anchor,
                    None if last is None else last[1],
                    0 if last is None else minutes - last[0],
                    ramp_minutes=ramp_minutes,
                ),
            }
        )
    return points
