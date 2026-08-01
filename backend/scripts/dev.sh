#!/usr/bin/env bash
# Dev entrypoint: refresh the local DB from production, then run uvicorn.
# Only pulls once per invocation — --reload restarts just the app import on
# file changes, not this wrapper, so it won't re-pull on every save.
set -euo pipefail
cd "$(dirname "$0")/.."

scripts/pull_prod_db.sh
exec .venv/bin/uvicorn app.main:app --reload
