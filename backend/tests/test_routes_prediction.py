from datetime import datetime
from types import SimpleNamespace

import fakeredis
import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def fake_redis(monkeypatch):
    import app.cache as cache_module

    monkeypatch.setattr(cache_module, "r", fakeredis.FakeRedis(decode_responses=True))


def test_prediction_returns_collecting_when_never_run():
    from app.main import app

    client = TestClient(app)
    response = client.get("/congestion/prediction")

    assert response.status_code == 200
    assert response.json() == {"status": "collecting", "days_collected": 0}


def test_prediction_returns_cached_result():
    from app.cache import set_prediction
    from app.main import app

    cached = {"status": "ready", "curve": []}
    set_prediction(cached)

    client = TestClient(app)
    response = client.get("/congestion/prediction")

    assert response.json() == cached


def test_prediction_drops_days_that_are_already_past(monkeypatch):
    """배치는 하루 한 번 돈다. 실행에 실패하거나 자정 직후 창에서는 저장된 첫
    항목이 어제가 되므로, 응답에서 걸러낸다."""
    import app.routes.prediction as route_module
    from app.cache import set_prediction
    from app.main import app

    monkeypatch.setattr(route_module, "_now_seoul", lambda: datetime(2026, 8, 24, 15, 0))

    set_prediction(
        {
            "status": "ready",
            "curve": [{"hour": 0, "baseline": 1.0, "model": 1.0}],
            "days": [
                {
                    "date": "2026-08-23",
                    "is_holiday": False,
                    "curve": [{"hour": 0, "baseline": 1.0, "model": 1.0}],
                },
                {
                    "date": "2026-08-24",
                    "is_holiday": False,
                    "curve": [{"hour": 0, "baseline": 2.0, "model": 2.0}],
                },
            ],
        }
    )

    body = TestClient(app).get("/congestion/prediction").json()

    assert [day["date"] for day in body["days"]] == ["2026-08-24"]
    # 하위 호환 필드도 남은 첫 항목에 맞춰야 한다 — 구 프론트가 어제 커브를
    # 오늘로 그리게 되기 때문이다.
    assert body["curve"] == [{"hour": 0, "baseline": 2.0, "model": 2.0}]


def test_prediction_leaves_a_payload_without_days_untouched():
    """days 를 담기 전 배치가 남긴 캐시가 TTL 안에 남아 있을 수 있다."""
    from app.cache import set_prediction
    from app.main import app

    cached = {"status": "ready", "curve": []}
    set_prediction(cached)

    body = TestClient(app).get("/congestion/prediction").json()

    assert body == cached


def _anchor_fixture(monkeypatch, readings, profile, now=datetime(2026, 8, 24, 13, 0)):
    """오늘 판독과 프로파일을 심고 응답의 오늘 곡선을 돌려준다.

    배치를 돌리지 않고 캐시를 직접 쓴다 — 여기서 재는 것은 route 가 붙이는
    보정이지 배치가 만드는 곡선이 아니다.
    """
    import app.routes.prediction as route_module
    from app.cache import set_prediction
    from app.main import app
    from app.prediction.batch import profile_key

    monkeypatch.setattr(route_module, "_now_seoul", lambda: now)
    monkeypatch.setattr(
        route_module,
        "_todays_readings",
        lambda _now: [
            SimpleNamespace(observed_at=stamp, population_avg=value) for stamp, value in readings
        ],
    )

    day = now.date().isoformat()
    set_prediction(
        {
            "status": "ready",
            "curve": [],
            "days": [
                {
                    "date": day,
                    "is_holiday": False,
                    "curve": [
                        {"hour": hour, "baseline": value, "model": value}
                        for hour, value in profile.items()
                    ],
                }
            ],
            "profile": {profile_key(now.weekday(), hour): v for hour, v in profile.items()},
        }
    )
    return TestClient(app).get("/congestion/prediction").json()


def test_prediction_scales_today_to_what_actually_happened(monkeypatch):
    """오늘이 창 평균의 절반이면 남은 시간도 절반으로 내려가야 한다.

    이 보정이 없던 동안 8월 성수기 수준(3,292명)을 학습한 곡선이 9월(2,250명)에도
    그대로 나와 영업시간 판독의 97%를 과대예측했다.
    """
    profile = {hour: 2000.0 for hour in range(10, 18)}
    # 12:00~13:00 실측이 프로파일의 절반.
    readings = [(datetime(2026, 8, 24, 12, minute), 1000.0) for minute in range(0, 60, 5)]
    readings += [(datetime(2026, 8, 24, 13, 0), 1000.0)]

    body = _anchor_fixture(monkeypatch, readings, profile)
    by_hour = {p["hour"]: p for p in body["days"][0]["curve"]}

    # 램프(90분)가 다 끝난 뒤 = 15시 이후는 온전히 보정된 값이다.
    assert by_hour[15]["model"] == pytest.approx(1000.0)
    # baseline 은 보정 전 값이라 그대로 — 응답만 보고도 얼마나 밀었는지 읽힌다.
    assert by_hour[15]["baseline"] == pytest.approx(2000.0)


