from datetime import datetime

from scripts.normalize_mmca_observed_at import cluster_rounds


def _row(row_id: int, iso: str, space_code: str) -> tuple[int, datetime, str]:
    return (row_id, datetime.fromisoformat(iso), space_code)


def test_cluster_rounds_groups_a_single_slow_round_together():
    rows = [
        _row(1, "2026-07-26 17:45:00", "MMCA-SPACE-1001"),
        _row(2, "2026-07-26 17:45:08", "MMCA-SPACE-1002"),
        _row(3, "2026-07-26 17:45:13", "MMCA-SPACE-1003"),
    ]

    clusters = cluster_rounds(rows)

    assert len(clusters) == 1
    assert [row_id for row_id, _, _ in clusters[0]] == [1, 2, 3]


def test_cluster_rounds_splits_on_a_large_gap():
    rows = [
        _row(1, "2026-07-24 16:37:56", "MMCA-SPACE-1001"),
        _row(2, "2026-07-24 16:37:57", "MMCA-SPACE-1002"),
        _row(3, "2026-07-24 16:44:29", "MMCA-SPACE-1001"),
        _row(4, "2026-07-24 16:44:33", "MMCA-SPACE-1002"),
    ]

    clusters = cluster_rounds(rows)

    assert len(clusters) == 2
    assert [row_id for row_id, _, _ in clusters[0]] == [1, 2]
    assert [row_id for row_id, _, _ in clusters[1]] == [3, 4]


def test_cluster_rounds_splits_on_a_repeated_space_code_even_with_no_gap():
    # Simulates the old poll-immediately-on-restart era: two full rounds back
    # to back, only ~7s apart — smaller than some real intra-round gaps, so a
    # time threshold alone can't separate them.
    rows = [
        _row(1, "2026-07-26 15:10:08", "MMCA-SPACE-1001"),
        _row(2, "2026-07-26 15:10:50", "MMCA-SPACE-4001"),
        _row(3, "2026-07-26 15:10:57", "MMCA-SPACE-1001"),
        _row(4, "2026-07-26 15:11:27", "MMCA-SPACE-4001"),
    ]

    clusters = cluster_rounds(rows)

    assert len(clusters) == 2
    assert [row_id for row_id, _, _ in clusters[0]] == [1, 2]
    assert [row_id for row_id, _, _ in clusters[1]] == [3, 4]
