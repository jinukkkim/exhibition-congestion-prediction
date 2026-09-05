from datetime import date, datetime, timedelta

from app.collector import MMCA_POLL_MINUTES
from app.prediction.mmca import (
    ANCHOR_WINDOW_MINUTES,
    MIN_ANCHOR_OBSERVATIONS,
    MIN_SAMPLE_DAYS,
    RAMP_MINUTES,
    build_profile,
    curve,
    predict_tier,
    SEAM_BUCKET_MINUTES,
    SEAM_WINDOW_MINUTES,
    sample_days,
    seam,
    today_shift,
)


class Row:
    """RawMmcaCongestion 스텁 — 순수 함수는 ORM 인스턴스를 요구하지 않는다."""

    def __init__(self, space_code: str, observed_at: str, congestion_nm: str | None):
        self.space_code = space_code
        self.observed_at = datetime.fromisoformat(observed_at)
        self.congestion_nm = congestion_nm


# 이 파일의 프로파일 키가 전부 ("A", 5, 15) 라 판독도 같은 셀 안에 있어야 한다 —
# 2026-08-01 은 토요일(weekday 5)이고 15시다.
_ANCHOR_START = datetime(2026, 8, 1, 15, 0)


def _anchor_rows(level: str, count: int | None = None) -> list[Row]:
    """앵커 게이트를 통과하는 판독을 한 시각 셀 안에 만든다.

    개수도 간격도 상수에서 끌어온다. 둘 다 수집 격자에 매여 있어서다 —
    MIN_ANCHOR_OBSERVATIONS 는 격자가 바뀌면 함께 움직여야 하고(그 결합은 아래
    test_the_anchor_gate_asks_for_at_least_twenty_minutes_of_collection 이
    지킨다), 판독 간격은 격자 그 자체다. 어느 쪽이든 손으로 적어 두면 이 헬퍼만
    현실과 어긋난 채 남는다 — 이 PR 이 프로덕션 코드에서 고치고 있는 것과 같은
    모양이다.

    timedelta 로 더하는 이유는 분을 문자열로 만들면 간격이 커질 때 60 을 넘겨
    "15:100" 같은 값이 나오기 때문이다.
    """
    count = MIN_ANCHOR_OBSERVATIONS if count is None else count
    return [
        Row("A", (_ANCHOR_START + timedelta(minutes=i * MMCA_POLL_MINUTES)).isoformat(), level)
        for i in range(count)
    ]


def test_build_profile_averages_ranks_per_room_weekday_hour():
    # 2026-08-01 은 토요일(weekday=5)
    rows = [
        Row("A", "2026-08-01T15:00:00", "붐빔"),        # rank 3
        Row("A", "2026-08-01T15:10:00", "약간 붐빔"),   # rank 2
        Row("A", "2026-08-08T15:00:00", "붐빔"),        # rank 3
    ]

    profile = build_profile(rows)

    # 날짜별로 먼저 평균, 그 다음 날짜끼리 평균 — 08-01 이 판독 2개라고 08-08
    # 보다 두 배 무거워지지 않는다. 판독을 통째로 평균내면 (3+2+3)/3 이다.
    assert profile[("A", 5, 15)] == ((3 + 2) / 2 + 3) / 2


def test_build_profile_weighs_days_equally_regardless_of_poll_interval():
    """수집 간격이 셀 가중치를 정하면 안 된다.

    MMCA_POLL_MINUTES 가 10 에서 1 로 바뀌면서 실제로 생긴 편향이다. 프로파일
    창(14일)에는 요일마다 두 날이 들어가는데, 1분 격자로 수집한 날은 시각당
    판독이 10분 격자 날의 10배다 — 실측 2026-09-03 방 1006 의 13시 셀이 60판독
    대 2026-08-27 의 6판독으로, 판독을 통째로 평균내면 최근 하루가 셀 가중치의
    91% 를 먹고 PROFILE_WINDOW_DAYS=14 가 요일별로 "가장 최근 1일"로 붕괴한다.
    """
    # 10분 격자로 수집한 날: 시각당 판독 6개, 전부 여유(rank 0)
    sparse_day = [Row("A", f"2026-08-01T15:{minute:02d}:00", "여유") for minute in range(0, 60, 10)]
    # 1분 격자로 수집한 날: 시각당 판독 60개, 전부 붐빔(rank 3)
    dense_day = [Row("A", f"2026-08-08T15:{minute:02d}:00", "붐빔") for minute in range(60)]

    profile = build_profile(sparse_day + dense_day)

    # 두 날이 한 표씩 — 여유 하루와 붐빔 하루의 중간이다. 판독을 통째로
    # 평균내면 60/66 이 붐빔이라 2.73 으로 붐빔에 붙는다.
    assert profile[("A", 5, 15)] == 1.5


