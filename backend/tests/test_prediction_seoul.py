"""seoul.py 프리미티브. 상수의 근거는 scripts/backtest_seoul_prediction.py 에 있다."""

from datetime import date, datetime
from types import SimpleNamespace

import pytest

from app.prediction.seoul import (
    SEAM_BUCKET_MINUTES,
    SEAM_WINDOW_MINUTES,
    Anchor,
    build_profile,
    close_minutes,
    curve,
    in_business_hours,
    predict_value,
    seam,
    today_anchor,
)


def reading(stamp: datetime, value: float):
    return SimpleNamespace(observed_at=stamp, population_avg=value)


def test_build_profile_averages_by_weekday_and_hour():
    rows = [
        reading(datetime(2026, 8, 24, 12, 0), 1000.0),
        reading(datetime(2026, 8, 24, 12, 30), 2000.0),
        reading(datetime(2026, 8, 25, 12, 0), 500.0),
    ]

    profile = build_profile(rows)

    assert profile[(0, 12)] == pytest.approx(1500.0)
    assert profile[(1, 12)] == pytest.approx(500.0)


def test_today_anchor_compares_the_same_hours_on_both_sides():
    """두 평균을 같은 시각 집합에서 잡아야 편차가 시간대 효과를 안 빨아들인다."""
    profile = {(0, 11): 1000.0, (0, 12): 3000.0}
    rows = [reading(datetime(2026, 8, 24, 12, m), 1500.0) for m in range(0, 60, 5)]

    anchor = today_anchor(profile, rows, datetime(2026, 8, 24, 12, 55))

    assert anchor == Anchor(observed=1500.0, expected=3000.0)


def test_today_anchor_skips_readings_with_no_profile_cell():
    """비교 기준이 없는 판독은 양쪽 평균에서 함께 빠져야 한다."""
    profile = {(0, 12): 2000.0}
    rows = [reading(datetime(2026, 8, 24, 11, m), 9999.0) for m in range(0, 60, 5)]
    rows += [reading(datetime(2026, 8, 24, 12, m), 1000.0) for m in range(0, 60, 5)]

    anchor = today_anchor(profile, rows, datetime(2026, 8, 24, 12, 55))

    assert anchor == Anchor(observed=1000.0, expected=2000.0)


def test_today_anchor_needs_enough_observations():
    """한두 판독의 잡음이 하루 곡선 전체를 밀어 올리면 안 된다."""
    profile = {(0, 12): 2000.0}
    rows = [reading(datetime(2026, 8, 24, 12, 0), 1000.0)]

    assert today_anchor(profile, rows, datetime(2026, 8, 24, 12, 5)) is None


def test_today_anchor_ignores_readings_outside_the_window():
    profile = {(0, 10): 2000.0, (0, 12): 2000.0}
    stale = [reading(datetime(2026, 8, 24, 10, m), 1000.0) for m in range(0, 60, 5)]

    assert today_anchor(profile, stale, datetime(2026, 8, 24, 12, 0), anchor_minutes=30) is None


def test_predict_value_scales_by_the_anchor_ratio():
    """어긋남이 수준의 배율로 오기 때문에 비율이다 — 백테스트에서 덧셈(195)보다
    비율(168)이 이겼다."""
    assert predict_value(3000.0, Anchor(1000.0, 2000.0), None, 0) == pytest.approx(1500.0)


def test_predict_value_without_an_anchor_is_the_profile_itself():
    assert predict_value(3000.0, None, None, 0) == pytest.approx(3000.0)


def test_predict_value_ramps_from_the_last_reading():
    """램프 없이 프로파일로 점프하면 이음매가 계단이 된다."""
    anchor = Anchor(1000.0, 1000.0)  # 보정 없음 — 램프만 본다

    at_seam = predict_value(2000.0, anchor, 1000.0, 0, ramp_minutes=90)
    halfway = predict_value(2000.0, anchor, 1000.0, 45, ramp_minutes=90)
    after = predict_value(2000.0, anchor, 1000.0, 120, ramp_minutes=90)

    assert at_seam == pytest.approx(1000.0)
    assert halfway == pytest.approx(1500.0)
    assert after == pytest.approx(2000.0)


def test_predict_value_never_goes_negative():
    """비율이 0 에 가까워도 인구수는 음수가 될 수 없다."""
    assert predict_value(100.0, Anchor(0.0, 5000.0), None, 0) == 0.0


def test_business_hours_follow_the_weekday():
    """프론트 nationalMuseumBusinessHours.ts 와 같은 표 (수·토 21:00)."""
    assert close_minutes(date(2026, 8, 26)) == 21 * 60  # 수
    assert close_minutes(date(2026, 8, 29)) == 21 * 60  # 토
    assert close_minutes(date(2026, 8, 24)) == 17 * 60 + 30  # 월

    assert in_business_hours(datetime(2026, 8, 24, 9, 30))
    assert not in_business_hours(datetime(2026, 8, 24, 9, 29))
    assert in_business_hours(datetime(2026, 8, 24, 17, 30))
    assert not in_business_hours(datetime(2026, 8, 24, 18, 0))
    assert in_business_hours(datetime(2026, 8, 26, 18, 0))  # 수요일은 연장


