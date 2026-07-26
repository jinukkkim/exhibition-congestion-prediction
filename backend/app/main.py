from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.db import init_db
from app.routes.congestion import router as congestion_router
from app.routes.mmca import router as mmca_router
from app.routes.prediction import router as prediction_router
from app.routes.stream import router as stream_router
from app.scheduler import build_scheduler


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    scheduler = build_scheduler()
    scheduler.start()
    yield
    scheduler.shutdown()


app = FastAPI(title="Exhibition Congestion Prediction", lifespan=lifespan)
app.include_router(congestion_router)
app.include_router(mmca_router)
app.include_router(prediction_router)
app.include_router(stream_router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
