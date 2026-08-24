from datetime import date, datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter

from app.cache import get_prediction

router = APIRouter()

# 커브에 박힌 날짜는 KST 기준이다 (batch.py 와 같은 기준). 프로덕션 서버는
# Etc/UTC 라 naive now() 는 KST 오전 내내 전날로 떨어진다.
_SEOUL_TZ = ZoneInfo("Asia/Seoul")


def _today_seoul() -> date:
    return datetime.now(_SEOUL_TZ).date()


@router.get("/congestion/prediction")
def prediction() -> dict:
    cached = get_prediction()
    if cached is None:
        return {"status": "collecting", "days_collected": 0}

    days = cached.get("days")
    if not days:
        return cached

    # 배치는 하루 한 번 돌고 저장한 목록은 다음 실행까지 남는다. 실행이 밀리거나
    # 실패하면 첫 항목이 어제가 되므로, 오늘 이후만 내려보낸다. 탭이 7개보다
    # 적어지는 것이 틀린 날짜를 오늘로 제시하는 것보다 낫다.
    today = _today_seoul().isoformat()
    upcoming = [day for day in days if day["date"] >= today]

    # upcoming 이 빌 수는 없다: 페이로드의 날짜는 배치가 돈 날부터 6일 뒤까지이고
    # cache.PREDICTION_TTL_SECONDS 가 24시간이라 페이로드 자체가 그보다 오래
    # 살아남지 못한다. 즉 남는 항목은 최소 6개다. TTL 을 늘린다면 이 가정이
    # 깨지므로, 그때는 빈 목록에 대비해 stale 한 curve 를 내려보내지 않도록
    # 해야 한다.


    result = {**cached, "days": upcoming}
    if upcoming:
        result["curve"] = upcoming[0]["curve"]
    return result
