"""One-off migration: reunite existing raw_mmca_congestion readings that
belong to the same collection round under one shared observed_at.

Before the fix in collector.py, every room's observed_at was individually
stamped at its own HTTP call's completion time instead of the round's start
time, so a slow batch against the real data.go.kr API could scatter one
round's rooms across several minutes — exactly what /mmca/daily's per-minute
bucketing assumes never happens.

Rounds are reconstructed by gap: consecutive readings (sorted by
observed_at) more than ROUND_GAP_SECONDS apart start a new round. That alone
isn't sufficient, though — history also contains back-to-back rounds only a
few seconds apart (from the old poll-immediately-on-restart behavior, before
that was removed), which a time gap alone can't separate from an ordinary
intra-round gap. A round can never re-fetch the same room twice, so a
repeated space_code within the current cluster forces a split regardless of
the elapsed time — confirmed necessary against real data (two full 17-room
rounds only ~7s apart around 2026-07-26 15:10-15:11).

Every reading in a round is rewritten to that round's earliest reading's
time, floored to the :00/:15/:30/:45 grid — matching what collect_mmca_once
now always stamps new readings with. Naively flooring every round
independently isn't safe on its own: some accumulated history predates the
cron-aligned scheduler (PR #24) and was collected on a different, non-grid
interval, so two genuinely separate rounds can floor to the same 15-minute
mark (confirmed against real data — the 2026-07-24 16:37 and 16:44 rounds,
~7 minutes apart, both floor to 16:30). Representative timestamps are
therefore assigned in round order and bumped forward a further 15 minutes
on collision, so every round still lands on the grid with a distinct,
strictly increasing timestamp.

A bump compares against the *previous round's already-bumped* timestamp,
not its raw floor — so 3+ legacy rounds in a row, each under 15 minutes
apart, chain: every bump after the first pushes further from that round's
real collection time. The result is still grid-aligned and strictly
increasing (the only properties this migration promises), just not
necessarily close to when the round actually ran. Not a concern for the
production data this was run against (no such chain existed), but worth
knowing if this script is ever reused on different history.

Idempotent — an already-normalized round (all readings sharing one
timestamp) reduces to a single-row "cluster" that rewrites to itself.
Pass --dry-run to preview the changes without committing.
"""

import argparse
import sqlite3
from datetime import datetime, timedelta

from app.config import settings

# fetch_mmca_congestion's HTTP call has a 10s timeout (mmca_api.py) and isn't
# retried on failure, so no single room's fetch can take longer than that.
# 60s gives comfortable margin above that while staying well under the
# ~270s+ gaps observed between genuinely separate rounds.
ROUND_GAP_SECONDS = 60


def floor_to_15(dt: datetime) -> datetime:
    return dt.replace(minute=(dt.minute // 15) * 15, second=0, microsecond=0)


def cluster_rounds(rows: list[tuple[int, datetime, str]]) -> list[list[tuple[int, datetime, str]]]:
    """rows must be sorted by observed_at ascending."""
    clusters: list[list[tuple[int, datetime, str]]] = []
    seen_codes: set[str] = set()
    for row_id, observed_at, space_code in rows:
        starts_new_round = (
            not clusters
            or (observed_at - clusters[-1][-1][1]).total_seconds() > ROUND_GAP_SECONDS
            or space_code in seen_codes
        )
        if starts_new_round:
            clusters.append([])
            seen_codes = set()
        clusters[-1].append((row_id, observed_at, space_code))
        seen_codes.add(space_code)
    return clusters


def assign_representatives(clusters: list[list[tuple[int, datetime, str]]]) -> list[datetime]:
    """One grid-aligned timestamp per cluster, in cluster order, strictly
    increasing — bumped forward 15 minutes on collision."""
    representatives: list[datetime] = []
    prev: datetime | None = None
    for cluster in clusters:
        representative = floor_to_15(cluster[0][1])
        if prev is not None and representative <= prev:
            representative = prev + timedelta(minutes=15)
        representatives.append(representative)
        prev = representative
    return representatives


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not settings.database_url.startswith("sqlite:///"):
        raise SystemExit(f"this script only supports sqlite:/// URLs, got: {settings.database_url}")

    db_path = settings.database_url.removeprefix("sqlite:///")
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute("SELECT id, observed_at, space_code FROM raw_mmca_congestion ORDER BY observed_at ASC")
        rows = [
            (row_id, datetime.fromisoformat(observed_at_str), space_code)
            for row_id, observed_at_str, space_code in cur.fetchall()
        ]

        clusters = cluster_rounds(rows)
        representatives = assign_representatives(clusters)

        changes: list[tuple[int, datetime, datetime]] = []
        for cluster, representative in zip(clusters, representatives):
            for row_id, observed_at, _space_code in cluster:
                if observed_at != representative:
                    changes.append((row_id, observed_at, representative))

        print(f"{len(rows)} rows examined, {len(clusters)} rounds reconstructed, {len(changes)} rows need rewriting")
        for row_id, before, after in changes[:20]:
            print(f"  id={row_id}: {before} -> {after}")
        if len(changes) > 20:
            print(f"  ... and {len(changes) - 20} more")

        if args.dry_run:
            print("dry run — no changes committed")
            return

        for row_id, _before, after in changes:
            cur.execute(
                "UPDATE raw_mmca_congestion SET observed_at = ? WHERE id = ?",
                (str(after), row_id),
            )
        conn.commit()
        print(f"committed {len(changes)} updates")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
