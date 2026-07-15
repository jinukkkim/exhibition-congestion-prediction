from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.db import init_db
from app.scheduler import build_scheduler


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    scheduler = build_scheduler()
    scheduler.start()
    yield
    scheduler.shutdown()


app = FastAPI(title="Exhibition Congestion Prediction", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
