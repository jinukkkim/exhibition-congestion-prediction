import logging
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx

BASE_URL = "https://apis.data.go.kr/1371033/mmcadensity"
_SEOUL_TZ = ZoneInfo("Asia/Seoul")

logger = logging.getLogger(__name__)

# resultCode 값 중 경고를 남기지 않는 것들. 남은 코드는 응답이 200 + 빈 data 로
# 와서 "진행 중인 전시가 2개 미만" 과 구별되지 않으므로 반드시 로그로 남아야
# 한다.
#
# 단, 그 "남은 코드" 에 키·쿼터 오류는 들어 있지 않다. 2026-09-02 실측:
#
#   잘못된 키 → HTTP 403, {"OpenAPI_ServiceResponse": {"cmmMsgHeader":
#                {"errMsg": "SERVICE_KEY_IS_NOT_REGISTERED_ERROR",
#                 "returnReasonCode": "30"}}}
#   빈 키     → HTTP 401, 같은 봉투에 "SERVICE_KEY_IS_NULL" / "20"
#
# 플랫폼 오류는 (a) 4xx 라 아래 raise_for_status 에서 먼저 끊기고 (b) 코드가
# resultCode 가 아니라 다른 봉투의 returnReasonCode 에 담기며 (c) 2자리 공용
# 코드라 이 서비스의 4자리 도메인 코드와 값 자체가 겹치지 않는다. 즉 여기서
# 무엇을 조용히 넘기든 키·쿼터 실패를 삼킬 수는 없다 — 그쪽은 collector 의
# _FETCH_FAILURES(httpx.HTTPError)가 방별로 잡아 경고를 남긴다.
#
# 실제 API 의 성공 코드는 "0000" 이다 — 여기가 "00" 만 알던 동안 모든 정상 응답이
# 경고를 찍었다(2026-09-02 실측: 방 전부). "00" 도 남겨 둔 것은 문서 표기이고
# 실측으로 부정한 적이 없기 때문이다.
#
# "0002" 는 "현재 진행 중인 전시가 없거나 혼잡도 정보를 제공하지 않는 전시실"로,
# 오류가 아니라 그 방의 정상 상태다 — data 가 비어 congestion_nm 이 None 으로
# 저장되고 프론트가 그걸 그대로 '정보 없음' 으로 그린다. 상태를 기록하는 자리는
# 로그가 아니라 그 None 이다. 실측 시점에 17개 중 8개가 이 상태였으니, 빼지 않으면
# 라운드마다 8줄이 쌓인다 — 1분 그리드에서 하루 3,800줄이고, 그만큼 남은 미지의
# resultCode 한 줄을 찾기 어려워진다. 덮이는 것이 키·쿼터 오류는 아니다(위 참조).
_EXPECTED_RESULT_CODES = {"00", "0000", "0002"}

# 방 하나를 기다리는 상한(초). collect_mmca_once 가 방을 **순차로** 부르므로
# 라운드 최악 시간은 `방 수 × 이 값`이고, APScheduler 의 max_instances 기본값이
# 1 이라 라운드가 격자를 넘기면 다음 라운드가 큐에 쌓이지 않고 버려진다. 즉
# 상한은 산식으로 묶여 있다:
#
#     FETCH_TIMEOUT_SECONDS < (MMCA_POLL_MINUTES × 60) ÷ 방 수
#
# 이 결합이 실제로 깨진 적이 있다. 값은 원래 10.0 이었고 seoul_api.py 에서
# 그대로 옮겨온 것인데(eb3fe13), 그쪽은 라운드당 호출이 1개·격자가 5분이라
# 10초가 예산의 3%다. MMCA 에서는 같은 10초가 17%였고, 격자가 10분 → 1분이 된
# 뒤로는 멈춘 방 6개면 60초 격자를 넘겼다. 2026-09-03 실측: 라운드 407개 중
# 55개가 통째로 스킵됐고, 스킵된 라운드의 직전 라운드 91%가 이미 방을 잃고
# 있었다(정상 간격 라운드는 85%가 손실 0). 방·판독 기준 20.6% 유실.
#
# 3.0 은 상한(2분 격자 17방이면 7초)이 아니라 그 아래다. 상한에 앉지 않는
# 이유는 비용이 비대칭이기 때문이다 — 짧아서 느린 성공을 자르면 그 방 판독
# 하나를 잃고 재시도가 2분 뒤인데, 길어서 라운드가 넘치면 다음 라운드 17방이
# 통째로 날아간다. 3.0 이면 최악 51초로 120초 예산의 43%만 쓰므로 방이 늘거나
# 상류가 느려져도 견딘다.
#
# 측정된 정상 응답은 방당 33ms 다(2026-09-02, 17방 총 0.58초). 3초는 그 90배지만
# 그것이 근거는 아니다 — timeout 을 정하는 데 필요한 값은 평균이 아니라 성공
# 응답의 꼬리이고, 지금 그 기록이 없다. 성공 호출의 소요 시간을 서울 쪽
# _fetch_congestion_with_retry 처럼 남긴 뒤에 다시 재야 한다. 그 주석이 말하는
# "응답이 11초에 온 건가, 아예 안 온 건가"가 여기서도 답이 없는 질문이다.
#
# httpx 의 timeout 은 요청 전체 데드라인이 아니다 — connect/read/write/pool
# 각각에 걸리고 read 는 "데이터 조각 하나를 기다리는 시간"이라, 바이트를 조금씩
# 흘려보내는 서버 앞에서는 위 산식이 깨진다. 관측된 실패 양상(정지)에 대한
# 상한이지 수학적 보장이 아니다.
FETCH_TIMEOUT_SECONDS = 3.0


@dataclass
class MmcaCongestionReading:
    observed_at: datetime
    space_code: str
    space_nm: str | None
    agnc_nm: str | None
    congestion_nm: str | None
    # No raw_response counterpart to CongestionReading's: /congestion returns
    # only agncNm/spaceNm/congestionNm, so the columns above already hold the
    # entire body and archiving it again was pure duplication.


def fetch_congestion(client: httpx.Client, space_code: str, api_key: str) -> MmcaCongestionReading:
    # ponytail: passing the key through httpx's `params` (which percent-encodes
    # it) assumes the "decoding" form of the data.go.kr service key. If real
    # calls 401 once a live key is wired in, try passing the already-encoded
    # key directly in the URL instead — known data.go.kr gotcha.
    response = client.get(
        f"{BASE_URL}/congestion",
        params={"serviceKey": api_key, "spaceCode": space_code},
        timeout=FETCH_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    body = response.json()

    result_code = body.get("resultCode")
    if result_code is not None and result_code not in _EXPECTED_RESULT_CODES:
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
    )
