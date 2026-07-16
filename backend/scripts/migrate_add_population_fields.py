"""One-time, idempotent migration: add the population-breakdown columns to
an existing local congestion.db without losing already-collected rows.

SQLite only — Base.metadata.create_all() creates missing tables but never
alters existing ones, so this fills that gap for local dev. Safe to re-run.
"""

import sqlite3

from app.config import settings

NEW_COLUMNS = [
    "male_ppltn_rate",
    "female_ppltn_rate",
    "ppltn_rate_0",
    "ppltn_rate_10",
    "ppltn_rate_20",
    "ppltn_rate_30",
    "ppltn_rate_40",
    "ppltn_rate_50",
    "ppltn_rate_60",
    "ppltn_rate_70",
    "resnt_ppltn_rate",
    "non_resnt_ppltn_rate",
]


def main() -> None:
    db_path = settings.database_url.removeprefix("sqlite:///")
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute("PRAGMA table_info(raw_congestion)")
        existing = {row[1] for row in cur.fetchall()}

        for column in NEW_COLUMNS:
            if column in existing:
                print(f"skip {column} (already present)")
                continue
            cur.execute(f"ALTER TABLE raw_congestion ADD COLUMN {column} FLOAT")
            print(f"added {column}")

        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    main()
