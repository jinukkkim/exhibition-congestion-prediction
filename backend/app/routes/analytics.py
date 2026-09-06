"""Who reached the site, read out of Caddy's access log.

There is no visit table and no beacon from the frontend: Caddy already writes
every request that arrives, with the referrer, the user agent and the client
address on it, and the backend runs as `ubuntu` on the same box. So the whole
feature is a parser — nothing new is collected, and nothing about a visitor is
stored anywhere it wasn't already.

What that costs is history. The log rolls (20MiB x 20 in deploy/Caddyfile) and
the oldest file is deleted, so the daily trend reaches back only as far as the
current window — weeks, not months, and shorter the busier the site gets. A
nightly rollup into a table is the upgrade if a year-long trend ever matters.
"""

import bisect
import gzip
import hashlib
import json
import re
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterator, NamedTuple
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Query

from app import cache
from app.config import settings

router = APIRouter(prefix="/analytics")

_SEOUL_TZ = ZoneInfo("Asia/Seoul")

# The SPA's own routes, from frontend/src/App.tsx. A whitelist rather than
# "not an API path and not a file", because Caddy's catch-all answers 200 with
# index.html for *any* address — so that rule counted /.git/config,
# /_profiler/open, /.aws/credentials and /wp-json/... as visits. In the first
# week of production log that was 16 of 44, all of it vulnerability scanning.
#
# A route added to App.tsx and not here goes uncounted. That is the side to be
# wrong on: a missing page is visible (its line reads zero), a page invented by
# a scanner is not.
_PAGE_PATHS = ("/", "/logs", "/visitors")
_PAGE_PREFIXES = ("/venues/",)

# Requests only the running app makes. Every page mounts a component that
# fetches one of these immediately, so a page request followed by one of these
# from the same address is a browser that actually started the app — and one
# without is something that took the HTML and left.
#
# It is the asset requests (/assets/index-*.js) that look like the obvious
# signal and are the worse one, measured on the first week of production log:
#
#             confirmed   what it got wrong
#   assets      8 of 13   caching and in-app navigation leave no asset request,
#                         and headless crawlers fetch assets anyway (3 of them)
#   API        13 of 13   exactly the real visits, nothing else
#
# An API response is never cached and never fetched by something that only
# parses HTML, which is what makes it the sharper line.
_CONFIRM_PREFIXES = ("/congestion/", "/mmca/", "/analytics/")

# How long after the page the call may arrive. Measured: 5s and 60s classify
# the same 4,968-line log identically — the call lands within a second of the
# page or not at all, so this only needs to be past the noise.
_CONFIRM_WINDOW_SECONDS = 10

_BOT_UA = re.compile(
    r"bot|crawl|spider|slurp|monitor|uptimerobot|curl|wget|python-|headless|scan|"
    r"preview|probe|lighthouse|scrapy|netcraft|survey|"
    # A crawler puts its own address in its user agent — "(+https://scrapy.org)",
    # "(compatible; InternetMeasurement/1.0; +https://internet-measurement.com)".
    # A browser never does, so this one clause catches the ones nobody has
    # thought to name yet.
    r"\+https?://",
    re.I,
)

_MOBILE_UA = re.compile(r"Mobile|Android|iPhone|iPad|iPod", re.I)

_NO_REFERRER = "직접 방문"

# How many recent page requests the visit list carries. At the traffic this
# site has (26 visits in a week) the list is the answer to "has anyone but me
# been here" — a number can't tell you that, a list can. The cap is what keeps
# the response bounded once that stops being true.
_VISIT_LIMIT = 200


class _Page(NamedTuple):
    at: float
    address: str
    path: str
    agent: str
    referer: str
    host: str


def _is_page_view(uri: str) -> bool:
    # 끝 슬래시는 라우터가 같은 화면으로 친다 — /logs/ 와 /logs 가 다른 줄이 되면
    # 안 된다. 이 정규화로 API 경로와 /assets/*, /favicon.ico 도 함께 떨어진다.
    path = urlsplit(uri).path.rstrip("/") or "/"
    return path in _PAGE_PATHS or path.startswith(_PAGE_PREFIXES)


def _referrer_source(referer: str, host: str) -> str | None:
    """The site that sent them, or None if this view says nothing about that."""
    if not referer:
        return _NO_REFERRER
    netloc = urlsplit(referer).netloc.lower()
    if not netloc:
        return _NO_REFERRER
    # 우리 페이지에서 온 것은 유입이 아니라 새로고침·뒤로가기다. 직접 방문으로
    # 세면 그 칸이 우리 자신으로 부풀어 나머지 순위를 못 읽게 된다.
    if netloc.split(":")[0] == host.split(":")[0]:
        return None
    return netloc


def _visitor_label(address: str) -> str:
    """A short stable name for an address, so two visits can be told apart.

    The address itself never leaves this module — /visitors has no lock on it
    (it is only unlinked), and a page anyone can open should not be a list of
    who was here. Six hex digits over the whole IPv4 space leaves a couple of
    hundred addresses per label, which is enough to recognise "the same one
    came back" and not enough to read off an address.
    """
    return hashlib.sha256(address.encode()).hexdigest()[:6]


def _log_files(since: date) -> Iterator[Path]:
    """access.log and the rolled siblings that can still hold `since`."""
    path = Path(settings.caddy_access_log)
    # 롤된 파일은 access-2026-09-01T00-00-00.000.log.gz 로 같은 디렉터리에 남는다.
    # 없는 디렉터리를 glob 하면 예외 없이 빈 결과다 — 개발 머신이 그 경우다.
    for candidate in sorted(path.parent.glob(path.stem + "*")):
        try:
            rolled_at = datetime.fromtimestamp(candidate.stat().st_mtime, _SEOUL_TZ)
        except OSError:
            continue
        # A rolled file's mtime is when it was closed, so every line in it is
        # older than that. Skipping on it is what keeps a 30-day window from
        # decompressing 400MB it will throw away line by line.
        if rolled_at.date() < since:
            continue
        yield candidate


