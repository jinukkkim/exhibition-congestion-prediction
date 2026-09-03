from datetime import date, datetime, time, timedelta

import fakeredis
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app.models import RawCongestion

TODAY = date(2026, 8, 23)  # 일요일


@pytest.fixture
def session_factory():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


@pytest.fixture(autouse=True)
def fake_redis(monkeypatch):
    import app.cache as cache_module

    monkeypatch.setattr(cache_module, "r", fakeredis.FakeRedis(decode_responses=True))


def _seed(session_factory, n_days, end=TODAY, value=None):
    """`end` 직전 `n_days` 일을 시간마다 채운다.

    end 에 붙여 두는 이유는 배치가 보는 창이 "오늘 기준 뒤로 PROFILE_WINDOW_DAYS"
    이기 때문이다 — 고정 날짜에서 시작하면 창 밖에 앉아 프로파일이 빈다.
    """
    with session_factory() as session:
        for offset in range(n_days):
            day = end - timedelta(days=n_days - offset)
            # 30분 간격 — 개관이 09:30 이라 정시만 심으면 9시 셀이 통째로 없고,
            # 그러면 프론트가 축 왼쪽 끝을 보간할 점을 잃는다(실제 수집은 5분).
            for half in range(48):
                ts = datetime.combine(day, time(hour=half // 2, minute=(half % 2) * 30))
                avg = value(ts) if value else (2000.0 if 11 <= ts.hour <= 14 else 500.0)
                session.add(
                    RawCongestion(
                        observed_at=ts,
                        congest_level="보통",
                        population_min=int(avg - 100),
                        population_max=int(avg + 100),
                    )
                )
        session.commit()


def test_run_daily_batch_reports_collecting_before_min_days(session_factory):
    from app.cache import get_prediction
    from app.prediction.batch import run_daily_batch

    _seed(session_factory, n_days=5)

    result = run_daily_batch(session_factory=session_factory, today=TODAY)

    assert result["status"] == "collecting"
    assert result["days_collected"] == 4
    assert get_prediction() == result


def test_run_daily_batch_returns_ready_with_a_curve(session_factory):
    from app.cache import get_prediction
    from app.prediction.batch import run_daily_batch

    _seed(session_factory, n_days=8)

    result = run_daily_batch(session_factory=session_factory, today=TODAY)

    assert result["status"] == "ready"
    assert result["curve"]
    assert get_prediction() == result


def test_run_daily_batch_keeps_only_business_hours(session_factory):
    """앵커를 심야 판독으로 잡으면 안 되므로 프로파일도 같은 모집단이어야 한다.

    일요일은 17:30 폐관이라 셀은 9~17시다 — 9시 셀은 09:30 판독 하나로 서고,
    09:00 판독은 개관 전이라 빠진다.
    """
    from app.prediction.batch import run_daily_batch

    _seed(session_factory, n_days=8)

    result = run_daily_batch(session_factory, today=TODAY)
    hours = [point["hour"] for point in result["days"][0]["curve"]]

    assert hours == list(range(9, 18))


def test_wednesday_and_saturday_run_to_the_later_close(session_factory):
    """수·토는 21:00 폐관이다 — 축이 길어지는 만큼 곡선도 길어야 한다."""
    from app.prediction.batch import run_daily_batch

    _seed(session_factory, n_days=8)

    result = run_daily_batch(session_factory, today=TODAY)
    by_date = {day["date"]: day for day in result["days"]}

    # 2026-08-26 은 수요일, 08-29 는 토요일.
    assert [p["hour"] for p in by_date["2026-08-26"]["curve"]] == list(range(9, 22))
    assert [p["hour"] for p in by_date["2026-08-29"]["curve"]] == list(range(9, 22))


def test_run_daily_batch_builds_a_curve_for_today_and_the_next_six_days(session_factory):
    from app.prediction.batch import run_daily_batch

    _seed(session_factory, n_days=8)

    result = run_daily_batch(session_factory, today=TODAY)

    assert [day["date"] for day in result["days"]] == [
        "2026-08-23",
        "2026-08-24",
        "2026-08-25",
        "2026-08-26",
        "2026-08-27",
        "2026-08-28",
        "2026-08-29",
    ]


def test_seven_day_window_never_repeats_a_weekday(session_factory):
    """프로파일이 (요일, 시각) 키라 같은 요일이 두 번 들어오면 곡선이 중복된다."""
    from app.prediction.batch import run_daily_batch

    _seed(session_factory, n_days=8)

    result = run_daily_batch(session_factory, today=TODAY)

    weekdays = [date.fromisoformat(day["date"]).weekday() for day in result["days"]]
    assert sorted(weekdays) == list(range(7))


def test_curve_field_still_holds_today(session_factory):
    """배포 중 '구 프론트 + 신 백엔드' 구간이 curve 를 읽는다."""
    from app.prediction.batch import run_daily_batch

    _seed(session_factory, n_days=8)

    result = run_daily_batch(session_factory, today=TODAY)

    assert result["curve"] == result["days"][0]["curve"]


def test_batch_curve_is_the_window_average_untouched(session_factory):
    """배치 시각(00:02)에는 오늘 판독이 없다 — 보정 없이 창 평균 그대로다."""
    from app.prediction.batch import run_daily_batch

    _seed(session_factory, n_days=8)

    result = run_daily_batch(session_factory, today=TODAY)
    noon = next(p for p in result["days"][0]["curve"] if p["hour"] == 12)

    assert noon["model"] == pytest.approx(2000.0)
    assert noon["baseline"] == pytest.approx(2000.0)


def test_profile_rides_along_for_the_route_to_anchor_with(session_factory):
    """route 가 앵커를 잡으려면 배치가 쓴 것과 같은 프로파일이 필요하다."""
    from app.prediction.batch import parse_profile, run_daily_batch

    _seed(session_factory, n_days=8)

    result = run_daily_batch(session_factory, today=TODAY)
    profile = parse_profile(result["profile"])

    assert profile[(TODAY.weekday(), 12)] == pytest.approx(2000.0)
    # 심야는 프로파일에 없다 — 영업시간만 담기 때문이다.
    assert (TODAY.weekday(), 3) not in profile
    # 9시 셀은 09:30 판독으로 선다. 09:00 은 개관 전이라 평균에 안 섞인다.
    assert profile[(TODAY.weekday(), 9)] == pytest.approx(500.0)


def test_holiday_flag_follows_the_calendar(session_factory):
    """2026-10-03 은 개천절, 10-04 는 평일 일요일."""
    from app.prediction.batch import run_daily_batch

    _seed(session_factory, n_days=8, end=date(2026, 10, 3))

    result = run_daily_batch(session_factory, today=date(2026, 10, 3))
    flags = {day["date"]: day["is_holiday"] for day in result["days"]}

    assert flags["2026-10-03"] is True
    assert flags["2026-10-04"] is False


def test_collecting_result_has_no_days(session_factory):
    from app.prediction.batch import run_daily_batch

    _seed(session_factory, n_days=3)

    result = run_daily_batch(session_factory, today=TODAY)

    assert result["status"] == "collecting"
    assert "days" not in result
