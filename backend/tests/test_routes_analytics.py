import gzip
import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import fakeredis
import pytest
from fastapi.testclient import TestClient

from app.routes.analytics import _aggregate

_SEOUL_TZ = ZoneInfo("Asia/Seoul")

NOW = datetime(2026, 9, 7, 15, 0, tzinfo=_SEOUL_TZ)

BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0 Safari/537.36"
)
PHONE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
)
HOST = "exhibition-traffic.duckdns.org"
UPTIME_UA = "Mozilla/5.0+(compatible; UptimeRobot/2.0; http://uptimerobot.com/)"


def line(
    at,
    uri="/",
    ip="1.1.1.1",
    ua=BROWSER_UA,
    referer=None,
    status=200,
    host=HOST,
):
    headers = {"User-Agent": [ua]}
    if referer:
        headers["Referer"] = [referer]
    return json.dumps(
        {
            "level": "info",
            "ts": at.timestamp(),
            "msg": "handled request",
            "request": {
                "client_ip": ip,
                "remote_ip": ip,
                "method": "GET",
                "host": host,
                "uri": uri,
                "headers": headers,
            },
            "status": status,
        }
    )


def visit(at, uri="/", ip="1.1.1.1", ua=BROWSER_UA, referer=None, host=HOST):
    """페이지 한 번과, 그 페이지에서 앱이 실제로 떴다는 증거 한 번.

    브라우저는 index.html 을 받으면 곧바로 화면이 부르는 API 를 친다. 그 뒤가
    없는 페이지 요청은 HTML 만 받아 간 것이므로, 두 줄이 한 번의 방문이다.
    """
    return [
        line(at, uri=uri, ip=ip, ua=ua, referer=referer, host=host),
        line(at + timedelta(seconds=1), uri="/congestion/current", ip=ip, ua=ua),
    ]


@pytest.fixture
def write_log(tmp_path, monkeypatch):
    """Point the route at a throwaway access.log and let a test fill it."""
    import app.routes.analytics as analytics

    path = tmp_path / "access.log"
    monkeypatch.setattr(analytics.settings, "caddy_access_log", str(path))

    def write(lines, rolled=None):
        path.write_text("\n".join(lines) + "\n")
        if rolled:
            # Caddy 가 롤하며 남기는 이름 그대로 — gzip 이 기본이다.
            with gzip.open(tmp_path / "access-2026-09-01T00-00-00.000.log.gz", "wt") as f:
                f.write("\n".join(rolled) + "\n")

    return write


def test_counts_page_views_per_day(write_log):
    write_log(
        [
            *visit(NOW, uri="/"),
            *visit(NOW, uri="/venues/mmca-seoul"),
            *visit(NOW - timedelta(days=1), uri="/logs"),
        ]
    )

    daily = {d["date"]: d for d in _aggregate(7, NOW)["daily"]}

    assert daily["2026-09-07"]["views"] == 2
    assert daily["2026-09-06"]["views"] == 1


def test_daily_covers_the_whole_window_even_where_nothing_was_served(write_log):
    write_log(visit(NOW))

    daily = _aggregate(7, NOW)["daily"]

    # 빈 날이 빠지면 추이 그래프의 가로축이 조용히 압축된다.
    assert [d["date"] for d in daily] == [
        (NOW - timedelta(days=n)).date().isoformat() for n in range(6, -1, -1)
    ]
    assert daily[0]["views"] == 0


def test_api_and_asset_requests_are_not_visits(write_log):
    write_log(
        [
            *visit(NOW, uri="/"),
            line(NOW, uri="/mmca/rooms?venue=seoul"),
            line(NOW, uri="/congestion/current"),
            line(NOW, uri="/health/collection"),
            line(NOW, uri="/assets/index-a1b2c3.js"),
            line(NOW, uri="/favicon.ico"),
        ]
    )

    assert _aggregate(1, NOW)["daily"][-1]["views"] == 1