def _entries(since: date) -> Iterator[dict]:
    for path in _log_files(since):
        opener = gzip.open if path.suffix == ".gz" else open
        try:
            with opener(path, "rt", errors="replace") as handle:
                for raw in handle:
                    try:
                        yield json.loads(raw)
                    except json.JSONDecodeError:
                        # The live file's last line is half-written as often as
                        # not, and a roll can cut one in two. One bad line is
                        # one view, not a reason to answer 500.
                        continue
        except OSError:
            # Rolled away, or unreadable — mode 0644 in the Caddyfile is what
            # makes the rest readable at all.
            continue


def _collect(since: date) -> tuple[list[_Page], dict[str, list[float]]]:
    """One pass over the log: the page requests, and the calls that confirm them."""
    pages: list[_Page] = []
    calls: defaultdict[str, list[float]] = defaultdict(list)

    for entry in _entries(since):
        request = entry.get("request")
        at = entry.get("ts")
        if not isinstance(request, dict) or not isinstance(at, (int, float)):
            continue
        if entry.get("status", 200) >= 400:
            continue
        address = request.get("client_ip") or request.get("remote_ip") or ""
        uri = request.get("uri", "")
        if _is_page_view(uri):
            headers = request.get("headers") or {}
            pages.append(
                _Page(
                    at=at,
                    address=address,
                    path=urlsplit(uri).path.rstrip("/") or "/",
                    agent=(headers.get("User-Agent") or [""])[0],
                    referer=(headers.get("Referer") or [""])[0],
                    host=request.get("host", ""),
                )
            )
        elif urlsplit(uri).path.startswith(_CONFIRM_PREFIXES):
            calls[address].append(at)

    # Caddy writes a line when the request finishes, so a slow one lands after a
    # faster one that started later. Close to sorted, not sorted.
    for series in calls.values():
        series.sort()
    return pages, calls


def _app_started(calls: dict[str, list[float]], page: _Page) -> bool:
    series = calls.get(page.address)
    if not series:
        return False
    index = bisect.bisect_left(series, page.at)
    return index < len(series) and series[index] <= page.at + _CONFIRM_WINDOW_SECONDS


def _aggregate(days: int, now: datetime) -> dict:
    since = (now - timedelta(days=days - 1)).date()
    pages, calls = _collect(since)

    views: defaultdict[date, int] = defaultdict(int)
    bots: defaultdict[date, int] = defaultdict(int)
    unconfirmed: defaultdict[date, int] = defaultdict(int)
    # Addresses are counted and dropped — the set never leaves this function
    # and no address reaches the response.
    seen: defaultdict[date, set[str]] = defaultdict(set)
    referrers: Counter[str] = Counter()
    devices: Counter[str] = Counter()
    visits: list[dict] = []

    for page in sorted(pages):
        day = datetime.fromtimestamp(page.at, _SEOUL_TZ).date()
        if day < since:
            continue

        source = _referrer_source(page.referer, page.host)
        if _BOT_UA.search(page.agent):
            kind = "bot"
            bots[day] += 1
        elif not _app_started(calls, page):
            # HTML 만 받아 가고 앱은 뜨지 않았다. 대개 스캐너지만 봇 이름을 달지
            # 않으므로 봇과 한 칸에 넣지 않는다 — 백엔드가 죽어 있던 동안의 진짜
            # 방문도 여기로 떨어지고, 그때는 그 사실이 보이는 편이 낫다.
            kind = "unconfirmed"
            unconfirmed[day] += 1
        else:
            kind = "human"
            views[day] += 1
            seen[day].add(page.address)
            devices["mobile" if _MOBILE_UA.search(page.agent) else "desktop"] += 1
            if source:
                referrers[source] += 1

        visits.append(
            {
                "at": datetime.fromtimestamp(page.at, _SEOUL_TZ).replace(microsecond=0).isoformat(),
                "path": page.path,
                "kind": kind,
                "visitor": _visitor_label(page.address),
                "device": "mobile" if _MOBILE_UA.search(page.agent) else "desktop",
                "referrer": source,
            }
        )

    window = [since + timedelta(days=n) for n in range(days)]
    return {
        # 트래픽이 없던 날도 0 으로 싣는다 — 빠지면 추이의 가로축이 조용히
        # 압축되어 뜸했던 기간이 안 보인다.
        "daily": [
            {
                "date": day.isoformat(),
                "views": views[day],
                "visitors": len(seen[day]),
                "unconfirmed": unconfirmed[day],
                "bots": bots[day],
            }
            for day in window
        ],
        "referrers": [
            {"source": source, "views": count} for source, count in referrers.most_common(20)
        ],
        "devices": {"mobile": devices["mobile"], "desktop": devices["desktop"]},
        # 최근 것부터. 잘리는 쪽은 오래된 끝이다.
        "visits": visits[-_VISIT_LIMIT:][::-1],
    }


@router.get("/visits")
def visits(days: int = Query(30, ge=1, le=365)) -> dict:
    cached = cache.get_analytics(days)
    if cached is not None:
        return cached
    # 한 번에 로그 창 전체를 훑는다. 개발자 한 사람이 가끔 여는 페이지라 그
    # 비용은 캐시로 덮으면 충분하다 — 열어둔 탭이 폴링하지 않는다.
    result = _aggregate(days, datetime.now(_SEOUL_TZ))
    cache.set_analytics(days, result)
    return result
