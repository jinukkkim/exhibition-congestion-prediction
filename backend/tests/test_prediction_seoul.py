"""seoul.py 프리미티브. 상수의 근거는 scripts/backtest_seoul_prediction.py 에 있다."""

from datetime import date, datetime
from types import SimpleNamespace

import pytest

from app.prediction.seoul import (
    Anchor,
    build_profile,
    close_minutes,
    curve,
    in_business_hours,
    predict_value,
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
