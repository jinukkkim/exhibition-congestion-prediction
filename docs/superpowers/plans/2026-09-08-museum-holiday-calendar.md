# 휴관일 달력 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 요일 하나로만 판정하던 휴관일을 공유 달력(공휴일 월요일 예외·대체 휴관·달력 휴관·임시 휴관)으로 바꾸고, 그 규칙으로 이미 쌓인 빈 건물 판독을 정리한다.

**Architecture:** 리포 루트 `shared/museum-holidays.json` 한 파일이 날짜 목록을 갖고, 백엔드(파일 읽기)와 프론트(`import`)가 각각 ~10줄짜리 같은 규칙을 구현한다. 백엔드는 `collector.py` 의 `_is_venue_open` 한 곳만 고치면 소비자 셋이 따라온다. 프론트는 `mmcaBusinessHours()` 의 `isOpenToday` 가 규칙을 물고, PR #96 이 만든 휴관일 안내 화면이 그대로 뜬다.

**Tech Stack:** Python 3.12 / SQLAlchemy / pytest, React 18 / TypeScript / Vite / vitest

**Spec:** `docs/superpowers/specs/2026-09-08-museum-holiday-calendar-design.md`

**실행 후 갱신(2026-09-09):** 아래 Task 1 의 JSON 스니펫은 계획 당시의 값이다.
코드 리뷰에서 설·추석 연휴 월요일(`2026-02-16`, `2027-02-08`)이 규칙 3 을
오작동시키는 것이 발견돼 두 날짜를 뺐다 — 그 월요일을 공휴일로 실으면 다음
날인 설날을 대체 휴관으로 닫는데, 과천·덕수궁의 공표 휴관일은 "1월1일, 매주
월요일" 뿐이다. **실제 값은 `shared/museum-holidays.json` 이 authoritative
하고**, 근거는 스펙의 알려진 한계에 있다. Task 6 의 실행 명령도 갱신했다
(purge 스크립트는 이제 미리보기가 기본값이고 `--delete` 로만 지운다).

## Global Constraints

- 커밋: Conventional Commits `type(scope): subject`. 영어, 소문자 시작, 명령형, 마침표 없음, 100자 미만.
- 스코프: `be` = `backend/app/` + `backend/tests/`, `dev` = `backend/scripts/`, `fe` = `frontend/`. `docs:`/`ci:` 는 스코프 없음. **`fe` 와 `be` 를 한 커밋에 섞지 않는다.**
- `Co-Authored-By: Claude` 등 AI 저작 트레일러 금지.
- 브랜치 접두사 = 커밋 타입. 이 계획은 `feat/museum-holiday-calendar` 에서 진행한다(`develop` 기준).
- 이 repo 의 `style` 은 **시각** 변경을 뜻한다. 코드 포매팅 전용 커밋을 만들지 않는다.
- 관 키는 `seoul` / `gwacheon` / `deoksugung` / `national-museum` 넷. 앞의 셋은 `settings.mmca_venue_space_codes` 의 키이자 프론트 `MmcaVenue` 타입과 같은 값이고, 마지막은 `venues.ts` 의 `id` 다.
- 날짜는 전부 `YYYY-MM-DD` 문자열로 비교한다. Python `date` ↔ JS `Date` 를 오가지 않는다.
- 백엔드 테스트: `cd backend && .venv/bin/python -m pytest`. 프론트: `cd frontend && npx vitest run` 과 `npx tsc --noEmit`.

## File Structure

| 파일 | 책임 |
|---|---|
| `shared/museum-holidays.json` (생성) | 날짜 목록만. 로직 없음. 양쪽의 유일한 공유물 |
| `backend/app/config.py` (수정) | JSON 로드 → `MUSEUM_PUBLIC_HOLIDAYS`, `MUSEUM_CLOSED_DAYS`, `MUSEUM_CALENDAR_CHECKED_THROUGH` |
| `backend/app/collector.py` (수정) | `_is_closed_day(venue, day)` 신설, `_is_venue_open` 이 그것을 씀 |
| `backend/scripts/purge_out_of_hours_mmca.py` (수정) | 공휴일 통째 스킵 제거 |
| `frontend/src/lib/museumCalendar.ts` (생성) | JSON import + `isClosedDay(venue, date)`. 백엔드 규칙의 TS 쌍 |
| `frontend/src/lib/mmcaBusinessHours.ts` (수정) | `isOpenToday` 가 `isClosedDay` 를 물음. 요일 전용 `isWeeklyClosed` 를 따로 내보냄 |
| `frontend/src/lib/businessHoursLine.ts` (수정) | 주간 요약이므로 달력이 아니라 `isWeeklyClosed` 를 씀 |
| `frontend/src/lib/nationalMuseumBusinessHours.ts` (수정) | `isOpenToday` 를 돌려주기 시작 |
| `frontend/src/lib/venueSummary.ts` (수정) | 국중박 홈 카드가 그 값을 씀 |
| `frontend/src/lib/date.ts` (수정) | 내부 `formatDate` 를 `dateString` 으로 내보냄 |
| `frontend/tsconfig.json` (수정) | `resolveJsonModule: true` |

