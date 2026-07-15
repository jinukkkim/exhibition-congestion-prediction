# Exhibition Traffic — 실시간 전시 혼잡도 예측 시스템

국립중앙박물관 실시간 혼잡도를 서울시 열린데이터광장 API에서 수집하고, 축적된 데이터로 시간대별 혼잡도를 예측하는 개인 포트폴리오 MVP. 베이스라인(요일×시간대 평균)과 scikit-learn 모델의 예측 정확도(MAE)를 비교해 보여준다.

## Prerequisites

- Python 3.12
- Node 18+ (tested with Node 24 / npm 11)
- Redis (caches the latest prediction result)
- Postgres — optional; dev defaults to a local SQLite file via `DATABASE_URL`

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
- `DATABASE_URL` — defaults to `sqlite:///./congestion.db`. For Postgres use the `pg8000` driver: `postgresql+pg8000://user:pass@host/db`
- `REDIS_URL` — defaults to `redis://localhost:6379/0`

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

## Docs

- Design spec: `docs/superpowers/specs/2026-07-15-exhibition-congestion-prediction-design.md`
- Implementation plan: `docs/superpowers/plans/2026-07-15-exhibition-congestion-prediction-plan.md`
