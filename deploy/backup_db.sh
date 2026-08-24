#!/usr/bin/env bash
# Daily off-box backup of the production SQLite DB. Installed as a cron job on
# the server (see README "Backups"); deploy.sh does NOT call it — a backup has
# to run on its own schedule, and there is no reason to push 7MB to object
# storage on every deploy.
set -euo pipefail

APP_DIR="${APP_DIR:-/home/ubuntu/exhibition-traffic/backend}"
BACKUP_DIR="${BACKUP_DIR:-/home/ubuntu/backups}"
PAR_FILE="${PAR_FILE:-/home/ubuntu/.backup_par}"
KEEP_LOCAL_DAYS="${KEEP_LOCAL_DAYS:-7}"

# This box runs Etc/UTC, so a bare `date +%F` would stamp the UTC day — and at
# the moment cron fires this, that is still yesterday: `date -d '2026-08-23
# 15:33 UTC' +%F` gives 08-23 while the same instant in Seoul is 08-24. Every
# archive would be named a day behind. Same trap as the unpinned cron in #43.
#
# The crontab entry cannot be pinned the same way — this cron has no CRON_TZ
# (absent from both the binary and crontab(5)), so the schedule is written in
# UTC with the conversion in a comment. Safe to hardcode because Korea has no
# DST: KST is +9 permanently, so the offset never drifts.
STAMP="$(TZ=Asia/Seoul date +%F)"

mkdir -p "$BACKUP_DIR"
SNAPSHOT="$(mktemp "$BACKUP_DIR/.snapshot.XXXXXX.db")"
trap 'rm -f "$SNAPSHOT"' EXIT

# sqlite3's online backup API via the app venv, exactly as
# backend/scripts/pull_prod_db.sh does it: the server has no sqlite3 CLI, and
# the collector writes this file every 5 minutes, so a plain cp (or gzipping
# the live file, which takes ~6.5s) can capture a torn mix of two states.
"$APP_DIR/.venv/bin/python3" - "$APP_DIR/congestion.db" "$SNAPSHOT" <<'PY'
import sqlite3
import sys

source, destination = sys.argv[1], sys.argv[2]

# timeout raises the busy handler's wait above the 5s default. The DB is in
# `delete` journal mode, so the collector's 5-minute INSERT holds an EXCLUSIVE
# lock and a backup starting inside that window gets SQLITE_BUSY. Those writes
# last milliseconds, so 5s is already ample; 30s costs nothing and removes the
# case entirely.
#
# Deliberately NOT a `pages=1, sleep=…` retry loop: with pages > 0 any write to
# the source restarts the backup from the beginning, trading a near-zero risk
# for repeated restarts on a file this size. One step under one lock cannot be
# invalidated halfway.
src = sqlite3.connect(source, timeout=30)
dst = sqlite3.connect(destination)
src.backup(dst)

# A backup nobody verified is not a backup. A silently corrupt snapshot is
# only discovered at restore time, which is the worst moment to discover it.
# quick_check reads every page; an empty table means we snapshotted something
# that is not the live database. Either one aborts before the upload.
status = dst.execute("pragma quick_check").fetchone()[0]
if status != "ok":
    raise SystemExit(f"quick_check failed: {status}")

# Both tables, not just Seoul: quick_check catches structural damage but not a
# table that an application bug emptied, and the MMCA readings are exactly as
# irreplaceable as the Seoul ones.
counts = []
for table in ("raw_congestion", "raw_mmca_congestion"):
    rows = dst.execute(f"select count(*) from {table}").fetchone()[0]
    if rows == 0:
        raise SystemExit(f"{table} is empty — refusing to upload")
    counts.append(f"{table}={rows}")

print("snapshot ok: " + ", ".join(counts))
dst.close()
src.close()
PY

ARCHIVE="$BACKUP_DIR/congestion-$STAMP.db.gz"
# gzip, not zstd (which is installed, and measured 3.2s/3.5MB against gzip's
# 6.5s/6.8MB on this box). Both are already trivially small, so zstd's win buys
# nothing, while `gunzip` exists on every machine you might be restoring from
# in a hurry. Level is the default: -9 costs CPU for a percent or two here.
gzip -c "$SNAPSHOT" > "$ARCHIVE"

# The credential is a write-only pre-authenticated request scoped to one OCI
# bucket: it can PUT and nothing else — no read, no list, no delete — so the
# token sitting on this box cannot be used to pull the backups back out.
# Restores go through the console. Kept outside the repo, 600, like .env.local.
[ -r "$PAR_FILE" ] || { echo "missing $PAR_FILE — see README 'Backups'" >&2; exit 1; }
# shellcheck source=/dev/null
. "$PAR_FILE"
: "${BACKUP_PAR_URL:?BACKUP_PAR_URL is not set in $PAR_FILE}"

# -f is what makes this a real check: without it curl exits 0 on an HTTP 4xx
# and the stamp below would record an upload that never landed. --retry covers
# transient network failures only — curl does not retry 4xx, which is what an
# expired PAR returns, and that should fail loudly rather than three times.
curl -fsS --retry 3 --max-time 300 -X PUT \
  --data-binary "@$ARCHIVE" \
  "${BACKUP_PAR_URL}$(basename "$ARCHIVE")" > /dev/null

# Stamped only after the upload returns. /health/collection reports the age of
# this file, and that number has to mean "an off-box copy exists" — a local
# archive with a failed upload is exactly the state we must not read as healthy.
touch "$BACKUP_DIR/.last_upload"

find "$BACKUP_DIR" -name 'congestion-*.db.gz' -mtime "+$KEEP_LOCAL_DAYS" -delete

echo "$(TZ=Asia/Seoul date -Is) uploaded $(basename "$ARCHIVE") ($(du -h "$ARCHIVE" | cut -f1))"
