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
- `DATABASE_URL` — defaults to `sqlite:///./congestion.db`, and **production runs that same SQLite file** — a single `congestion.db` on the server, not a managed database. Postgres was the original design (see `docs/superpowers/specs/2026-07-15-*`) and SQLAlchemy would still take it via the `pg8000` driver (`postgresql+pg8000://user:pass@host/db`), but it has never been deployed. There is no replication and no managed failover; backups are a cron job on
  this same box, described under Backups below.
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

## Backups

`deploy/backup_db.sh` snapshots the production DB once a day and pushes it off
the box. It is a cron job, not part of `deploy.sh` — a backup has to run on its
own schedule, and there is no reason to ship 7MB to object storage on every
deploy.

```
backend/congestion.db  (216MB, collector writing every 5 min)
  → sqlite3 online backup API → temp snapshot   ← safe mid-write; a plain cp,
                                                  or gzipping the live file
                                                  (~6.5s), can tear
  → PRAGMA quick_check + row count > 0          ← fails here = no upload
  → gzip                 → congestion-YYYY-MM-DD.db.gz  (6.5MB, 30× smaller)
  → /home/ubuntu/backups/                       last 7 days
  → OCI Object Storage, bucket `exhibition-backups`   90 days, lifecycle rule
  → touch .last_upload                          ← only after the PUT returns
```

The server is OCI (`VM.Standard.E2.1.Micro`, `ap-tokyo-1`), not EC2, and Always
Free covers this entirely: 10 GiB Standard object storage against ~7MB/day.

gzip rather than zstd, which is also installed and measured smaller and faster
(3.2s/3.5MB vs 6.5s/6.8MB on this box). Both are already trivially small, so
zstd's win buys nothing, while `gunzip` exists on whatever machine you end up
restoring from in a hurry.

### One-time setup

1. **Bucket** — Object Storage → Create Bucket, name `exhibition-backups`,
   Standard tier.

2. **Lifecycle rule** — in that bucket, `expire-90d`: target Objects, action
   Delete, 90 days. Creating it fails with `InsufficientServicePermissions`
   until the Object Storage *service* is allowed to act on your behalf; the
   console offers to add the policy, which lands in the root compartment as:

   ```
   Allow service objectstorage-ap-tokyo-1 to manage object-family in tenancy
   ```

   Do not add a `Move to Archive` or `Move to Infrequent Access` action yet —
   see the capacity note below.

3. **Pre-authenticated request** — in that bucket, a PAR named `backup-upload`:
   type **Bucket** (the object name changes daily, so an Object-scoped PAR will
   not do), access **Permit object writes** only, object listing off, expiry a
   couple of years out. The URL is shown once.

4. **Put the URL on the server**, outside the repo, same treatment as
   `backend/.env.local`. Use an editor, not `echo` — a token in shell history
   is a token you cannot unsee:

   ```bash
   install -m 600 /dev/null /home/ubuntu/.backup_par
   nano /home/ubuntu/.backup_par     # BACKUP_PAR_URL=https://…/o/
   ```

5. **Crontab.** `15:33 UTC = 00:33 KST` — written in UTC because this cron has
   no `CRON_TZ` and the box is `Etc/UTC`. Korea has no DST, so +9 never drifts.
   `:33` keeps it clear of the 00:02 daily batch and of the `*/5` collector and
   `*/10` MMCA grids, which would otherwise scan and INSERT at the same instant.

   ```
   33 15 * * * /home/ubuntu/exhibition-traffic/deploy/backup_db.sh >> /home/ubuntu/backups/backup.log 2>&1
   ```

Nothing to install: the upload is `curl`, which is already there. The PAR is
write-only by design — the token on the box cannot read or list the backups, so
compromising the server does not hand over the archive history.

### Restore

Each archive is a **full copy of the whole database**, not an increment, so any
one of them is enough. What retention buys is not data but *points in time*: a
90-day window means a corruption is recoverable if it is noticed within 90 days,
because every snapshot taken after the damage contains the damage.

Download from the console (the upload PAR cannot read), then:

```bash
gunzip -c congestion-2026-08-24.db.gz > /tmp/restore.db
# no sqlite3 CLI on the box; use the app venv
backend/.venv/bin/python3 -c "import sqlite3;print(sqlite3.connect('/tmp/restore.db').execute('pragma integrity_check').fetchone())"
sudo systemctl stop exhibition-backend
cp /tmp/restore.db /home/ubuntu/exhibition-traffic/backend/congestion.db
sudo systemctl start exhibition-backend
```

### Knowing it still works

`/health/collection` carries `backup.age_hours`, the age of the last *off-box*
upload — the stamp is touched only after the PUT returns, so a local archive
whose upload failed does not read as healthy. This matters more than it looks:
a PAR expires, and a cron job that has silently stopped is the normal way a
backup is discovered to be missing.

It is reported but **never returns 503**: a late backup is worth seeing, not
worth paging for, and a threshold this endpoint cannot satisfy is what once
pinned it at a permanent 503. `age_hours` is `null` on dev machines, which have
no backup dir.

### Capacity, and why not a longer window

Snapshots are full copies of a database that grows ~287 rows/day, so each one is
bigger than the last (~0.18MB/day compressed) and the bucket total grows with
the *square* of time, not linearly:

```
total(day T, N-day retention) ≈ 0.18 × N × (T − N/2)  MB
```

Against the 10 GiB free tier, measured from the 2026-07-16 collection start:

| retention | free tier reached |
| --- | --- |
| 30 days | ~5.5 years |
| **90 days** (current) | **~1.9 years** |
| 346 days or more | ~11 months — *the rule never fires before the limit* |

A 1000-day rule is therefore identical to no rule at all. When the limit does
come into view, the next step is a `Move to Infrequent Access` transition at 31
days with deletion at a year: IA is a separate 10 GiB allowance, reads
immediately (unlike Archive, which needs a restore request and up to an hour),
and its 31-day minimum retention fits that schedule where Archive's 90-day
minimum does not fit this one.

## Docs

- Design spec: `docs/superpowers/specs/2026-07-15-exhibition-congestion-prediction-design.md`
- Implementation plan: `docs/superpowers/plans/2026-07-15-exhibition-congestion-prediction-plan.md`
