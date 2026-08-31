import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.db import init_db
from app.routes.congestion import router as congestion_router
from app.routes.health import router as health_router
from app.routes.mmca import router as mmca_router
from app.routes.prediction import router as prediction_router
from app.routes.stream import router as stream_router
from app.scheduler import build_scheduler


# uvicorn configures its own loggers and leaves the root logger alone, so it
# stays at Python's WARNING default and every logger.info() in this package is
# silently dropped. That is not hypothetical: the collector's per-fetch timing
# was written as logger.debug, and moving it to info would have produced
# nothing at all while looking like it had been fixed.
#
# INFO rather than DEBUG: the collector logs one line per successful poll, so
# this is ~288 lines/day for Seoul plus the MMCA rounds — nothing against the
# journal's usage (307MB across 45 days), and it is what makes "when did we
# actually poll" answerable. observed_at cannot answer it, because it is the
# Open API's publication time rather than ours.
# basicConfig is a no-op when the root logger already has a handler, which is
# deliberate rather than a hole: in that case something else — pytest's capture,
# a container's log setup — already owns the output and adding a second handler
# would duplicate every line. Under uvicorn root has none (its dictConfig
# touches only the uvicorn.* loggers), so this is what installs one. Verified
# by running the app: without it, app-level info lines print zero times while
# looking configured.
logging.basicConfig(level=logging.INFO)
logging.getLogger("app").setLevel(logging.INFO)

# Third-party INFO is noise that would bury what the level was raised for.
# APScheduler narrates every job run and httpx every request — together far
# more lines than the ~288 collection records they would be sitting among.
# WARNING keeps the one APScheduler message that matters: "Run time of job
# was missed", which is how a retry budget growing past the 5-minute cycle
# would announce itself (no max_instances is set, so the default of 1 skips
# the overlapping run rather than queueing it).
for _noisy in ("apscheduler", "httpx", "httpcore"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    scheduler = build_scheduler()
    scheduler.start()
    yield
    scheduler.shutdown()


app = FastAPI(title="Exhibition Congestion Prediction", lifespan=lifespan)
app.include_router(congestion_router)
app.include_router(health_router)
app.include_router(mmca_router)
app.include_router(prediction_router)
app.include_router(stream_router)


# Liveness only — deploy.sh polls this straight after a restart, when no
# collection has run yet. Freshness lives at /health/collection.
@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