---

### Task 1: 공유 달력 파일과 백엔드 로더

**Files:**
- Create: `shared/museum-holidays.json`
- Modify: `backend/app/config.py:1-7`
- Test: `backend/tests/test_config.py`

**Interfaces:**
- Consumes: 없음
- Produces: `app.config.MUSEUM_PUBLIC_HOLIDAYS: frozenset[str]`,
  `app.config.MUSEUM_CLOSED_DAYS: dict[str, frozenset[str]]`,
  `app.config.MUSEUM_CALENDAR_CHECKED_THROUGH: date`.
  전부 `YYYY-MM-DD` 문자열 집합이다(`date` 객체가 아니다).

- [ ] **Step 1: 달력 파일을 만든다**

`shared/museum-holidays.json`:

```json
{
  "_comment": "손으로 큐레이션한 목록. holidays 라이브러리 출력이 아니다 - 근로자의날처럼 미술관이 정상 개관하는 공휴일이 섞여 있기 때문이다. publicHolidays 에는 월요일만 적는다: 규칙이 요일 휴관일에서만 발동하므로 다른 요일은 판정에 닿지 않는다. 출처와 근거는 docs/superpowers/specs/2026-09-08-museum-holiday-calendar-design.md.",
  "checkedThrough": "2027-12-31",
  "publicHolidays": [
    "2026-02-16",
    "2026-03-02",
    "2026-05-25",
    "2026-08-17",
    "2026-10-05",
    "2027-02-08",
    "2027-03-01",
    "2027-08-16",
    "2027-10-04",
    "2027-10-11",
    "2027-12-27"
  ],
  "closed": {
    "national-museum": ["2026-01-01", "2026-02-17", "2026-09-25", "2027-01-01", "2027-02-07", "2027-09-15"],
    "seoul": ["2026-01-01", "2026-02-17", "2026-09-08", "2026-09-25", "2026-12-01", "2027-01-01", "2027-02-07", "2027-09-15"],
    "gwacheon": ["2026-01-01", "2027-01-01"],
    "deoksugung": ["2026-01-01", "2027-01-01"]
  }
}
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`backend/tests/test_config.py` 끝에 붙인다:

```python
from datetime import date, timedelta

from app.config import (
    MUSEUM_CALENDAR_CHECKED_THROUGH,
    MUSEUM_CLOSED_DAYS,
    MUSEUM_PUBLIC_HOLIDAYS,
)


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
```

- [ ] **Step 3: 실패를 확인한다**

Run: `cd backend && .venv/bin/python -m pytest tests/test_config.py -q`
Expected: FAIL — `ImportError: cannot import name 'MUSEUM_CALENDAR_CHECKED_THROUGH'`

- [ ] **Step 4: 로더를 구현한다**

`backend/app/config.py` 맨 위(`KR_HOLIDAYS` 바로 아래)에 넣는다:

```python
import json
from datetime import date
from pathlib import Path

# 미술관 휴관일 달력. KR_HOLIDAYS 와 **다른 것**이다 — 저쪽은 예측 배치의
# is_holiday 피처가 쓰는 관공서 공휴일이고, 이쪽은 관이 실제로 문을 닫는 날이다.
# 근로자의날처럼 공휴일이지만 미술관이 여는 날이 있어 겹치지 않는다.
#
# 프론트 src/lib/museumCalendar.ts 가 같은 파일을 import 한다. 규칙은 양쪽에
# 각각 있지만(짧다) 목록은 여기 하나뿐이라 어긋날 수 없다.
_CALENDAR = json.loads(
    (Path(__file__).resolve().parents[2] / "shared" / "museum-holidays.json").read_text(
        encoding="utf-8"
    )
)

MUSEUM_PUBLIC_HOLIDAYS: frozenset[str] = frozenset(_CALENDAR["publicHolidays"])
MUSEUM_CLOSED_DAYS: dict[str, frozenset[str]] = {
    venue: frozenset(days) for venue, days in _CALENDAR["closed"].items()
}
MUSEUM_CALENDAR_CHECKED_THROUGH: date = date.fromisoformat(_CALENDAR["checkedThrough"])
```

`parents[2]` 는 `backend/app/config.py` → 리포 루트다. 프로덕션도 같다 —
`deploy/deploy.sh` 가 서버에서 리포 전체를 체크아웃한다.

- [ ] **Step 5: 통과를 확인한다**

Run: `cd backend && .venv/bin/python -m pytest tests/test_config.py -q`
Expected: PASS

- [ ] **Step 6: 전체 스위트를 돌린다**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: 235 passed + 새 테스트 3개

- [ ] **Step 7: 커밋**

```bash
git add shared/museum-holidays.json backend/app/config.py backend/tests/test_config.py
git commit -m "feat(be): load a curated museum closing-day calendar"
```

---

### Task 2: 수집 게이트가 달력을 본다

**Files:**
- Modify: `backend/app/collector.py:304-332`
- Test: `backend/tests/test_collector.py`

**Interfaces:**
- Consumes: Task 1 의 `MUSEUM_PUBLIC_HOLIDAYS`, `MUSEUM_CLOSED_DAYS`
- Produces: `app.collector._is_closed_day(venue: str, day: datetime.date) -> bool`.
  `_is_venue_open(venue, now)` 의 동작이 바뀐다 — 소비자
  (`collect_mmca_once`, `routes/health.py` 의 `_mmca_is_stale`·`_open_space_codes`,
  `scripts/purge_out_of_hours_mmca.py`)가 전부 자동으로 따라온다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/tests/test_collector.py` 의 `_is_venue_open` 테스트들 뒤에 붙인다:

