import logging
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import date

import httpx

BASE_URL = "https://api.kcisa.kr/openapi/service/rest/moca/docMeta"

# 최신순으로 내려온다. 확인 시점 totalCount 는 3976 이고 300건째가 이미 2024년
# 이라, 진행중 전시는 3페이지 안에 전부 들어온다. 전량을 받으면 40번 호출이다.
PAGE_COUNT = 3
ROWS_PER_PAGE = 100

# 응답의 venue 는 관 이름뿐이다 — 전시실 정보는 이 API 어디에도 없다(그래서
# 전시명이 방 카드가 아니라 헤더에 관 단위로 붙는다). 여기 없는 값(청주,
# 레지던시, 해외)은 우리가 페이지를 가진 관이 아니라 버린다.
VENUE_IDS: dict[str, str] = {
    "서울": "seoul",
    "과천": "gwacheon",
    # 과천관 1층에 있다 (MMCA_SPACE_NAMES 의 MMCA-SPACE-2008).
    "어린이미술관": "gwacheon",
    "덕수궁": "deoksugung",
}

logger = logging.getLogger(__name__)


@dataclass
class MmcaExhibition:
    title: str
    start_date: str
    end_date: str


def fetch_exhibition_pages(client: httpx.Client, api_key: str) -> list[str]:
    pages = []
    for page_no in range(1, PAGE_COUNT + 1):
        response = client.get(
            BASE_URL,
            params={"serviceKey": api_key, "numOfRows": ROWS_PER_PAGE, "pageNo": page_no},
            timeout=15.0,
        )
        response.raise_for_status()
        pages.append(response.text)
    return pages


def _normalize_title(title: str) -> str:
    # 제목에 <br/> 이 섞여 온다. 태그를 지우면 붙어 버리므로 공백으로 바꾼 뒤
    # 접는다. 콜론 앞 공백도 접는다 — 같은 전시가 "명작 : 수련"과 "명작: 수련"
    # 두 벌로 수록돼 있어, 이걸 맞춰야 중복으로 걸린다.
    without_tags = re.sub(r"<[^>]*>", " ", title)
    return re.sub(r"\s+:", ":", re.sub(r"\s+", " ", without_tags)).strip()


def _parse_period(period: str) -> tuple[date, date] | None:
    start, _, end = period.partition("~")
    try:
        return date.fromisoformat(start.strip()), date.fromisoformat(end.strip())
    except ValueError:
        return None


def current_exhibitions(xml_pages: list[str], today: date) -> dict[str, list[MmcaExhibition]]:
    """진행중인 전시를 관별로 모은다.

    subjectCategory(과거/현재/예정전시)는 쓰지 않는다 — 같은 전시가 세 값으로
    중복 수록돼 있고, 지금 열려 있는 전시가 '예정전시'로만 달려 있는 경우도
    있다. eventPeriod 의 날짜만이 신뢰할 수 있는 신호다.
    """
    # (관, 정규화 제목) 단위로 첫 등장만 남긴다 — 최신순이라 첫 등장이 가장
    # 최근에 수집된 판이다.
    seen: dict[tuple[str, str], MmcaExhibition] = {}
    for page in xml_pages:
        for item in ET.fromstring(page).findall(".//item"):
            venue_id = VENUE_IDS.get((item.findtext("venue") or "").strip())
            if venue_id is None:
                continue
            period = _parse_period((item.findtext("eventPeriod") or "").strip())
            if period is None:
                continue
            start, end = period
            if not start <= today <= end:
                continue
            title = _normalize_title(item.findtext("title") or "")
            if not title:
                continue
            seen.setdefault(
                (venue_id, title),
                MmcaExhibition(title=title, start_date=start.isoformat(), end_date=end.isoformat()),
            )

    # 옛 제목이 남아 있는 항목들("이대원" ↔ "이대원: 당신을 슬프게 하는 것은
    # 하나도 없다")을 접는다: 같은 관에 자기보다 긴 제목의 앞부분인 항목이
    # 있으면 그쪽이 정식 제목이다.
    #
    # ponytail: 앞부분이 겹치지 않게 개제된 전시는 그대로 두 줄로 남는다
    # (과천 상설전이 그렇다). API 가 옛 이름을 계속 흘리는 한 자동으로는
    # 못 가른다 — 눈에 거슬리면 제외 목록을 config 에 두는 수밖에 없다.
    by_venue: dict[str, list[MmcaExhibition]] = {venue: [] for venue in set(VENUE_IDS.values())}
    for (venue_id, title), exhibition in seen.items():
        if any(
            other_venue == venue_id and other_title != title and other_title.startswith(title)
            for other_venue, other_title in seen
        ):
            continue
        by_venue[venue_id].append(exhibition)

    # 최근 시작한 전시가 위로 — MMCA 누리집의 진행중 전시 목록과 같은 순서다.
    for exhibitions in by_venue.values():
        exhibitions.sort(key=lambda e: e.start_date, reverse=True)
    return by_venue
