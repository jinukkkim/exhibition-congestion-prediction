# Exhibition Traffic — 실시간 전시 혼잡도 예측 시스템

국립중앙박물관 실시간 혼잡도를 서울시 열린데이터광장 API에서 수집하고, 축적된 데이터로 시간대별 혼잡도를 예측하는 개인 포트폴리오 MVP. 베이스라인(요일×시간대 평균)과 scikit-learn 모델의 예측 정확도(MAE)를 비교해 보여준다.

## Prerequisites

- Python 3.12
- Node 18+ (tested with Node 24 / npm 11)
- Redis (caches the latest prediction result)

## Backend setup

```bash
cd backend
python3.12 -m venv .venv
.venv/bin/pip install -e . --group dev
cp .env.example .env   # fill in SEOUL_API_KEY
.venv/bin/uvicorn app.main:app --reload
```

`.env` variables (see `backend/app/config.py`):

- `SEOUL_API_KEY` — required, no default
- `SEOUL_AREA_NAME` — defaults to `국립중앙박물관·용산가족공원`
- `DATABASE_URL` — defaults to `sqlite:///./congestion.db`, and **production runs that same SQLite file** — a single `congestion.db` on the server, not a managed database. Postgres was the original design (see `docs/superpowers/specs/2026-07-15-*`) and SQLAlchemy would still take it via the `pg8000` driver (`postgresql+pg8000://user:pass@host/db`), but it has never been deployed. Anything that assumes a replicated or backed-up database does not hold here.
- `REDIS_URL` — defaults to `redis://localhost:6379/0`

### Developing against real data

`scripts/dev.sh` pulls a fresh snapshot of the production DB into
`congestion.db` before starting uvicorn, so local dev always sees current
data instead of whatever's been collected locally. Needs `DEPLOY_HOST` /
`DEPLOY_USER` / `DEPLOY_SSH_KEY` set in `.env.local` (see `.env.local.example`).

```bash
scripts/dev.sh
```

Run `scripts/pull_prod_db.sh` on its own to refresh the DB without
restarting the server.

## Frontend setup

```bash
cd frontend
npm install
npm run dev
```

## Running tests

```bash
cd backend && .venv/bin/pytest
cd frontend && npx vitest run
cd frontend && npx playwright test
```

## Monitoring

Two endpoints, deliberately separate:

| | Answers | Polled by |
| --- | --- | --- |
| `GET /health` | Is the process up? | `deploy/deploy.sh`, right after a restart |
| `GET /health/collection` | Is data still arriving? | An external uptime monitor |

`/health/collection` returns 503 once the Seoul poll is more than 45 minutes
old, or an MMCA round is more than 25 minutes old *while a venue is open* —
overnight staleness is expected, not a failure. The Seoul threshold is that
wide because its `observed_at` is the Open API's own publication time, which
already lags roughly 30 minutes on a perfectly healthy system; tightening it
is what once pinned this endpoint at a permanent 503. The body also carries
MMCA's call count for the day, as a floor on quota spent against the
1,000/day cap.

Point an external monitor (UptimeRobot, Better Stack, cron-job.org — any of
them will do) at `/health/collection` on a 5–10 minute interval. It has to be
external: collection dying and the whole box dying look the same from inside,
and an in-process alerter cannot report its own death.

### DNS renewal

`deploy/duckdns_update.sh` re-points the duckdns hostname at this box every
five minutes, from cron:

```
*/5 * * * * /home/ubuntu/exhibition-traffic/deploy/duckdns_update.sh >> /home/ubuntu/duckdns.log 2>&1
```

The token is read from `/home/ubuntu/.duckdns` (mode 600, outside the repo, same
treatment as `.backup_par`) rather than written inline in the crontab. Cron logs
every command it runs to the journal verbatim, so an inline token becomes a
permanent, greppable copy in `journalctl -u cron`:

```
CRON[411116]: (ubuntu) CMD (curl -fsS "https://…&token=<the actual token>…")
```

The script `source`s that file, so it holds one shell assignment and nothing
else:

```
DUCKDNS_TOKEN=00000000-0000-0000-0000-000000000000
```

The script also checks the response *body*. duckdns answers HTTP 200 with `KO`
for a bad or rotated token, so `curl -f` alone reports success — verified: `curl
-fsS` with a junk token exits 0 and writes `KO` to the log. Renewal would stop
and nothing would say so until the hostname expired.

To rotate the token: recreate it at duckdns.org, then edit the one line in
`/home/ubuntu/.duckdns` and run the script once by hand — it prints nothing and
exits 0 on success, or names the refusal and exits 1. Rotate *after* the crontab
points at this script; while the token is still inline, recreating it breaks
renewal silently.

## Docs

- Design spec: `docs/superpowers/specs/2026-07-15-exhibition-congestion-prediction-design.md`
- Implementation plan: `docs/superpowers/plans/2026-07-15-exhibition-congestion-prediction-plan.md`
