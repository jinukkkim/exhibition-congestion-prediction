# MMCA Room-Name Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a room's latest MMCA poll has `space_nm: null`, fall back to the most recent poll that *did* have a name for that `space_code`, instead of surfacing the raw code to the user.

**Architecture:** Add one helper query to `backend/app/routes/mmca.py` that returns `{space_code: last_known_name}` for a set of codes (same group-by-max shape as the existing `latest_ids` query, filtered to `space_nm IS NOT NULL`). Apply `row.space_nm or last_known.get(code)` at the two response-building sites in `/mmca/rooms` and `/mmca/daily`.

**Tech Stack:** FastAPI, SQLAlchemy ORM, pytest, sqlite in-memory test DB (existing patterns in `backend/tests/test_routes_mmca.py`).

## Global Constraints

- Backend only — see `docs/superpowers/specs/2026-07-28-mmca-room-name-fallback-design.md`. No frontend changes; the existing `room.space_nm ?? spaceCode` fallback in `MmcaRoomChartCard.tsx` and `MmcaDailyLogTable.tsx` stays as the last-resort safety net.
- No static space_code → name mapping table (out of scope per design doc).
- One extra query per request, reusing the existing group-by-max(id) pattern already used for `latest_ids` in `/mmca/rooms`.

---

### Task 1: `_last_known_names` helper + apply in `/mmca/rooms`

**Files:**
- Modify: `backend/app/routes/mmca.py` (imports at top, add helper function, edit `mmca_rooms`)
- Test: `backend/tests/test_routes_mmca.py`

**Interfaces:**
- Produces: `_last_known_names(session: Session, codes: list[str]) -> dict[str, str]` — module-level function in `backend/app/routes/mmca.py`, used by both this task and Task 2.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_routes_mmca.py`:

```python
def test_mmca_rooms_falls_back_to_last_known_name_when_latest_is_null(client):
    test_client, session_factory = client

    with session_factory() as session:
        session.add_all(
            [
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 24, 10, 0),
                    space_code="MMCA-SPACE-1001",
                    space_nm="1전시실",
                    congestion_nm="여유",
                ),
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 24, 10, 15),
                    space_code="MMCA-SPACE-1001",
                    space_nm=None,
                    congestion_nm="보통",
                ),
            ]
        )
        session.commit()

    response = test_client.get("/mmca/rooms?venue=seoul")
    assert response.status_code == 200
    room = next(r for r in response.json() if r["space_code"] == "MMCA-SPACE-1001")
    assert room["space_nm"] == "1전시실"
    assert room["congestion_nm"] == "보통"


