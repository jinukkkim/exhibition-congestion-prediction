#!/usr/bin/env bash
# Dev entrypoint: refresh the local DB from production if it's stale, then run
# uvicorn.
#
# The pull is skipped when the local DB was refreshed recently. Restarting the
# backend a few times while working on one thing used to re-download the whole
# snapshot every time, and production only moves every 5 minutes (Seoul) /
# 10 minutes (MMCA) — so a copy from half an hour ago is as useful for dev as
# a fresh one. --reload restarts only the app import on file changes, not this
# wrapper, so a save never re-pulls either way.
#
#   scripts/dev.sh              # pull only if congestion.db is older than 30m
#   DB_MAX_AGE=0 scripts/dev.sh # always pull
#   DB_MAX_AGE=inf scripts/dev.sh   # never pull, use whatever is on disk
set -euo pipefail
cd "$(dirname "$0")/.."

DB_MAX_AGE="${DB_MAX_AGE:-1800}"

if [ "$DB_MAX_AGE" = "inf" ]; then
  echo "DB_MAX_AGE=inf — using the local congestion.db as-is."
elif [ ! -f congestion.db ]; then
  scripts/pull_prod_db.sh
else
  # stat's flags differ between BSD (macOS) and GNU (Linux); dev happens on
  # macOS but CI/servers are Linux, so try both rather than assuming.
  MTIME="$(stat -f %m congestion.db 2>/dev/null || stat -c %Y congestion.db)"
  AGE=$(( $(date +%s) - MTIME ))
  if [ "$AGE" -ge "$DB_MAX_AGE" ]; then
    echo "Local DB is ${AGE}s old (limit ${DB_MAX_AGE}s) — refreshing."
    scripts/pull_prod_db.sh
  else
    echo "Local DB is ${AGE}s old (limit ${DB_MAX_AGE}s) — skipping pull. DB_MAX_AGE=0 to force."
  fi
fi

exec .venv/bin/uvicorn app.main:app --reload
