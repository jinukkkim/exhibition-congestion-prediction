import json
import logging
from datetime import date, datetime

import fakeredis
import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app.mmca_api import MmcaCongestionReading
from app.models import RawCongestion, RawMmcaCongestion
from app.seoul_api import CongestionReading


@pytest.fixture
def session_factory():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


@pytest.fixture(autouse=True)
def fake_redis(monkeypatch):
    import app.cache as cache_module

    monkeypatch.setattr(cache_module, "r", fakeredis.FakeRedis(decode_responses=True))


def test_collect_once_stores_and_caches(monkeypatch, session_factory):
    import app.collector as collector_module

    fake_reading = CongestionReading(
        observed_at=datetime(2026, 7, 15, 14, 30),
        congest_level="보통",
        population_min=1000,
        population_max=2000,
    )
    monkeypatch.setattr(collector_module, "fetch_congestion", lambda client, area, key: fake_reading)

    result = collector_module.collect_once(session_factory=session_factory)

    assert result == fake_reading
    with session_factory() as session:
        assert session.query(RawCongestion).count() == 1

    from app.cache import get_latest
    assert get_latest()["congest_level"] == "보통"


def test_collect_once_propagates_api_error(monkeypatch, session_factory):
    """A sustained outage still reaches the scheduler's error listener."""
    import app.collector as collector_module

    calls = []

    def raise_error(client, area, key):
        calls.append(1)
        raise httpx.HTTPError("boom")

    monkeypatch.setattr(collector_module, "fetch_congestion", raise_error)
    monkeypatch.setattr(collector_module, "_FETCH_RETRY_SECONDS", 0)

    with pytest.raises(httpx.HTTPError):
        collector_module.collect_once(session_factory=session_factory)

    assert len(calls) == collector_module._FETCH_ATTEMPTS
    with session_factory() as session:
        assert session.query(RawCongestion).count() == 0


def test_collect_once_retries_a_non_json_body(monkeypatch, session_factory):
    """The Seoul API answers 200 with a non-JSON body on isolated polls.

    Observed six times in the week of 2026-08-11, always as a single poll with
    healthy neighbours — so the retry is what keeps that slot out of the gap.
    """
    import app.collector as collector_module

    fake_reading = CongestionReading(
        observed_at=datetime(2026, 8, 11, 13, 0),
        congest_level="보통",
        population_min=1000,
        population_max=2000,
    )
    calls = []

    def flake_once(client, area, key):
        calls.append(1)
        if len(calls) == 1:
            raise json.JSONDecodeError("Expecting value", "", 0)
        return fake_reading

    monkeypatch.setattr(collector_module, "fetch_congestion", flake_once)
    monkeypatch.setattr(collector_module, "_FETCH_RETRY_SECONDS", 0)

    result = collector_module.collect_once(session_factory=session_factory)

    assert len(calls) == 2
    assert result.congest_level == "보통"
    with session_factory() as session:
        assert session.query(RawCongestion).count() == 1


def test_a_recovered_fetch_records_how_long_the_bad_spell_lasted(
    monkeypatch, session_factory, caplog
):
    """The recovery line is the only measurement of an upstream bad spell.

    raw_congestion.observed_at is the Open API's publication time, so the DB
    cannot say when a poll ran or how long it was blocked. Reconstructing the
    2026-08-30 outage windows from it meant assuming the ~30 minute lag. This
    log line is what makes the next one measurable — and it has to be at
    warning, because that is the level the journal keeps.

    Asserted on substance, not on the elapsed number: timing assertions are
    brittle and the seconds are not the contract.
    """
    import app.collector as collector_module

    fake_reading = CongestionReading(
        observed_at=datetime(2026, 7, 15, 14, 30),
        congest_level="보통",
        population_min=1000,
        population_max=2000,
    )
    calls = []

    def flake_once(client, area, key):
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ReadTimeout("timed out")
        return fake_reading

    monkeypatch.setattr(collector_module, "fetch_congestion", flake_once)
    monkeypatch.setattr(collector_module, "_FETCH_RETRY_SECONDS", 0)

    with caplog.at_level(logging.WARNING, logger="app.collector"):
        collector_module.collect_once(session_factory=session_factory)

    recovered = [r for r in caplog.records if "recovered" in r.message]
    assert len(recovered) == 1, "a recovery must leave exactly one line"
    assert recovered[0].levelno == logging.WARNING
    assert "after" in recovered[0].getMessage()