```python
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
```

파일 맨 위 import 에 `date` 를 더한다: `from datetime import date, datetime`
(현재는 `from datetime import datetime`).

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && .venv/bin/python -m pytest tests/test_collector.py -q`
Expected: FAIL — `ImportError: cannot import name '_is_closed_day'`

- [ ] **Step 3: 구현한다**

`backend/app/collector.py` 의 import 에 `date`, `timedelta` 를 더하고
(`from datetime import date, datetime, time, timedelta` — `timedelta` 는 이미 있다)
`from app.config import MUSEUM_CLOSED_DAYS, MUSEUM_PUBLIC_HOLIDAYS, settings` 로 바꾼 뒤,
`_VENUE_CLOSED_DAYS` 의 `ponytail:` 문단을 아래 주석으로 **교체**하고
`_is_venue_open` 위에 함수를 넣는다:

```python
# 요일 휴관. 덕수궁관은 궁 안에 있고 과천관도 화~일 주간을 지킨다 — 매주 월요일
# 문을 여는 것은 서울관뿐이다.
#
# 폐관 중에도 API 는 에러가 아니라 정상 응답으로 "여유"를 돌려준다. 그래서 이
# 게이트는 쿼터 장치가 아니라 데이터 품질 장치다: 없으면 "닫혀서 빈 것"이
# "열려 있는데 한산함"으로 히스토리에 쌓이고, build_profile 이 (방, 요일, 시각)
# 평균을 내므로 예측 프로파일을 그대로 끌어내린다. 과천 월요일 895 건이 전부
# 여유인 것이 그 증거다.
_VENUE_CLOSED_DAYS: dict[str, set[int]] = {
    "gwacheon": {0},  # 월요일 휴무
    "deoksugung": {0},  # 월요일 휴무
}


def _is_closed_day(venue: str, day: date) -> bool:
    """그날 그 관이 문을 닫는가.

    프론트 src/lib/museumCalendar.ts 의 isClosedDay 와 같은 규칙이다. 목록은
    shared/museum-holidays.json 하나뿐이고 규칙만 양쪽에 있다 — 값이 아니라
    목록을 중복하는 쪽이 위험해서 그것만 공유한다.

    공휴일 월요일에 문을 열고 다음 날 쉬는 규칙(아래 둘째·셋째 갈래)의 출처는
    **공식 문서가 아니라 실측**이다. 과천·덕수궁 관람정보와 MMCA FAQ 모두
    "1월1일, 매주 월요일" 만 적는다. 근거는 2026-08-17(월, 광복절 대체)에
    과천관 non-여유 185건, 이튿날 219 판독 전부 여유 하나뿐이다 — 신호는
    모호하지 않지만 표본이 하나다. 2026-10-05 → 10/06 이 다음 검증 기회다.
    """
    if day.isoformat() in MUSEUM_CLOSED_DAYS.get(venue, frozenset()):
        return True

    weekly_closed = _VENUE_CLOSED_DAYS.get(venue, set())
    if day.weekday() in weekly_closed:
        return day.isoformat() not in MUSEUM_PUBLIC_HOLIDAYS

    previous = day - timedelta(days=1)
    return previous.weekday() in weekly_closed and previous.isoformat() in MUSEUM_PUBLIC_HOLIDAYS
```

그리고 `_is_venue_open` 의 첫 줄을 바꾼다:

```python
def _is_venue_open(venue: str, now: datetime) -> bool:
    if _is_closed_day(venue, now.date()):
        return False
    close = _LONG_CLOSE if now.weekday() in _LONG_DAYS.get(venue, set()) else _NORMAL_CLOSE
