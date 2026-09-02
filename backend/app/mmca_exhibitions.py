import re
from dataclasses import dataclass, field

import httpx

from app.config import MMCA_SPACE_NAMES, settings

# 누리집 전시 목록 화면이 쓰는 JSON 엔드포인트다. exhFlag=1 이 "진행중"이라
# 날짜 필터가 필요 없다.
#
# 공공데이터포털의 전시정보 API(문화체육관광부_전시정보(국립현대미술관)) 대신
# 이걸 쓰는 이유는 하나다: 그 API 는 장소를 관 이름까지만 준다. 전시실을 주는
# 곳은 여기뿐이다. 덤으로 중복 수록과 옛 제목 잔재도 없다.
#
# ponytail: 문서화된 API 가 아니라 화면이 쓰는 내부 엔드포인트다. 누리집이
# 개편되면 깨진다 — 깨지면 전시 줄만 사라지고 혼잡도는 그대로 읽히게 두는
# 것이 이 기능의 실패 방식이다(라우트가 500 을 내면 프론트가 섹션을 숨긴다).
# 공공데이터 API 가 전시실을 내려주기 시작하면 그때 갈아탄다.
BASE_URL = "https://www.mmca.go.kr/exhibitions/AjaxExhibitionList.do"

# 이 UA 가 없으면 누리집이 400 Request Blocked 를 낸다.
_HEADERS = {"User-Agent": "Mozilla/5.0"}

# 한 요청이 8건씩만 준다. 진행중 전시가 20건을 넘긴 적은 없지만, 페이지 수는
# 응답의 paginationInfo 를 따르고 이 값은 폭주 방지선으로만 쓴다.
MAX_PAGES = 10

# 응답 exhPlaNm -> 우리 관 id. 여기 없는 값(청주, 레지던시, 해외)은 우리가
# 페이지를 가진 관이 아니라 버린다.
VENUE_IDS: dict[str, str] = {
    "서울": "seoul",
    "과천": "gwacheon",
    # 과천관 1층에 있다 (MMCA_SPACE_NAMES 의 MMCA-SPACE-2008).
    "어린이미술관": "gwacheon",
    "덕수궁": "deoksugung",
}

# exhPlaDtl 은 "지하1층 3,4,5 전시실 / 2층 MMCA 스튜디오" 처럼 층·전시실·기타
# 공간이 섞인 자유 문자열이다. "전시실" 바로 앞에 붙은 번호 나열만 집는다:
# "지하1층"의 1 이나 "3층"의 3 은 뒤에 "층"이 오므로 걸리지 않고,
# "2원형전시실"은 원형을 함께 삼켜 "2전시실"로 오인되지 않는다.
_ROOMS = re.compile(r"(\d+(?:\s*,\s*\d+)*)\s*(원형)?전시실")


@dataclass
class MmcaExhibition:
    title: str
    start_date: str
    end_date: str
    # 이 전시가 쓰는 전시실. 서울박스·교육동·아이공간처럼 혼잡도를 수집하지
    # 않는 공간에서만 열리는 전시는 빈 목록이라 방 카드에는 안 붙고 헤더
    # 목록에만 남는다.
    space_codes: list[str] = field(default_factory=list)


def fetch_exhibitions(client: httpx.Client) -> list[dict]:
    rows: list[dict] = []
    page_no = 1
    total_pages = 1
    while page_no <= min(total_pages, MAX_PAGES):
        response = client.get(
            BASE_URL,
            params={
                "exhFlag": 1,  # 진행중
                "searchExhPlaCd": "",
                "searchExhCd": "",
                "sort": 1,
                "pageIndex": page_no,
            },
            headers=_HEADERS,
            timeout=15.0,
        )
        response.raise_for_status()
        body = response.json()
        rows.extend(body.get("exhibitionsList") or [])
        total_pages = (body.get("paginationInfo") or {}).get("totalPageCount") or 1
        page_no += 1
    return rows


def _space_code(venue_id: str, room_name: str) -> str | None:
    # 전시실 이름은 이미 config 에 코드별로 있다 — 여기서 표를 또 만들지 않고
    # 그걸 거꾸로 찾는다. 관을 좁혀서 보므로 관끼리 같은 "3전시실" 이름이
    # 겹치지 않는다.
    for code in settings.mmca_venue_space_codes.get(venue_id, []):
        if MMCA_SPACE_NAMES.get(code) == room_name:
            return code
    return None


def space_codes(venue_id: str, place_detail: str) -> list[str]:
    codes = []
    for numbers, circular in _ROOMS.findall(place_detail):
        for number in (n.strip() for n in numbers.split(",")):
            # 우리 코드에 없는 방(과천 2원형전시실, 덕수궁 2~4전시실)은
            # 그냥 빠진다 — 혼잡도를 수집하지 않으니 붙일 카드도 없다.
            code = _space_code(venue_id, f"{number}{'원형' if circular else ''}전시실")
            if code is not None and code not in codes:
                codes.append(code)
    return codes


def current_exhibitions(rows: list[dict]) -> dict[str, list[MmcaExhibition]]:
    """진행중인 전시를 관별로 모은다. 순서는 누리집 목록 그대로(최근 개막 순)."""
    by_venue: dict[str, list[MmcaExhibition]] = {venue: [] for venue in set(VENUE_IDS.values())}
    for row in rows:
        venue_id = VENUE_IDS.get((row.get("exhPlaNm") or "").strip())
        title = (row.get("exhTitle") or "").strip()
        if venue_id is None or not title:
            continue
        by_venue[venue_id].append(
            MmcaExhibition(
                title=title,
                start_date=(row.get("exhStDt") or "").strip(),
                end_date=(row.get("exhEdDt") or "").strip(),
                space_codes=space_codes(venue_id, row.get("exhPlaDtl") or ""),
            )
        )
    return by_venue
