from datetime import date, timedelta

from app.config import (
    MUSEUM_CALENDAR_CHECKED_THROUGH,
    MUSEUM_CLOSED_DAYS,
    MUSEUM_PUBLIC_HOLIDAYS,
)


def test_settings_reads_env(monkeypatch):
    monkeypatch.setenv("SEOUL_API_KEY", "test-key")
    monkeypatch.setenv("DATABASE_URL", "sqlite:///:memory:")
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/1")

    from app.config import Settings
    settings = Settings()

    assert settings.seoul_api_key == "test-key"
    assert settings.seoul_area_name == "국립중앙박물관·용산가족공원"
    assert settings.database_url == "sqlite:///:memory:"
    assert settings.redis_url == "redis://localhost:6379/1"


def test_settings_reads_mmca_env(monkeypatch):
    monkeypatch.setenv("SEOUL_API_KEY", "test-key")
    monkeypatch.setenv("MMCA_API_KEY", "mmca-test-key")
    monkeypatch.setenv("DATABASE_URL", "sqlite:///:memory:")
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/1")

    from app.config import Settings
    settings = Settings()

    assert settings.mmca_api_key == "mmca-test-key"
    assert settings.mmca_venue_space_codes == {
        "seoul": [
            "MMCA-SPACE-1001",
            "MMCA-SPACE-1002",
            "MMCA-SPACE-1003",
            "MMCA-SPACE-1004",
            "MMCA-SPACE-1005",
            "MMCA-SPACE-1006",
            "MMCA-SPACE-1007",
            "MMCA-SPACE-1008",
        ],
        "gwacheon": [
            "MMCA-SPACE-2001",
            "MMCA-SPACE-2002",
            "MMCA-SPACE-2003",
            "MMCA-SPACE-2004",
            "MMCA-SPACE-2005",
            "MMCA-SPACE-2006",
            "MMCA-SPACE-2007",
            "MMCA-SPACE-2008",
        ],
        "deoksugung": ["MMCA-SPACE-4001"],
    }


def test_museum_calendar_loads_the_shared_file():
    # 2026-08-17 은 광복절 대체공휴일 월요일 — 규칙 2 의 유일한 실측 근거다.
    assert "2026-08-17" in MUSEUM_PUBLIC_HOLIDAYS
    # 서울관 임시 휴관일. 어떤 달력으로도 계산할 수 없어 손으로 넣은 값이다.
    assert "2026-09-08" in MUSEUM_CLOSED_DAYS["seoul"]
    assert "2026-09-08" not in MUSEUM_CLOSED_DAYS["gwacheon"]


def test_public_holidays_are_all_mondays():
    """월요일만 싣는다 — 다른 요일의 공휴일은 판정에 닿지 않고, 실으면
    holidays 라이브러리의 회색지대(근로자의날 등)를 그대로 들여오게 된다."""
    for day in MUSEUM_PUBLIC_HOLIDAYS:
        assert date.fromisoformat(day).weekday() == 0, day


def test_the_calendar_has_not_gone_stale():
    """손으로 채운 목록이라 checkedThrough 를 넘기면 조용히 틀린다 — 요일
    규칙만 남아 공휴일 월요일을 휴관으로 그리게 되고, 그것이 이 달력이
    고치려던 버그다. 60일 전에 CI 가 먼저 빨개진다.

    고치는 방법은 하나뿐이다: shared/museum-holidays.json 에 다음 해를 채우고
    checkedThrough 를 미룬다. 각 관 관람정보 페이지(venues.ts 의 homepage)가
    그 해 휴관일과 임시 휴관일을 싣는다.
    """
    assert MUSEUM_CALENDAR_CHECKED_THROUGH - date.today() > timedelta(days=60)
