import os
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import fakeredis
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base
from app.models import RawCongestion, RawMmcaCongestion

# A Wednesday, comfortably inside opening hours (10:10-21:00 on 수/토).
OPEN_HOURS = datetime(2026, 8, 12, 15, 0)
# Same Wednesday before the first round of the day is due.
BEFORE_OPENING = datetime(2026, 8, 12, 9, 0)


@pytest.fixture(autouse=True)
def fake_redis(monkeypatch):
    import app.cache as cache_module

    monkeypatch.setattr(cache_module, "r", fakeredis.FakeRedis(decode_responses=True))


@pytest.fixture
def client(monkeypatch):
    import app.routes.health as health_routes
    from app.main import app

    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine)
    monkeypatch.setattr(health_routes, "SessionLocal", session_factory)

    return TestClient(app), session_factory, monkeypatch


def _freeze(monkeypatch, now: datetime):
    """Pin the endpoint's clock; freshness is meaningless against a live one."""
    import app.routes.health as health_routes

    class _Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return now.replace(tzinfo=tz) if tz else now

    monkeypatch.setattr(health_routes, "datetime", _Frozen)


def _add(session_factory, seoul: datetime | None = None, mmca: list[datetime] | None = None):
    with session_factory() as session:
        if seoul is not None:
            session.add(
                RawCongestion(
                    observed_at=seoul,
                    congest_level="보통",
                    population_min=1000,
                    population_max=2000,
                )
            )
        for index, observed_at in enumerate(mmca or []):
            session.add(
                RawMmcaCongestion(
                    observed_at=observed_at,
                    space_code=f"MMCA-SPACE-100{index}",
                    space_nm="테스트 전시실",
                    agnc_nm="국립현대미술관 서울관",
                    congestion_nm="보통",
                )
            )
        session.commit()


def test_liveness_stays_independent_of_freshness(client):
    """deploy.sh polls /health right after a restart, before any collection."""
    test_client, _, _ = client

    response = test_client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_reports_ok_while_both_sources_are_current(client):
    test_client, session_factory, monkeypatch = client
    _freeze(monkeypatch, OPEN_HOURS)
    _add(
        session_factory,
        seoul=OPEN_HOURS - timedelta(minutes=4),
        mmca=[OPEN_HOURS - timedelta(minutes=8)] * 3,
    )

    response = test_client.get("/health/collection")
    body = response.json()

    assert response.status_code == 200
    assert body["status"] == "ok"
    assert body["seoul"]["age_minutes"] == 4.0
    assert body["mmca"]["rooms_in_last_round"] == 3
    assert body["mmca"]["calls_today"] == 3


def test_upstream_publication_lag_is_not_treated_as_stale(client):
    """국중박 observed_at 은 서울 API 가 준 PPLTN_TIME, 즉 우리가 폴링한 시각이
    아니라 상류가 발행한 측정 시각이다. 발행이 약 30분 지연되므로(2026-08-22
    프로덕션 실측 34.1분, 같은 시각 판독 간격은 5분 결손 0) 정상 수집 중에도
    나이가 30분을 넘는다. 임계값을 그보다 낮게 잡으면 이 엔드포인트가 상시
    503 이 되어 업타임 모니터가 무력해진다."""
    test_client, session_factory, monkeypatch = client
    _freeze(monkeypatch, OPEN_HOURS)
    _add(
        session_factory,
        seoul=OPEN_HOURS - timedelta(minutes=35),
        mmca=[OPEN_HOURS - timedelta(minutes=8)],
    )

    response = test_client.get("/health/collection")
    body = response.json()

    assert response.status_code == 200
    assert body["seoul"]["stale"] is False


def test_reports_503_when_seoul_collection_stops(client):
    test_client, session_factory, monkeypatch = client
    _freeze(monkeypatch, OPEN_HOURS)
    _add(
        session_factory,
        seoul=OPEN_HOURS - timedelta(minutes=90),
        mmca=[OPEN_HOURS - timedelta(minutes=8)],
    )

    response = test_client.get("/health/collection")
    body = response.json()

    assert response.status_code == 503
    assert body["status"] == "stale"
    assert body["seoul"]["stale"] is True
    assert body["mmca"]["stale"] is False


def test_a_rough_upstream_hour_is_not_reported_as_an_outage(client):
    """A 60-minute-old reading is upstream being slow, not collection dying.

    Seoul's observed_at is the API's own publication time, which already lags
    ~30 minutes on a healthy day, so the age this endpoint measures starts at
    ~34 and every missed 5-minute cycle adds five. The threshold was 45 until
    2026-08-30, leaving 11 minutes of headroom — two missed cycles tripped it,
    and one bad upstream day mailed "server down" five times for a process
    that never restarted.

    75 was picked against 45 days of gap history rather than a formula —
    alerting days by threshold were 45 → 2, 60 → 1, 75 → 0, and nothing past
    75 buys anything. The full table is in SEOUL_STALE_MINUTES's comment.

    This pins the headroom rather than the constant: if someone tightens the
    threshold back toward the publication lag, this fails.
    """
    test_client, session_factory, monkeypatch = client
    _freeze(monkeypatch, OPEN_HOURS)
    _add(
        session_factory,
        seoul=OPEN_HOURS - timedelta(minutes=60),
        mmca=[OPEN_HOURS - timedelta(minutes=8)],
    )

    response = test_client.get("/health/collection")
    body = response.json()

    assert response.status_code == 200
    assert body["seoul"]["stale"] is False


