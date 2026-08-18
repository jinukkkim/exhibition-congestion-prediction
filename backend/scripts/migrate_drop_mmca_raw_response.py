"""Idempotent migration: drop raw_mmca_congestion.raw_response.

The MMCA /congestion body is only agncNm/spaceNm/congestionNm, all three of
which already have their own columns, so the archived body was duplicating
data it could always be reconstructed from. Safe to re-run; deploy.sh runs it
on every deploy for that reason.

Needs SQLite 3.35+ for ALTER TABLE ... DROP COLUMN (Ubuntu 22.04 ships 3.37).
"""

import sqlite3

from app.config import settings


def main() -> None:
    if not settings.database_url.startswith("sqlite:///"):
        raise SystemExit(f"this script only supports sqlite:/// URLs, got: {settings.database_url}")

    db_path = settings.database_url.removeprefix("sqlite:///")
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute("PRAGMA table_info(raw_mmca_congestion)")
        existing = {row[1] for row in cur.fetchall()}

        if "raw_response" not in existing:
            print("skip raw_response (already dropped)")
        else:
            cur.execute("ALTER TABLE raw_mmca_congestion DROP COLUMN raw_response")
            print("dropped raw_response")

        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    main()