def test_prediction_ramps_out_of_the_last_reading(monkeypatch):
    """직전 값에서 곧바로 프로파일로 점프하면 이음매가 계단이 된다."""
    profile = {hour: 2000.0 for hour in range(10, 18)}
    readings = [(datetime(2026, 8, 24, 12, minute), 2000.0) for minute in range(0, 60, 5)]
    # 마지막 한 판독만 크게 튄다 — 보정은 창 평균이라 거의 안 움직이고,
    # 램프만 이 값에서 출발한다.
    readings += [(datetime(2026, 8, 24, 13, 0), 4000.0)]

    body = _anchor_fixture(monkeypatch, readings, profile)
    by_hour = {p["hour"]: p for p in body["days"][0]["curve"]}

    # 13:00 이 마지막 실측이므로 곡선은 14시부터 — 그 자리는 아직 램프 중이라
    # 마지막 실측과 프로파일 사이에 있다.
    assert min(by_hour) == 14
    assert 2000.0 < by_hour[14]["model"] < 4000.0
    # 90분 뒤(14:30)를 지난 15시는 램프가 끝나 보정된 프로파일이다.
    assert by_hour[15]["model"] < by_hour[14]["model"]


def test_prediction_leaves_future_days_unanchored(monkeypatch):
    """앵커는 오늘의 것이다 — 내일 곡선까지 오늘 수준으로 끌면 근거가 없다."""
    import app.routes.prediction as route_module
    from app.cache import set_prediction
    from app.main import app
    from app.prediction.batch import profile_key

    now = datetime(2026, 8, 24, 13, 0)
    monkeypatch.setattr(route_module, "_now_seoul", lambda: now)
    monkeypatch.setattr(
        route_module,
        "_todays_readings",
        lambda _now: [
            SimpleNamespace(observed_at=datetime(2026, 8, 24, 12, m), population_avg=1000.0)
            for m in range(0, 60, 5)
        ],
    )
    tomorrow_curve = [{"hour": 15, "baseline": 2000.0, "model": 2000.0}]
    set_prediction(
        {
            "status": "ready",
            "curve": [],
            "days": [
                {"date": "2026-08-24", "is_holiday": False, "curve": [{"hour": 15, "baseline": 2000.0, "model": 2000.0}]},
                {"date": "2026-08-25", "is_holiday": False, "curve": tomorrow_curve},
            ],
            "profile": {profile_key(0, 15): 2000.0, profile_key(1, 15): 2000.0},
        }
    )

    body = TestClient(app).get("/congestion/prediction").json()

    assert body["days"][1]["curve"] == tomorrow_curve


def test_prediction_keeps_the_batch_curve_before_any_reading_today(monkeypatch):
    """개장 전에는 보정할 실측이 없다 — 창 평균을 그대로 내려보낸다."""
    import app.routes.prediction as route_module
    from app.cache import set_prediction
    from app.main import app
    from app.prediction.batch import profile_key

    now = datetime(2026, 8, 24, 9, 0)
    monkeypatch.setattr(route_module, "_now_seoul", lambda: now)
    monkeypatch.setattr(route_module, "_todays_readings", lambda _now: [])

    batch_curve = [{"hour": 15, "baseline": 2000.0, "model": 2000.0}]
    set_prediction(
        {
            "status": "ready",
            "curve": batch_curve,
            "days": [{"date": "2026-08-24", "is_holiday": False, "curve": batch_curve}],
            "profile": {profile_key(0, 15): 2000.0},
        }
    )

    body = TestClient(app).get("/congestion/prediction").json()

    assert body["days"][0]["curve"] == batch_curve


def test_prediction_does_not_leak_the_profile(monkeypatch):
    """프로파일은 route 가 쓰는 내부 값이다."""
    profile = {hour: 2000.0 for hour in range(10, 18)}
    readings = [(datetime(2026, 8, 24, 12, m), 1000.0) for m in range(0, 60, 5)]

    body = _anchor_fixture(monkeypatch, readings, profile)

    assert "profile" not in body