def test_collect_once_stores_population_breakdown_fields(monkeypatch, session_factory):
    import app.collector as collector_module

    fake_reading = CongestionReading(
        observed_at=datetime(2026, 7, 15, 14, 30),
        congest_level="보통",
        population_min=1000,
        population_max=2000,
        male_ppltn_rate=51.8,
        resnt_ppltn_rate=45.1,
    )
    monkeypatch.setattr(collector_module, "fetch_congestion", lambda client, area, key: fake_reading)

    collector_module.collect_once(session_factory=session_factory)

    with session_factory() as session:
        stored = session.query(RawCongestion).one()
        assert stored.male_ppltn_rate == 51.8
        assert stored.resnt_ppltn_rate == 45.1


def test_collect_once_stores_raw_response(monkeypatch, session_factory):
    import app.collector as collector_module

    fake_reading = CongestionReading(
        observed_at=datetime(2026, 7, 15, 14, 30),
        congest_level="보통",
        population_min=1000,
        population_max=2000,
        raw_response='{"CITYDATA": {"AREA_NM": "test"}}',
    )
    monkeypatch.setattr(collector_module, "fetch_congestion", lambda client, area, key: fake_reading)

    collector_module.collect_once(session_factory=session_factory)

    with session_factory() as session:
        stored = session.query(RawCongestion).one()
        assert stored.raw_response == '{"CITYDATA": {"AREA_NM": "test"}}'


def test_is_venue_open_normal_day_within_hours():
    from app.collector import _is_venue_open

    # 2026-07-27 is a Monday
    # Collection starts on the opening minute — the 10:00 round used to be
    # skipped for quota (see _COLLECTION_START).
    assert _is_venue_open("seoul", datetime(2026, 7, 27, 9, 59)) is False
    assert _is_venue_open("seoul", datetime(2026, 7, 27, 10, 0)) is True
    assert _is_venue_open("seoul", datetime(2026, 7, 27, 10, 10)) is True
    assert _is_venue_open("seoul", datetime(2026, 7, 27, 18, 0)) is True
    assert _is_venue_open("seoul", datetime(2026, 7, 27, 18, 1)) is False


def test_is_venue_open_tolerates_sub_minute_jitter_at_closing():
    from app.collector import _is_venue_open

    # The scheduler fires exactly at 18:00:00, but real execution always
    # lands a little after that instant. Comparing by minute (not exact
    # second) means the closing-time reading isn't silently dropped just
    # because the poll ran a few seconds late within the same minute.
    assert _is_venue_open("seoul", datetime(2026, 7, 27, 18, 0, 47)) is True
    assert _is_venue_open("seoul", datetime(2026, 7, 27, 18, 0, 59, 999999)) is True
    # A full minute late is still correctly treated as closed.
    assert _is_venue_open("seoul", datetime(2026, 7, 27, 18, 1, 0)) is False


def test_is_venue_open_gwacheon_tolerates_sub_minute_jitter_at_closing():
    from app.collector import _is_venue_open

    # The jitter bug was originally found on Gwacheon. The check is shared
    # across venues, but this pins the venue where it actually mattered — on a
    # Wednesday, which is a 21:00 day everywhere except here.
    # 2026-07-29 is a Wednesday.
    assert _is_venue_open("gwacheon", datetime(2026, 7, 29, 18, 0, 47)) is True
    assert _is_venue_open("gwacheon", datetime(2026, 7, 29, 18, 1, 0)) is False


