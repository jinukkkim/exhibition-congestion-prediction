#!/usr/bin/env bash
# Overwrites the local dev SQLite DB (backend/congestion.db) with a
# consistent snapshot of the production DB, so `uvicorn`/`npm run dev` see
# real current data instead of whatever's been sitting in the local file.
#
# Uses sqlite3's online backup API (via the remote venv's Python — the
# server doesn't have the sqlite3 CLI installed) so it's safe to run while
# the production collector is mid-write, unlike a raw `scp` of the live file.
#
# Config comes from backend/.env (gitignored) rather than being hardcoded
# here, since DEPLOY_HOST/DEPLOY_SSH_KEY are server-specific, not something
# to commit. Add to backend/.env:
#   DEPLOY_HOST=<server ip>
#   DEPLOY_USER=ubuntu
#   DEPLOY_SSH_KEY=/path/to/your/key
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
[ -f .env ] && source .env
set +a

: "${DEPLOY_HOST:?Set DEPLOY_HOST in backend/.env}"
: "${DEPLOY_USER:=ubuntu}"
: "${DEPLOY_SSH_KEY:?Set DEPLOY_SSH_KEY in backend/.env (path to the SSH private key)}"
REMOTE_APP_DIR="${REMOTE_APP_DIR:-/home/ubuntu/exhibition-traffic/backend}"
REMOTE_TMP="/tmp/congestion_snapshot_$$.db"

cleanup() {
  ssh -i "$DEPLOY_SSH_KEY" "$DEPLOY_USER@$DEPLOY_HOST" "rm -f $REMOTE_TMP" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Snapshotting production DB..."
ssh -i "$DEPLOY_SSH_KEY" "$DEPLOY_USER@$DEPLOY_HOST" \
  "cd $REMOTE_APP_DIR && .venv/bin/python3 -c \"import sqlite3; s=sqlite3.connect('congestion.db'); d=sqlite3.connect('$REMOTE_TMP'); s.backup(d); d.close(); s.close()\""

echo "Downloading..."
scp -i "$DEPLOY_SSH_KEY" "$DEPLOY_USER@$DEPLOY_HOST:$REMOTE_TMP" "$(pwd)/congestion.db"

echo "Done: backend/congestion.db now mirrors production."
