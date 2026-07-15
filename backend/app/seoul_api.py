from dataclasses import dataclass
from datetime import datetime

import httpx

BASE_URL = "http://openapi.seoul.go.kr:8088"


@dataclass
class CongestionReading:
    observed_at: datetime
    congest_level: str
    population_min: int
    population_max: int


def fetch_congestion(client: httpx.Client, area_name: str, api_key: str) -> CongestionReading:
    url = f"{BASE_URL}/{api_key}/json/citydata/1/5/{area_name}"
    response = client.get(url, timeout=10.0)
    response.raise_for_status()
    live = response.json()["CITYDATA"]["LIVE_PPLTN_STTS"][0]

    return CongestionReading(
        observed_at=datetime.strptime(live["PPLTN_TIME"], "%Y-%m-%d %H:%M"),
        congest_level=live["AREA_CONGEST_LVL"],
        population_min=int(live["AREA_PPLTN_MIN"]),
        population_max=int(live["AREA_PPLTN_MAX"]),
    )
