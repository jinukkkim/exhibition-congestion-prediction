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
    male_ppltn_rate: float | None = None
    female_ppltn_rate: float | None = None
    ppltn_rate_0: float | None = None
    ppltn_rate_10: float | None = None
    ppltn_rate_20: float | None = None
    ppltn_rate_30: float | None = None
    ppltn_rate_40: float | None = None
    ppltn_rate_50: float | None = None
    ppltn_rate_60: float | None = None
    ppltn_rate_70: float | None = None
    resnt_ppltn_rate: float | None = None
    non_resnt_ppltn_rate: float | None = None
    # Full API response body, verbatim. We only parse the population fields
    # above today, but /citydata also returns traffic, parking, subway, bus,
    # weather, and event data we don't use yet — keeping the raw body means
    # we can parse those out later without having to wait for new data to
    # accumulate from that point forward.
    raw_response: str | None = None


def _optional_float(live: dict, key: str) -> float | None:
    value = live.get(key)
    return float(value) if value is not None else None


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
        male_ppltn_rate=_optional_float(live, "MALE_PPLTN_RATE"),
        female_ppltn_rate=_optional_float(live, "FEMALE_PPLTN_RATE"),
        ppltn_rate_0=_optional_float(live, "PPLTN_RATE_0"),
        ppltn_rate_10=_optional_float(live, "PPLTN_RATE_10"),
        ppltn_rate_20=_optional_float(live, "PPLTN_RATE_20"),
        ppltn_rate_30=_optional_float(live, "PPLTN_RATE_30"),
        ppltn_rate_40=_optional_float(live, "PPLTN_RATE_40"),
        ppltn_rate_50=_optional_float(live, "PPLTN_RATE_50"),
        ppltn_rate_60=_optional_float(live, "PPLTN_RATE_60"),
        ppltn_rate_70=_optional_float(live, "PPLTN_RATE_70"),
        resnt_ppltn_rate=_optional_float(live, "RESNT_PPLTN_RATE"),
        non_resnt_ppltn_rate=_optional_float(live, "NON_RESNT_PPLTN_RATE"),
        raw_response=response.text,
    )