```

`_LONG_DAYS`(야간개장 요일)는 건드리지 않는다 — 개관하는 날의 폐관 시각이라
휴관 판정과 무관하다.

- [ ] **Step 4: 통과를 확인한다**

Run: `cd backend && .venv/bin/python -m pytest tests/test_collector.py tests/test_routes_health.py -q`
Expected: PASS

기존 `test_is_venue_open_*` 테스트가 쓰는 날짜(2026-07-27 월, 2026-07-28 화 등)는
전부 공휴일이 아니므로 그대로 통과해야 한다. 하나라도 깨지면 그 날짜가 달력에
들어 있다는 뜻이니 **테스트가 아니라 달력을 의심한다.**

- [ ] **Step 5: 전체 스위트**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: 전부 통과

- [ ] **Step 6: 커밋**

```bash
git add backend/app/collector.py backend/tests/test_collector.py
git commit -m "feat(be): gate collection on the museum calendar, not the weekday alone"
```

---

### Task 3: 정리 스크립트의 공휴일 스킵을 걷어낸다

**Files:**
- Modify: `backend/scripts/purge_out_of_hours_mmca.py:1-30`(docstring), `:55-67`, `:88-92`
- Test: `backend/tests/test_purge_out_of_hours_mmca.py`

**Interfaces:**
- Consumes: Task 2 의 `_is_venue_open`(달력을 보는 버전)
- Produces: `out_of_hours(rows)` 가 공휴일 행도 후보에 넣는다. 시그니처 불변.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/tests/test_purge_out_of_hours_mmca.py` 에 붙인다:

```python
def test_out_of_hours_now_deletes_a_substitute_closure_day():
    """2026-08-18 은 대체 휴관일이다 — 그날 과천 판독은 빈 건물이다.
    예전에는 '달력을 못 보니 공휴일 근처는 건드리지 않는다'로 통째로
    남겨 뒀는데, 이제 게이트가 달력을 보므로 그 유예가 필요 없다."""
    rows = [(1, datetime(2026, 8, 18, 14, 0), "MMCA-SPACE-2001")]

    assert [row[0] for row in out_of_hours(rows)] == [1]


def test_out_of_hours_keeps_an_open_holiday_monday():
    """2026-08-17 은 과천관이 실제로 연 날이다 — 규칙 2 의 유일한 증거이므로
    지우면 안 된다."""
    rows = [(1, datetime(2026, 8, 17, 14, 0), "MMCA-SPACE-2001")]

    assert out_of_hours(rows) == []
```

기존 테스트 중 "공휴일이라 남긴다"를 단언하는 것이 있으면 지운다 — 그 동작이
사라지는 것이 이 태스크의 내용이다. `grep -n "KR_HOLIDAYS\|holiday" backend/tests/test_purge_out_of_hours_mmca.py` 로 찾는다.

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && .venv/bin/python -m pytest tests/test_purge_out_of_hours_mmca.py -q`
Expected: `test_out_of_hours_now_deletes_a_substitute_closure_day` 가 FAIL
(빈 리스트가 돌아온다 — 8/18 이 아직 스킵된다)

- [ ] **Step 3: 스킵을 제거한다**

`out_of_hours` 에서 한 줄을 뺀다:

```python
    return [
        (row_id, observed_at, space_code)
        for row_id, observed_at, space_code in rows
        if space_code in VENUE_OF
        and not _is_venue_open(VENUE_OF[space_code], observed_at)
    ]
```

`main()` 의 집계 줄에서도 공휴일 카운트를 뺀다:

```python
        print(
            f"{len(rows)} rows examined, {len(doomed)} outside opening hours, "
            f"{unknown} with an unknown space_code (kept)"
        )
```

`from app.config import KR_HOLIDAYS, settings` → `from app.config import settings`
(이 파일에서 `KR_HOLIDAYS` 가 더는 쓰이지 않는다. `app/config.py` 의 `KR_HOLIDAYS`
자체는 예측 배치가 쓰므로 남긴다.)

- [ ] **Step 4: docstring 을 고친다**

모듈 docstring 의 두 번째 문단(`_is_venue_open is reused rather than
reimplemented...` 로 시작해 `...only record of an open holiday Monday.` 로
끝나는 부분)을 통째로 교체한다:

```
_is_venue_open is reused rather than reimplemented, so "outside hours" here
can never drift from what the collector refuses to collect. That gate now
reads shared/museum-holidays.json, so it knows the three things a weekday-only
gate could not: MMCA opens on a holiday that lands on its weekly closing day
(2026-08-17, non-여유 185), closes the day after (2026-08-18, all 219 readings
여유), and closes on the ad-hoc days each venue announces (Seoul 2026-09-08,
1,928 readings with non-여유 0).

