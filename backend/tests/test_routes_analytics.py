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
UPTIME_UA = "Mozilla/5.0+(compatible; UptimeRobot/2.0; http://uptimerobot.com/)"


def line(
    at,
    uri="/",
    ip="1.1.1.1",
    ua=BROWSER_UA,
    referer=None,
    status=200,
    host="exhibition-traffic.duckdns.org",
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
            line(NOW, uri="/"),
            line(NOW, uri="/venues/mmca-seoul"),
            line(NOW - timedelta(days=1), uri="/logs"),
        ]
    )

    daily = {d["date"]: d for d in _aggregate(7, NOW)["daily"]}

    assert daily["2026-09-07"]["views"] == 2
    assert daily["2026-09-06"]["views"] == 1


def test_daily_covers_the_whole_window_even_where_nothing_was_served(write_log):
    write_log([line(NOW)])

    daily = _aggregate(7, NOW)["daily"]

    # 빈 날이 빠지면 추이 그래프의 가로축이 조용히 압축된다.
    assert [d["date"] for d in daily] == [
        (NOW - timedelta(days=n)).date().isoformat() for n in range(6, -1, -1)
    ]
    assert daily[0]["views"] == 0


def test_api_and_asset_requests_are_not_visits(write_log):
    write_log(
        [
            line(NOW, uri="/"),
            line(NOW, uri="/mmca/rooms?venue=seoul"),
            line(NOW, uri="/congestion/current"),
            line(NOW, uri="/health/collection"),
            line(NOW, uri="/assets/index-a1b2c3.js"),
            line(NOW, uri="/favicon.ico"),
        ]
    )

    assert _aggregate(1, NOW)["daily"][-1]["views"] == 1


def test_visitors_counts_each_address_once_a_day(write_log):
    write_log(
        [
            line(NOW, ip="1.1.1.1"),
            line(NOW, uri="/logs", ip="1.1.1.1"),
            line(NOW, ip="2.2.2.2"),
        ]
    )

    today = _aggregate(1, NOW)["daily"][-1]

    assert today["views"] == 3
    assert today["visitors"] == 2


def test_bots_are_counted_apart_from_people(write_log):
    write_log([line(NOW), line(NOW, ua=UPTIME_UA), line(NOW, ua="python-requests/2.32")])

    today = _aggregate(1, NOW)["daily"][-1]

    assert today["views"] == 1
    assert today["bots"] == 2
    # 봇이 순방문자나 기기 비율을 밀어올리면 두 숫자 다 못 쓰게 된다.
    assert today["visitors"] == 1
    assert _aggregate(1, NOW)["devices"] == {"mobile": 0, "desktop": 1}


def test_referrers_group_by_host_and_skip_our_own_pages(write_log):
    write_log(
        [
            line(NOW, referer="https://www.google.com/search?q=%EB%B0%95%EB%AC%BC%EA%B4%80"),
            line(NOW, referer="https://www.google.com/"),
            line(NOW, uri="/logs", referer="https://exhibition-traffic.duckdns.org/"),
            line(NOW),
        ]
    )

    referrers = _aggregate(1, NOW)["referrers"]

    assert referrers == [
        {"source": "www.google.com", "views": 2},
        {"source": "직접 방문", "views": 1},
    ]


def test_devices_split_by_user_agent(write_log):
    write_log([line(NOW), line(NOW, ua=PHONE_UA), line(NOW, ua=PHONE_UA)])

    assert _aggregate(1, NOW)["devices"] == {"mobile": 2, "desktop": 1}


def test_rolled_gzip_files_are_read_too(write_log):
    write_log([line(NOW)], rolled=[line(NOW - timedelta(days=2))])

    daily = {d["date"]: d for d in _aggregate(7, NOW)["daily"]}

    assert daily["2026-09-05"]["views"] == 1


def test_a_truncated_line_does_not_lose_the_rest_of_the_file(write_log):
    write_log([line(NOW), '{"level":"info","ts":1757', line(NOW, uri="/logs")])

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
    write_log([line(datetime.now(_SEOUL_TZ))])

    from app.main import app

    response = TestClient(app).get("/analytics/visits?days=7")

    assert response.status_code == 200
    body = response.json()
    assert len(body["daily"]) == 7
    assert body["daily"][-1]["views"] == 1