def test_addresses_the_spa_does_not_serve_are_not_visits(write_log):
    # 전부 프로덕션 로그에서 그대로 가져온 것이다. Caddy 폴백이 index.html 로
    # 200 을 답하므로, 셈에서 떼려면 주소가 우리 라우트인지 봐야 한다.
    write_log(
        [
            *visit(NOW, uri="/venues/mmca-seoul"),
            *visit(NOW, uri="/.git/config"),
            *visit(NOW, uri="/.aws/credentials"),
            *visit(NOW, uri="/_profiler/open"),
            *visit(NOW, uri="/wp-json/gravitysmtp/v1/tests/mock-data"),
            *visit(NOW, uri="/_rNd9xZ7kL3"),
        ]
    )

    assert _aggregate(1, NOW)["daily"][-1]["views"] == 1


def test_a_trailing_slash_is_the_same_page(write_log):
    write_log([*visit(NOW, uri="/logs"), *visit(NOW, uri="/logs/")])

    assert _aggregate(1, NOW)["daily"][-1]["views"] == 2


def test_a_crawler_that_advertises_its_url_is_a_bot(write_log):
    # 이름을 몰라도 잡히는 쪽. 브라우저 UA 에는 주소가 들어가지 않는다.
    write_log(
        [
            *visit(NOW),
            *visit(NOW, ua="Scrapy/2.17.0 (+https://scrapy.org)"),
            *visit(NOW, ua="Mozilla/5.0 (compatible; ForestEngine/1.0; +https://forest.example)"),
        ]
    )

    today = _aggregate(1, NOW)["daily"][-1]

    assert today["views"] == 1
    assert today["bots"] == 2


def test_visitors_counts_each_address_once_a_day(write_log):
    write_log(
        [
            *visit(NOW, ip="1.1.1.1"),
            *visit(NOW, uri="/logs", ip="1.1.1.1"),
            *visit(NOW, ip="2.2.2.2"),
        ]
    )

    today = _aggregate(1, NOW)["daily"][-1]

    assert today["views"] == 3
    assert today["visitors"] == 2


def test_bots_are_counted_apart_from_people(write_log):
    write_log([*visit(NOW), *visit(NOW, ua=UPTIME_UA), *visit(NOW, ua="python-requests/2.32")])

    today = _aggregate(1, NOW)["daily"][-1]

    assert today["views"] == 1
    assert today["bots"] == 2
    # 봇이 순방문자나 기기 비율을 밀어올리면 두 숫자 다 못 쓰게 된다.
    assert today["visitors"] == 1
    assert _aggregate(1, NOW)["devices"] == {"mobile": 0, "desktop": 1}


def test_referrers_group_by_host_and_skip_our_own_pages(write_log):
    write_log(
        [
            *visit(NOW, referer="https://www.google.com/search?q=%EB%B0%95%EB%AC%BC%EA%B4%80"),
            *visit(NOW, referer="https://www.google.com/"),
            *visit(NOW, uri="/logs", referer="https://exhibition-traffic.duckdns.org/"),
            *visit(NOW),
        ]
    )

    referrers = _aggregate(1, NOW)["referrers"]

    assert referrers == [
        {"source": "www.google.com", "views": 2},
        {"source": "직접 방문", "views": 1},
    ]


def test_devices_split_by_user_agent(write_log):
    write_log([*visit(NOW), *visit(NOW, ua=PHONE_UA), *visit(NOW, ua=PHONE_UA)])

    assert _aggregate(1, NOW)["devices"] == {"mobile": 2, "desktop": 1}


def test_rolled_gzip_files_are_read_too(write_log):
    write_log(visit(NOW), rolled=visit(NOW - timedelta(days=2)))

    daily = {d["date"]: d for d in _aggregate(7, NOW)["daily"]}

    assert daily["2026-09-05"]["views"] == 1


def test_a_truncated_line_does_not_lose_the_rest_of_the_file(write_log):
    write_log([*visit(NOW), '{"level":"info","ts":1757', *visit(NOW, uri="/logs")])

    assert _aggregate(1, NOW)["daily"][-1]["views"] == 2


def test_missing_log_file_reads_as_no_traffic(tmp_path, monkeypatch):
    import app.routes.analytics as analytics

    # 개발 머신에는 Caddy 로그가 없다 — 500 이 아니라 0 이어야 한다.
    monkeypatch.setattr(
        analytics.settings, "caddy_access_log", str(tmp_path / "nope" / "access.log")
    )

    result = _aggregate(7, NOW)

    assert sum(d["views"] for d in result["daily"]) == 0
    assert result["referrers"] == []