Public holidays used to be skipped outright for exactly that reason — a
calendar this script could not check was not a calendar it should delete
against. That exemption is gone with the calendar's arrival, which also brings
back into scope the 78 rows this file used to name as a knowing miss: Gwacheon
after closing on the Saturday 2026-08-15. They were out-of-hours rows all
along.
```

- [ ] **Step 5: 통과를 확인한다**

Run: `cd backend && .venv/bin/python -m pytest tests/test_purge_out_of_hours_mmca.py -q`
Expected: PASS

- [ ] **Step 6: 로컬 DB 에 미리보기를 돌려 숫자를 확인한다**

Run: `cd backend && .venv/bin/python -m scripts.purge_out_of_hours_mmca`
(미리보기가 기본값이다 — 삭제는 `--delete` 로만 일어난다.)
Expected: 과천 8/18 의 219행과 서울 9/8 의 1,928행이 포함된 합계가 나온다.
숫자를 커밋 메시지에 적을 수 있게 기록해 둔다. **로컬 DB 는 프로덕션 사본이므로
`--delete` 를 붙이지 않는다** — 실제 정리는 Task 6 이다.

- [ ] **Step 7: 커밋**

```bash
git add backend/scripts/purge_out_of_hours_mmca.py backend/tests/test_purge_out_of_hours_mmca.py
git commit -m "fix(dev): purge closed-day rows the calendar can now identify"
```

---

### Task 4: 프론트 달력과 MMCA 휴관 판정

**Files:**
- Create: `frontend/src/lib/museumCalendar.ts`
- Modify: `frontend/src/lib/mmcaBusinessHours.ts`, `frontend/src/lib/businessHoursLine.ts:14-18`, `frontend/src/lib/date.ts:1-6`, `frontend/tsconfig.json`
- Test: `frontend/tests/museumCalendar.test.ts` (생성), `frontend/tests/mmcaBusinessHours.test.ts`, `frontend/tests/MmcaPage.test.tsx`

**Interfaces:**
- Consumes: Task 1 의 `shared/museum-holidays.json`
- Produces:
  - `src/lib/museumCalendar.ts`: `isClosedDay(venue: string, date: Date): boolean`,
    `isWeeklyClosed(venue: string, date: Date): boolean`
  - `src/lib/date.ts`: `dateString(d: Date): string` (기존 비공개 `formatDate` 를 이름 바꿔 export)
  - `mmcaBusinessHours(venue, date)` 의 `isOpenToday` 가 달력을 반영한다. 시그니처 불변이라
    `nextOpenDay`·`MmcaPage`·`venueSummary` 는 그대로 따라온다.

- [ ] **Step 1: tsconfig 에 JSON import 를 켠다**

`frontend/tsconfig.json` 의 `"moduleResolution": "bundler",` 다음 줄에 넣는다:

```json
    "resolveJsonModule": true,
