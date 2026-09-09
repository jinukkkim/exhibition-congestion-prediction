import fakeredis
import pytest
from fastapi.testclient import TestClient

PAGE = """
<div class="info">
    <a href="?schM=view&exhiSpThemId=1"><strong>우리들의 밥상</strong></a>
    <ul class="info-list special">
    <li><strong>기간</strong><p>2026-07-01~2026-10-25</p></li>
    <li><strong>장소</strong><p>국립중앙박물관 특별전시실 2</p></li>
    </ul>
"""


@pytest.fixture(autouse=True)
def fake_redis(monkeypatch):
    import app.cache as cache_module

    monkeypatch.setattr(cache_module, "r", fakeredis.FakeRedis(decode_responses=True))


@pytest.fixture
def client():
    from app.main import app

    return TestClient(app)


def test_serves_the_current_exhibitions_and_calls_the_site_once(client, monkeypatch):
    import app.routes.national_museum as routes

    calls = []

    def fake_fetch(_client):
        calls.append(1)
        return PAGE

    monkeypatch.setattr(routes, "fetch_page", fake_fetch)

    expected = [
        {
            "title": "우리들의 밥상",
            "start_date": "2026-07-01",
            "end_date": "2026-10-25",
            "place": "국립중앙박물관 특별전시실 2",
        }
    ]
    assert client.get("/national-museum/exhibitions").json() == expected
    # 두 번째 요청은 캐시에서 온다 — 방문마다 누리집을 긁지 않는다.
    assert client.get("/national-museum/exhibitions").json() == expected
    assert len(calls) == 1


def test_refetches_when_the_cache_holds_an_older_payload_shape(client, monkeypatch):
    # 배포로 응답에 필드가 하나 늘면 직전 버전이 써 둔 캐시는 새 스키마로
    # 되살릴 수 없다. 캐시 미스로 보지 않으면 TTL(6시간) 동안 전부 500 이다.
    import app.routes.national_museum as routes
    from app.cache import set_national_museum_exhibitions

    set_national_museum_exhibitions(
        [{"title": "옛 형태", "start_date": "2026-01-01", "end_date": "2026-12-31"}]
    )
    monkeypatch.setattr(routes, "fetch_page", lambda _client: PAGE)

    assert client.get("/national-museum/exhibitions").json()[0]["title"] == "우리들의 밥상"
