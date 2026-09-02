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
]


def test_out_of_hours_selects_only_rows_their_venue_was_closed_for():
    assert [row_id for row_id, _, _ in out_of_hours(ROWS)] == [1, 4, 5, 8]


def test_out_of_hours_is_idempotent():
    """Re-running the purge finds nothing: what survives is all in-hours."""
    doomed = out_of_hours(ROWS)
    survivors = [row for row in ROWS if row not in doomed]

    assert out_of_hours(survivors) == []
