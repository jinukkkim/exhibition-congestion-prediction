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

# 아래 셋과 "클램프 없음"이 롤링 오리진으로 확정된 값이다. 임의로 바꾸지 말 것 —
# scripts/backtest_mmca_prediction.py 를 돌려서 근거를 다시 만든 뒤에 바꾼다.
# (그 아래 둘은 여기 해당하지 않는다. 백테스트가 스윕하지 않으며 근거가 다르다 —
# 각자의 주석 참고. "넷" 이라고만 적혀 있던 동안에는 다섯 줄이 한 문단 아래
# 늘어서 있어 뒤의 둘도 백테스트로 잠긴 값처럼 읽혔다.)
PROFILE_WINDOW_DAYS = 14      # 7일 63.5% / 14일 64.0% / 21일 63.4% / 28일 63.4%
ANCHOR_WINDOW_MINUTES = 120   # 오전고정 59.7% / 60분 63.7% / 120분 64.0% / 오늘전체 63.0%
RAMP_MINUTES = 90             # 램프없음 59.2% / 30분 62.7% / 90분 64.0% / 180분 63.1%

# 평행이동을 계산해도 되는 최소 판독 수. 단위는 개수지만 재는 것은 **시간**이라,
# collector 의 MMCA_POLL_MINUTES 가 움직이면 함께 움직여야 한다:
#
#     (MIN_ANCHOR_OBSERVATIONS - 1) x MMCA_POLL_MINUTES = 앵커가 요구하는 관측 시간
#
# 3 이었고, 그 값은 10분 격자에서 "20분치(10:00·10:10·10:20)를 본 뒤에 켠다"는
# 뜻이었다. 격자가 10 -> 1 -> 2 로 바뀌는 동안 3 이 그대로 남아 뜻이 20분에서
# 4분으로 줄었다. 11 은 */2 에서 그 20분을 그대로 복원한 값이다(10:00~10:20).
# 새 모델링 주장이 아니라 이전 동작의 복원이라 백테스트가 필요 없다.
#
# 게이트가 실제로 구속하는 상황은 둘뿐이다. 개관 직후(10:04~10:20)와, 창
# (ANCHOR_WINDOW_MINUTES) 이 통째로 비워질 만큼 긴 수집 장애 뒤의 복구다. 앞은
# 매일 걸리지만 2026-09-03 실측에서 그 시간대는 전 방이 여유라 3개든 11개든
# 편차가 같았고(차이 0.00), 뒤는 아직 일어난 적이 없다(실측 최악 공백 9분).
#
# 그래도 되돌린 이유는 그 두 번째 상황의 크기다. 같은 날 하루를 */2 로 모사해
# "최근 3개 평균" 과 "최근 11개 평균" 을 모든 시점에서 비교하면 중위 0.000 이지만
# 12.2% 의 시점에서 0.5등급 이상, 최대 1.909등급 어긋난다 — 그리고 그 편차는
# 남은 하루 곡선 **전체**에 더해진다. 3 개가 2분 간격이면 4분 안에 몰려 있어
# 사실상 한 번의 관측이고, 그 순간이 왕복 잡음이면 곡선이 통째로 밀린다.
#
# 부수 효과로 범례도 정직해진다: anchored(= "예측 (오늘 반영)")가 판독 4분치가
# 아니라 20분치를 근거로 켜진다.
MIN_ANCHOR_OBSERVATIONS = 11

MIN_SAMPLE_DAYS = 3


