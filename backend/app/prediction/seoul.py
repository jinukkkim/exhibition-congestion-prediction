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


# 램프의 출발점을 만드는 마크 격자와 평균 창(분). 프론트 CongestionCard 의
# resample 이 쓰는 BUCKET_MINUTES 와 그 기본 창(간격의 절반)과 같은 값이어야
# 한다 — 실선의 마지막 점이 그 마크에서 그 창으로 낸 평균이고, 점선은 같은
# 값에서 출발해야 이음매의 좌표뿐 아니라 기울기까지 맞는다.
# MMCA(mmca.py)는 창이 간격보다 넓다 — 4단계 계단을 눕히려는 것이고, 여기
# 인구수는 애초에 계단이 아니라 분리 버킷 그대로다.
SEAM_BUCKET_MINUTES = 10
SEAM_WINDOW_MINUTES = 5


def seam(
    rows,
    bucket_minutes: int = SEAM_BUCKET_MINUTES,
    window_minutes: int | None = None,
) -> tuple[int, float] | None:
    """(마크 시각, 그 마크의 평균 인구수). 램프가 여기서 출발한다. 판독이 없으면 None.

    마지막 판독 하나가 아니라 마크 평균인 이유는 mmca.seam 과 같은 둘이다.

    하나는 밴드다. 인구수는 연속값처럼 보이지만 서울시 API 가 내는 것은 굵은
    구간이라 이 관의 영업시간 판독은 사실상 여섯 단계다(950·1250·1750·2250·
    2750·3250). 2026-08-20~09-06 판독 2,435개로 재면 한 마크의 두 판독이 서로
    다른 밴드에 앉는 경우가 7.2% 고, 그때 차이는 수준의 11%(중앙값)다. 그런
    판독에서 출발하면 램프 90분 **전체**가 밴드 한 칸을 물고 간다.

    다른 하나는 프론트와의 이음매다. 차트는 마크 평균을 그리고 점선을 실선의
    마지막 점에 다시 잇는다(CongestionCard 의 predPoints). 여기서 생판독을 쓰면
    이음매의 좌표는 프론트가 맞춰 주지만 램프의 기울기는 다른 값에서 계산돼,
    점선이 이은 자리에서 어긋난 방향으로 출발한다.

    `bucket_minutes` 는 마지막 판독을 어느 마크로 내릴지, `window_minutes` 는 그
    마크에서 몇 분을 평균낼지다. 둘 다 백테스트가 스윕하기 위해 열려 있고(⑥⑦),
    프로덕션은 기본값을 쓴다. `bucket_minutes=0` 은 마지막 판독 하나(옛 동작)다.

    스윕 결과(프로덕션 설정 7일/690분/90분/비율, n=1,845. 백테스트 ⑥⑦):

        마크 폭(창 5분 고정)      창 폭(마크 10분 고정)
        생판독(0)  MAE 168        5분   MAE 169
        5분        MAE 169        10분  MAE 170
        10분       MAE 169        15분  MAE 171
        20분       MAE 169        20분  MAE 171
        30분       MAE 169        30분  MAE 173

    생판독이 5창 전부에서 1 이긴다(168 대 169, 0.6%). 창을 넓히면 단조 나빠지는
    것도 MMCA 와 같다 — 미래 판독이 아직 없으니 창을 넓히는 것은 잡음 평균이
    아니라 직전 판독을 끌어오는 지연으로 작동한다. 그래서 창은 프론트와 같은
    분리 버킷(간격의 절반)에서 멈춘다.

    그 1 을 내주고 마크 평균을 쓰는 근거는 정확도가 아니라 위의 두 가지다.
    특히 이음매: 생판독이면 점선이 실선의 끝값과 다른 값에서 기울기를 잡는
    경우가 7.2% 인데, 마크 평균이면 0% 다 — 프론트가 같은 마크·같은 창으로
    그 점을 그리기 때문이다.
    """
    if not rows:
        return None
    last = max(rows, key=lambda r: r.observed_at)
    last_minutes = last.observed_at.hour * 60 + last.observed_at.minute
    if bucket_minutes <= 0:
        return (last_minutes, last.population_avg)
    window = SEAM_WINDOW_MINUTES if window_minutes is None else window_minutes
    # JS 의 Math.round 와 같은 규칙(.5 는 위로)이어야 한다 — 파이썬 round 는
    # 짝수로 붙어서 :25 판독이 프론트는 마크 30, 여기는 마크 20 이 된다. 서울시
    # 수집은 */5 라 .5 가 실제로 나온다(MMCA 는 */2 라 나오지 않는다).
    mark = int(last_minutes / bucket_minutes + 0.5) * bucket_minutes
    # 프론트 resample 과 같은 반개구간 [mark - w, mark + w).
    values = [
        r.population_avg
        for r in rows
        if -window <= (r.observed_at.hour * 60 + r.observed_at.minute) - mark < window
    ]
    # 창이 마크 반폭보다 좁으면 마지막 판독조차 창 밖으로 떨어진다 — 백테스트가
    # 창을 스윕하는 이상 도달 가능한 경로다. 그때는 생판독으로 돌아간다.
    if not values:
        values = [last.population_avg]
    return (mark, sum(values) / len(values))


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