```

- [ ] **Step 2: `date.ts` 의 `formatDate` 를 내보낸다**

`frontend/src/lib/date.ts` 첫 줄의 `function formatDate(` 를
`export function dateString(` 로 바꾸고, 같은 파일 안의 호출부
(`grep -n "formatDate" frontend/src/lib/date.ts`)를 전부 `dateString` 으로 바꾼다.

```typescript
// Date -> "YYYY-MM-DD" (브라우저 로컬 기준). todayString() 과 달리 KST 로
// 고정하지 않는다 — 영업시간 판정 전체가 이미 로컬 시계를 쓰고(now.getHours()),
// 이 함수는 그 판정에 쓰이는 날짜 키라 같은 시계를 봐야 한다.
export function dateString(d: Date): string {
```

- [ ] **Step 3: 실패하는 테스트를 쓴다**

`frontend/tests/museumCalendar.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { isClosedDay, isWeeklyClosed } from "../src/lib/museumCalendar";

describe("isClosedDay", () => {
  it("opens Gwacheon on a public-holiday Monday", () => {
    // 2026-08-17 광복절 대체. 실측: 과천 non-여유 185건.
    expect(isClosedDay("gwacheon", new Date("2026-08-17T12:00:00"))).toBe(false);
  });

  it("closes Gwacheon the day after a public-holiday Monday", () => {
    // 실측: 2026-08-18 과천 219판독 전부 여유. 다른 화요일은 59~157.
    expect(isClosedDay("gwacheon", new Date("2026-08-18T12:00:00"))).toBe(true);
    // 서울관은 요일 휴관이 없어 대체 휴관도 없다.
    expect(isClosedDay("seoul", new Date("2026-08-18T12:00:00"))).toBe(false);
  });

  it("still closes a plain Monday", () => {
    expect(isClosedDay("gwacheon", new Date("2026-09-07T12:00:00"))).toBe(true);
    expect(isClosedDay("seoul", new Date("2026-09-07T12:00:00"))).toBe(false);
  });

  it("honours an ad-hoc closure", () => {
    // 서울관 임시 휴관. 실측: 그날 1,928판독의 non-여유 0.
    expect(isClosedDay("seoul", new Date("2026-09-08T12:00:00"))).toBe(true);
    expect(isClosedDay("gwacheon", new Date("2026-09-08T12:00:00"))).toBe(false);
  });
});

describe("isWeeklyClosed", () => {
  it("ignores the calendar and answers on the weekday alone", () => {
    // businessHoursLine 이 쓰는 값이다 — 한 주를 한 줄로 접는 요약이라
    // 특정 날짜의 달력 휴관을 섞으면 "월요일 휴무"가 엉뚱하게 바뀐다.
    expect(isWeeklyClosed("gwacheon", new Date("2026-08-17T12:00:00"))).toBe(true);
    expect(isWeeklyClosed("gwacheon", new Date("2026-08-18T12:00:00"))).toBe(false);
  });
});
```

- [ ] **Step 4: 실패를 확인한다**

Run: `cd frontend && npx vitest run tests/museumCalendar.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/museumCalendar"`

- [ ] **Step 5: `museumCalendar.ts` 를 구현한다**

`frontend/src/lib/museumCalendar.ts`:

```typescript
import calendar from "../../../shared/museum-holidays.json";
import { dateString } from "./date";

// 요일 휴관. 덕수궁관은 궁 안에 있고 과천관도 화~일 주간을 지킨다 — 매주
// 월요일 문을 여는 것은 서울관뿐이다. JS Date.getDay(): 일=0, 월=1
// (백엔드 collector.py 의 datetime.weekday() 는 월=0 인 다른 규약이다.
// 같은 현실 규칙을 JS 규약으로 옮긴 것이지 값을 베낀 것이 아니다).
const WEEKLY_CLOSED: Record<string, number> = {
  gwacheon: 1,
  deoksugung: 1,
};

const PUBLIC_HOLIDAYS = new Set<string>(calendar.publicHolidays);
const CLOSED: Record<string, string[]> = calendar.closed;

export function isWeeklyClosed(venue: string, date: Date): boolean {
  return WEEKLY_CLOSED[venue] === date.getDay();
}

/**
 * 그날 그 관이 문을 닫는가.
 *
 * 백엔드 collector.py 의 `_is_closed_day` 와 같은 규칙이다. 목록은
 * shared/museum-holidays.json 하나뿐이고 규칙만 양쪽에 있다 — 값이 아니라
 * 목록을 중복하는 쪽이 위험해서 그것만 공유한다.
 *
 * 공휴일 월요일에 열고 다음 날 쉬는 규칙의 출처는 **공식 문서가 아니라
 * 실측**이다. 과천·덕수궁 관람정보와 MMCA FAQ 모두 "1월1일, 매주 월요일"
 * 만 적는다. 근거는 2026-08-17 과천 non-여유 185건과 이튿날 219판독 전부
 * 여유 하나뿐이다. 다음 검증 기회는 2026-10-05 → 10/06.
 */
export function isClosedDay(venue: string, date: Date): boolean {
  const day = dateString(date);
  if (CLOSED[venue]?.includes(day)) return true;

  if (isWeeklyClosed(venue, date)) return !PUBLIC_HOLIDAYS.has(day);

  const previous = new Date(date);
  previous.setDate(previous.getDate() - 1);
  return isWeeklyClosed(venue, previous) && PUBLIC_HOLIDAYS.has(dateString(previous));
}
```

- [ ] **Step 6: 통과를 확인한다**

Run: `cd frontend && npx vitest run tests/museumCalendar.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 7: `mmcaBusinessHours` 가 그것을 쓰게 한다**

`frontend/src/lib/mmcaBusinessHours.ts` 에서 `VENUE_CLOSED_DAYS` 상수와 그
위의 `ponytail:` 문단을 **지우고**(요일 규칙이 `museumCalendar.ts` 로 옮겨갔다),
`isOpenToday` 계산을 바꾼다:

```typescript
import { isClosedDay } from "./museumCalendar";

// ... LONG_CLOSE_DAYS 는 그대로 ...

export function mmcaBusinessHours(
  venue: MmcaVenue,
  date: Date
): { open: number; close: number; isOpenToday: boolean } {
  const close = LONG_CLOSE_DAYS[venue]?.has(date.getDay())
    ? LONG_CLOSE_MINUTES
    : NORMAL_CLOSE_MINUTES;
  return { open: OPEN_MINUTES, close, isOpenToday: !isClosedDay(venue, date) };
}
```

`nextOpenDay` 는 `mmcaBusinessHours` 를 부르므로 자동으로 달력을 따른다 —
본문을 바꾸지 않는다.

- [ ] **Step 8: `businessHoursLine` 을 요일 전용으로 돌린다**

`frontend/src/lib/businessHoursLine.ts` 의 `dayHours` 를 바꾼다:

```typescript
import { isWeeklyClosed } from "./museumCalendar";

function dayHours(venue: Venue, weekday: number) {
  const date = new Date(`${REFERENCE_SUNDAY}T12:00:00`);
  date.setDate(date.getDate() + weekday);
  // 달력이 아니라 요일 규칙만 본다. 이 줄은 한 주를 "10:00~18:00 (월요일
  // 휴무)" 로 접는 요약이라 특정 날짜의 달력 휴관이 섞이면 안 된다 —
  // REFERENCE_SUNDAY 주간에 휴관일이 하나라도 들어오면 헤더가 조용히
  // 틀려진다.
  return venue.mmcaVenue
    ? {
        ...mmcaBusinessHours(venue.mmcaVenue, date),
        isOpenToday: !isWeeklyClosed(venue.mmcaVenue, date),
      }
    : { ...nationalMuseumBusinessHours(date), isOpenToday: true };
}
```

- [ ] **Step 9: 임시 휴관일 화면 테스트를 더한다**

`frontend/tests/MmcaPage.test.tsx` 에 붙인다:

```typescript
  it("shows the closed-day notice on an ad-hoc closure", async () => {
    // 서울관 2026-09-08 임시 휴관. 요일로는 알 수 없어 달력에서만 나온다.
    vi.setSystemTime(new Date("2026-09-08T14:00:00"));
    vi.spyOn(api, "fetchMmcaRooms").mockResolvedValue([makeRoom()]);

    render(
      <MemoryRouter>
        <MmcaPage venue="seoul" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("휴관일입니다")).toBeInTheDocument());
    expect(screen.queryByTestId("mmca-room-chart")).not.toBeInTheDocument();
  });
```

- [ ] **Step 10: 전체를 돌린다**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: 전부 통과.

`businessHoursLine.test.ts` 와 `mmcaBusinessHours.test.ts` 의 기존 단언이
깨지면, 그 테스트가 쓰는 날짜(2026-07-27, 2026-07-28, 2026-08-01, 2026-08-02,
2026-01-04 주간)가 달력에 있는지 먼저 확인한다. 전부 공휴일이 아니므로
정상이라면 깨지지 않는다.

- [ ] **Step 11: 커밋**

```bash
git add frontend/src/lib/museumCalendar.ts frontend/src/lib/mmcaBusinessHours.ts \
        frontend/src/lib/businessHoursLine.ts frontend/src/lib/date.ts \
        frontend/tsconfig.json frontend/tests/museumCalendar.test.ts \
        frontend/tests/mmcaBusinessHours.test.ts frontend/tests/MmcaPage.test.tsx
git commit -m "feat(fe): read closing days from the shared museum calendar"
```

---

### Task 5: 국립중앙박물관 홈 카드

**Files:**
- Modify: `frontend/src/lib/nationalMuseumBusinessHours.ts`, `frontend/src/lib/venueSummary.ts:29-47`, `frontend/src/lib/businessHoursLine.ts:14-18`
- Test: `frontend/tests/nationalMuseumBusinessHours.test.ts`, `frontend/tests/venueSummary.test.ts`

**Interfaces:**
- Consumes: Task 4 의 `isClosedDay`
- Produces: `nationalMuseumBusinessHours(date)` 가
  `{ open: number; close: number; isOpenToday: boolean }` 를 돌려준다(필드가 하나 는다).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`frontend/tests/nationalMuseumBusinessHours.test.ts` 에 붙인다:

```typescript
  it("closes on the calendar days the museum publishes", () => {
    // 관람정보 원문: "휴관일: 2026년 1월1일, 설날(2.17.화), 추석(9.25.금)"
    expect(nationalMuseumBusinessHours(new Date("2026-09-25T12:00:00")).isOpenToday).toBe(false);
    expect(nationalMuseumBusinessHours(new Date("2026-01-01T12:00:00")).isOpenToday).toBe(false);
    // 요일 휴관은 없다.
    expect(nationalMuseumBusinessHours(new Date("2026-09-07T12:00:00")).isOpenToday).toBe(true);
  });
```

기존 세 테스트가 `toEqual({ open, close })` 로 객체 전체를 비교하므로
`isOpenToday: true` 를 각각 더한다.

`frontend/tests/venueSummary.test.ts` 에 붙인다:

```typescript
  it("says 휴관일 for the National Museum on a calendar closing day", () => {
    // 시계 판정과 같은 자리 — 데이터 도착 전에 확정된다.
    expect(nationalMuseumSummary(null, new Date("2026-09-25T12:00:00"))).toEqual({
      kind: "inactive",
      label: "휴관일",
    });
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd frontend && npx vitest run tests/nationalMuseumBusinessHours.test.ts tests/venueSummary.test.ts`
Expected: FAIL — `isOpenToday` 가 `undefined`

- [ ] **Step 3: 구현한다**

`frontend/src/lib/nationalMuseumBusinessHours.ts`:

```typescript
import { isClosedDay } from "./museumCalendar";

const OPEN_MINUTES = 9 * 60 + 30; // 09:30, every day
const LONG_CLOSE_DAYS = new Set([3, 6]); // Wed, Sat: 21:00 close; other days: 17:30

// 요일 휴관이 없는 관이라 isOpenToday 는 달력에서만 온다 — 관람정보 원문이
// "1월1일, 설날, 추석" 이다. 상설전시관 정기휴실일(3·6·9·12월 첫째 월요일)은
// 관 전체 휴관이 아니고, 이 관의 혼잡도는 서울시 생활인구(그 지역 인구지
// 관람객 수가 아니다)라 애초에 보이지 않아 달력에 넣지 않았다.
export function nationalMuseumBusinessHours(
  date: Date
): { open: number; close: number; isOpenToday: boolean } {
  const close = LONG_CLOSE_DAYS.has(date.getDay()) ? 21 * 60 : 17 * 60 + 30;
  return { open: OPEN_MINUTES, close, isOpenToday: !isClosedDay("national-museum", date) };
}
```

`frontend/src/lib/venueSummary.ts` 의 `nationalMuseumSummary` 에서 시계 판정
위에 한 줄 더한다:

```typescript
  const { open, close, isOpenToday } = nationalMuseumBusinessHours(now);
  if (!isOpenToday) return { kind: "inactive", label: "휴관일" };
  const closed = closedLabel(now, open, close);
  if (closed) return { kind: "inactive", label: closed };
```

`frontend/src/lib/businessHoursLine.ts` 의 `dayHours` 에서 국중박 갈래의
하드코딩 `isOpenToday: true` 를 지운다 — 이제 함수가 직접 돌려준다:

```typescript
    : nationalMuseumBusinessHours(date);
```

`REFERENCE_SUNDAY` 주간(2026-01-04~01-10)에 국중박 휴관일이 없으므로 결과는
같다. 이 결합을 주석 한 줄로 적어 둔다:

```typescript
// 국중박은 요일 휴관이 없어 이 주(REFERENCE_SUNDAY 기준)에는 늘 개관이다.
// 그 주에 달력 휴관일이 들어오면 이 줄도 isWeeklyClosed 로 바꿔야 한다.
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: 전부 통과

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/lib/nationalMuseumBusinessHours.ts frontend/src/lib/venueSummary.ts \
        frontend/src/lib/businessHoursLine.ts frontend/tests/nationalMuseumBusinessHours.test.ts \
        frontend/tests/venueSummary.test.ts
git commit -m "feat(fe): close the National Museum card on its published holidays"
```

---

### Task 6: 프로덕션 데이터 정리 — 배포 후 수동 실행

**이 태스크는 코드가 아니다. 서브에이전트에게 맡기지 않는다.** PR 이 머지되고
`main` 으로 배포된 **뒤에** 사람이 실행한다.

- [ ] **Step 1: 배포를 확인한다**

Run: `curl -s https://exhibition-traffic.duckdns.org/health/collection | python3 -m json.tool`
Expected: 200. 배포일이 휴관일이면 `mmca.calls_today` 가 0 이고 `stale` 이
`false` 여야 한다(`_mmca_is_stale` 이 같은 게이트를 쓰므로 503 으로 새지 않는다).

- [ ] **Step 2: 프로덕션 DB 사본을 받아 미리보기를 돌린다**

```bash
cd backend && ./scripts/pull_prod_db.sh
.venv/bin/python -m scripts.purge_out_of_hours_mmca
```

Expected: 과천 2026-08-18 219행, 서울 2026-09-08 1,928행, 과천 2026-08-15
저녁 78행이 합계에 들어 있어야 한다. **2026-08-17 은 대상이 아니어야 한다.**
숫자가 다르면 멈추고 원인을 본다.

- [ ] **Step 3: 프로덕션에서 실행한다**

서버에 접속해 같은 스크립트를 먼저 그냥(미리보기) 돌려 숫자를 확인한 뒤
`--delete` 를 붙여 실행한다. 스크립트는 멱등이라 두 번째 실행은 아무것도 지우지
않는다.

- [ ] **Step 4: 결과를 기록한다**

지운 행 수를 PR 코멘트에 남긴다. 예측 프로파일은 창(14일) 안에 있던
2026-09-08 분만 즉시 달라지고, 2026-08-18 은 이미 창 밖이라 백테스트에만
반영된다.

---

## 자체 검토

**스펙 대응**

| 스펙 항목 | 태스크 |
|---|---|
| 1. 달력 `shared/museum-holidays.json` | Task 1 |
| 2. 규칙 (백엔드) | Task 2 |
| 2. 규칙 (프론트) | Task 4, 5 |
| 3. 예측 프로파일 — 손대지 않음 | 해당 태스크 없음(의도) |
| 4. 과거 데이터 정리 | Task 3(코드) + Task 6(실행) |
| 5. 달력 만료 | Task 1 Step 2 의 `test_the_calendar_has_not_gone_stale` |

**스펙에서 벗어난 곳**

스펙이 다루지 않은 결합을 하나 찾아 계획에 넣었다: `businessHoursLine` 이
`mmcaBusinessHours` 를 요일별로 7번 불러 주간 요약을 만든다. 그 함수가 달력을
보기 시작하면 `REFERENCE_SUNDAY` 주간에 휴관일이 들어오는 순간 헤더 줄이 조용히
틀려진다. 그래서 `isWeeklyClosed` 를 따로 내보내 그쪽만 요일 규칙을 쓰게 했다
(Task 4 Step 8, Task 5 Step 3).

**남는 불일치 하나** — Task 5 는 국중박 **홈 카드**만 고친다. 스펙의 후속
항목대로 `NationalMuseumPage` 자체는 그대로라, 1월 1일에 홈 카드는 "휴관일" 인데
그 관 페이지는 평소처럼 그린다. 이 관의 혼잡도는 서울시 생활인구라 관이 닫아도
숫자가 나오기 때문이다. 홈 카드가 맞아지는 것은 회귀가 아니라 개선이고, 페이지
쪽은 별도 작업으로 남긴다.
