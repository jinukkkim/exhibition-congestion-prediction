from datetime import datetime

from app.prediction.mmca import (
    MIN_SAMPLE_DAYS,
    build_profile,
    sample_days,
    today_shift,
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


def test_today_shift_drops_cell_less_readings_from_both_means():
    # 셀이 있는 판독 2개 + 셀이 없는 판독 1개를 같은 방·같은 창에 섞는다.
    # 셀 없는 판독이 observed 에만 들어가고 expected 에서 빠지면 편차가
    # 시간대 효과를 빨아들인다 — 브리프가 최중요 불변식이라 부른 버그다.
    profile = {("A", 5, 15): 2.0}          # 16시 셀은 일부러 비워 둔다
    rows = [
        Row("A", "2026-08-01T15:00:00", "보통"),   # rank 1, 셀 있음
        Row("A", "2026-08-01T15:10:00", "보통"),   # rank 1, 셀 있음
        Row("A", "2026-08-01T16:00:00", "붐빔"),   # rank 3, 셀 없음 → 양쪽에서 빠져야 한다
        Row("A", "2026-08-01T16:10:00", "보통"),   # rank 1, 셀 없음 → 양쪽에서 빠져야 한다
    ]

    shift = today_shift(profile, rows, now=datetime.fromisoformat("2026-08-01T16:10:00"))

    # 셀 있는 2개만 쓰면 (1+1)/2 - 2.0 = -1.0.
    # 셀 없는 판독이 observed 에만 섞이면 (1+1+3+1)/4 - 2.0 = -0.5 가 되어 실패한다.
    assert shift == {"A": -1.0}
