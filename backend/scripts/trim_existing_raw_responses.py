"""One-off backfill: shrink already-collected raw_response bodies down to the
same subset new collections keep (see seoul_api._ARCHIVED_SECTIONS).

Run from backend/ as a module, not as a file path — it imports a sibling
script, which only resolves with the package root on sys.path:

    .venv/bin/python -m scripts.trim_existing_raw_responses

Deliberately NOT in deploy.sh — this is a data backfill, not a schema
migration, and the collector already writes trimmed bodies. Re-running is safe
(rows without a CITYDATA wrapper are recognised as already trimmed and left
alone) but does nothing.

Runs backfill_forecasts first rather than documenting "run that one before
this one": trimming strips FCST24HOURS out of the stored bodies, so getting
the order wrong destroys the historical weather forecasts for good. That
backfill is idempotent, so chaining it costs one no-op pass on later runs and
removes the failure mode entirely.

Ends with VACUUM: shrinking a row hands its pages back to SQLite's free list
for reuse, but never truncates the file, so without it the ~170MB high-water
mark would stay even though 80% of the content is gone.
"""

import json
import os
import sqlite3

from app.config import settings
from app.seoul_api import _archived_body
from scripts.backfill_forecasts import main as backfill_forecasts

BATCH = 500


def trim_body(raw: str) -> str | None:
    """Trimmed body, or None if this row was already collected trimmed."""
    body = json.loads(raw)
    city = body.get("CITYDATA")
    if city is None:
        return None
    return _archived_body(city)


def main() -> None:
    if not settings.database_url.startswith("sqlite:///"):
        raise SystemExit(f"this script only supports sqlite:/// URLs, got: {settings.database_url}")

    # Must complete before a single body is trimmed — see the module docstring.
    print("== backfill_forecasts ==")
    backfill_forecasts()
    print("== trim ==")

    db_path = settings.database_url.removeprefix("sqlite:///")
    before = os.path.getsize(db_path)

    trimmed = skipped = 0
    conn = sqlite3.connect(db_path)
    try:
        last_id = 0
        while True:
            rows = conn.execute(
                "SELECT id, raw_response FROM raw_congestion "
                "WHERE id > ? AND raw_response IS NOT NULL ORDER BY id LIMIT ?",
                (last_id, BATCH),
            ).fetchall()
            if not rows:
                break

            updates = []
            for row_id, raw in rows:
                last_id = row_id
                body = trim_body(raw)
                if body is None:
                    skipped += 1
                else:
                    updates.append((body, row_id))

            if updates:
                conn.executemany(
                    "UPDATE raw_congestion SET raw_response = ? WHERE id = ?", updates
                )
                conn.commit()
                trimmed += len(updates)
    finally:
        conn.close()

    # Skipped when there was nothing to reclaim: VACUUM rewrites the whole file
    # under an exclusive lock, which is not something to hand a re-run for free.
    if trimmed:
        # VACUUM can't run inside a transaction, hence the separate autocommit
        # connection rather than reusing the one above.
        vacuum = sqlite3.connect(db_path, isolation_level=None)
        try:
            vacuum.execute("VACUUM")
        finally:
            vacuum.close()

    after = os.path.getsize(db_path)
    mb = 1024 * 1024
    print(f"trimmed {trimmed} rows, skipped {skipped} already-trimmed")
    print(f"{before / mb:.1f}MB -> {after / mb:.1f}MB" + ("" if trimmed else " (VACUUM skipped)"))


if __name__ == "__main__":
    main()
