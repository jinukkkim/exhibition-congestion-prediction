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
