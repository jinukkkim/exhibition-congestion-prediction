import httpx
from fastapi import APIRouter

from app.cache import (
    get_national_museum_exhibitions,
    revive,
    set_national_museum_exhibitions,
)
from app.national_museum_exhibitions import current_exhibitions, fetch_page
from app.schemas import NationalMuseumExhibition

# 국중박 혼잡도는 서울시 API 에서 오므로 routes/congestion.py 에 있다 —
# /congestion 접두는 그 시절 이름이다. 전시는 출처도 관도 다르니 그 파일에
# 얹지 않고 관 이름을 접두로 쓴다(/mmca/exhibitions 와 같은 결).
router = APIRouter()


@router.get("/national-museum/exhibitions", response_model=list[NationalMuseumExhibition])
def national_museum_exhibitions() -> list[NationalMuseumExhibition]:
    cached = revive(get_national_museum_exhibitions(), NationalMuseumExhibition)
    if cached is not None:
        return cached

    with httpx.Client() as client:
        exhibitions = current_exhibitions(fetch_page(client))

    set_national_museum_exhibitions([vars(e) for e in exhibitions])
    return [NationalMuseumExhibition(**vars(e)) for e in exhibitions]
