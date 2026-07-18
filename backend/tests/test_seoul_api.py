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
            }
        ],
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
    assert json.loads(reading.raw_response) == FIXTURE


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
