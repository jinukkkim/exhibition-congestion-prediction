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
from collections import defaultdict
from enum import IntEnum
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Iterator, NamedTuple
from urllib.parse import parse_qs, urlsplit
from zoneinfo import ZoneInfo

from fastapi import APIRouter

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

_MOBILE_UA = re.compile(r"Mobile|Android|iPhone|iPod", re.I)
# 안드로이드 태블릿은 UA 에 Mobile 을 달지 않는 것으로 폰과 갈린다.
_TABLET_UA = re.compile(r"iPad|Tablet|Android(?!.*Mobile)", re.I)

# 먼저 맞는 것이 이긴다. 인앱 브라우저와 Chromium 파생은 UA 에 Chrome 과
# Safari 를 함께 달고 오므로 그 둘보다 앞에 둬야 제 이름을 찾는다.
_BROWSERS = (
    ("KakaoTalk", re.compile(r"KAKAOTALK", re.I)),
    ("Naver", re.compile(r"NAVER\(inapp")),
    ("Instagram", re.compile(r"Instagram")),
    ("Whale", re.compile(r"Whale/")),
    ("Samsung Internet", re.compile(r"SamsungBrowser/")),
    ("Edge", re.compile(r"Edg(A|iOS)?/")),
    ("Firefox", re.compile(r"Firefox/|FxiOS/")),
    ("Chrome", re.compile(r"Chrome/|CriOS/")),
    ("Safari", re.compile(r"Safari/")),
)

# 안드로이드 UA 에도 Linux 가, 아이폰 UA 에도 "like Mac OS X" 가 있다. 순서가 판정이다.
_OSES = (
    ("iOS", re.compile(r"iPhone|iPad|iPod")),
    ("Android", re.compile(r"Android")),
    ("Windows", re.compile(r"Windows")),
    ("macOS", re.compile(r"Macintosh|Mac OS X")),
    ("ChromeOS", re.compile(r"CrOS")),
    ("Linux", re.compile(r"Linux")),
)

_OTHER = "기타"

_UTM_KEYS = ("source", "medium", "campaign", "content", "term")

_NO_REFERRER = "직접 방문"

# How many recent page requests the visit list carries. At the traffic this
# site has (26 visits in a week) the list is the answer to "has anyone but me
# been here" — a number can't tell you that, a list can. The cap is what keeps
# the response bounded once that stops being true.
_VISIT_LIMIT = 200

# 페이지뷰는 화면이 필터마다 다시 세도록 집계 전의 행으로 내린다 — 서버에서
# 세면 필터 조합마다 캐시 미스가 나고 미스 한 번이 로그 창 전체를 훑는다.
# ponytail: 상한에 닿으면 오래된 쪽이 잘려 직전 기간 비교부터 틀어진다. 그
# 규모면 일별 rollup 테이블로 옮길 때다.
_PAGEVIEW_LIMIT = 20_000


class _Page(NamedTuple):
    at: float
    address: str
    path: str
    agent: str
    referer: str
    host: str
    query: str


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


def _visitor_label(address: str, agent: str) -> str:
    """A short stable name for a visitor, so two visits can be told apart.

    Address and user agent together, the way Vercel counts a visitor — the
    address alone makes one person of everyone behind the same NAT.

    The address itself never leaves this module — /visitors has no lock on it
    (it is only unlinked), and a page anyone can open should not be a list of
    who was here. Six hex digits over the whole IPv4 space leaves a couple of
    hundred addresses per label for any one user agent, which is enough to
    recognise "the same one came back" and not enough to read off an address.
    """
    return hashlib.sha256(f"{address}\n{agent}".encode()).hexdigest()[:6]


def _first_match(agent: str, table: tuple[tuple[str, re.Pattern], ...]) -> str:
    return next((name for name, pattern in table if pattern.search(agent)), _OTHER)


def _browser(agent: str) -> str:
    return _first_match(agent, _BROWSERS)


def _os(agent: str) -> str:
    return _first_match(agent, _OSES)


def _device(agent: str) -> str:
    if _TABLET_UA.search(agent):
        return "tablet"
    return "mobile" if _MOBILE_UA.search(agent) else "desktop"


