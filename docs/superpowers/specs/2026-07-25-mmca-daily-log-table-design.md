# MMCA 폴링 로그 표 — 설계

- 날짜: 2026-07-25
- 배경: MMCA 3개 관(서울/과천/덕수궁)이 실제로 어떤 데이터를 수집하고 있는지 카드(전시실별 현재 상태)만으로는 시간에 따른 변화, 결측 패턴을 눈으로 확인하기 어렵다. 국립중앙박물관 페이지엔 이미 `DailyLogTable`(하루치 폴링 로그 전체를 표로)이 있는데, MMCA에는 동급 화면이 없다. 이번 작업으로 3개 관 페이지 각각에 같은 개념의 표를 추가한다.

## 1. 목표 & 범위

**무엇을 만드나**: 관별 페이지(`/venues/mmca-seoul`, `/venues/mmca-gwacheon`, `/venues/mmca-deoksugung`)에서 하루치 폴링 로그를, 폴링 시각 1행 · 전시실별 컬럼으로 피벗한 표를 보여준다.

### 포함 (In Scope)
- 백엔드: `GET /mmca/daily?venue={venue}&date=YYYY-MM-DD` 신규 엔드포인트 — 분 단위로 그룹핑해 전시실 코드 순서 고정 배열로 피벗 반환
- 프론트: `MmcaDailyLogTable` 신규 컴포넌트 — 이전/다음 날짜 네비게이션, 관별로 동적 컬럼 수(1~8개)
- 기존 `MmcaPage`(3관 공용) 카드 그리드 아래에 표 삽입

### 제외 (Out of Scope, YAGNI)
- `raw_response`(원본 JSON) 노출 — 지금은 `congestion_nm`만 보이면 충분, 필요해지면 별도로 확장
- 관별 `EARLIEST_DATE` 하드코딩 — 관마다 수집 시작일이 다르고 계속 바뀌므로, 대신 데이터 없는 날은 "데이터 없음"으로만 표시
- 예측/집계/차트화 — 이번엔 원본 로그를 눈으로 확인하는 것 자체가 목적

## 2. 아키텍처

기존 `/congestion/daily` → `DailyLogTable` 패턴을 그대로 재사용하되, MMCA는 전시실이 관마다 여러 개(서울/과천 8개, 덕수궁 1개)라 피벗이 필요하다는 점만 다르다.

```
[MmcaPage(venue)] --GET /mmca/daily?venue&date--> [백엔드: 분 단위 그룹핑] --> [raw_mmca_congestion]
        |
        v
[RoomCongestionCard 그리드 (기존, 변경 없음)]
[MmcaDailyLogTable (신규)]
```

## 3. 백엔드 — 피벗 로직

`raw_mmca_congestion`은 폴링 1회당 전시실 개수만큼 행이 생기고, 같은 폴링 내에서도 전시실마다 `observed_at`이 몇 초씩 다르다(실측: 서울관 8실 조회에 약 4초). "같은 폴링"으로 묶기 위해 `observed_at`을 분 단위로 내림(`replace(second=0, microsecond=0)`)해 그룹핑한다. 폴링 간격이 15분이므로 분 단위 버킷이면 서로 다른 폴링끼리 섞이지 않는다.

```python
# backend/app/routes/mmca.py 추가

class MmcaDailyRoom(BaseModel):
    space_code: str
    space_nm: str | None
    congestion_nm: str | None

class MmcaDailyLogPoint(BaseModel):
    observed_at: str
    rooms: list[MmcaDailyRoom]


@router.get("/mmca/daily", response_model=list[MmcaDailyLogPoint])
def mmca_daily(venue: str, date: str | None = Query(default=None)) -> list[MmcaDailyLogPoint]:
    codes = settings.mmca_venue_space_codes.get(venue)
    if codes is None:
        raise HTTPException(status_code=400, detail=f"unknown venue: {venue}")

    if date is None:
        day_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    else:
        try:
            day_start = datetime.strptime(date, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="date must be in YYYY-MM-DD format")
    day_end = day_start + timedelta(days=1)

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

    buckets: dict[datetime, dict[str, RawMmcaCongestion]] = defaultdict(dict)
    for row in rows:
        bucket_key = row.observed_at.replace(second=0, microsecond=0)
        buckets[bucket_key][row.space_code] = row

    return [
        MmcaDailyLogPoint(
            observed_at=bucket_time.isoformat(),
            rooms=[
                MmcaDailyRoom(
                    space_code=code,
                    space_nm=buckets[bucket_time][code].space_nm if code in buckets[bucket_time] else None,
                    congestion_nm=buckets[bucket_time][code].congestion_nm if code in buckets[bucket_time] else None,
                )
                for code in codes
            ],
        )
        for bucket_time in sorted(buckets)
    ]
```

