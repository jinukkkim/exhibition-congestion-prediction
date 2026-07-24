import json
from datetime import datetime

import httpx

from app.mmca_api import fetch_congestion


def test_fetch_congestion_parses_response():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["spaceCode"] == "MMCA-SPACE-1001"
        assert request.url.params["serviceKey"] == "test-key"
        return httpx.Response(
            200,
            json={
                "resultCode": "00",
                "resultMsg": "NORMAL SERVICE",
                "totalCount": 1,
                "data": {
                    "congestionNm": "보통",
                    "agncNm": "국립현대미술관 서울관",
                    "spaceNm": "1전시실",
                },
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    before = datetime.now()

    reading = fetch_congestion(client, "MMCA-SPACE-1001", "test-key")

    assert reading.space_code == "MMCA-SPACE-1001"
    assert reading.congestion_nm == "보통"
    assert reading.agnc_nm == "국립현대미술관 서울관"
    assert reading.space_nm == "1전시실"
    assert before <= reading.observed_at <= datetime.now()
    assert json.loads(reading.raw_response)["data"]["congestionNm"] == "보통"


def test_fetch_congestion_handles_empty_data():
    """Fewer than 2 concurrent exhibitions: data comes back empty, not an error."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"resultCode": "00", "resultMsg": "NORMAL SERVICE", "totalCount": 0, "data": {}},
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))

    reading = fetch_congestion(client, "MMCA-SPACE-1003", "test-key")

    assert reading.congestion_nm is None
    assert reading.space_nm is None
    assert reading.agnc_nm is None


def test_fetch_congestion_handles_null_data():
    """Some data.go.kr responses use null instead of {} for an empty result."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"resultCode": "00", "resultMsg": "NORMAL SERVICE", "totalCount": 0, "data": None},
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))

    reading = fetch_congestion(client, "MMCA-SPACE-1003", "test-key")

    assert reading.congestion_nm is None