def test_route_serves_the_aggregate(write_log, monkeypatch):
    import app.cache as cache_module

    monkeypatch.setattr(cache_module, "r", fakeredis.FakeRedis(decode_responses=True))
    write_log(visit(datetime.now(_SEOUL_TZ)))

    from app.main import app

    response = TestClient(app).get("/analytics/visits?days=7")

    assert response.status_code == 200
    body = response.json()
    assert len(body["daily"]) == 7
    assert body["daily"][-1]["views"] == 1


def test_html_taken_without_the_app_starting_is_not_a_visit(write_log):
    write_log(
        [
            *visit(NOW, uri="/"),
            # 스캐너는 index.html 만 받고 끊는다 — 봇 이름을 UA 에 달지 않으므로
            # 후속 호출이 없다는 사실 말고는 사람과 구분할 것이 없다.
            line(NOW, uri="/", ip="9.9.9.9"),
        ]
    )

    today = _aggregate(1, NOW)["daily"][-1]

    assert today["views"] == 1
    assert today["visitors"] == 1
    assert today["unconfirmed"] == 1
    # 봇 이름을 달지 않았으니 봇 칸에도 들어가지 않는다.
    assert today["bots"] == 0


def test_a_call_long_after_the_page_does_not_confirm_it(write_log):
    write_log(
        [
            line(NOW, uri="/"),
            # 다음 폴이 아니라 한참 뒤의 호출이면 그 페이지에서 뜬 앱이 아니다.
            line(NOW + timedelta(minutes=5), uri="/congestion/current"),
        ]
    )

    assert _aggregate(1, NOW)["daily"][-1]["unconfirmed"] == 1


def test_an_unconfirmed_page_does_not_reach_referrers_or_devices(write_log):
    write_log([line(NOW, uri="/", referer="https://www.netcraft.com/")])

    result = _aggregate(1, NOW)

    assert result["referrers"] == []
    assert result["devices"] == {"mobile": 0, "desktop": 0}


def test_visits_list_newest_first_and_says_what_each_one_was(write_log):
    write_log(
        [
            *visit(NOW - timedelta(hours=2), uri="/"),
            line(NOW - timedelta(hours=1), uri="/", ip="9.9.9.9"),
            *visit(NOW, uri="/logs", ua=PHONE_UA),
        ]
    )

    visits = _aggregate(1, NOW)["visits"]

    assert [v["kind"] for v in visits] == ["human", "unconfirmed", "human"]
    assert visits[0]["path"] == "/logs"
    assert visits[0]["device"] == "mobile"
    assert visits[0]["at"].startswith(NOW.date().isoformat())


def test_the_same_address_carries_the_same_label_and_the_address_is_not_in_it(write_log):
    write_log([*visit(NOW, ip="14.47.51.124"), *visit(NOW, ip="203.0.113.9")])

    visits = _aggregate(1, NOW)["visits"]
    labels = {v["visitor"] for v in visits}

    assert len(labels) == 2
    # 주소 자체는 어디에도 실리지 않는다 — /visitors 는 잠겨 있지 않다.
    assert "14.47.51.124" not in json.dumps(visits)


def test_the_route_takes_only_the_ranges_the_page_offers(write_log, monkeypatch):
    import app.cache as cache_module

    monkeypatch.setattr(cache_module, "r", fakeredis.FakeRedis(decode_responses=True))
    write_log(visit(datetime.now(_SEOUL_TZ)))

    from app.main import app

    client = TestClient(app)

    assert client.get("/analytics/visits?days=30").status_code == 200
    # 1~365 를 열어두면 값마다 캐시 슬롯이 생겨 TTL 이 무의미해진다. 잠금 없는
    # 라우트에서 캐시 미스 한 번의 비용이 크므로 화면이 쓰는 값만 받는다.
    assert client.get("/analytics/visits?days=14").status_code == 422
    assert client.get("/analytics/visits?days=1").status_code == 422
