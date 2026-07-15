from collections.abc import Generator

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from app import cache
from app.cache import UPDATE_CHANNEL

router = APIRouter()


def _event_source() -> Generator[str, None, None]:
    pubsub = cache.r.pubsub()
    pubsub.subscribe(UPDATE_CHANNEL)
    try:
        for message in pubsub.listen():
            if message["type"] != "message":
                continue
            yield f"data: {message['data']}\n\n"
    finally:
        pubsub.close()


@router.get("/congestion/stream")
def stream_congestion() -> StreamingResponse:
    return StreamingResponse(_event_source(), media_type="text/event-stream")