def test_is_venue_open_gwacheon_has_no_night_opening_and_shuts_on_monday():
    """과천관은 화~일 10:00~18:00 이다. 서울관 시간표를 그대로 쓰던 동안 휴관일
    월요일 종일과 수·토 18~21시를 폴링했고, 폐관 중에도 API 가 정상 응답으로
    "여유" 를 주므로 그 가짜 여유가 예측 프로파일에 그대로 쌓였다."""
    from app.collector import _is_venue_open

    # 2026-07-29 is a Wednesday — 21:00 for Seoul, 18:00 here.
    assert _is_venue_open("gwacheon", datetime(2026, 7, 29, 18, 0)) is True
    assert _is_venue_open("gwacheon", datetime(2026, 7, 29, 19, 0)) is False
    assert _is_venue_open("seoul", datetime(2026, 7, 29, 19, 0)) is True
    # 2026-07-27 is a Monday, 2026-07-28 a Tuesday.
    assert _is_venue_open("gwacheon", datetime(2026, 7, 27, 14, 0)) is False
    assert _is_venue_open("gwacheon", datetime(2026, 7, 28, 14, 0)) is True


def test_is_venue_open_long_day():
    from app.collector import _is_venue_open

    # 2026-07-29 is a Wednesday
    assert _is_venue_open("seoul", datetime(2026, 7, 29, 20, 0)) is True
    assert _is_venue_open("seoul", datetime(2026, 7, 29, 21, 0)) is True
    assert _is_venue_open("seoul", datetime(2026, 7, 29, 21, 1)) is False


def test_is_venue_open_deoksugung_closed_on_monday():
    from app.collector import _is_venue_open

    # 2026-07-27 is a Monday — within Seoul's hours, but Deoksugung is shut.
    assert _is_venue_open("deoksugung", datetime(2026, 7, 27, 14, 0)) is False
    # 2026-07-28 is a Tuesday — same hours as Seoul, open.
    assert _is_venue_open("deoksugung", datetime(2026, 7, 28, 14, 0)) is True


def test_is_closed_day_opens_a_holiday_monday():
    """2026-08-17(광복절 대체) 과천관은 열었다 — non-여유 판독 185건.
    출처는 공식 문서가 아니라 실측이다(관람정보 페이지는 '매주 월요일'만
    적는다). 스펙의 '알려진 한계' 참고."""
    from app.collector import _is_closed_day

    assert _is_closed_day("gwacheon", date(2026, 8, 17)) is False
    assert _is_closed_day("deoksugung", date(2026, 8, 17)) is False


def test_is_closed_day_closes_the_day_after_a_holiday_monday():
    """2026-08-18 과천관은 219 판독이 전부 여유였다(빈 건물). 다른 모든
    화요일은 non-여유가 59~157."""
    from app.collector import _is_closed_day

    assert _is_closed_day("gwacheon", date(2026, 8, 18)) is True
    # 서울관은 요일 휴관이 없어 대체 휴관도 없다 — 같은 날 non-여유 65.
    assert _is_closed_day("seoul", date(2026, 8, 18)) is False


def test_is_closed_day_still_closes_a_plain_monday():
    from app.collector import _is_closed_day

    # 2026-09-07 은 공휴일이 아닌 월요일이다.
    assert _is_closed_day("gwacheon", date(2026, 9, 7)) is True
    assert _is_closed_day("seoul", date(2026, 9, 7)) is False
    # 그 다음 화요일은 대체 휴관이 아니다 — 앞날이 공휴일이 아니었다.
    assert _is_closed_day("gwacheon", date(2026, 9, 8)) is False


def test_is_closed_day_honours_an_ad_hoc_closure():
    """서울관 2026-09-08 임시 휴관 — 관람정보 페이지가 명시하고, 그날 판독
    1,928건의 non-여유가 0이었다."""
    from app.collector import _is_closed_day

    assert _is_closed_day("seoul", date(2026, 9, 8)) is True


