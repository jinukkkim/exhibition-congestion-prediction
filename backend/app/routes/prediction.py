from datetime import date, datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter

from app.cache import get_prediction
from app.db import SessionLocal
from app.models import RawCongestion
from app.prediction.batch import parse_profile
from app.prediction.seoul import (
    ANCHOR_WINDOW_MINUTES,
    curve,
    in_business_hours,
    today_anchor,
)

router = APIRouter()

# 커브에 박힌 날짜는 KST 기준이다 (batch.py 와 같은 기준). 프로덕션 서버는
# Etc/UTC 라 naive now() 는 KST 오전 내내 전날로 떨어진다.
_SEOUL_TZ = ZoneInfo("Asia/Seoul")


def _now_seoul() -> datetime:
    """테스트가 몽키패치할 자리 — routes/mmca.py 의 같은 이름과 같은 형태다.

    날짜만 따로 두지 않는다: 오늘이 언제인지와 앵커의 "지금"이 같은 시계에서
    나와야 자정 전후로 둘이 어긋나지 않는다.
    """
    return datetime.now(_SEOUL_TZ).replace(tzinfo=None)


def _todays_readings(now: datetime, session_factory=SessionLocal) -> list[RawCongestion]:
    """오늘 개장 이후의 판독. 앵커와 이음매가 둘 다 여기서 나온다.

    캐시를 두지 않는다 — 하루치(최대 138행)를 인덱스로 긁는 질의고, /congestion/daily
    도 같은 모양으로 매 요청 조회한다.
    """
    with session_factory() as session:
        rows = (
            session.query(RawCongestion)
            .filter(RawCongestion.observed_at >= datetime.combine(now.date(), datetime.min.time()))
            .filter(RawCongestion.observed_at <= now)
            .order_by(RawCongestion.observed_at)
            .all()
        )
    return [row for row in rows if in_business_hours(row.observed_at)]


def _anchored_today(cached: dict, today_entry: dict, now: datetime) -> list[dict] | None:
    """오늘 곡선을 지금까지의 실측에 맞춰 다시 만든다.

    배치는 00:02 에 돌아 그날 판독을 하나도 못 본다 — 보정 없이 그린 곡선은 지난
    7일 평균이라, 오늘이 그 평균과 다른 날이면 온종일 어긋난 채로 남는다.

    프로파일이 없는 페이로드(배치 이전 버전이 캐시에 남아 있는 배포 중 구간)나
    앵커 관측이 모자란 이른 아침에는 None — 배치가 만든 곡선을 그대로 쓴다.
    """
    raw_profile = cached.get("profile")
    if not raw_profile:
        return None
    readings = _todays_readings(now)
    if not readings:
        return None
    profile = parse_profile(raw_profile)
    anchor = today_anchor(profile, readings, now, anchor_minutes=ANCHOR_WINDOW_MINUTES)
    if anchor is None:
        return None
    last = readings[-1]
    day = date.fromisoformat(today_entry["date"])
    return curve(
        profile,
        day,
        anchor=anchor,
        # 이음매: 실선의 마지막 점에서 출발한다. 프론트도 같은 자리에서 이어
        # 붙이므로(CongestionCard 의 predPoints) 두 곡선이 한 번만 만난다.
        last=(last.observed_at.hour * 60 + last.observed_at.minute, last.population_avg),
    )


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
    now = _now_seoul()
    today = now.date().isoformat()
    upcoming = [day for day in days if day["date"] >= today]

    # upcoming 이 빌 수는 없다: 페이로드의 날짜는 배치가 돈 날부터 6일 뒤까지이고
    # cache.PREDICTION_TTL_SECONDS 가 24시간이라 페이로드 자체가 그보다 오래
    # 살아남지 못한다. 즉 남는 항목은 최소 6개다. TTL 을 늘린다면 이 가정이
    # 깨지므로, 그때는 빈 목록에 대비해 stale 한 curve 를 내려보내지 않도록
    # 해야 한다.

    if upcoming and upcoming[0]["date"] == today:
        anchored = _anchored_today(cached, upcoming[0], now)
        if anchored is not None:
            upcoming = [{**upcoming[0], "curve": anchored}, *upcoming[1:]]

    result = {**cached, "days": upcoming}
    # 프로파일은 route 가 쓰는 내부 값이다 — 응답에 실어 보낼 이유가 없다.
    result.pop("profile", None)
    if upcoming:
        result["curve"] = upcoming[0]["curve"]
    return result
