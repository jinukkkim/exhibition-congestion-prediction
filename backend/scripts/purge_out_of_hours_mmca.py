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
can never drift from what the collector refuses to collect. That gate now
reads shared/museum-holidays.json, so it knows the three things a weekday-only
gate could not: MMCA opens on a holiday that lands on its weekly closing day
(2026-08-17, non-여유 185), closes the day after (2026-08-18, all 219 readings
여유), and closes on the ad-hoc days each venue announces (Seoul 2026-09-08,
1,928 readings with non-여유 0). The ad-hoc dates are the venue's own published
notice; the holiday-Monday open/close pair is inferred from that single
measured pair of days, not from any published policy — and this is the only
file on the branch that deletes rows on the strength of it, so treat that
distinction as load-bearing here.

Public holidays used to be skipped outright for exactly that reason — a
calendar this script could not check was not a calendar it should delete
against. That exemption is gone with the calendar's arrival, which also brings
back into scope the 78 rows this file used to name as a knowing miss: Gwacheon
after closing on the Saturday 2026-08-15. They were out-of-hours rows all
along.

Not in deploy.sh — a data cleanup, not a schema migration. Idempotent by
nature: a second run finds nothing left to delete. Previewing is the default;
deletion happens only with --delete.

Hold the first production run until after 2026-10-05. collector.py's
_is_closed_day names that date (Monday, 개천절 대체) as the next chance to
re-verify the holiday-Monday-open rule (rule 2) — non-empty Gwacheon readings
that day confirm it. This deletion is irreversible and this file is the only
place that acts on rule 2/3 as settled fact rather than as inferred, so run it
after that date has had its chance to confirm or contradict the rule, not
before.
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
    opening hours to judge it by — those rows are kept too, and main() reports
    how many there were.
    """
    return [
        (row_id, observed_at, space_code)
        for row_id, observed_at, space_code in rows
        if space_code in VENUE_OF
        and not _is_venue_open(VENUE_OF[space_code], observed_at)
    ]


def main(session_factory=SessionLocal) -> None:
    parser = argparse.ArgumentParser()
    # 미리보기가 기본값이고 삭제는 --delete 로만 일어난다. 뒤집혀 있었을 때는
    # 플래그를 잊는 것이 곧 프로덕션 행 삭제였고, 이 스크립트가 지우는 근거
    # 일부(대체 휴관)는 실측 한 쌍에서 나온 추론이라 되돌릴 수도 없다. 위
    # docstring 이 "10-05 재검증 전에는 돌리지 말라" 고 적고 있지만, 문단을
    # 놓친 사람을 막아 주는 것은 문단이 아니라 기본값이다.
    parser.add_argument(
        "--delete", action="store_true", help="actually delete; without it this only previews"
    )
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

        if not args.delete:
            print("preview only — nothing deleted. Pass --delete to apply.")
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