def test_collect_mmca_once_polls_gwacheon_on_a_holiday_monday(monkeypatch, session_factory):
    import app.collector as collector_module

    seen_codes = []

    def fake_fetch(client, space_code, api_key):
        seen_codes.append(space_code)
        return MmcaCongestionReading(
            observed_at=datetime(2026, 8, 17, 14, 0),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="테스트관",
            congestion_nm="보통",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {"gwacheon": ["MMCA-SPACE-2001"]},
    )

    # 14:00 은 probe 라운드가 아니지만 창이 비어 있어 전부 부른다.
    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 8, 17, 14, 0)
    )

    assert seen_codes == ["MMCA-SPACE-2001"]
    assert len(result) == 1


def test_collect_mmca_once_skips_gwacheon_the_day_after(monkeypatch, session_factory):
    import app.collector as collector_module

    def fake_fetch(client, space_code, api_key):
        raise AssertionError("대체 휴관일에는 부르지 않는다")

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {"gwacheon": ["MMCA-SPACE-2001"]},
    )

    assert (
        collector_module.collect_mmca_once(
            session_factory=session_factory, now=datetime(2026, 8, 18, 14, 0)
        )
        == []
    )


def test_collect_mmca_once_skips_api_call_when_closed(monkeypatch, session_factory):
    import app.collector as collector_module

    call_count = 0

    def fake_fetch(client, space_code, api_key):
        nonlocal call_count
        call_count += 1
        raise AssertionError("should not be called outside business hours")

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)

    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 8, 0)
    )

    assert result == []
    assert call_count == 0
    with session_factory() as session:
        assert session.query(RawMmcaCongestion).count() == 0


def test_collect_mmca_once_fetches_all_rooms_when_open(monkeypatch, session_factory):
    import app.collector as collector_module

    def fake_fetch(client, space_code, api_key):
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 27, 14, 0),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="국립현대미술관 서울관",
            congestion_nm="보통",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {"seoul": ["MMCA-SPACE-1001", "MMCA-SPACE-1002"]},
    )

    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 14, 0)
    )

    assert len(result) == 2
    with session_factory() as session:
        assert session.query(RawMmcaCongestion).count() == 2


def test_collect_mmca_once_continues_after_one_room_fails(monkeypatch, session_factory):
    import app.collector as collector_module

    def fake_fetch(client, space_code, api_key):
        if space_code == "MMCA-SPACE-1001":
            raise httpx.HTTPError("boom")
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 27, 14, 0),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="국립현대미술관 서울관",
            congestion_nm="여유",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {"seoul": ["MMCA-SPACE-1001", "MMCA-SPACE-1002"]},
    )

    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 14, 0)
    )

    assert len(result) == 1
    assert result[0].space_code == "MMCA-SPACE-1002"
    with session_factory() as session:
        assert session.query(RawMmcaCongestion).count() == 1


def test_collect_mmca_once_continues_after_one_room_returns_invalid_json(monkeypatch, session_factory):
    """data.go.kr sometimes returns a non-JSON (e.g. XML error) body with a 200
    status. That must not crash the whole collection cycle. (A key error is a
    4xx on this endpoint, measured 2026-09-02 — a different exception down the
    same per-room handler.)"""
    import app.collector as collector_module

    def fake_fetch(client, space_code, api_key):
        if space_code == "MMCA-SPACE-1001":
            raise json.JSONDecodeError("bad json", "doc", 0)
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 27, 14, 0),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="국립현대미술관 서울관",
            congestion_nm="여유",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {"seoul": ["MMCA-SPACE-1001", "MMCA-SPACE-1002"]},
    )

    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 14, 0)
    )

    assert len(result) == 1
    assert result[0].space_code == "MMCA-SPACE-1002"
    with session_factory() as session:
        assert session.query(RawMmcaCongestion).count() == 1