def _utm(query: str) -> dict[str, str]:
    params = parse_qs(query)
    return {key: params[f"utm_{key}"][0] for key in _UTM_KEYS if params.get(f"utm_{key}")}


def _log_files(since: date) -> tuple[list[Path], bool]:
    """access.log and the rolled siblings that can still hold `since`.

    And whether a rolled file was skipped for being older than that — which
    proves the log reaches back past `since` without opening it.
    """
    path = Path(settings.caddy_access_log)
    files: list[Path] = []
    older_skipped = False
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
            older_skipped = True
            continue
        files.append(candidate)
    return files, older_skipped


def _entries(paths: list[Path]) -> Iterator[dict]:
    for path in paths:
        opener = gzip.open if path.suffix == ".gz" else open
        try:
            # encoding 을 안 주면 로케일 기본값을 따른다. systemd 유닛에는 LANG 이
            # 없고, 그 자리에서 UTF-8 이 되는 것은 CPython 의 로케일 강제(PEP 538)
            # 덕이지 보장이 아니다. errors="replace" 때문에 어긋나도 예외가 아니라
            # 한글 referrer 와 경로가 조용히 깨진 채 집계된다.
            with opener(path, "rt", encoding="utf-8", errors="replace") as handle:
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


class _Log(NamedTuple):
    pages: list[_Page]
    # The calls that confirm a page, by address.
    calls: dict[str, list[float]]
    # How far back the log reaches, or None if there is none.
    coverage: float | None


def _collect(since: date) -> _Log:
    """One pass over the log: the page requests, and the calls that confirm them."""
    files, older_skipped = _log_files(since)
    pages: list[_Page] = []
    calls: defaultdict[str, list[float]] = defaultdict(list)
    oldest: float | None = None

    for entry in _entries(files):
        request = entry.get("request")
        at = entry.get("ts")
        if not isinstance(request, dict) or not isinstance(at, (int, float)):
            continue
        oldest = at if oldest is None else min(oldest, at)
        if entry.get("status", 200) >= 400:
            continue
        address = request.get("client_ip") or request.get("remote_ip") or ""
        uri = request.get("uri", "")
        if _is_page_view(uri):
            headers = request.get("headers") or {}
            parts = urlsplit(uri)
            pages.append(
                _Page(
                    at=at,
                    address=address,
                    path=parts.path.rstrip("/") or "/",
                    agent=(headers.get("User-Agent") or [""])[0],
                    referer=(headers.get("Referer") or [""])[0],
                    host=request.get("host", ""),
                    query=parts.query,
                )
            )
        elif urlsplit(uri).path.startswith(_CONFIRM_PREFIXES):
            calls[address].append(at)

    # Caddy writes a line when the request finishes, so a slow one lands after a
    # faster one that started later. Close to sorted, not sorted.
    for series in calls.values():
        series.sort()

    if older_skipped:
        # 열지 않은 더 오래된 파일이 있다 — 첫 줄 시각이 아니라 창의 시작까지는
        # 확실히 덮여 있다. 첫 줄로 재면 직전 기간 비교가 이유 없이 사라진다.
        floor = datetime.combine(since, time(), tzinfo=_SEOUL_TZ).timestamp()
        oldest = floor if oldest is None else min(oldest, floor)
    return _Log(pages, calls, oldest)


def _app_started(calls: dict[str, list[float]], page: _Page) -> bool:
    """Was there a call from that address just after the page was served?

    The call is not consumed, so one address's traffic confirms every page
    request in the same window. Behind a NAT that shares an address between a
    person with a tab open and a scanner, the scanner's request rides on the
    person's poll and counts as human. It is the same ceiling as counting
    unique visitors by address, and it moves the same way: a beacon the app
    sends itself is what separates them, and that needs a table.
    """
    series = calls.get(page.address)
    if not series:
        return False
    index = bisect.bisect_left(series, page.at)
    return index < len(series) and series[index] <= page.at + _CONFIRM_WINDOW_SECONDS