def test_reports_503_when_mmca_stops_during_opening_hours(client):
    test_client, session_factory, monkeypatch = client
    _freeze(monkeypatch, OPEN_HOURS)
    _add(
        session_factory,
        seoul=OPEN_HOURS - timedelta(minutes=2),
        mmca=[OPEN_HOURS - timedelta(hours=3)],
    )

    response = test_client.get("/health/collection")

    assert response.status_code == 503
    assert response.json()["mmca"]["stale"] is True


def test_an_hours_old_mmca_round_is_fine_outside_opening_hours(client):
    """Nothing is collected overnight, so age alone can't mean failure."""
    test_client, session_factory, monkeypatch = client
    _freeze(monkeypatch, BEFORE_OPENING)
    _add(
        session_factory,
        seoul=BEFORE_OPENING - timedelta(minutes=3),
        mmca=[BEFORE_OPENING - timedelta(hours=14)],
    )

    response = test_client.get("/health/collection")

    assert response.status_code == 200
    assert response.json()["mmca"]["stale"] is False


def test_mmca_is_not_stale_in_the_first_minutes_after_opening(client):
    """The first round of the day hasn't run yet at 10:15."""
    test_client, session_factory, monkeypatch = client
    just_opened = datetime(2026, 8, 12, 10, 15)
    _freeze(monkeypatch, just_opened)
    _add(
        session_factory,
        seoul=just_opened - timedelta(minutes=3),
        mmca=[just_opened - timedelta(hours=13)],
    )

    response = test_client.get("/health/collection")

    assert response.status_code == 200
    assert response.json()["mmca"]["stale"] is False


def test_an_empty_database_reads_as_stale(client):
    """Both sources, not just Seoul — a wiped DB during opening hours is not
    the same situation as the off-hours case above, where MMCA having nothing
    recent is expected."""
    test_client, _, monkeypatch = client
    _freeze(monkeypatch, OPEN_HOURS)

    response = test_client.get("/health/collection")
    body = response.json()

    assert response.status_code == 503
    assert body["seoul"]["last_observed_at"] is None
    assert body["seoul"]["stale"] is True
    assert body["mmca"]["last_observed_at"] is None
    assert body["mmca"]["stale"] is True
    assert body["mmca"]["rooms_in_last_round"] == 0


def _stamp_backup(monkeypatch, tmp_path, uploaded_at: datetime | None):
    """Point settings at a scratch backup dir, optionally with a stamp in it.

    backup_db.sh touches .last_upload only after the upload PUT returns, so its
    mtime means "an off-box copy exists" — not "a local file exists".
    """
    from app.config import settings

    monkeypatch.setattr(settings, "backup_dir", str(tmp_path))
    if uploaded_at is not None:
        stamp = tmp_path / ".last_upload"
        stamp.touch()
        epoch = uploaded_at.replace(tzinfo=ZoneInfo("Asia/Seoul")).timestamp()
        os.utime(stamp, (epoch, epoch))


def test_backup_age_is_null_when_nothing_has_been_uploaded(client, tmp_path):
    """Dev machines have no backup dir. That is not a failure, just an absence."""
    test_client, session_factory, monkeypatch = client
    _freeze(monkeypatch, OPEN_HOURS)
    _stamp_backup(monkeypatch, tmp_path, None)
    _add(
        session_factory,
        seoul=OPEN_HOURS - timedelta(minutes=4),
        mmca=[OPEN_HOURS - timedelta(minutes=8)] * 3,
    )

    response = test_client.get("/health/collection")
    body = response.json()

    assert response.status_code == 200
    assert body["status"] == "ok"
    assert body["backup"] == {"last_offsite_upload_at": None, "age_hours": None}


def test_a_stale_backup_is_reported_without_failing_the_check(client, tmp_path):
    """The backup block deliberately does not gate the 503.

    A threshold this endpoint could not satisfy is what once pinned it at a
    permanent 503 and made the uptime monitor useless (see SEOUL_STALE_MINUTES).
    A backup four days old is worth seeing, not worth paging for — and it must
    not mask a genuine collection outage by sharing the same status code.
    """
    test_client, session_factory, monkeypatch = client
    _freeze(monkeypatch, OPEN_HOURS)
    _stamp_backup(monkeypatch, tmp_path, OPEN_HOURS - timedelta(hours=100))
    _add(
        session_factory,
        seoul=OPEN_HOURS - timedelta(minutes=4),
        mmca=[OPEN_HOURS - timedelta(minutes=8)] * 3,
    )

    response = test_client.get("/health/collection")
    body = response.json()

    assert response.status_code == 200
    assert body["status"] == "ok"
    assert body["backup"]["age_hours"] == 100.0
    assert body["backup"]["last_offsite_upload_at"] == "2026-08-08T11:00:00"
    # No "stale" key: sharing the name with seoul/mmca would imply it votes
    # on the status code, which it must not.
    assert "stale" not in body["backup"]
