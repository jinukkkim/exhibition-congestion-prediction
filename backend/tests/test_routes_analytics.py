import gzip
import json
import os
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import fakeredis
import pytest
from fastapi.testclient import TestClient

from app.routes.analytics import _aggregate, _browser, _device, _os

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


def current(result):
    """이번 기간의 페이지뷰만 — 응답에는 비교용 직전 기간도 함께 실린다."""
    return [p for p in result["pageviews"] if p["at"] >= result["start"]]


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


def test_each_confirmed_page_is_one_pageview(write_log):
    write_log(
        [
            *visit(NOW, uri="/"),
            *visit(NOW, uri="/venues/mmca-seoul"),
            *visit(NOW - timedelta(days=1), uri="/logs"),
        ]
    )

    paths = sorted(p["path"] for p in current(_aggregate(7, NOW)))

    assert paths == ["/", "/logs", "/venues/mmca-seoul"]


def test_api_and_asset_requests_are_not_pageviews(write_log):
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

    assert len(current(_aggregate(1, NOW))) == 1


def test_addresses_the_spa_does_not_serve_are_not_pageviews(write_log):
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

    assert len(current(_aggregate(1, NOW))) == 1


def test_a_trailing_slash_is_the_same_page(write_log):
    write_log([*visit(NOW, uri="/logs"), *visit(NOW, uri="/logs/")])

    assert [p["path"] for p in current(_aggregate(1, NOW))] == ["/logs", "/logs"]


def test_bots_are_counted_apart_from_people(write_log):
    write_log(
        [
            *visit(NOW),
            *visit(NOW, ua=UPTIME_UA),
            *visit(NOW, ua="python-requests/2.32"),
            # 이름을 몰라도 잡히는 쪽. 브라우저 UA 에는 주소가 들어가지 않는다.
            *visit(NOW, ua="Scrapy/2.17.0 (+https://scrapy.org)"),
        ]
    )

    result = _aggregate(1, NOW)

    # 봇이 순방문자나 기기 비율을 밀어올리면 두 숫자 다 못 쓰게 된다.
    assert len(current(result)) == 1
    assert result["excluded"] == {"bots": 3, "unconfirmed": 0}


def test_html_taken_without_the_app_starting_is_not_a_pageview(write_log):
    write_log(
        [
            *visit(NOW, uri="/"),
            # 스캐너는 index.html 만 받고 끊는다 — 봇 이름을 UA 에 달지 않으므로
            # 후속 호출이 없다는 사실 말고는 사람과 구분할 것이 없다.
            line(NOW, uri="/", ip="9.9.9.9", referer="https://www.netcraft.com/"),
        ]
    )

    result = _aggregate(1, NOW)

    assert len(current(result)) == 1
    # 봇 이름을 달지 않았으니 봇 칸에도 들어가지 않는다.
    assert result["excluded"] == {"bots": 0, "unconfirmed": 1}


def test_a_call_long_after_the_page_does_not_confirm_it(write_log):
    write_log(
        [
            line(NOW, uri="/"),
            # 다음 폴이 아니라 한참 뒤의 호출이면 그 페이지에서 뜬 앱이 아니다.
            line(NOW + timedelta(minutes=5), uri="/congestion/current"),
        ]
    )

    assert _aggregate(1, NOW)["excluded"]["unconfirmed"] == 1


def test_referrer_is_the_sending_host_and_our_own_pages_are_none(write_log):
    write_log(
        [
            *visit(NOW, referer="https://www.google.com/search?q=%EB%B0%95%EB%AC%BC%EA%B4%80"),
            *visit(NOW, uri="/logs", referer="https://exhibition-traffic.duckdns.org/"),
            *visit(NOW, uri="/venues/mmca-seoul"),
        ]
    )

    referrers = {p["path"]: p["referrer"] for p in current(_aggregate(1, NOW))}

    assert referrers == {
        "/": "www.google.com",
        # 우리 페이지에서 온 것은 유입이 아니라 새로고침·뒤로가기다.
        "/logs": None,
        "/venues/mmca-seoul": "직접 방문",
    }


