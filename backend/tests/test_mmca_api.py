from datetime import datetime
from zoneinfo import ZoneInfo

import httpx

from app.mmca_api import fetch_congestion

_SEOUL_TZ = ZoneInfo("Asia/Seoul")


def test_fetch_congestion_parses_response():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["spaceCode"] == "MMCA-SPACE-1001"
        assert request.url.params["serviceKey"] == "test-key"
        return httpx.Response(
            200,
            json={
                "resultCode": "0000",
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
    # fetch_congestion pins observed_at to Asia/Seoul wall-clock time regardless
    # of the host's local timezone (e.g. a UTC CI runner), so the bounds here
    # must be captured on the same clock or this comparison drifts by the
    # host/KST offset.
    before = datetime.now(_SEOUL_TZ).replace(tzinfo=None)

    reading = fetch_congestion(client, "MMCA-SPACE-1001", "test-key")

    assert reading.space_code == "MMCA-SPACE-1001"
    assert reading.congestion_nm == "보통"
    assert reading.agnc_nm == "국립현대미술관 서울관"
    assert reading.space_nm == "1전시실"
    assert before <= reading.observed_at <= datetime.now(_SEOUL_TZ).replace(tzinfo=None)


def test_fetch_congestion_handles_empty_data():
    """Fewer than 2 concurrent exhibitions: data comes back empty, not an error."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"resultCode": "0000", "resultMsg": "NORMAL SERVICE", "totalCount": 0, "data": {}},
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
            json={"resultCode": "0000", "resultMsg": "NORMAL SERVICE", "totalCount": 0, "data": None},
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))

    reading = fetch_congestion(client, "MMCA-SPACE-1003", "test-key")

    assert reading.congestion_nm is None


def test_fetch_congestion_logs_warning_for_non_normal_result_code(caplog):
    """An unexpected resultCode looks identical to the "fewer than 2
    exhibitions" empty-data case unless we log it separately. Deliberately
    defensive: no such code has been observed, and the key and quota failures
    this docstring once cited as the example arrive as 4xx instead — see
    _EXPECTED_RESULT_CODES. It stands for whatever the service adds next."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "resultCode": "99",
                "resultMsg": "SERVICE_KEY_IS_NOT_REGISTERED_ERROR",
                "totalCount": 0,
                "data": {},
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))

    with caplog.at_level("WARNING"):
        reading = fetch_congestion(client, "MMCA-SPACE-1001", "bad-key")

    assert reading.congestion_nm is None
    assert "MMCA-SPACE-1001" in caplog.text
    assert "99" in caplog.text


def test_fetch_congestion_stays_quiet_for_the_no_exhibition_result_code(caplog):
    """0002 ("진행 중인 전시가 없거나 혼잡도 미제공") is a room's normal steady
    state, not a failure. Recorded as congestion_nm=None, not as a log line —
    eight of seventeen rooms sat in it on 2026-09-02, so warning per call
    would put ~3,800 lines a day on a 1-minute grid between a reader and the
    one unexpected code this log exists for."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "resultCode": "0002",
                "resultMsg": "현재 진행 중인 전시가 없거나 혼잡도 정보를 제공하지 않는 전시실입니다.",
                "totalCount": 0,
                "data": {},
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))

    with caplog.at_level("WARNING"):
        reading = fetch_congestion(client, "MMCA-SPACE-1002", "test-key")

    assert reading.congestion_nm is None
    assert caplog.text == ""


def test_fetch_congestion_stays_quiet_for_the_real_success_code(caplog):
    """The live API answers "0000", not the "00" these fixtures used to assume."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "resultCode": "0000",
                "resultMsg": "성공",
                "totalCount": 1,
                "data": {"congestionNm": "여유", "agncNm": "국립현대미술관 서울관", "spaceNm": "1전시실"},
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))

    with caplog.at_level("WARNING"):
        reading = fetch_congestion(client, "MMCA-SPACE-1001", "test-key")

    assert reading.congestion_nm == "여유"
    assert caplog.text == ""


def test_worst_case_round_fits_the_poll_grid_with_a_room_to_spare():
    """라운드 최악 시간이 수집 격자 안에 들어와야 한다.

    방을 순차 호출하므로 최악은 `방 수 × FETCH_TIMEOUT_SECONDS` 이고, 넘기면
    APScheduler 가 다음 라운드를 버린다(max_instances 기본값 1). 세 값이 서로
    묶여 있는데 세 파일에 흩어져 있어서, 어느 하나만 만져도 조용히 깨진다 —
    2026-09-03 에 실제로 깨져 하루 수집의 20.6% 를 잃었다.

    방을 하나 더한 수로 재는 이유는 방 수가 설정값이기 때문이다
    (settings.mmca_venue_space_codes). 딱 맞게 통과하는 상한에 앉으면 전시실
    코드 하나 추가가 곧 수집 장애가 된다. 현재 값으로는 18방 × 3초 = 54초로
    120초 예산의 45% 다.
    """
    from app.collector import MMCA_POLL_MINUTES
    from app.config import settings
    from app.mmca_api import FETCH_TIMEOUT_SECONDS

    rooms = sum(len(codes) for codes in settings.mmca_venue_space_codes.values())
    worst_case_seconds = (rooms + 1) * FETCH_TIMEOUT_SECONDS

    assert worst_case_seconds < MMCA_POLL_MINUTES * 60
