"""One-time, idempotent migration: add the raw_response column to an
existing local congestion.db without losing already-collected rows.

SQLite only — Base.metadata.create_all() creates missing tables but never
alters existing ones, so this fills that gap for local dev. Safe to re-run.
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
        cur.execute("PRAGMA table_info(raw_congestion)")
        existing = {row[1] for row in cur.fetchall()}

        if "raw_response" in existing:
            print("skip raw_response (already present)")
        else:
            cur.execute("ALTER TABLE raw_congestion ADD COLUMN raw_response TEXT")
            print("added raw_response")

        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    main()