def test_utm_parameters_are_read_off_the_landing_address(write_log):
    write_log(
        [
            *visit(NOW, uri="/?utm_source=instagram&utm_medium=social&utm_campaign=%EA%B0%80%EC%9D%84"),
            *visit(NOW, uri="/logs"),
        ]
    )

    utm = {p["path"]: p["utm"] for p in current(_aggregate(1, NOW))}

    assert utm == {
        "/": {"source": "instagram", "medium": "social", "campaign": "가을"},
        "/logs": {},
    }


@pytest.mark.parametrize(
    "agent, browser, os_name, device",
    [
        (BROWSER_UA, "Chrome", "macOS", "desktop"),
        (PHONE_UA, "Safari", "iOS", "mobile"),
        (
            "Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) "
            "SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36",
            "Samsung Internet",
            "Android",
            "mobile",
        ),
        (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
            "(KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.8.5",
            "KakaoTalk",
            "iOS",
            "mobile",
        ),
        (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/128.0 Whale/3.27 Safari/537.36",
            "Whale",
            "Windows",
            "desktop",
        ),
        (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/128.0 Safari/537.36 Edg/128.0",
            "Edge",
            "Windows",
            "desktop",
        ),
        (
            "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
            "Firefox",
            "Linux",
            "desktop",
        ),
        (
            "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
            "(KHTML, like Gecko) CriOS/128.0 Mobile/15E148 Safari/604.1",
            "Chrome",
            "iOS",
            "tablet",
        ),
        (
            "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/128.0 Safari/537.36",
            "Chrome",
            "Android",
            "tablet",
        ),
    ],
)
def test_user_agent_reads_as_browser_os_and_device(agent, browser, os_name, device):
    assert (_browser(agent), _os(agent), _device(agent)) == (browser, os_name, device)


def test_rows_carry_what_the_panels_break_down_by(write_log):
    write_log(visit(NOW, ua=PHONE_UA))

    (row,) = current(_aggregate(1, NOW))

    assert row["browser"] == "Safari"
    assert row["os"] == "iOS"
    assert row["device"] == "mobile"
    assert row["at"].startswith(NOW.date().isoformat())


def test_one_address_with_two_browsers_is_two_visitors(write_log):
    # 같은 NAT 뒤의 두 사람 — 주소만으로는 한 명이 된다.
    write_log([*visit(NOW, ip="1.1.1.1"), *visit(NOW, ip="1.1.1.1", ua=PHONE_UA)])

    labels = {p["visitor"] for p in current(_aggregate(1, NOW))}

    assert len(labels) == 2


def test_the_same_visitor_carries_the_same_label_and_the_address_is_not_in_it(write_log):
    write_log(
        [*visit(NOW, ip="14.47.51.124"), *visit(NOW, uri="/logs", ip="14.47.51.124"),
         *visit(NOW, ip="203.0.113.9")]
    )

    result = _aggregate(1, NOW)
    labels = [p["visitor"] for p in current(result)]

    assert len(set(labels)) == 2
    # 주소 자체는 어디에도 실리지 않는다 — /visitors 는 잠겨 있지 않다.
    assert "14.47.51.124" not in json.dumps(result)


def test_a_day_is_the_last_24_hours_and_a_week_starts_at_midnight(write_log):
    write_log([])

    day = _aggregate(1, NOW)
    week = _aggregate(7, NOW)

    assert day["start"] == (NOW - timedelta(hours=24)).isoformat()
    assert day["previous_start"] == (NOW - timedelta(hours=48)).isoformat()
    assert week["start"] == "2026-09-01T00:00:00+09:00"
    assert week["previous_start"] == "2026-08-25T00:00:00+09:00"


def test_the_previous_period_rides_along_for_the_comparison(write_log):
    write_log(
        [
            *visit(NOW),
            *visit(NOW - timedelta(days=9)),
            # 직전 기간보다도 앞은 실리지 않는다.
            *visit(NOW - timedelta(days=20)),
        ]
    )

    result = _aggregate(7, NOW)

    assert len(result["pageviews"]) == 2
    assert len(current(result)) == 1


