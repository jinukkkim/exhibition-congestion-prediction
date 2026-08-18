import json
from dataclasses import dataclass, field
from datetime import datetime

import httpx

BASE_URL = "http://openapi.seoul.go.kr:8088"

# /citydata returns 17 sections (~22KB) but only these could plausibly become
# model features for museum congestion, so the rest is dropped before the body
# ever reaches the DB — that's ~68% of the payload. Deliberately excluded:
# EV chargers, road traffic, parking, cultural events, subway/bus station
# metadata, 따릉이, four blocks the API always returns empty, and the area
# name/code (already inside LIVE_PPLTN_STTS).
_ARCHIVED_SECTIONS = (
    "LIVE_PPLTN_STTS",  # what we parse today, plus 서울시's own congestion forecast
    "WEATHER_STTS",  # top future-feature candidate
    "LIVE_SUB_PPLTN",  # subway boardings — candidate leading indicator
    "LIVE_BUS_PPLTN",  # bus boardings — ditto
)


@dataclass
class CongestionForecast:
    target_at: datetime
    congest_level: str | None = None
    population_min: int | None = None
    population_max: int | None = None


@dataclass
class WeatherForecast:
    target_at: datetime
    temp: float | None = None
    precipitation: str | None = None
    precpt_type: str | None = None
    rain_chance: float | None = None
    sky_stts: str | None = None


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
    # The _ARCHIVED_SECTIONS subset of the response body. We only parse the
    # population fields above today; keeping the rest of that subset means we
    # can promote weather or transit to columns later without waiting for new
    # data to accumulate from that point forward.
    raw_response: str | None = None
    # Both forecast blocks get their own tables instead of riding along in
    # raw_response — see ForecastCongestion for why the issue time matters.
    congestion_forecasts: list[CongestionForecast] = field(default_factory=list)
    weather_forecasts: list[WeatherForecast] = field(default_factory=list)


def _optional_float(live: dict, key: str) -> float | None:
    value = live.get(key)
    return float(value) if value is not None else None


def _optional_int(entry: dict, key: str) -> int | None:
    value = entry.get(key)
    return int(value) if value is not None else None


def parse_congestion_forecasts(live: dict) -> list[CongestionForecast]:
    return [
        CongestionForecast(
            target_at=datetime.strptime(entry["FCST_TIME"], "%Y-%m-%d %H:%M"),
            congest_level=entry.get("FCST_CONGEST_LVL"),
            population_min=_optional_int(entry, "FCST_PPLTN_MIN"),
            population_max=_optional_int(entry, "FCST_PPLTN_MAX"),
        )
        for entry in live.get("FCST_PPLTN") or []
    ]


def parse_weather_forecasts(city: dict) -> list[WeatherForecast]:
    weather = (city.get("WEATHER_STTS") or [{}])[0]
    return [
        WeatherForecast(
            target_at=datetime.strptime(entry["FCST_DT"], "%Y%m%d%H%M"),
            temp=_optional_float(entry, "TEMP"),
            precipitation=entry.get("PRECIPITATION"),
            precpt_type=entry.get("PRECPT_TYPE"),
            rain_chance=_optional_float(entry, "RAIN_CHANCE"),
            sky_stts=entry.get("SKY_STTS"),
        )
        for entry in weather.get("FCST24HOURS") or []
    ]


def _archived_body(city: dict) -> str:
    kept = {name: city[name] for name in _ARCHIVED_SECTIONS if name in city}
    # 79% of the weather section is FCST24HOURS, which repeats near-verbatim on
    # every poll (97.8% duplicate over a day). It goes to ForecastWeather
    # instead. Rebuilt rather than popped in place: `city` is still needed by
    # parse_weather_forecasts, and mutating it here would silently empty it.
    if "WEATHER_STTS" in kept:
        kept["WEATHER_STTS"] = [
            {key: value for key, value in weather.items() if key != "FCST24HOURS"}
            for weather in kept["WEATHER_STTS"]
        ]
    return json.dumps(kept, ensure_ascii=False)


def fetch_congestion(client: httpx.Client, area_name: str, api_key: str) -> CongestionReading:
    url = f"{BASE_URL}/{api_key}/json/citydata/1/5/{area_name}"
    response = client.get(url, timeout=10.0)
    response.raise_for_status()
    city = response.json()["CITYDATA"]
    live = city["LIVE_PPLTN_STTS"][0]

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
        raw_response=_archived_body(city),
        congestion_forecasts=parse_congestion_forecasts(live),
        weather_forecasts=parse_weather_forecasts(city),
    )