전시실 컬럼 순서/개수는 항상 `settings.mmca_venue_space_codes[venue]` 순서로 고정 — 특정 전시실 조회가 그 폴링에서 실패했으면 해당 칸만 `null`.

```ponytail
# 한 폴링 배치가 분 경계를 넘겨 걸치면(예: :59:58에 시작해 다음 분까지 이어짐)
# 배치가 두 행으로 쪼개질 수 있다. 지금 전시실 수(최대 8개, 배치 소요 ~4초)로는
# 사실상 안 일어나지만, 관/전시실이 훨씬 늘어나 배치 소요시간이 1분에 근접하면
# batch_id 기반 그룹핑으로 바꿔야 한다.
```

데이터 없는 날/관 폐관일은 에러가 아니라 빈 리스트(`[]`) 반환 — `/congestion/daily`와 동일한 규약.

## 4. 프론트엔드

- `frontend/src/api/mmca.ts`: `fetchMmcaDaily(venue: MmcaVenue, date?: string): Promise<MmcaDailyLogPoint[]>` 추가 (`fetchDaily`와 동일한 형태)
- `frontend/src/components/MmcaDailyLogTable.tsx` 신규:
  - `DailyLogTable`과 달리 컬럼이 고정 배열이 아니라 응답의 `rooms` 순서에서 동적으로 뽑음 — 데이터가 있는 첫 행의 `rooms[i].space_nm`(없으면 `space_code`)을 헤더로 사용
  - 이전/다음 날짜 버튼은 `DailyLogTable`과 동일 UX. `EARLIEST_DATE` 상수는 두지 않고, "다음 날짜"만 오늘 이후로 못 가게 막음. 데이터 없는 날은 "데이터 없음" 표시(빈 배열 응답 시)
  - `venue: MmcaVenue` prop을 받아 `MmcaPage`에서 그대로 전달
- `frontend/src/pages/MmcaPage.tsx`: 카드 그리드 아래에 `<MmcaDailyLogTable venue={venue} />` 삽입

## 5. 테스트

- `test_routes_mmca.py`: venue 필터링, date 파라미터/기본값(오늘), 여러 전시실이 분 단위로 한 행에 피벗되는지, 특정 전시실만 실패해 누락된 경우 해당 칸이 `null`인지, 잘못된 venue(400)/date(400), 데이터 없는 날 빈 배열
- 프론트: `MmcaDailyLogTable.test.tsx` 신규 — 로딩/에러/빈 상태, 날짜 이동, 동적 컬럼 렌더링
- e2e: 기존 `/mmca/rooms` 목에 `/mmca/daily` 목 응답 추가, 표 렌더링 확인 한 줄 추가

## 6. 의사결정 요약

| 항목 | 결정 | 이유 |
|---|---|---|
| 표 형태 | 폴링 로그 전체(시각별 1행), 전시실은 가로 컬럼으로 피벗 | 시간에 따른 변화/결측을 한눈에 보기 위함(사용자 요청) |
| 그룹핑 방식 | `observed_at`을 분 단위로 내림 | 폴링 간격(15분) 대비 배치 소요시간(~수 초)이 훨씬 짧아 안전, 구현 단순 |
| 배치–분 경계 문제 | 알려진 한계로 남기고 `ponytail:` 주석만 남김 | 지금 전시실 수로는 사실상 발생 안 함, 발생 시 batch_id 그룹핑으로 전환 |
| 카드 그리드와의 관계 | 대체 아니고 추가(카드 유지 + 아래 표) | 카드는 "지금 상태 한눈에", 표는 "시간대별 로그" — 용도가 다름 |
| `EARLIEST_DATE` 상수 | 두지 않음 | 관별 수집 시작일이 다르고 계속 바뀌어 유지보수 비용 발생, 빈 배열로 자연스럽게 처리 가능 |
| `raw_response` 노출 | 이번 범위 제외 | `congestion_nm`만으로 목적(결측/변화 확인) 충분, YAGNI |