def test_coverage_starts_at_the_oldest_line_left_in_the_log(write_log):
    write_log([*visit(NOW - timedelta(days=3)), *visit(NOW)])

    result = _aggregate(7, NOW)

    # 직전 기간이 로그에 남아 있지 않으면 화면은 증감률을 그리지 않는다.
    assert result["coverage_start"] == (NOW - timedelta(days=3)).isoformat()


def test_a_rolled_file_older_than_the_window_means_the_window_is_covered(
    write_log, tmp_path
):
    write_log(visit(NOW), rolled=visit(NOW - timedelta(days=40)))
    rolled = tmp_path / "access-2026-09-01T00-00-00.000.log.gz"
    closed = (NOW - timedelta(days=39)).timestamp()
    os.utime(rolled, (closed, closed))

    result = _aggregate(7, NOW)

    # 그 파일은 열지 않고 건너뛰지만, 그런 파일이 있다는 것만으로 창 전체가
    # 덮여 있다는 뜻이다 — 첫 줄 시각으로 재면 증감률이 이유 없이 사라진다.
    assert result["coverage_start"] <= result["previous_start"]


def test_rolled_gzip_files_are_read_too(write_log):
    write_log(visit(NOW), rolled=visit(NOW - timedelta(days=2)))

    assert len(current(_aggregate(7, NOW))) == 2


def test_a_truncated_line_does_not_lose_the_rest_of_the_file(write_log):
    write_log([*visit(NOW), '{"level":"info","ts":1757', *visit(NOW, uri="/logs")])

    assert len(current(_aggregate(1, NOW))) == 2


def test_missing_log_file_reads_as_no_traffic(tmp_path, monkeypatch):
    import app.routes.analytics as analytics

    # 개발 머신에는 Caddy 로그가 없다 — 500 이 아니라 0 이어야 한다.
    monkeypatch.setattr(
        analytics.settings, "caddy_access_log", str(tmp_path / "nope" / "access.log")
    )

    result = _aggregate(7, NOW)

    assert result["pageviews"] == []
    assert result["coverage_start"] is None


def test_recent_lists_every_kind_newest_first(write_log):
    write_log(
        [
            *visit(NOW - timedelta(hours=2), uri="/"),
            line(NOW - timedelta(hours=1), uri="/", ip="9.9.9.9"),
            *visit(NOW, uri="/logs", ua=PHONE_UA),
        ]
    )

    recent = _aggregate(1, NOW)["recent"]

    assert [v["kind"] for v in recent] == ["human", "unconfirmed", "human"]
    assert recent[0]["path"] == "/logs"
    assert recent[0]["device"] == "mobile"


def test_route_serves_the_aggregate(write_log, monkeypatch):
    import app.cache as cache_module

    monkeypatch.setattr(cache_module, "r", fakeredis.FakeRedis(decode_responses=True))
    write_log(visit(datetime.now(_SEOUL_TZ)))

    from app.main import app

    response = TestClient(app).get("/analytics/visits?days=7")

    assert response.status_code == 200
    assert len(response.json()["pageviews"]) == 1


def test_the_route_takes_only_the_ranges_the_page_offers(write_log, monkeypatch):
    import app.cache as cache_module

    monkeypatch.setattr(cache_module, "r", fakeredis.FakeRedis(decode_responses=True))
    write_log(visit(datetime.now(_SEOUL_TZ)))

    from app.main import app

    client = TestClient(app)

    assert client.get("/analytics/visits?days=1").status_code == 200
    assert client.get("/analytics/visits?days=30").status_code == 200
    # 1~365 를 열어두면 값마다 캐시 슬롯이 생겨 TTL 이 무의미해진다. 잠금 없는
    # 라우트에서 캐시 미스 한 번의 비용이 크므로 화면이 쓰는 값만 받는다.
    assert client.get("/analytics/visits?days=14").status_code == 422
