"""Runs ON THE PRODUCTION SERVER, shipped there by pull_prod_db.sh.

Snapshots the live DB, drops archived /citydata bodies older than
RAW_RESPONSE_KEEP_DAYS from the snapshot, and writes a compacted copy for
pull_prod_db.sh to gzip and stream down.

Everything here touches the /tmp snapshot only — production keeps every
archived body. This file must never write to congestion.db.

Kept as a real .py file rather than inlined in the shell script: inlining it
meant nesting three levels of quoting around SQL string literals, and macOS
bash 3.2 mis-parses a heredoc containing parentheses inside $(...).
"""

import os
import sqlite3

snapshot = os.environ["REMOTE_TMP"]
slim = os.environ["REMOTE_SLIM"]
keep = int(os.environ["RAW_RESPONSE_KEEP_DAYS"])
if keep < 0:
    raise SystemExit(f"RAW_RESPONSE_KEEP_DAYS must be 0 or more, got {keep}")

# timeout raises the busy handler above the 5s default: the DB is in `delete`
# journal mode, so the collector's INSERT holds an EXCLUSIVE lock and a backup
# starting inside that window would get SQLITE_BUSY. Same reasoning as
# deploy/backup_db.sh.
src = sqlite3.connect("congestion.db", timeout=30)
snap = sqlite3.connect(snapshot)
src.backup(snap)
src.close()

# keep == 0 means "no archived bodies at all" — the smallest possible dev DB.
# It gets no cutoff: date(newest, "--1 day") is not a modifier SQLite knows, so
# it returns NULL and `< NULL` would match nothing at all.
if keep == 0:
    cond, params = "1", ()
else:
    # The cutoff is derived from the newest row, not from the clock:
    # observed_at is naive Asia/Seoul wall-clock while this box runs Etc/UTC,
    # so a bare date() would be a day behind for the whole KST morning — the
    # trap deploy/backup_db.sh documents. Anchoring to the data has no
    # timezone to get wrong.
    newest = snap.execute("select max(date(observed_at)) from raw_congestion").fetchone()[0]
    cutoff = snap.execute("select date(?, ?)", (newest, f"-{keep - 1} day")).fetchone()[0]
    cond, params = "date(observed_at) < ?", (cutoff,)

snap.execute(f"update raw_congestion set raw_response = null where {cond}", params)
snap.commit()
# The whole point of this script is that the trimmed rows really are trimmed;
# a wrong WHERE clause would silently ship the full 213MB instead.
leftover = snap.execute(
    f"select count(*) from raw_congestion where {cond} and raw_response is not null",
    params,
).fetchone()[0]
if leftover:
    raise SystemExit(f"trim left {leftover} rows that should have been nulled")

# VACUUM INTO writes a compact copy in a single pass. An in-place VACUUM would
# rewrite the whole ~213MB file and still leave the copy to make afterwards.
snap.execute("vacuum into ?", (slim,))
snap.close()

if keep == 0:
    print("  raw_response nulled for every row (RAW_RESPONSE_KEEP_DAYS=0)")
else:
    print(f"  raw_response kept from {cutoff} ({keep}d), older rows nulled")
print(f"  snapshot trimmed to {os.path.getsize(slim) / 1048576:.0f} MB before compression")
