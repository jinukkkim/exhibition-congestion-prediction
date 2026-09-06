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

import gzip
import json
import re
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterator
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Query

from app import cache
from app.config import settings

router = APIRouter(prefix="/analytics")

_SEOUL_TZ = ZoneInfo("Asia/Seoul")

# Everything Caddy routes to the backend. The SPA is the catch-all underneath,
# so "not one of these, and not a file" is what a page request looks like from
# the log's side. Keep in step with deploy/Caddyfile's handle blocks.
_BACKEND_PREFIXES = ("/congestion", "/mmca", "/health", "/analytics")

# Deliberately broad. A missed bot inflates the visitor count, which is the
# number this page exists to answer; a browser wrongly called a bot only moves
# one view into the column next to it, which is still on screen. UptimeRobot
# alone accounts for most of what this catches — it polls /health every five
# minutes, but follows redirects and warms the root as well.
_BOT_UA = re.compile(
    r"bot|crawl|spider|slurp|monitor|uptimerobot|curl|wget|python-|headless|scan|"
    r"preview|probe|lighthouse",
    re.I,
)

_MOBILE_UA = re.compile(r"Mobile|Android|iPhone|iPad|iPod", re.I)

_NO_REFERRER = "직접 방문"


def _is_page_view(uri: str) -> bool:
    path = urlsplit(uri).path
    if path.startswith(_BACKEND_PREFIXES):
        return False
    # /assets/index-a1b2c3.js, /favicon.ico: things a page pulls in after it
    # loads, not a page someone opened. A dot in the last segment is the only
    # thing separating them, since every real route here is dotless.
    return "." not in path.rsplit("/", 1)[-1]


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


def _aggregate(days: int, now: datetime) -> dict:
    since = (now - timedelta(days=days - 1)).date()
    views: defaultdict[date, int] = defaultdict(int)
    bots: defaultdict[date, int] = defaultdict(int)
    # Addresses are counted and dropped — the set never leaves this function
    # and no address reaches the response.
    seen: defaultdict[date, set[str]] = defaultdict(set)
    referrers: Counter[str] = Counter()
    devices: Counter[str] = Counter()

    for entry in _entries(since):
        request = entry.get("request")
        if not isinstance(request, dict) or entry.get("status", 200) >= 400:
            continue
        if not _is_page_view(request.get("uri", "")):
            continue
        try:
            day = datetime.fromtimestamp(entry["ts"], _SEOUL_TZ).date()
        except (KeyError, TypeError, ValueError, OSError):
            continue
        if day < since:
            continue

        headers = request.get("headers") or {}
        agent = (headers.get("User-Agent") or [""])[0]
        if _BOT_UA.search(agent):
            bots[day] += 1
            continue

        views[day] += 1
        seen[day].add(request.get("client_ip") or request.get("remote_ip") or "")
        devices["mobile" if _MOBILE_UA.search(agent) else "desktop"] += 1
        source = _referrer_source(
            (headers.get("Referer") or [""])[0], request.get("host", "")
        )
        if source:
            referrers[source] += 1

    window = [since + timedelta(days=n) for n in range(days)]
    return {
        # 트래픽이 없던 날도 0 으로 싣는다 — 빠지면 추이의 가로축이 조용히
        # 압축되어 뜸했던 기간이 안 보인다.
        "daily": [
            {
                "date": day.isoformat(),
                "views": views[day],
                "visitors": len(seen[day]),
                "bots": bots[day],
            }
            for day in window
        ],
        "referrers": [
            {"source": source, "views": count} for source, count in referrers.most_common(20)
        ],
        "devices": {"mobile": devices["mobile"], "desktop": devices["desktop"]},
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
