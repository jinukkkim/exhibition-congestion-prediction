import logging
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx

BASE_URL = "https://apis.data.go.kr/1371033/mmcadensity"
_SEOUL_TZ = ZoneInfo("Asia/Seoul")

logger = logging.getLogger(__name__)


@dataclass
class MmcaCongestionReading:
    observed_at: datetime
    space_code: str
    space_nm: str | None
    agnc_nm: str | None
    congestion_nm: str | None
    # Full /congestion response body, verbatim, same rationale as
    # CongestionReading.raw_response in seoul_api.py.
    raw_response: str | None = None


def fetch_congestion(client: httpx.Client, space_code: str, api_key: str) -> MmcaCongestionReading:
    # ponytail: passing the key through httpx's `params` (which percent-encodes
    # it) assumes the "decoding" form of the data.go.kr service key. If real
    # calls 401 once a live key is wired in, try passing the already-encoded
    # key directly in the URL instead — known data.go.kr gotcha.
    response = client.get(
        f"{BASE_URL}/congestion",
        params={"serviceKey": api_key, "spaceCode": space_code},
        timeout=10.0,
    )
    response.raise_for_status()
    body = response.json()

    result_code = body.get("resultCode")
    if result_code is not None and result_code != "00":
        logger.warning(
            "MMCA API non-normal resultCode for %s: %s %s", space_code, result_code, body.get("resultMsg")
        )

    data = body.get("data") or {}

    return MmcaCongestionReading(
        # Server local time isn't guaranteed to be KST (e.g. a UTC container),
        # so pin explicitly to Asia/Seoul instead of a naive datetime.now().
        observed_at=datetime.now(_SEOUL_TZ).replace(tzinfo=None),
        space_code=space_code,
        space_nm=data.get("spaceNm"),
        agnc_nm=data.get("agncNm"),
        congestion_nm=data.get("congestionNm"),
        raw_response=response.text,
    )
