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

Run this only where the collector it imports already reads the calendar. The
gate is imported rather than reimplemented, so against pre-calendar code a
weekday-only gate judges the same rows and silently keeps the closed days —
it fails as a preview count too small rather than as a wrong deletion, which
is only recognisable against a known figure.

**Already run in production on 2026-09-11**, right after the calendar
deployed: 297 rows deleted (Gwacheon 219 on 2026-08-18, the substitute
closure, plus 78 after closing time on Saturday 2026-08-15), and a re-run
previews 0. The hold this file used to carry — no first run until after
2026-10-05, on the grounds that rule 3 rested on a single inferred pair of
days — was lifted first: 2026-08-18's closure was confirmed from the museum's
own notice, and it is the only rule-3 day in the collected data. Its 219 rows
were 192 여유 readings and 27 empty ones, against 59~94 non-여유 on every
other Tuesday of those rooms.

Seoul's own ad-hoc closure (2026-09-08, 1,928 rows) is not in that count: it
had already been deleted from production by then, before this file could see
it. So a future run starts from zero out-of-hours rows, and any figure it
reports is new drift — most plausibly a calendar entry added for a date
already collected, since the gate now refuses to collect a closed day at all.

2026-10-05 still matters, but to the gate's future rulings rather than to
anything deleted here: rule 2 rests on 2026-08-17's 185 non-여유 readings, and
no deletion in this file depends on it — that day is judged open, so its rows
are kept either way.
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
    # 플래그를 잊는 것이 곧 프로덕션 행 삭제였다. 지금 이 기본값이 지키는 것은
    # 순서다 — 달력을 읽지 않는 배포에서 돌리면 지워야 할 2,225행 중 78행만
    # 지우고 조용히 끝나므로(위 docstring), 먼저 미리보기 숫자를 2,225 와
    # 맞춰 보게 만드는 자리가 여기다.
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
