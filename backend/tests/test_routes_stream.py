import threading
import time

import fakeredis
import pytest


@pytest.fixture
def fake_redis(monkeypatch):
    import app.cache as cache_module

    fake = fakeredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(cache_module, "r", fake)
    return fake


def test_stream_route_registered():
    from app.main import app

    schema = app.openapi()
    assert "get" in schema["paths"]["/congestion/stream"]


def test_stream_emits_published_message(fake_redis):
    # NOTE: this deliberately does not go through FastAPI's TestClient.
    # starlette's TestClient (and httpx's ASGITransport) fully drain the
    # ASGI app's response body before `handle_request`/`client.stream()`
    # returns anything to the caller -- there is no support for reading a
    # streaming response incrementally. `_event_source()` is an infinite
    # generator by design (it keeps listening on the redis channel forever),
    # so driving it through TestClient deadlocks: the request never
    # "completes" for the test client to return from. Verified against
    # starlette 1.3.1 / httpx 0.28.1 in this environment -- confirmed via a
    # standalone repro that `with client.stream(...)` never even returns the
    # response object.
    #
    # Instead, exercise the actual generator the route uses, which is what
    # matters: a redis publish on UPDATE_CHANNEL becomes a `data: ...`
    # chunk. Run it on a background thread since it blocks until a message
    # arrives, and publish only once we can see (via pubsub_numsub) that the
    # generator has actually subscribed -- pub/sub does not replay messages
    # published before a subscriber attaches.
    from app.routes.stream import _event_source

    gen = _event_source()
    result: dict[str, str] = {}

    def consume() -> None:
        result["chunk"] = next(gen)

    thread = threading.Thread(target=consume, daemon=True)
    thread.start()

    deadline = time.monotonic() + 2
    while fake_redis.pubsub_numsub("congestion:updates")[0][1] == 0:
        if time.monotonic() > deadline:
            pytest.fail("generator never subscribed to the channel")
        time.sleep(0.01)

    fake_redis.publish("congestion:updates", '{"congest_level": "보통"}')

    thread.join(timeout=2)
    assert not thread.is_alive(), "generator did not yield after publish"
    assert "보통" in result["chunk"]
    assert result["chunk"].startswith("data: ")