def test_build_profile_averages_within_a_day_before_weighing_it():
    """하루 안에서 판독 수가 시각마다 달라도 그 하루는 한 표다.

    수집 장애·부분 라운드 때문에 실제로 흔하다 — 2026-09-03 방 1006 은 같은
    날 안에서 시각당 판독이 20~60 개로 흔들렸다.
    """
    rows = [
        # 08-01 15시: 판독 4개, 평균 0.5
        Row("A", "2026-08-01T15:00:00", "여유"),
        Row("A", "2026-08-01T15:01:00", "여유"),
        Row("A", "2026-08-01T15:02:00", "보통"),
        Row("A", "2026-08-01T15:03:00", "보통"),
        # 08-08 15시: 수집이 죽어 판독 1개
        Row("A", "2026-08-08T15:00:00", "약간 붐빔"),
    ]

    profile = build_profile(rows)

    assert profile[("A", 5, 15)] == (0.5 + 2) / 2


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


def test_the_anchor_gate_asks_for_at_least_twenty_minutes_of_collection():
    """게이트의 단위는 판독 개수지만 재는 것은 시간이라, 격자에 매여 있다.

    3 이던 동안 이 값은 10분 격자에서 20분치를 뜻했는데, 격자가 1분이 되면서
    같은 3 이 3분치가 됐다. 상수 자체는 그대로라 어떤 테스트도 반응하지 않았다 —
    MMCA_POLL_MINUTES 를 바꾸면 깨지는 것이 여기 있어야 하는 이유다.

    상한은 앵커 창이다. 요구 시간이 창보다 길면 게이트를 영영 통과할 수 없어
    평행이동이 조용히 사라진다.
    """
    span_minutes = (MIN_ANCHOR_OBSERVATIONS - 1) * MMCA_POLL_MINUTES

    assert span_minutes >= 20
    assert span_minutes < ANCHOR_WINDOW_MINUTES


def test_min_sample_days_is_three():
    # 전시 교체 직후 재개된 방을 걸러내는 게이트. 스펙 확정값.
    assert MIN_SAMPLE_DAYS == 3


def test_today_shift_is_observed_minus_profile_on_the_same_timestamps():
    # 토요일 15시 프로파일이 2.0 인데 오늘 실측이 1.0 이면 편차 -1.0
    profile = {("A", 5, 15): 2.0}
    rows = _anchor_rows("보통")  # rank 1

    shift = today_shift(profile, rows, now=rows[-1].observed_at)

    assert shift == {"A": -1.0}


def test_today_shift_uses_only_the_last_120_minutes():
    # 12시 셀은 프로파일 0.0, 15시 셀은 2.0.
    # now=15:20 이면 12:00 판독은 200분 전이라 앵커 창(120분) 밖이다.
    profile = {("A", 5, 12): 0.0, ("A", 5, 15): 2.0}
    rows = [
        Row("A", "2026-08-01T12:00:00", "붐빔"),      # 창 밖 — 무시돼야 한다
        *_anchor_rows("보통"),                        # rank 1
    ]

    shift = today_shift(profile, rows, now=rows[-1].observed_at)

    # 창 안 판독만 쓰면 (1+1+1)/3 - 2.0 = -1.0
    assert shift == {"A": -1.0}


def test_today_shift_omits_rooms_below_the_minimum_observations():
    profile = {("A", 5, 15): 2.0}
    rows = _anchor_rows("보통", count=MIN_ANCHOR_OBSERVATIONS - 1)

    shift = today_shift(profile, rows, now=rows[-1].observed_at)

    # 하나 모자라면 편차를 만들지 않는다 — 개관 직후 편차는 노이즈다.
    assert shift == {}