def test_curve_skips_hours_the_solid_line_already_drew():
    """겹쳐 그리면 이음매가 둘이 된다 — 램프의 minutes_ahead 도 음수가 된다."""
    profile = {(0, hour): 2000.0 for hour in range(10, 18)}

    points = curve(profile, date(2026, 8, 24), last=(12 * 60 + 30, 1000.0))

    assert [p["hour"] for p in points] == [13, 14, 15, 16, 17]


def test_curve_keeps_the_unanchored_value_in_baseline():
    """응답만 보고도 앵커가 얼마나 밀었는지 읽혀야 한다."""
    profile = {(0, 15): 2000.0}

    point = curve(profile, date(2026, 8, 24), anchor=Anchor(1000.0, 2000.0))[0]

    assert point["baseline"] == pytest.approx(2000.0)
    assert point["model"] == pytest.approx(1000.0)


def test_seam_averages_the_readings_in_the_last_mark():
    """램프 출발점은 마지막 판독 하나가 아니라 그 마크의 평균이다.

    프론트가 같은 마크 평균을 실선으로 그리고 점선을 그 끝에 잇는다
    (CongestionCard 의 resample 과 predPoints). 여기서 생판독을 쓰면 이음매 좌표는
    프론트가 맞춰 주지만 램프 기울기가 다른 값에서 계산돼 방향이 어긋난다.
    """
    rows = [
        reading(datetime(2026, 8, 24, 14, 55), 1750.0),  # 마크 15:00 의 창 안
        reading(datetime(2026, 8, 24, 15, 0), 2250.0),
    ]

    assert seam(rows) == (15 * 60, pytest.approx(2000.0))


def test_seam_takes_only_the_last_window_not_the_whole_day():
    rows = [
        reading(datetime(2026, 8, 24, 14, 0), 950.0),  # 창 밖 (마크에서 60분 전)
        reading(datetime(2026, 8, 24, 14, 55), 1750.0),
        reading(datetime(2026, 8, 24, 15, 0), 2250.0),
    ]

    assert seam(rows) == (15 * 60, pytest.approx(2000.0))


def test_seam_rounds_the_mark_up_at_the_half_like_the_frontend():
    """서울시 수집은 */5 라 마지막 판독이 마크 사이 정중앙(:25)에 떨어진다.

    프론트의 Math.round 는 .5 를 위로 보내 마크가 15:30 이 된다. 파이썬 round 는
    짝수로 붙어 15:20 을 내놓고, 그러면 반개구간 [15:15, 15:25) 이 그 판독조차
    놓쳐 두 곡선이 다른 값에서 만난다.
    """
    rows = [reading(datetime(2026, 8, 24, 15, 25), 2250.0)]

    assert seam(rows) == (15 * 60 + 30, pytest.approx(2250.0))


def test_seam_constants_pair_with_the_frontend():
    """frontend CongestionCard 의 resample 이 쓰는 BUCKET_MINUTES 와 그 기본
    창(간격의 절반)과 짝이다.

    두 언어에 흩어져 있어 임포트로 묶을 수 없다. 한쪽만 바꾸면 점선이 실선과
    다른 값에서 출발하므로, 최소한 리뷰에서 "왜 한쪽만 움직이나"가 보이도록
    값 자체를 고정한다.
    """
    assert SEAM_BUCKET_MINUTES == 10
    assert SEAM_WINDOW_MINUTES == SEAM_BUCKET_MINUTES / 2


def test_seam_with_a_zero_bucket_is_the_single_last_reading():
    """백테스트가 옛 동작(생판독)과 비교할 수 있어야 한다."""
    rows = [
        reading(datetime(2026, 8, 24, 14, 55), 1750.0),
        reading(datetime(2026, 8, 24, 15, 0), 2250.0),
    ]

    assert seam(rows, bucket_minutes=0) == (15 * 60, 2250.0)


def test_seam_falls_back_to_the_last_reading_when_the_window_catches_nothing():
    """창이 마크 반폭보다 좁으면 마지막 판독조차 창 밖이다 — 백테스트가 창을
    스윕(⑦)하는 이상 도달 가능한 경로라 나눗셈이 터지면 안 된다."""
    rows = [reading(datetime(2026, 8, 24, 15, 5), 2250.0)]  # 마크는 15:10

    assert seam(rows, window_minutes=3) == (15 * 60 + 10, 2250.0)


def test_seam_without_readings_is_none():
    assert seam([]) is None
