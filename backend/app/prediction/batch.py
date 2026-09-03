"""하루 한 번 도는 예측 배치.

`days` 는 오늘부터 7일이고, 오늘 곡선은 여기서 만들 때 앵커가 없다 — 배치는
00:02 에 돌아 그날 판독이 아직 하나도 없다. 오늘의 보정은 routes/prediction.py
가 요청 시각에 붙인다 (MMCA 는 곡선 전체를 요청 시각에 만든다 — 그쪽은 캐시
TTL 이 60초라 그래도 되지만, 이쪽은 24시간이라 배치가 만든 것을 route 가
덧칠하는 형태가 된다).

프로파일을 페이로드에 함께 담는 이유가 그것이다: route 가 앵커를 잡으려면
"같은 시각의 프로파일 값"이 필요한데, 배치가 쓴 창과 다른 창으로 다시 만들면
보정의 기준이 갈라진다.
"""

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func

from app.cache import set_prediction
from app.config import KR_HOLIDAYS
from app.db import SessionLocal
from app.models import RawCongestion
from app.prediction.seoul import PROFILE_WINDOW_DAYS, build_profile, curve, in_business_hours

# 프로파일이 (요일, 시각) 키라 모든 요일이 한 번씩은 들어와야 한다.
MIN_DAYS_REQUIRED = PROFILE_WINDOW_DAYS

_SEOUL_TZ = ZoneInfo("Asia/Seoul")


def profile_key(weekday: int, hour: int) -> str:
    """캐시는 JSON 이라 튜플 키를 담지 못한다."""
    return f"{weekday}-{hour}"


def parse_profile(raw: dict[str, float]) -> dict[tuple[int, int], float]:
    out = {}
    for key, value in raw.items():
        weekday, hour = key.split("-")
        out[(int(weekday), int(hour))] = value
    return out


def run_daily_batch(session_factory=SessionLocal, today: date | None = None) -> dict:
    # 커브에 박힌 날짜는 KST 기준이다. 프로덕션은 Etc/UTC 라 naive now() 는 KST
    # 오전 내내 전날로 떨어진다.
    first_day = today or datetime.now(_SEOUL_TZ).date()
    window_start = datetime.combine(first_day - timedelta(days=PROFILE_WINDOW_DAYS), datetime.min.time())

    with session_factory() as session:
        # 집계로 묻는다. order_by 를 두 번 붙이면 두 번째가 첫 번째를 대체하지
        # 않고 뒤에 붙어(asc, desc) 최신 행이 아니라 같은 행이 두 번 나온다.
        oldest, newest = session.query(
            func.min(RawCongestion.observed_at), func.max(RawCongestion.observed_at)
        ).one()
        rows = (
            session.query(RawCongestion)
            .filter(RawCongestion.observed_at >= window_start)
            .order_by(RawCongestion.observed_at)
            .all()
        )

    if oldest is None:
        result = {"status": "collecting", "days_collected": 0}
        set_prediction(result)
        return result

    days_collected = (newest - oldest).days
    # 영업시간만 쓴다 — 앵커가 심야 판독을 잡으면 안 되는 것과 같은 이유이고,
    # 프로파일과 앵커가 같은 모집단 위에 있어야 비율이 뜻을 갖는다.
    window = [row for row in rows if in_business_hours(row.observed_at)]
    if days_collected < MIN_DAYS_REQUIRED or not window:
        result = {"status": "collecting", "days_collected": days_collected}
        set_prediction(result)
        return result

    profile = build_profile(window)

    # 오늘 + 6일. 프로파일이 (요일, 시각) 키라 8일째부터는 곡선이 그대로 반복된다.
    days = []
    for offset in range(7):
        day = first_day + timedelta(days=offset)
        days.append(
            {
                "date": day.isoformat(),
                "is_holiday": day in KR_HOLIDAYS,
                "curve": curve(profile, day),
            }
        )

    result = {
        "status": "ready",
        # 배포 중 "구 프론트 + 신 백엔드" 구간이 이 필드를 읽는다. days[0] 과 같은
        # 리스트이며, 프론트가 days 를 쓰게 된 뒤에도 지우지 않는다.
        "curve": days[0]["curve"],
        "days": days,
        "profile": {profile_key(*key): value for key, value in profile.items()},
    }
    set_prediction(result)
    return result
