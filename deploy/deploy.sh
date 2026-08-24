#!/usr/bin/env bash
# Runs on the production server (via SSH from the deploy workflow) to bring
# it in sync with main and restart the backend.
set -euo pipefail

# Port matches deploy/exhibition-backend.service, which is where uvicorn's
# --host/--port are actually set. Still overridable, but no longer a guess.
# The wait budget (~30s) is likewise overridable, for whenever startup grows
# something slower than init_db() and the scheduler.
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8000/health}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-15}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-2}"

APP_DIR=/home/ubuntu/exhibition-traffic

cd "$APP_DIR"

git fetch origin
git reset --hard HEAD
git checkout -B main origin/main

# Build the frontend first, before anything user-facing has moved. `set -e`
# aborts on a build failure, and at this point that leaves production
# completely untouched — the old bundle is still being served and the old
# backend is still running. Building after the restart (as this used to) meant
# a broken build stranded a new backend behind a stale frontend.
cd frontend
npm ci
npm run build

cd ../backend
.venv/bin/pip install -e . --quiet
# Every schema migration runs on every deploy; each is idempotent and skips
# itself once applied. One-off *data* backfills deliberately stay out of this
# list — scripts/normalize_mmca_observed_at.py rewrites timestamps that are
# already normalised, and scripts/trim_existing_raw_responses.py would VACUUM
# the whole DB on each run.
.venv/bin/python scripts/migrate_add_raw_response.py
.venv/bin/python scripts/migrate_add_population_fields.py
.venv/bin/python scripts/migrate_drop_mmca_raw_response.py
sudo systemctl restart exhibition-backend.service

# systemctl returns as soon as the unit is started, not when uvicorn is
# serving, so poll rather than checking once. Failing here aborts before the
# new bundle is published, leaving the old frontend against a backend we know
# didn't come up — bad, but recoverable by a rollback deploy, unlike shipping
# a frontend that talks to an API that never started.
for attempt in $(seq 1 "$HEALTH_ATTEMPTS"); do
  if curl -fsS --max-time 3 -o /dev/null "$HEALTH_URL"; then
    echo "backend healthy after ${attempt} attempt(s)"
    break
  fi
  if [ "$attempt" -eq "$HEALTH_ATTEMPTS" ]; then
    echo "backend failed health check at ${HEALTH_URL}" >&2
    sudo systemctl status exhibition-backend.service --no-pager >&2 || true
    sudo journalctl -u exhibition-backend.service -n 50 --no-pager >&2 || true
    exit 1
  fi
  sleep "$HEALTH_INTERVAL"
done

# Caddy routes every backend path explicitly and falls back to the SPA for
# anything else, so a path missing from its config answers 200 with index.html
# instead of 404 — which is how /health went unnoticed as unroutable. Shipping
# the file from the repo keeps that config reviewable instead of living only on
# the server. Validate the repo's copy *before* overwriting the live one: a
# reload of a rejected config is a no-op against the running process, but a
# copy that lands first leaves broken config on disk, and the next unrelated
# `systemctl restart caddy` or reboot would then fail to bring Caddy up at all.
sudo caddy validate --config "$APP_DIR/deploy/Caddyfile"
sudo cp "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
sudo systemctl reload caddy

# Publish the already-built bundle last: an old frontend against the new
# backend is the safe intermediate state, the reverse is not.
cd ../frontend
sudo rsync -a --delete dist/ /var/www/exhibition-traffic/