def test_collect_mmca_once_normalizes_observed_at_across_the_round(monkeypatch, session_factory):
    """Rooms are polled sequentially, each via its own HTTP call that stamps
    its own wall-clock time. A slow batch can straddle a minute boundary
    mid-round (room 1 fetched at :39:59, room 2 at :40:03) — without
    normalization those readings would land in different /mmca/daily minute
    buckets even though they belong to the same collection round."""
    import app.collector as collector_module

    def fake_fetch(client, space_code, api_key):
        drifted_time = {
            "MMCA-SPACE-2001": datetime(2026, 7, 28, 14, 39, 59),
            "MMCA-SPACE-2002": datetime(2026, 7, 28, 14, 40, 3),
        }[space_code]
        return MmcaCongestionReading(
            observed_at=drifted_time,
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="국립현대미술관 과천관",
            congestion_nm="보통",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {"gwacheon": ["MMCA-SPACE-2001", "MMCA-SPACE-2002"]},
    )

    round_time = datetime(2026, 7, 28, 14, 40, 0)
    result = collector_module.collect_mmca_once(session_factory=session_factory, now=round_time)

    assert len(result) == 2
    assert all(reading.observed_at == round_time for reading in result)
    with session_factory() as session:
        stored_times = {row.observed_at for row in session.query(RawMmcaCongestion).all()}
    assert stored_times == {round_time}


def test_collect_mmca_once_snaps_observed_at_to_the_poll_grid(monkeypatch, session_factory):
    """The scheduler fires on the MMCA_POLL_MINUTES cron grid, but jitter or a
    misfire-grace-time catch-up run can land the actual invocation off that
    mark. Every reading must still be stamped with the grid mark, not the raw
    run time, so rounds are always exactly one grid step apart regardless of
    when they actually ran.

    Asserted as properties rather than against a literal mark: the expected
    stamp depends on MMCA_POLL_MINUTES, and re-deriving it here would just
    restate the implementation. The last assertion is the one that catches a
    cron/floor mismatch — floor 10 under a 1-minute cron leaves `now` up to
    9 minutes past the stamp, which is exactly the state where consecutive
    rounds collide on one observed_at."""
    from datetime import timedelta

    import app.collector as collector_module
    from app.collector import MMCA_POLL_MINUTES

    def fake_fetch(client, space_code, api_key):
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 28, 11, 31, 12),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="국립현대미술관 과천관",
            congestion_nm="보통",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {"gwacheon": ["MMCA-SPACE-2001"]},
    )

    now = datetime(2026, 7, 28, 11, 31, 4)
    result = collector_module.collect_mmca_once(session_factory=session_factory, now=now)

    assert len(result) == 1
    stamped = result[0].observed_at
    with session_factory() as session:
        stored = session.query(RawMmcaCongestion).one()
    assert stored.observed_at == stamped

    # Not the fetch's own wall-clock time (11:31:12, ahead of `now`), and not
    # `now` either: a grid mark, seconds cleared, at or before the run.
    assert (stamped.second, stamped.microsecond) == (0, 0)
    assert stamped.minute % MMCA_POLL_MINUTES == 0
    assert timedelta(0) <= now - stamped < timedelta(minutes=MMCA_POLL_MINUTES)


def test_collect_mmca_once_fetches_rooms_from_every_venue(monkeypatch, session_factory):
    import app.collector as collector_module

    seen_codes = []

    def fake_fetch(client, space_code, api_key):
        seen_codes.append(space_code)
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 28, 14, 0),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="테스트관",
            congestion_nm="보통",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {
            "seoul": ["MMCA-SPACE-1001"],
            "gwacheon": ["MMCA-SPACE-2001"],
        },
    )

    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 28, 14, 0)
    )

    assert len(result) == 2
    assert set(seen_codes) == {"MMCA-SPACE-1001", "MMCA-SPACE-2001"}