def test_today_shift_omits_rooms_whose_cells_are_missing_from_the_profile():
    profile: dict[tuple[str, int, int], float] = {}
    rows = _anchor_rows("보통")

    shift = today_shift(profile, rows, now=rows[-1].observed_at)

    # 비교 기준이 없으면 편차를 만들 수 없다.
    assert shift == {}


def test_today_shift_is_not_clamped():
    # 클램프는 측정에서 손해였다(없음 64.0% / ±1.0 63.3% / ±0.5 61.9%).
    profile = {("A", 5, 15): 0.0}
    rows = _anchor_rows("붐빔")

    shift = today_shift(profile, rows, now=rows[-1].observed_at)

    assert shift == {"A": 3.0}


def test_today_shift_drops_cell_less_readings_from_both_means():
    # 셀 있는 판독(게이트 통과) + 셀 없는 판독 2개를 같은 방·같은 창에 섞는다.
    # 셀 없는 판독이 observed 에만 들어가고 expected 에서 빠지면 편차가 시간대
    # 효과를 빨아들인다 — 브리프가 최중요 불변식이라 부른 버그다.
    profile = {("A", 5, 15): 2.0}          # 16시 셀은 일부러 비워 둔다
    rows = [
        *_anchor_rows("보통"),                     # rank 1, 셀 있음
        Row("A", "2026-08-01T16:00:00", "붐빔"),   # rank 3, 셀 없음 → 양쪽에서 빠져야 한다
        Row("A", "2026-08-01T16:10:00", "보통"),   # rank 1, 셀 없음 → 양쪽에서 빠져야 한다
    ]

    shift = today_shift(profile, rows, now=datetime.fromisoformat("2026-08-01T16:10:00"))

    # 셀 있는 판독만 쓰면 전부 rank 1 이라 1.0 - 2.0 = -1.0.
    # 셀 없는 판독이 observed 에만 섞이면 평균이 1 위로 끌려 올라가 실패한다.
    assert shift == {"A": -1.0}


def test_today_shift_gate_counts_usable_readings_not_raw_window_rows():
    # 창 안 행 수는 게이트를 넘지만 셀이 맞는 것은 하나 모자란다 — 그렇게 만든
    # 편차야말로 MIN_ANCHOR_OBSERVATIONS 가 막으려는 노이즈다.
    profile = {("A", 5, 15): 2.0}
    rows = [
        *_anchor_rows("보통", count=MIN_ANCHOR_OBSERVATIONS - 1),   # 셀 있음
        Row("A", "2026-08-01T16:00:00", "붐빔"),   # 셀 없음
        Row("A", "2026-08-01T16:10:00", "보통"),   # 셀 없음
    ]

    shift = today_shift(profile, rows, now=datetime.fromisoformat("2026-08-01T16:10:00"))

    assert shift == {}


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


def test_curve_drops_an_hour_landing_exactly_on_the_last_reading():
    # last 가 정시에 걸린 경우. 14:00 판독 뒤에 14시 프로파일 점을 또 그리면
    # 이음매 지점이 두 번 그려진다 — `<` 로 약해지면 이 테스트만 잡는다.
    profile = {("A", 5, 14): 3.0, ("A", 5, 15): 3.0}

    points = curve(profile, "A", date(2026, 8, 1), hours=[14, 15], last=(14 * 60, 0))

    # 14시 점은 last 그 자체(tier 0.0)로 한 번만 나와야 한다.
    assert [p.minutes for p in points] == [14 * 60, 15 * 60]
    assert points[0].tier == 0.0
    assert len([p for p in points if p.minutes == 14 * 60]) == 1


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


def test_predict_tier_without_current_is_the_shifted_profile():
    # 미래 날짜 경로 — 램프가 없다.
    assert predict_tier(2.0, shift=-0.5, current=None, minutes_ahead=0) == 1.5


def test_predict_tier_ramps_from_current_to_profile():
    # 프로파일 3.0, 현재 0. 45분 뒤면 w = 45/90 = 0.5
    assert predict_tier(3.0, shift=0.0, current=0, minutes_ahead=45) == 1.5
    # 90분 이상이면 프로파일 그대로
    assert predict_tier(3.0, shift=0.0, current=0, minutes_ahead=90) == 3.0
    assert predict_tier(3.0, shift=0.0, current=0, minutes_ahead=200) == 3.0


