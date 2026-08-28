#!/usr/bin/env bash
# Overwrites the local dev SQLite DB (backend/congestion.db) with a
# consistent snapshot of the production DB, so `uvicorn`/`npm run dev` see
# real current data instead of whatever's been sitting in the local file.
#
# Uses sqlite3's online backup API (via the remote venv's Python — the
# server doesn't have the sqlite3 CLI installed) so it's safe to run while
# the production collector is mid-write, unlike a raw `scp` of the live file.
#
# Two things keep this fast. Production is ~213MB, of which ~179MB is
# raw_congestion.raw_response (archived /citydata bodies):
#
#   1. Old archived bodies are dropped from the snapshot before it is sent.
#      Only /congestion/daily/raw (the logs page) reads that column, one day
#      at a time, so a month of them is local disk dev never opens.
#   2. What remains is gzipped on the server and streamed through one ssh
#      connection. Sending the raw file, as this script used to, moved 31x
#      more bytes than necessary and took over five minutes.
#
# Config comes from backend/.env.local (gitignored, see .env.local.example)
# rather than being hardcoded here or living in .env — app/config.py's
# Settings reads .env directly and rejects unknown keys, so dev-tooling
# config has to stay out of it.
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
[ -f .env.local ] && source .env.local
set +a

: "${DEPLOY_HOST:?Set DEPLOY_HOST in backend/.env.local}"
: "${DEPLOY_USER:=ubuntu}"
: "${DEPLOY_SSH_KEY:?Set DEPLOY_SSH_KEY in backend/.env.local (path to the SSH private key)}"
REMOTE_APP_DIR="${REMOTE_APP_DIR:-/home/ubuntu/exhibition-traffic/backend}"
REMOTE_TMP="/tmp/congestion_snapshot_$$.db"
REMOTE_SLIM="/tmp/congestion_slim_$$.db"

# How many of the most recent days keep their archived bodies. Rows older than
# this keep every parsed column and lose only the ~25 extra fields the archived
# body would have added — /congestion/daily/raw already falls back to the
# columns when raw_response is NULL, so the logs page degrades rather than
# breaking. Raise it if you need to inspect older days locally.
RAW_RESPONSE_KEEP_DAYS="${RAW_RESPONSE_KEEP_DAYS:-7}"

# Download into a sibling temp file and move it into place only after it
# verifies. A half-finished stream must never replace a working local DB —
# debugging a truncated SQLite file costs far more than re-running this.
LOCAL_TMP="$(mktemp "$(pwd)/.congestion.db.XXXXXX")"

cleanup() {
  rm -f "$LOCAL_TMP"
  ssh -i "$DEPLOY_SSH_KEY" "$DEPLOY_USER@$DEPLOY_HOST" "rm -f $REMOTE_TMP $REMOTE_SLIM" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The remote half lives in scripts/_pull_prod_remote.py and is shipped
# base64-encoded: base64 output has no quotes or backslashes, so there is no
# nesting to get wrong, and the Python stays a real file that lints.

echo "Snapshotting production DB, trimming old archived bodies, streaming it down (gzipped)..."
START=$(date +%s)

# One ssh invocation does snapshot + trim + compress, so neither the full file
# nor the uncompressed slim one crosses the network. gzip writes to stdout;
# everything informational on the remote side goes to stderr or it would
# corrupt the stream.
base64 < "$(dirname "$0")/_pull_prod_remote.py" | ssh -i "$DEPLOY_SSH_KEY" "$DEPLOY_USER@$DEPLOY_HOST" "
  set -euo pipefail
  cd $REMOTE_APP_DIR
  base64 -d > /tmp/pull_prod_db_$$.py
  trap 'rm -f /tmp/pull_prod_db_$$.py' EXIT
  REMOTE_TMP=$REMOTE_TMP REMOTE_SLIM=$REMOTE_SLIM \
    RAW_RESPONSE_KEEP_DAYS=$RAW_RESPONSE_KEEP_DAYS \
    .venv/bin/python3 /tmp/pull_prod_db_$$.py >&2
  gzip -c $REMOTE_SLIM
" | gunzip > "$LOCAL_TMP"

# A snapshot nobody verified is not a snapshot — same reasoning as
# deploy/backup_db.sh. quick_check reads every page, so a truncated or mangled
# stream is caught here rather than surfacing as a confusing app error later.
# The row counts catch the other failure: a structurally valid file that is not
# the database we wanted.
.venv/bin/python3 - "$LOCAL_TMP" <<'PY' >&2
import sqlite3
import sys

db = sqlite3.connect(sys.argv[1])
status = db.execute("pragma quick_check").fetchone()[0]
if status != "ok":
    raise SystemExit(f"downloaded DB failed quick_check: {status}")
for table in ("raw_congestion", "raw_mmca_congestion"):
    rows = db.execute(f"select count(*) from {table}").fetchone()[0]
    if rows == 0:
        raise SystemExit(f"{table} is empty — refusing to replace the local DB")
    print(f"  {table}: {rows} rows")
db.close()
PY

mv "$LOCAL_TMP" congestion.db
echo "Done in $(( $(date +%s) - START ))s: backend/congestion.db now mirrors production ($(du -h congestion.db | cut -f1))."