def build_profile(rows) -> dict[tuple[str, int, int], float]:
    """(방, 요일, 시각) -> 평균 등급(0.0~3.0).

    최빈값이 아니라 평균인 이유: 평행이동이 연속값 산술을 요구하고, 차트의
    yOf(tier) 가 이미 소수를 받는다. 평균 기반 + 평행이동(47.4%)이 최빈값
    단독(44.8%)을 이겼다.

    **날짜별로 먼저 평균을 내고 그 평균들을 평균낸다.** 셀 안의 판독을 통째로
    평균내면 판독 수가 가중치가 되고, 판독 수는 관측이 아니라 수집 간격이
    정한다 — 즉 MMCA_POLL_MINUTES 를 바꾸는 것만으로 예측이 바뀐다. 실제로
    바뀌었다: 10 → 1 이 된 뒤 1분 격자 날은 시각당 판독이 10분 격자 날의
    10배다. 창(PROFILE_WINDOW_DAYS=14)에는 요일마다 두 날이 들어가므로,
    2026-09-03 방 1006 의 13시 셀은 60판독 대 2026-08-27 의 6판독 — 최근
    하루가 가중치의 91% 를 먹어 14일 창이 요일별로 "가장 최근 1일"로 붕괴한다.
    백테스트가 7일(63.5%)·21일(63.4%) 대신 14일(64.0%)을 고른 근거가 그대로
    무효가 되는 자리다.

    같은 이유로 하루 안의 불균등 표본도 같이 막힌다. 부분 라운드와 수집 장애로
    실제로 흔하다 — 2026-09-03 방 1006 은 같은 날 안에서 시각당 판독이 20~60
    개로 흔들렸다. 이쪽은 격자가 다 1분으로 채워진 뒤에도 남는다.

    실질적인 차이는 격자가 섞인 셀에만 나타난다. 2026-09-03 기준 14일 창의
    479셀 실측: 407셀이 완전히 동일하고, 움직이는 72셀은 두 무리로 갈린다.

      1분 격자가 섞인 요일(목) 48셀 — 최대 1.155, 중위 0.374, 0.5 이상 15셀
      10분 격자끼리인 그 밖 24셀 — 최대 0.108, 중위 0.037, 0.5 이상 0셀

    최대는 방 1006 목 16시의 2.74 → 1.58 이다. 통째 평균은 그 시각을 "붐빔에
    가깝다"고 말하는데 근거는 목요일 두 날 중 촘촘히 수집한 하루뿐이고, 다른
    목요일은 0.17 이었다. 뒤 무리(≤0.108)가 곧 위에서 말한 하루 안 불균등의
    잔여분이다 — 실재하지만 등급을 바꾸지 않는 크기다.

    그래서 백테스트로는 이 고침의 이득을 볼 수 없다 — 데이터가 거의 다 10분
    격자라 판독 수가 이미 날짜별로 고르고, 위 407셀이 곧 그 항등이다. 프로덕션
    설정(14일/120분/90분/보정)의 합계 정확도는 59.8% → 59.6% 로, 이득 없이
    비용만 재고 있는 수치다. 네 상수의 순위는 그대로다(14일 3/5, 90분 3/5,
    보정 있음 5/5) — 앵커 창만 120분과 240분이 59.6% 로 붙었으니, 1분 데이터가
    2주 쌓이면 그때 ANCHOR_WINDOW_MINUTES 를 다시 재는 것이 맞다.

    ponytail: 하루 한 표라 판독이 하나뿐인 날도 온전한 날과 같은 무게를 갖는다.
    창에 요일별 두 날뿐이라 그런 날은 50% 를 먹는다 (통째 평균이었다면 1/n).
    셀·날짜별 최소 판독수 게이트는 두지 않았다 — MIN_SAMPLE_DAYS 가 이미 방
    단위로 걸러 주고, 이 게이트가 필요할 만큼 짧은 날-셀이 예측을 실제로
    틀리게 한 사례가 아직 없다. 생기면 그때 재 볼 것.
    """
    by_day: dict[tuple[str, int, int], dict[date, list[int]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for row in rows:
        if row.congestion_nm is None:
            continue
        rank = CONGESTION_RANKS.get(row.congestion_nm)
        if rank is None:
            continue
        key = (row.space_code, row.observed_at.weekday(), row.observed_at.hour)
        by_day[key][row.observed_at.date()].append(rank)
    return {
        key: sum(sum(ranks) / len(ranks) for ranks in days.values()) / len(days)
        for key, days in by_day.items()
    }


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


# 램프의 출발점을 만드는 마크 격자와 평균 창(분). 프론트 lib/resample.ts 의
# BUCKET_MINUTES / MMCA_WINDOW_MINUTES 와 같은 값이어야 한다 — 실선의 마지막
# 점이 그 마크에서 그 창으로 낸 평균이고, 점선은 같은 값에서 출발해야 이음매의
# 좌표뿐 아니라 기울기까지 맞는다. 한쪽만 바꾸면 점선이 이어 붙은 자리에서
# 엉뚱한 방향으로 떠난다.
SEAM_BUCKET_MINUTES = 10
SEAM_WINDOW_MINUTES = 20


def seam(
    rows,
    bucket_minutes: int = SEAM_BUCKET_MINUTES,
    window_minutes: int | None = None,
) -> dict[str, tuple[int, float]]:
    """방별 (마크 시각, 그 마크의 평균 등급). 램프가 여기서 출발한다.

    마지막 판독 하나가 아니라 마크 평균인 이유는 둘이다.

    하나는 잡음이다. 판독 하나는 관측 하나가 아니라 순간 하나다 — 2026-09-03
    실측에서 전이의 34% 가 2분 이하만 유지되고 37% 가 3분 안에 되돌아갔다. 그런
    순간에서 출발하면 90분 램프 **전체**가 그 잡음을 물고 간다.

    다른 하나는 프론트와의 이음매다. 차트는 마크 평균을 그리고 점선을 실선의
    마지막 점에 다시 잇는다(MmcaRoomChartCard 의 predPoints). 여기서 생판독을
    쓰면 이음매의 좌표는 프론트가 맞춰 주지만 램프의 기울기는 다른 값에서
    계산돼, 점선이 이은 자리에서 어긋난 방향으로 출발한다.

    `bucket_minutes` 는 마지막 판독을 어느 마크로 내릴지, `window_minutes` 는
    그 마크에서 몇 분을 평균낼지다. 창을 주지 않으면 SEAM_WINDOW_MINUTES 를
    쓴다. 둘 다 백테스트가 스윕하기 위해 인자로 열려 있고 — 스크립트가 로직을
    재구현하면 근거가 프로덕션 코드와 갈라진다 — 프로덕션은 기본값을 쓴다.
    `bucket_minutes=0` 은 마지막 판독 하나(옛 동작)다.

    스윕 결과(프로덕션 설정 14일/120분/90분/보정, n=33,797):

        생판독(0)  59.3%  MAE 0.49
        5분        59.3%  MAE 0.49
        10분       59.3%  MAE 0.49
        20분       58.3%  MAE 0.50
        30분       58.4%  MAE 0.50

    앞의 셋이 **완전히 동일**한 것은 스냅샷이 거의 다 10분 격자여서다 — 백테스트
    창(2026-08-09~08-25)의 모든 날이 10분 마크당 판독 1개라 어떤 평균도 그
    하나를 그대로 돌려준다. 즉 이 표는 이득을 재지 못하고 **한계만 잰다**:
    20분부터 −1.0%p 로 꺾이므로 10분은 그 아래로 안전하다. 이득이 나타나는
    자리는 마크에 판독이 여럿인 격자(*/2 는 5개)이고, 그건 아직 스냅샷에 없다.
    2주 뒤 다시 돌릴 것 — build_profile 의 날짜별 가중과 같은 사정이다.
    """
    by_room: dict[str, list] = defaultdict(list)
    for row in rows:
        if row.congestion_nm is None:
            continue
        if CONGESTION_RANKS.get(row.congestion_nm) is None:
            continue
        by_room[row.space_code].append(row)

    out: dict[str, tuple[int, float]] = {}
    for code, room_rows in by_room.items():
        last = max(room_rows, key=lambda r: r.observed_at)
        last_minutes = last.observed_at.hour * 60 + last.observed_at.minute
        if bucket_minutes <= 0:
            out[code] = (last_minutes, float(CONGESTION_RANKS[last.congestion_nm]))
            continue
        window = SEAM_WINDOW_MINUTES if window_minutes is None else window_minutes
        mark = round(last_minutes / bucket_minutes) * bucket_minutes
        # 프론트 resample 과 같은 반개구간 [mark - w, mark + w) — 마크 사이
        # 정중앙에 떨어지는 판독이 두 마크에 겹쳐 들어가지 않게 한다.
        ranks = [
            CONGESTION_RANKS[r.congestion_nm]
            for r in room_rows
            if -window <= (r.observed_at.hour * 60 + r.observed_at.minute) - mark < window
        ]
        out[code] = (mark, sum(ranks) / len(ranks))
    return out


class CurvePoint(NamedTuple):
    minutes: int   # 자정부터의 분 — 프론트 minutesOfDay 와 같은 단위
    tier: float    # 0.0~3.0, 곡선을 그리는 값
    label: str     # round(tier) 의 등급명, 툴팁용


def _clamp_tier(value: float) -> float:
    return max(0.0, min(3.0, value))


def predict_tier(
    cell: float,
    shift: float,
    current: float | None,
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
    last: tuple[int, float] | None = None,
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
        points.append(point(last_minutes, last_rank))

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