def test_predict_tier_with_zero_ramp_jumps_straight_to_the_profile():
    # 백테스트의 "램프 없음" 변형. 근거리 정확도가 18%p 떨어지는 쪽이다.
    assert predict_tier(3.0, shift=0.0, current=0, minutes_ahead=10, ramp_minutes=0) == 3.0


def test_seam_averages_the_readings_in_the_last_mark():
    """램프 출발점은 마지막 판독 하나가 아니라 그 마크의 평균이다.

    프론트가 같은 마크 평균을 실선으로 그리고 점선을 그 끝에 잇는다
    (lib/resample.ts, MmcaRoomChartCard). 여기서 생판독을 쓰면 이음매 좌표는
    프론트가 맞춰 주지만 램프 기울기가 다른 값에서 계산돼 방향이 어긋난다.
    """
    rows = [
        Row("A", "2026-08-01T15:00:00", "여유"),      # rank 0, 마크 15:00
        Row("A", "2026-08-01T15:02:00", "붐빔"),      # rank 3, 마크 15:00
        Row("A", "2026-08-01T15:04:00", "붐빔"),      # rank 3, 마크 15:00
    ]

    assert seam(rows) == {"A": (15 * 60, 2.0)}


def test_seam_takes_only_the_last_window_not_the_whole_day():
    rows = [
        Row("A", "2026-08-01T14:00:00", "여유"),      # 창 밖 (마크에서 80분 전)
        Row("A", "2026-08-01T15:20:00", "붐빔"),
        Row("A", "2026-08-01T15:22:00", "약간 붐빔"),
    ]

    # 마지막 마크의 창만 — 하루 전체 평균이면 (0+3+2)/3 = 1.67 이 된다.
    assert seam(rows) == {"A": (15 * 60 + 20, 2.5)}


def test_seam_window_reaches_past_its_own_mark():
    """창이 마크 간격보다 넓어 이웃 마크의 판독까지 들어온다.

    프론트의 실선이 같은 창으로 그려지므로(lib/resample.ts) 여기서 마크 하나
    분량만 보면 점선이 실선과 다른 값에서 출발한다.
    """
    rows = [
        Row("A", "2026-08-01T15:05:00", "여유"),      # 마크 15:20 의 창 안 (15분 전)
        Row("A", "2026-08-01T15:20:00", "붐빔"),
    ]

    assert seam(rows) == {"A": (15 * 60 + 20, 1.5)}


def test_seam_constants_pair_with_the_frontend():
    """frontend/src/lib/resample.ts 의 BUCKET_MINUTES / MMCA_WINDOW_MINUTES 와 짝이다.

    두 언어에 흩어져 있어 임포트로 묶을 수 없다. 한쪽만 바꾸면 점선이 실선과
    다른 값에서 출발하므로, 최소한 리뷰에서 "왜 한쪽만 움직이나"가 보이도록
    값 자체를 고정한다 — freshness.ts 와 health.py 의 짝을 다루는 방식과 같다.

    창이 간격보다 넓어야 이웃 마크가 판독을 공유한다. 같거나 좁으면 분리 버킷
    이라 벽이 그대로 남는다.
    """
    assert SEAM_BUCKET_MINUTES == 10
    assert SEAM_WINDOW_MINUTES == 20
    assert SEAM_WINDOW_MINUTES > SEAM_BUCKET_MINUTES / 2


def test_seam_with_a_zero_bucket_is_the_single_last_reading():
    """백테스트가 옛 동작(생판독)과 비교할 수 있어야 한다."""
    rows = [
        Row("A", "2026-08-01T15:00:00", "여유"),
        Row("A", "2026-08-01T15:02:00", "붐빔"),
    ]

    assert seam(rows, bucket_minutes=0) == {"A": (15 * 60 + 2, 3.0)}


def test_seam_ignores_rooms_with_no_usable_reading():
    rows = [
        Row("A", "2026-08-01T15:00:00", None),
        Row("B", "2026-08-01T15:00:00", "보통"),
    ]

    assert seam(rows) == {"B": (15 * 60, 1.0)}