def _window(days: int, now: datetime) -> tuple[datetime, datetime]:
    """This period's start, and the start of the one before it."""
    if days == 1:
        # Vercel 의 "Last 24 Hours" 처럼 달력 하루가 아니라 지금부터 거꾸로 24시간.
        return now - timedelta(hours=24), now - timedelta(hours=48)
    start = datetime.combine(now.date() - timedelta(days=days - 1), time(), tzinfo=_SEOUL_TZ)
    return start, start - timedelta(days=days)


def _iso(at: float) -> str:
    return datetime.fromtimestamp(at, _SEOUL_TZ).replace(microsecond=0).isoformat()


def _aggregate(days: int, now: datetime) -> dict:
    now = now.replace(microsecond=0)
    start, previous_start = _window(days, now)
    log = _collect(previous_start.date())

    pageviews: list[dict] = []
    recent: list[dict] = []
    bots = unconfirmed = 0

    for page in sorted(log.pages):
        # 직전 기간까지 싣는다 — 화면이 증감률을 거기서 센다.
        if page.at < previous_start.timestamp():
            continue

        if _BOT_UA.search(page.agent):
            kind = "bot"
        elif not _app_started(log.calls, page):
            # HTML 만 받아 가고 앱은 뜨지 않았다. 대개 스캐너지만 봇 이름을 달지
            # 않으므로 봇과 한 칸에 넣지 않는다 — 백엔드가 죽어 있던 동안의 진짜
            # 방문도 여기로 떨어지고, 그때는 그 사실이 보이는 편이 낫다.
            kind = "unconfirmed"
        else:
            kind = "human"

        # Addresses are hashed into the label and dropped — no address
        # reaches the response.
        row = {
            "at": _iso(page.at),
            "path": page.path,
            "visitor": _visitor_label(page.address, page.agent),
            "device": _device(page.agent),
            "browser": _browser(page.agent),
            "os": _os(page.agent),
            "referrer": _referrer_source(page.referer, page.host),
            "utm": _utm(page.query),
        }
        if kind == "human":
            pageviews.append(row)
        if page.at >= start.timestamp():
            recent.append({**row, "kind": kind})
            bots += kind == "bot"
            unconfirmed += kind == "unconfirmed"

    return {
        "start": start.isoformat(),
        "previous_start": previous_start.isoformat(),
        "coverage_start": None if log.coverage is None else _iso(log.coverage),
        "pageviews": pageviews[-_PAGEVIEW_LIMIT:],
        # 최근 것부터. 잘리는 쪽은 오래된 끝이다.
        "recent": recent[-_VISIT_LIMIT:][::-1],
        "excluded": {"bots": bots, "unconfirmed": unconfirmed},
    }


class Range(IntEnum):
    """화면의 기간 탭(VisitorsPage 의 RANGES)이 쓰는 값 전부.

    임의의 1~365 를 받으면 값마다 캐시 슬롯이 따로 생겨 10분 TTL 이 무의미해진다.
    이 라우트는 잠겨 있지 않고 캐시 미스 한 번이 로그 창 전체를 훑는 일이라
    (보관 상한에서 원본 8.8GB, 약 35초) days 를 1부터 세는 것만으로 같은 박스의
    혼잡도 API 까지 함께 느려진다. 화면이 안 쓰는 값을 받을 이유도 없다.

    Literal[1, 7, 30, 90] 이 더 짧지만 pydantic 2.13 이 쿼리스트링 "30" 을 int 로
    바꾸지 않아 정상 요청까지 422 가 된다. IntEnum 은 그 변환을 한다.
    """

    day = 1
    week = 7
    month = 30
    quarter = 90


@router.get("/visits")
def visits(days: Range = Range.month) -> dict:
    # int() 세 번: 캐시 키가 f-string 이라 IntEnum 의 __str__ 에 기대면 파이썬
    # 버전에 따라 "analytics:visits:Range.month" 가 되고, 그 어긋남은 프로덕션
    # 에서만 조용히 드러난다.
    cached = cache.get_analytics(int(days))
    if cached is not None:
        return cached
    # 한 번에 로그 창 전체를 훑는다. 개발자 한 사람이 가끔 여는 페이지라 그
    # 비용은 캐시로 덮으면 충분하다 — 열어둔 탭이 폴링하지 않는다.
    result = _aggregate(int(days), datetime.now(_SEOUL_TZ))
    cache.set_analytics(int(days), result)
    return result
