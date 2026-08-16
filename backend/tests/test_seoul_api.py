import json
from datetime import datetime

import httpx

from app.seoul_api import fetch_congestion

FIXTURE = {
    "CITYDATA": {
        "AREA_NM": "국립중앙박물관·용산가족공원",
        "LIVE_PPLTN_STTS": [
            {
                "AREA_CONGEST_LVL": "보통",
                "AREA_PPLTN_MIN": "1000",
                "AREA_PPLTN_MAX": "2000",
                "PPLTN_TIME": "2026-07-15 14:30",
                "MALE_PPLTN_RATE": "51.8",
                "FEMALE_PPLTN_RATE": "48.2",
                "PPLTN_RATE_0": "3.9",
                "PPLTN_RATE_10": "17.8",
                "PPLTN_RATE_20": "9.3",
                "PPLTN_RATE_30": "12.3",
                "PPLTN_RATE_40": "15.7",
                "PPLTN_RATE_50": "18.2",
                "PPLTN_RATE_60": "13.2",
                "PPLTN_RATE_70": "9.8",
                "RESNT_PPLTN_RATE": "45.1",
                "NON_RESNT_PPLTN_RATE": "54.9",
                "FCST_PPLTN": [
                    {
                        "FCST_TIME": "2026-07-15 15:00",
                        "FCST_CONGEST_LVL": "약간 붐빔",
                        "FCST_PPLTN_MIN": "2500",
                        "FCST_PPLTN_MAX": "3000",
                    }
                ],
            }
        ],
        "WEATHER_STTS": [
            {
                "TEMP": "30.2",
                "FCST24HOURS": [
                    {
                        "FCST_DT": "202607151500",
                        "TEMP": "31",
                        "PRECIPITATION": "-",
                        "PRECPT_TYPE": "없음",
                        "RAIN_CHANCE": "0",
                        "SKY_STTS": "구름많음",
                    }
                ],
            }
        ],
        "LIVE_SUB_PPLTN": {"SUB_ACML_GTON_PPLTN_MIN": "4000"},
        "LIVE_BUS_PPLTN": {"BUS_ACML_GTON_PPLTN_MIN": "150"},
        "CHARGER_STTS": [{"STAT_NM": "국립 중앙 박물관"}],
        "ROAD_TRAFFIC_STTS": {"AVG_ROAD_DATA": {"ROAD_TRAFFIC_IDX": "원활"}},
        "PRK_STTS": [{"PRK_NM": "가족공원 부설주차장"}],
        "EVENT_STTS": [{"EVENT_NM": "뮤지컬"}],
        "ACDNT_CNTRL_STTS": [],
    }
}


def test_fetch_congestion_parses_response():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=FIXTURE)

    client = httpx.Client(transport=httpx.MockTransport(handler))

    reading = fetch_congestion(client, "국립중앙박물관·용산가족공원", "test-key")

    assert reading.congest_level == "보통"
    assert reading.population_min == 1000
    assert reading.population_max == 2000
    assert reading.observed_at == datetime(2026, 7, 15, 14, 30)
    assert reading.male_ppltn_rate == 51.8
    assert reading.female_ppltn_rate == 48.2
    assert reading.ppltn_rate_0 == 3.9
    assert reading.ppltn_rate_10 == 17.8
    assert reading.ppltn_rate_20 == 9.3
    assert reading.ppltn_rate_30 == 12.3
    assert reading.ppltn_rate_40 == 15.7
    assert reading.ppltn_rate_50 == 18.2
    assert reading.ppltn_rate_60 == 13.2
    assert reading.ppltn_rate_70 == 9.8
    assert reading.resnt_ppltn_rate == 45.1
    assert reading.non_resnt_ppltn_rate == 54.9


def test_fetch_congestion_archives_only_candidate_sections():
    """Sections that can't become model features never reach the DB."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=FIXTURE)

    client = httpx.Client(transport=httpx.MockTransport(handler))

    archived = json.loads(fetch_congestion(client, "국립중앙박물관", "test-key").raw_response)

    assert set(archived) == {
        "LIVE_PPLTN_STTS",
        "WEATHER_STTS",
        "LIVE_SUB_PPLTN",
        "LIVE_BUS_PPLTN",
    }
    # The weather block is kept, but its 24-hour forecast is not — that belongs
    # in a forecast table keyed by issue time, not re-archived on every poll.
    assert archived["WEATHER_STTS"][0] == {"TEMP": "30.2"}
    assert archived["LIVE_PPLTN_STTS"][0]["AREA_CONGEST_LVL"] == "보통"


def test_fetch_congestion_parses_both_forecast_blocks():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=FIXTURE)

    client = httpx.Client(transport=httpx.MockTransport(handler))

    reading = fetch_congestion(client, "국립중앙박물관", "test-key")

    (congestion,) = reading.congestion_forecasts
    assert congestion.target_at == datetime(2026, 7, 15, 15, 0)
    assert congestion.congest_level == "약간 붐빔"
    assert (congestion.population_min, congestion.population_max) == (2500, 3000)

    (weather,) = reading.weather_forecasts
    assert weather.target_at == datetime(2026, 7, 15, 15, 0)
    assert weather.temp == 31.0
    assert weather.precipitation == "-"
    assert weather.rain_chance == 0.0
    assert weather.sky_stts == "구름많음"


def test_trimming_the_body_does_not_consume_the_weather_forecast():
    """_archived_body drops FCST24HOURS; parsing it must still see it.

    Both read the same parsed response, so trimming in place would leave
    weather_forecasts silently empty depending on evaluation order.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=FIXTURE)

    client = httpx.Client(transport=httpx.MockTransport(handler))

    reading = fetch_congestion(client, "국립중앙박물관", "test-key")

    assert "FCST24HOURS" not in json.loads(reading.raw_response)["WEATHER_STTS"][0]
    assert len(reading.weather_forecasts) == 1


def test_fetch_congestion_defaults_new_fields_when_absent():
    """A minimal legacy-shaped response (no breakdown fields) must not crash."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "CITYDATA": {
                    "LIVE_PPLTN_STTS": [
                        {
                            "AREA_CONGEST_LVL": "여유",
                            "AREA_PPLTN_MIN": "500",
                            "AREA_PPLTN_MAX": "700",
                            "PPLTN_TIME": "2026-07-15 09:00",
                        }
                    ]
                }
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    reading = fetch_congestion(client, "국립중앙박물관·용산가족공원", "test-key")

    assert reading.male_ppltn_rate is None
    assert reading.resnt_ppltn_rate is None
