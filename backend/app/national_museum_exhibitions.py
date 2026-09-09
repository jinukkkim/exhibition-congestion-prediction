import html
import re
from dataclasses import dataclass

import httpx

# 누리집 "전시 > 특별 전시 > 현재 전시" 화면이다. selectTime=current 가 진행중만
# 주므로 날짜 필터가 필요 없다.
#
# 문화데이터광장의 전시정보(통합) API(api.kcisa.kr 의 API_CCA_145, 23개 기관에
# 국중박이 들어 있다) 대신 이걸 쓰는 이유는 하나다: 그 API 의 요청 인자는
# serviceKey, numOfRows, pageNo 뿐이다. 기관 필터도 진행중 필터도 없어 23개
# 기관 전체를 페이징해 받아 우리가 골라야 하고, 기간(PERIOD)은 자유 문자열이며
# 값이 수집일 기준이라 개막이 늦게 반영된다. 국중박 자체 오픈API 는 채용정보
# 하나뿐이다.
#
# ponytail: 문서화된 API 가 아니라 화면 HTML 파싱이다. 누리집이 개편되면
# 깨진다 — 깨지면 전시 줄만 사라지고 혼잡도는 그대로 읽히게 두는 것이 이
# 기능의 실패 방식이다(파싱이 빈 목록을 내면 프론트가 섹션을 숨긴다).
# mmca_exhibitions.py 와 같은 계약이며, 통합 API 가 기관 필터를 주기 시작하면
# 그때 갈아탄다.
#
# /site/main/exhiSpecial/... 경로로 부르지 말 것 — 같은 화면이지만 302 를
# 자기 자신으로 돌려 리다이렉트가 끝나지 않는다.
URL = "https://www.museum.go.kr/MUSEUM/contents/M0202010000.do"

# pageSize 기본값은 9다. 진행중 전시가 그보다 많으면 페이지가 갈리므로 한
# 화면에 다 담아 페이지네이션을 없앤다.
PARAMS = {"cp": 1, "pageSize": 100, "selectTime": "current", "unitedUse": "MUSEUM"}

# 목록 한 건. <div class="info"> 안에 링크로 감싼 제목과 기간·장소 표가 있고
# 그 표의 </ul> 로 끝난다.
_ITEM = re.compile(r'<div class="info">(.*?)</ul>', re.S)
# 제목은 상세로 가는 링크 안의 strong 이다. 기간·장소 라벨도 strong 이라
# 링크를 함께 물어야 구별된다.
_TITLE = re.compile(r"<a [^>]*>\s*<strong>(.*?)</strong>\s*</a>", re.S)
_DATES = re.compile(r"\d{4}-\d{2}-\d{2}")

# 이 목록에는 지역 공립박물관 순회전과 해외 전시도 섞인다. 장소가 우리 관을
# 가리키는 것만 남긴다.
#
# 보수적으로 자른다: 어린이박물관이나 야외 전시처럼 장소에 이 낱말이 없는
# 우리 관 전시가 생기면 그것도 함께 빠진다. 그쪽이 안전한 실패다 — 이 목록이
# 답하는 질문은 "지금 이 건물에서 뭘 하나"이고, 남는 오답(다른 도시의 전시)이
# 빠지는 오답보다 나쁘다.
_ON_SITE = ("국립중앙박물관", "상설전시", "특별전시")


@dataclass
class NationalMuseumExhibition:
    title: str
    start_date: str
    end_date: str
    # 누리집이 적어 준 장소 문자열 그대로("상설전시관 2층 서화실"). 전시실
    # 단위 혼잡도가 없는 관이라, 이 줄이 이 페이지가 줄 수 있는 유일한 위치
    # 정보다.
    place: str


def fetch_page(client: httpx.Client) -> str:
    response = client.get(URL, params=PARAMS, timeout=15.0)
    response.raise_for_status()
    return response.text


def _field(block: str, label: str) -> str:
    match = re.search(rf"<strong>{label}</strong>\s*<p>([^<]*)</p>", block)
    return html.unescape(match.group(1)).strip() if match else ""


def current_exhibitions(page: str) -> list[NationalMuseumExhibition]:
    """진행중인 국중박 전시. 순서는 누리집 목록 그대로."""
    exhibitions = []
    for block in _ITEM.findall(page):
        title = _TITLE.search(block)
        place = _field(block, "장소")
        if title is None or not any(word in place for word in _ON_SITE):
            continue
        dates = _DATES.findall(_field(block, "기간"))
        # 기간이 양쪽 다 있어야 프론트가 한 줄로 그린다. 한쪽만 오는 표기
        # (상시, 개막 전 미정)는 여기서 버린다.
        if len(dates) != 2:
            continue
        exhibitions.append(
            NationalMuseumExhibition(
                title=html.unescape(title.group(1)).strip(),
                start_date=dates[0],
                end_date=dates[1],
                place=place,
            )
        )
    return exhibitions
