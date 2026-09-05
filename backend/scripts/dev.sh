#!/usr/bin/env bash
# Dev entrypoint: refresh the local DB from production if it's stale, then run
# uvicorn.
#
# The pull is skipped when the local DB was refreshed recently. Restarting the
# backend a few times while working on one thing used to re-download the whole
# snapshot every time, and production only moves every 5 minutes (Seoul) /
# 2 minutes (MMCA) — so a copy from half an hour ago is as useful for dev as
# a fresh one. --reload restarts only the app import on file changes, not this
# wrapper, so a save never re-pulls either way.
#
#   scripts/dev.sh              # pull only if congestion.db is older than 30m
#   DB_MAX_AGE=0 scripts/dev.sh # always pull
#   DB_MAX_AGE=inf scripts/dev.sh   # never pull, use whatever is on disk
set -euo pipefail
cd "$(dirname "$0")/.."

# Same .env.local as pull_prod_db.sh, so DB_MAX_AGE set there works too — it
# used to be read only by the child process, which never looks at it. An
# inline DB_MAX_AGE=0 still wins: `set -a` + source would overwrite the
# inherited value, so it is saved first and restored after.
DB_MAX_AGE_INLINE="${DB_MAX_AGE:-}"
set -a
[ -f .env.local ] && source .env.local
set +a
DB_MAX_AGE="${DB_MAX_AGE_INLINE:-${DB_MAX_AGE:-1800}}"

if [ ! -f congestion.db ]; then
  # Checked before DB_MAX_AGE: "never pull" cannot mean "start with no DB",
  # so a fresh checkout pulls even under DB_MAX_AGE=inf.
  scripts/pull_prod_db.sh
elif [ "$DB_MAX_AGE" = "inf" ]; then
  echo "DB_MAX_AGE=inf — using the local congestion.db as-is."
else
  # Not `stat`: -f is a format flag on BSD but --file-system on GNU, and the
  # dialect that fails still prints a block to stdout, so a `stat -f ... ||
  # stat -c ...` chain quietly yields garbage instead of falling through.
  # This script already requires .venv, so ask the interpreter.
  MTIME="$(.venv/bin/python3 -c 'import os, sys; print(int(os.path.getmtime(sys.argv[1])))' congestion.db)"
  AGE=$(( $(date +%s) - MTIME ))
  if [ "$AGE" -ge "$DB_MAX_AGE" ]; then
    echo "Local DB is ${AGE}s old (limit ${DB_MAX_AGE}s) — refreshing."
    scripts/pull_prod_db.sh
  else
    echo "Local DB is ${AGE}s old (limit ${DB_MAX_AGE}s) — skipping pull. DB_MAX_AGE=0 to force."
  fi
fi

# 예측 응답은 DB 가 아니라 Redis 캐시에서 나오고(routes/prediction.py), 그 캐시를
# 채우는 것은 하루 한 번(00:02 KST) 도는 배치뿐이다 — DB 를 갓 당겨와도 캐시가
# 비어 있으면 라우트가 "수집 중 0/14일"을 돌려주고 차트의 예측 점선이 사라진다.
# 그 시각 뒤에 서버를 띄우면 늘 그 상태다. 비어 있을 때만 한 번 돌린다 (로컬
# 49일치로 1.5초). Redis 가 없으면 예측만 없는 것이니 여기서 죽지 않는다.
.venv/bin/python -c '
from app.cache import get_prediction
from app.prediction.batch import run_daily_batch

if get_prediction() is None:
    print("Prediction cache is empty - running the daily batch.")
    print("Prediction batch:", run_daily_batch()["status"])
else:
    print("Prediction cache is warm - skipping the batch.")
' || echo "Prediction batch skipped (is Redis running?)."

exec .venv/bin/uvicorn app.main:app --reload