def test_collect_mmca_once_skips_only_the_closed_venue(monkeypatch, session_factory):
    import app.collector as collector_module

    seen_codes = []

    def fake_fetch(client, space_code, api_key):
        seen_codes.append(space_code)
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 27, 14, 0),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="테스트관",
            congestion_nm="보통",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    # MMCA-SPACE-9001 stands in for a Monday-closed venue — keeps this test
    # isolated to the business-hours gate.
    monkeypatch.setattr(
        collector_module,
        "_VENUE_CLOSED_DAYS",
        {"deoksugung": {0}, "test-closed-venue": {0}},
    )
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {
            "seoul": ["MMCA-SPACE-1001"],
            "test-closed-venue": ["MMCA-SPACE-9001"],
        },
    )

    # 2026-07-27 is a Monday: Seoul is open, the test venue is shut.
    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 14, 0)
    )

    assert len(result) == 1
    assert seen_codes == ["MMCA-SPACE-1001"]


def _record_fetch(monkeypatch, collector_module, seen_codes, congestion_nm="보통"):
    def fake_fetch(client, space_code, api_key):
        seen_codes.append(space_code)
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 27, 12, 0),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="테스트관",
            congestion_nm=congestion_nm,
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)
    monkeypatch.setattr(
        collector_module.settings,
        "mmca_venue_space_codes",
        {"seoul": ["MMCA-SPACE-1001", "MMCA-SPACE-1002"]},
    )


def _seed(session_factory, space_code, minutes, congestion_nm):
    with session_factory() as session:
        for hour, minute in minutes:
            session.add(
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 27, hour, minute),
                    space_code=space_code,
                    congestion_nm=congestion_nm,
                )
            )
        session.commit()


def test_collect_mmca_once_skips_a_room_with_no_exhibition_between_probes(
    monkeypatch, session_factory
):
    """전시가 없어 빈 판독만 오는 방은 probe 라운드 사이에서 빠진다."""
    import app.collector as collector_module

    _seed(session_factory, "MMCA-SPACE-1001", [(11, 40), (11, 50)], "보통")
    _seed(session_factory, "MMCA-SPACE-1002", [(11, 40), (11, 50)], None)

    seen_codes = []
    _record_fetch(monkeypatch, collector_module, seen_codes)

    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 11, 52)
    )

    assert seen_codes == ["MMCA-SPACE-1001"]
    assert len(result) == 1


def test_collect_mmca_once_probe_round_polls_a_room_with_no_exhibition(
    monkeypatch, session_factory
):
    """probe 라운드에서는 빈 판독만 오던 방도 다시 부른다.

    이 스킵은 옛 1,000콜/일 상한 시절에도 있었고, 그때는 재확인이 2시간
    주기라 낮에 새로 여는 전시를 최대 2시간 뒤에야 잡아서 걷어냈다. 다시
    넣은 지금 그 지연을 _PROBE_MINUTES 로 묶어 두는 것이 요점이다.
    """
    import app.collector as collector_module

    _seed(session_factory, "MMCA-SPACE-1001", [(11, 40), (11, 50)], "보통")
    _seed(session_factory, "MMCA-SPACE-1002", [(11, 40), (11, 50)], None)

    seen_codes = []
    _record_fetch(monkeypatch, collector_module, seen_codes)

    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 12, 0)
    )

    assert seen_codes == ["MMCA-SPACE-1001", "MMCA-SPACE-1002"]
    assert len(result) == 2


def test_collect_mmca_once_polls_a_revived_room_on_every_round_again(
    monkeypatch, session_factory
):
    """probe 가 살아난 방을 잡으면 다음 라운드부터 다시 매번 돈다.

    1003·1005 가 37일 내리 0002 였다가 2026-09-01 15:00 에 살아난 것이
    이 경로다 — 개장 시각이 아니라 장중이었다.
    """
    import app.collector as collector_module

    _seed(session_factory, "MMCA-SPACE-1001", [(11, 40), (12, 0)], "보통")
    _seed(session_factory, "MMCA-SPACE-1002", [(11, 40)], None)
    _seed(session_factory, "MMCA-SPACE-1002", [(12, 0)], "여유")

    seen_codes = []
    _record_fetch(monkeypatch, collector_module, seen_codes)

    collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 12, 2)
    )

    assert seen_codes == ["MMCA-SPACE-1001", "MMCA-SPACE-1002"]


