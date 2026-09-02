"""One-off cleanup: delete raw_mmca_congestion rows collected outside their
own venue's opening hours.

The gate in collector.py (_is_venue_open) is newer than the data. Before it
existed the collector polled every room on a flat schedule, and the MMCA API
answers a closed building with a normal 200 reading of "여유" rather than an
error — so the history still holds rounds from Gwacheon Mondays, from the
evenings only Seoul stays open for, and from before the 10:00 opening.
build_profile averages by (room, weekday, time), which is exactly the shape
those rows distort: an empty building reads as a quiet open one and drags the
prediction profile down.

_is_venue_open is reused rather than reimplemented, so "outside hours" here
can never drift from what the collector refuses to collect. Its ponytail
limitation comes along too: it gates on weekday alone, so a substitute-holiday
Monday when Gwacheon really did open (2026-08-17 has normal congestion) is
deleted with the rest. Those rows would never have been collected under the
current gate either, and keeping them would leave the profile fed by exactly
one Monday.

Not in deploy.sh — a data cleanup, not a schema migration. Idempotent by
nature: a second run finds nothing left to delete. Pass --dry-run to preview.
"""

import argparse
from collections import Counter
from collections.abc import Sequence
from datetime import datetime

from app.collector import _is_venue_open
from app.config import settings
from app.db import SessionLocal
from app.models import RawMmcaCongestion

# space_code -> venue, inverted from the same config the collector gates on.
VENUE_OF: dict[str, str] = {
    code: venue for venue, codes in settings.mmca_venue_space_codes.items() for code in codes
}

# Ids per DELETE ... WHERE id IN (...), kept under SQLite's 999-variable limit
# (raised to 32766 in 3.32, but the old ceiling costs nothing to respect).
BATCH = 500


Row = tuple[int, datetime, str]


def out_of_hours(rows: Sequence[Row]) -> list[Row]:
    """The (id, observed_at, space_code) rows _is_venue_open rejects.

    A space_code missing from the config belongs to no venue, so there are no
    opening hours to judge it by — those rows are kept, and main() reports how
    many there were.
    """
    return [
        (row_id, observed_at, space_code)
        for row_id, observed_at, space_code in rows
        if space_code in VENUE_OF and not _is_venue_open(VENUE_OF[space_code], observed_at)
    ]


def main(session_factory=SessionLocal) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    with session_factory() as session:
        rows = (
            session.query(
                RawMmcaCongestion.id,
                RawMmcaCongestion.observed_at,
                RawMmcaCongestion.space_code,
            )
            .order_by(RawMmcaCongestion.id)
            .all()
        )
        doomed = out_of_hours(rows)
        unknown = sum(1 for _, _, space_code in rows if space_code not in VENUE_OF)

        print(
            f"{len(rows)} rows examined, {len(doomed)} outside opening hours, "
            f"{unknown} with an unknown space_code (kept)"
        )
        for venue, count in sorted(Counter(VENUE_OF[space_code] for _, _, space_code in doomed).items()):
            print(f"  {venue}: {count}")

        if args.dry_run:
            print("dry run — nothing deleted")
            return

        for start in range(0, len(doomed), BATCH):
            ids = [row_id for row_id, _, _ in doomed[start : start + BATCH]]
            session.query(RawMmcaCongestion).filter(RawMmcaCongestion.id.in_(ids)).delete(
                synchronize_session=False
            )
        session.commit()
        print(f"deleted {len(doomed)} rows")


if __name__ == "__main__":
    main()