def test_mmca_rooms_space_nm_stays_null_when_never_known(client):
    test_client, session_factory = client

    with session_factory() as session:
        session.add(
            RawMmcaCongestion(
                observed_at=datetime(2026, 7, 24, 10, 0),
                space_code="MMCA-SPACE-1001",
                space_nm=None,
                congestion_nm="여유",
            )
        )
        session.commit()

    response = test_client.get("/mmca/rooms?venue=seoul")
    room = next(r for r in response.json() if r["space_code"] == "MMCA-SPACE-1001")
    assert room["space_nm"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_routes_mmca.py -k last_known_name -v`
Expected: `test_mmca_rooms_falls_back_to_last_known_name_when_latest_is_null` FAILS (asserts `"1전시실" == None`). The second test passes already (nothing to fall back to) — that's fine, it's a regression guard for Step 4.

- [ ] **Step 3: Implement**

In `backend/app/routes/mmca.py`, add the import and helper, then use it in `mmca_rooms`:

```python
from sqlalchemy import func
from sqlalchemy.orm import Session
```

```python
def _last_known_names(session: Session, codes: list[str]) -> dict[str, str]:
    latest_named_ids = [
        row[0]
        for row in session.query(func.max(RawMmcaCongestion.id))
        .filter(
            RawMmcaCongestion.space_code.in_(codes),
            RawMmcaCongestion.space_nm.isnot(None),
        )
        .group_by(RawMmcaCongestion.space_code)
        .all()
    ]
    rows = session.query(RawMmcaCongestion).filter(RawMmcaCongestion.id.in_(latest_named_ids)).all()
    return {row.space_code: row.space_nm for row in rows}
```

Edit `mmca_rooms` (`backend/app/routes/mmca.py:15-47`) to compute `last_known` alongside the existing `rows` query and use it when building the response:

```python
@router.get("/mmca/rooms", response_model=list[MmcaRoomStatus])
def mmca_rooms(venue: str) -> list[MmcaRoomStatus]:
    codes = settings.mmca_venue_space_codes.get(venue)
    if codes is None:
        raise HTTPException(status_code=400, detail=f"unknown venue: {venue}")

    with SessionLocal() as session:
        latest_ids = [
            row[0]
            for row in session.query(func.max(RawMmcaCongestion.id))
            .filter(RawMmcaCongestion.space_code.in_(codes))
            .group_by(RawMmcaCongestion.space_code)
            .all()
        ]
        rows = (
            session.query(RawMmcaCongestion)
            .filter(RawMmcaCongestion.id.in_(latest_ids))
            .order_by(RawMmcaCongestion.space_code)
            .all()
        )
        last_known = _last_known_names(session, codes)

    if not rows:
        raise HTTPException(status_code=503, detail="no MMCA congestion data yet")

    return [
        MmcaRoomStatus(
            space_code=row.space_code,
            space_nm=row.space_nm or last_known.get(row.space_code),
            congestion_nm=row.congestion_nm,
            observed_at=row.observed_at.isoformat(),
        )
        for row in rows
    ]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_routes_mmca.py -v`
Expected: all PASS, including the two new tests and every pre-existing test in the file (no regressions).

- [ ] **Step 5: Commit**

```bash
cd backend
git add app/routes/mmca.py tests/test_routes_mmca.py
git commit -m "fix(be): fall back to last known room name when latest MMCA poll has none"
```

---

### Task 2: Apply the same fallback in `/mmca/daily`

**Files:**
- Modify: `backend/app/routes/mmca.py` (edit `mmca_daily`)
- Test: `backend/tests/test_routes_mmca.py`

**Interfaces:**
- Consumes: `_last_known_names(session: Session, codes: list[str]) -> dict[str, str]` from Task 1 (same file, no import needed).

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_routes_mmca.py`:

```python
def test_mmca_daily_falls_back_to_last_known_name_when_poll_row_is_null(client):
    test_client, session_factory = client

    with session_factory() as session:
        session.add_all(
            [
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 25, 10, 0),
                    space_code="MMCA-SPACE-1001",
                    space_nm="1전시실",
                    congestion_nm="여유",
                ),
                RawMmcaCongestion(
                    observed_at=datetime(2026, 7, 25, 15, 0, 3),
                    space_code="MMCA-SPACE-1001",
                    space_nm=None,
                    congestion_nm="보통",
                ),
            ]
        )
        session.commit()

    response = test_client.get("/mmca/daily?venue=seoul&date=2026-07-25")
    body = response.json()
    bucket = next(b for b in body if b["observed_at"] == "2026-07-25T15:00:00")
    room = next(r for r in bucket["rooms"] if r["space_code"] == "MMCA-SPACE-1001")
    assert room["space_nm"] == "1전시실"
    assert room["congestion_nm"] == "보통"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_routes_mmca.py -k falls_back_to_last_known_name_when_poll_row_is_null -v`
Expected: FAIL (asserts `"1전시실" == None`).

- [ ] **Step 3: Implement**

Edit `mmca_daily` (`backend/app/routes/mmca.py`, currently lines 50-101) to compute `last_known` once and use it inside the bucket-building comprehension:

```python
    with SessionLocal() as session:
        rows = (
            session.query(RawMmcaCongestion)
            .filter(
                RawMmcaCongestion.space_code.in_(codes),
                RawMmcaCongestion.observed_at >= day_start,
                RawMmcaCongestion.observed_at < day_end,
            )
            .order_by(RawMmcaCongestion.observed_at.asc())
            .all()
        )
        last_known = _last_known_names(session, codes)
```

```python
    return [
        MmcaDailyLogPoint(
            observed_at=bucket_time.isoformat(),
            rooms=[
                MmcaDailyRoom(
                    space_code=code,
                    space_nm=(
                        buckets[bucket_time][code].space_nm or last_known.get(code)
                        if code in buckets[bucket_time]
                        else None
                    ),
                    congestion_nm=buckets[bucket_time][code].congestion_nm
                    if code in buckets[bucket_time]
                    else None,
                )
                for code in codes
            ],
        )
        for bucket_time in sorted(buckets)
    ]
```

Note: a room *missing* from a bucket entirely (`code not in buckets[bucket_time]`) still gets `space_nm=None` — that's "no data point," a different case from "had a poll but the name was null," and is already covered by `test_mmca_daily_fills_null_for_rooms_missing_from_a_poll`.

- [ ] **Step 4: Run full backend suite to verify no regressions**

Run: `cd backend && .venv/bin/pytest -v`
Expected: all PASS, including `test_mmca_daily_fills_null_for_rooms_missing_from_a_poll` (unchanged behavior for that case) and the new test.

- [ ] **Step 5: Commit**

```bash
cd backend
git add app/routes/mmca.py tests/test_routes_mmca.py
git commit -m "fix(be): apply room-name fallback to /mmca/daily poll rows"
```
