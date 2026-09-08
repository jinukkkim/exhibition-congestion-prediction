from datetime import datetime

from scripts.purge_out_of_hours_mmca import out_of_hours

SEOUL = "MMCA-SPACE-1001"
GWACHEON = "MMCA-SPACE-2001"

# 2026-07-27 월, 2026-07-28 화, 2026-07-29 수(서울관 야간개장).
ROWS = [
    (1, datetime(2026, 7, 27, 9, 50), SEOUL),  # 개관 전
    (2, datetime(2026, 7, 27, 10, 0), SEOUL),  # 개관 시각
    (3, datetime(2026, 7, 27, 18, 0), SEOUL),  # 폐관 시각
    (4, datetime(2026, 7, 27, 18, 10), SEOUL),  # 폐관 후
    (5, datetime(2026, 7, 27, 14, 0), GWACHEON),  # 월요일 휴관
    (6, datetime(2026, 7, 28, 14, 0), GWACHEON),
    (7, datetime(2026, 7, 29, 19, 0), SEOUL),  # 수요일 야간개장
    (8, datetime(2026, 7, 29, 19, 0), GWACHEON),  # 과천관은 야간개장 없음
    (9, datetime(2026, 7, 28, 14, 0), "MMCA-SPACE-9999"),  # 설정에 없는 코드
    (10, datetime(2026, 8, 17, 14, 0), GWACHEON),  # 대체공휴일 월요일 — 실제 개관
    (11, datetime(2026, 8, 15, 20, 0), GWACHEON),  # 토요일 폐관(18:00) 후 — 공휴일이어도 영업시간 밖이다
]


def test_out_of_hours_selects_only_rows_their_venue_was_closed_for():
    assert [row_id for row_id, _, _ in out_of_hours(ROWS)] == [1, 4, 5, 8, 11]


def test_out_of_hours_now_deletes_a_substitute_closure_day():
    """2026-08-18 은 대체 휴관일이다 — 그날 과천 판독은 빈 건물이다.
    예전에는 '달력을 못 보니 공휴일 근처는 건드리지 않는다'로 통째로
    남겨 뒀는데, 이제 게이트가 달력을 보므로 그 유예가 필요 없다."""
    rows = [(1, datetime(2026, 8, 18, 14, 0), "MMCA-SPACE-2001")]

    assert [row[0] for row in out_of_hours(rows)] == [1]


def test_out_of_hours_keeps_an_open_holiday_monday():
    """2026-08-17 은 과천관이 실제로 연 날이다 — 규칙 2 의 유일한 증거이므로
    지우면 안 된다."""
    rows = [(1, datetime(2026, 8, 17, 14, 0), "MMCA-SPACE-2001")]

    assert out_of_hours(rows) == []


def test_out_of_hours_is_idempotent():
    """Re-running the purge finds nothing: what survives is all in-hours."""
    doomed = out_of_hours(ROWS)
    survivors = [row for row in ROWS if row not in doomed]

    assert out_of_hours(survivors) == []
