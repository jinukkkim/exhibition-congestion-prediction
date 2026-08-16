from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.collector import store_forecast_revisions
from app.db import Base
from app.models import ForecastCongestion, ForecastWeather
from app.seoul_api import CongestionForecast, WeatherForecast

TARGET = datetime(2026, 8, 13, 15, 0)


@pytest.fixture
def session_factory():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


def _forecast(level: str, minimum: int, maximum: int) -> CongestionForecast:
    return CongestionForecast(
        target_at=TARGET, congest_level=level, population_min=minimum, population_max=maximum
    )


def _store(session, issued: str, *forecasts) -> int:
    stored = store_forecast_revisions(
        session, ForecastCongestion, datetime.fromisoformat(issued), list(forecasts)
    )
    session.commit()
    return stored


def test_repeated_forecast_is_not_stored_again(session_factory):
    """The same forecast comes back on all 288 daily polls."""
    with session_factory() as session:
        assert _store(session, "2026-08-13 02:30", _forecast("약간 붐빔", 2500, 3000)) == 1
        assert _store(session, "2026-08-13 02:35", _forecast("약간 붐빔", 2500, 3000)) == 0
        assert _store(session, "2026-08-13 02:40", _forecast("약간 붐빔", 2500, 3000)) == 0

        assert session.query(ForecastCongestion).count() == 1


def test_each_revision_is_kept_with_its_issue_time(session_factory):
    with session_factory() as session:
        _store(session, "2026-08-13 02:30", _forecast("약간 붐빔", 2500, 3000))
        _store(session, "2026-08-13 04:55", _forecast("보통", 2000, 2500))
        _store(session, "2026-08-13 09:00", _forecast("보통", 1500, 2000))

        rows = session.query(ForecastCongestion).order_by(ForecastCongestion.issued_at).all()

        assert [(row.issued_at.hour, row.congest_level, row.population_min) for row in rows] == [
            (2, "약간 붐빔", 2500),
            (4, "보통", 2000),
            (9, "보통", 1500),
        ]


def test_a_population_only_change_still_counts_as_a_revision(session_factory):
    """등급은 그대로여도 인구 구간이 바뀌면 다른 예보다."""
    with session_factory() as session:
        _store(session, "2026-08-13 09:00", _forecast("보통", 1500, 2000))

        assert _store(session, "2026-08-13 09:30", _forecast("보통", 2000, 2500)) == 1


def test_a_value_reverting_to_an_earlier_one_is_a_new_revision(session_factory):
    """12:30 붐빔 -> 12:55 약간 붐빔 -> 13:45 붐빔 really happened on 2026-08-13.

    Comparing against every row ever stored instead of just the latest would
    drop the third one and lose the fact that the forecast flip-flopped.
    """
    with session_factory() as session:
        _store(session, "2026-08-13 12:30", _forecast("붐빔", 2500, 3000))
        _store(session, "2026-08-13 12:55", _forecast("약간 붐빔", 2500, 3000))

        assert _store(session, "2026-08-13 13:45", _forecast("붐빔", 2500, 3000)) == 1
        assert session.query(ForecastCongestion).count() == 3


def test_forecasts_for_different_targets_do_not_shadow_each_other(session_factory):
    with session_factory() as session:
        stored = _store(
            session,
            "2026-08-13 09:00",
            _forecast("보통", 1500, 2000),
            CongestionForecast(
                target_at=datetime(2026, 8, 13, 16, 0),
                congest_level="붐빔",
                population_min=3000,
                population_max=3500,
            ),
        )

        assert stored == 2


def test_weather_forecasts_use_the_same_revision_rule(session_factory):
    def forecast(temp: float) -> WeatherForecast:
        return WeatherForecast(
            target_at=TARGET,
            temp=temp,
            precipitation="-",
            precpt_type="없음",
            rain_chance=0.0,
            sky_stts="구름많음",
        )

    with session_factory() as session:
        issued = datetime(2026, 8, 13, 9, 0)
        assert store_forecast_revisions(session, ForecastWeather, issued, [forecast(31.0)]) == 1
        session.commit()

        assert store_forecast_revisions(session, ForecastWeather, issued, [forecast(31.0)]) == 0
        assert store_forecast_revisions(session, ForecastWeather, issued, [forecast(32.0)]) == 1


def test_replaying_the_same_polls_adds_nothing(session_factory):
    """scripts/backfill_forecasts.py replays history from the start.

    Comparing against the latest row overall rather than the latest as of
    issued_at makes every replayed poll look like a revision of the newest
    stored value, re-inserting the whole table on each run.
    """
    polls = [
        ("2026-08-13 02:30", _forecast("약간 붐빔", 2500, 3000)),
        ("2026-08-13 04:55", _forecast("보통", 2000, 2500)),
        ("2026-08-13 09:00", _forecast("보통", 1500, 2000)),
    ]

    with session_factory() as session:
        assert sum(_store(session, issued, f) for issued, f in polls) == 3

        assert sum(_store(session, issued, f) for issued, f in polls) == 0
        assert session.query(ForecastCongestion).count() == 3