def test_collect_mmca_once_polls_everything_when_the_probe_window_is_empty(
    monkeypatch, session_factory
):
    """창에 판독이 하나도 없으면 스킵하지 않는다 — 개관 직후·재시작 직후에
    빈 결과를 "전부 0002" 로 읽으면 다음 probe 까지 통째로 잃는다."""
    import app.collector as collector_module

    seen_codes = []
    _record_fetch(monkeypatch, collector_module, seen_codes)

    collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 12, 2)
    )

    assert seen_codes == ["MMCA-SPACE-1001", "MMCA-SPACE-1002"]


def test_probe_rounds_survive_a_grid_that_does_not_divide_the_probe_interval(
    monkeypatch, session_factory
):
    """격자가 30 을 나누지 않아도 30분 창마다 probe 라운드가 하나 있다.

    MMCA_POLL_MINUTES 는 이미 세 번(10→1→2) 바뀐 값이다. 4 가 되면 라운드의
    분이 0,4,…,28,32,… 라 30 이 아예 나오지 않으므로, `% 30 == 0` 으로
    판정하면 probe 가 정각 하나로 줄고 그만큼 되살아난 방을 늦게 잡는다.
    """
    import app.collector as collector_module

    monkeypatch.setattr(collector_module, "MMCA_POLL_MINUTES", 4)
    _seed(session_factory, "MMCA-SPACE-1001", [(11, 40), (11, 44)], "보통")
    _seed(session_factory, "MMCA-SPACE-1002", [(11, 40), (11, 44)], None)

    seen_codes = []
    _record_fetch(monkeypatch, collector_module, seen_codes)

    # 11:47 → 라운드 마크 11:44. 30분 창 안쪽이라 probe 가 아니다.
    collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 11, 47)
    )
    assert seen_codes == ["MMCA-SPACE-1001"]

    # 11:35 → 라운드 마크 11:32. 30 은 격자에 없지만 이것이 그 창의 첫
    # 라운드라 probe 다.
    seen_codes.clear()
    collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 27, 11, 35)
    )
    assert seen_codes == ["MMCA-SPACE-1001", "MMCA-SPACE-1002"]


def test_collect_mmca_once_polls_every_configured_room(monkeypatch, session_factory):
    import app.collector as collector_module

    seen_codes = []

    def fake_fetch(client, space_code, api_key):
        seen_codes.append(space_code)
        return MmcaCongestionReading(
            observed_at=datetime(2026, 7, 28, 14, 0),
            space_code=space_code,
            space_nm="테스트 전시실",
            agnc_nm="테스트관",
            congestion_nm="보통",
        )

    monkeypatch.setattr(collector_module, "fetch_mmca_congestion", fake_fetch)

    # settings 를 갈아끼우지 않는다 — 실제 설정의 17개 방(서울 8 + 과천 8 +
    # 덕수궁 1)이 전부 폴링되는지가 요점이다. 덕수궁 1전시실과 과천
    # 어린이미술관은 쿼터 때문에 수집에서 빠져 있었고, 운영 계정으로 바뀐 뒤
    # 다시 대상이 되었다.
    # 2026-07-28 은 화요일 — 세 관 모두 개관일이다.
    result = collector_module.collect_mmca_once(
        session_factory=session_factory, now=datetime(2026, 7, 28, 14, 0)
    )

    assert len(result) == 17
    assert {"MMCA-SPACE-4001", "MMCA-SPACE-2008"} <= set(seen_codes)
