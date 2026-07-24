# 국립현대미술관(MMCA) 서울관 혼잡도 수집 파이프라인 — 설계

- 날짜: 2026-07-24
- 배경: MMCA 전시실 혼잡도 API는 진행 중인 전시가 2개 이상일 때만 값이 표출된다. 2026-07-25부터 서울관 전시가 2개 이상이 되어 값이 나오기 시작하므로, 그 전에 수집 파이프라인을 준비해 첫날부터 데이터를 놓치지 않는다.

## 1. 목표 & 범위

**무엇을 만드나**: MMCA 서울관 8개 전시실의 혼잡도 값을 5분(정확히는 6분, 아래 참조) 간격으로 수집해 DB에 적재하는 백엔드 파이프라인.

**차별점 없음 — 이번 단계는 수집만**: 기존 국립중앙박물관 파이프라인은 예측까지 포함하지만, MMCA는 데이터가 실제로 어떤 모양으로 들어오는지(활성 전시실이 몇 개인지, `congestionNm` 값의 실제 문자열, 결측 패턴)를 아직 모른다. 표시/예측 설계는 실 데이터를 보고 별도로 진행한다. 기존 프로젝트도 콜드스타트 때 이 순서(수집 먼저, 모델은 데이터 축적 후)를 따랐다.

### 포함 (In Scope)
- MMCA 전시실 혼잡도 API 연동 (`GET https://apis.data.go.kr/1371033/mmcadensity/congestion`)
- 서울관 8개 전시실(MMCA-SPACE-1001~1008) 고정 폴링
- 서울관 영업시간에만 수집 (월·화·목·금·일 10:00–18:00, 수·토 10:00–21:00)
- 원본 응답 DB 적재 (기존 `raw_response` 보관 패턴 재사용)

### 제외 (Out of Scope, YAGNI)
- 과천관/청주관/덕수궁관 (전시실 코드는 확보했으나 지금 폴링 대상 아님 — 필요해지면 `MMCA_SPACE_CODES` 설정값만 늘리면 됨)
- 프론트엔드 표시, 예측 모델, SSE 브로드캐스트
- 전시실 코드 → 실제 전시명 매핑 (엑셀 문서에서 방 번호만 확인됨, 전시명 매핑은 필요 시 별도 작업)

## 2. 아키텍처

기존 서울시 API 파이프라인(`app/seoul_api.py` → `app/collector.py` → `app/scheduler.py`)과 동일한 3계층 패턴을 그대로 반복한다. 새 코드로 완전히 분리하고 기존 국립중앙박물관 경로는 건드리지 않는다.

```
[APScheduler] --6분마다(IntervalTrigger)--> [collect_mmca_once()]
                                                    |
                                    영업시간 아니면 즉시 return (API 호출 없음)
                                                    |
                                    8개 spaceCode 순회, 각각 독립 try/except
                                                    |
                                                    v
                                    [MMCA 혼잡도 API] --> [SQLite: raw_mmca_congestion]
```

### 2.1 API 클라이언트 — `app/mmca_api.py`

`seoul_api.py`의 `fetch_congestion`을 모델로 삼되, 응답 모양이 다르므로 별도 모듈로 분리한다.

```python
@dataclass
class MmcaCongestionReading:
    observed_at: datetime       # API가 타임스탬프를 안 주므로 수집 시각(now)을 기록
    space_code: str
    space_nm: str | None
    agnc_nm: str | None
    congestion_nm: str | None   # 여유/보통/약간 붐빔/붐빔, 또는 전시 2개 미만이면 None/빈 값 추정
    raw_response: str | None

def fetch_congestion(client: httpx.Client, space_code: str, api_key: str) -> MmcaCongestionReading:
    url = f"{BASE_URL}/congestion"
    response = client.get(url, params={"serviceKey": api_key, "spaceCode": space_code}, timeout=10.0)
    response.raise_for_status()
    body = response.json()
    data = body.get("data") or {}
    return MmcaCongestionReading(
        observed_at=datetime.now(),
        space_code=space_code,
        space_nm=data.get("spaceNm"),
        agnc_nm=data.get("agncNm"),
        congestion_nm=data.get("congestionNm"),
        raw_response=response.text,
    )
```

`data`가 비어 있거나 `congestionNm`이 없는 경우(전시 2개 미만 등)도 에러로 취급하지 않고 `None`으로 담아 그대로 한 행 적재한다 — "값이 없었다"는 사실 자체가 콜드스타트 구간 분석에 유용한 정보다.

### 2.2 DB 모델 — `app/models.py`에 추가

```python
class RawMmcaCongestion(Base):
    __tablename__ = "raw_mmca_congestion"

    id: Mapped[int] = mapped_column(primary_key=True)
    observed_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    space_code: Mapped[str] = mapped_column(String, index=True)
    space_nm: Mapped[str | None] = mapped_column(String, nullable=True)
    agnc_nm: Mapped[str | None] = mapped_column(String, nullable=True)
    congestion_nm: Mapped[str | None] = mapped_column(String, nullable=True)
    raw_response: Mapped[str | None] = mapped_column(Text, nullable=True, deferred=True)
```

기존 `RawCongestion`과 컬럼 모양이 완전히 다르므로(인구수 없음, room 단위) 재사용하지 않고 새 테이블로 분리한다. 마이그레이션은 기존 `backend/scripts/migrate_add_*.py` 패턴을 따라 `migrate_add_mmca_congestion.py`로 추가한다.

### 2.3 수집기 — `app/collector.py`에 추가

```python
SEOUL_BRANCH_NORMAL_CLOSE = time(18, 0)
SEOUL_BRANCH_LONG_CLOSE = time(21, 0)
SEOUL_BRANCH_OPEN = time(10, 0)
LONG_DAYS = {2, 5}  # Mon=0 기준, 수=2, 토=5

def _is_seoul_branch_open(now: datetime) -> bool:
    close = SEOUL_BRANCH_LONG_CLOSE if now.weekday() in LONG_DAYS else SEOUL_BRANCH_NORMAL_CLOSE
    return SEOUL_BRANCH_OPEN <= now.time() <= close

def collect_mmca_once(session_factory=SessionLocal) -> list[MmcaCongestionReading]:
    if not _is_seoul_branch_open(datetime.now()):
        return []

    readings = []
    with httpx.Client() as client:
        for space_code in settings.mmca_space_codes:
            try:
                readings.append(fetch_congestion(client, space_code, settings.mmca_api_key))
            except httpx.HTTPError:
                logger.warning("MMCA fetch failed for %s", space_code)

    with session_factory() as session:
        for r in readings:
            session.add(RawMmcaCongestion(...))
        session.commit()

    return readings
```

방 하나가 실패해도 나머지 7개는 계속 수집한다 (개별 try/except). 영업시간이 아니면 API를 아예 호출하지 않아 트래픽을 소모하지 않는다.

### 2.4 스케줄러 — `app/scheduler.py`에 등록 추가

```python
scheduler.add_job(
    collect_mmca_once,
    trigger=IntervalTrigger(minutes=6),
    id="collect_mmca_congestion",
    misfire_grace_time=60,
)
```

### 2.5 설정 — `app/config.py`에 추가

```python
mmca_api_key: str
mmca_space_codes: list[str] = [f"MMCA-SPACE-100{i}" for i in range(1, 9)]
```

## 3. 폴링 주기 & 트래픽 한도

공공데이터포털 개발계정은 1,000건/일 제한. 8개 전시실 × 영업시간 내 호출 횟수:

| 요일군 | 영업시간 | 6분 간격 슬롯 수 | 8실 호출 수 |
|---|---|---|---|
| 월·화·목·금·일 | 10:00–18:00 (8h) | 80 | 640 |
| 수·토 | 10:00–21:00 (11h) | 110 | 880 |

5분 간격이면 수/토에 1,056건으로 한도를 넘기므로 6분으로 결정. 요일별 간격을 분기하지 않고 상수 하나로 통일해 코드를 단순하게 유지한다.

## 4. 데이터 흐름 & 폴백

- **API 호출 실패** (개별 room): 해당 room만 건너뛰고 나머지 room은 계속 수집. 재시도 큐 없이 다음 6분 주기에 자연 재시도 (기존 국립중앙박물관 파이프라인과 동일한 폴백 철학).
- **혼잡도 값 없음** (전시 2개 미만, 또는 API가 아직 값을 안 주는 경우): 에러가 아니라 `congestion_nm=None`인 정상 행으로 적재.
- **영업시간 외**: 스케줄러 job은 계속 6분마다 실행되지만, `_is_seoul_branch_open`이 false면 API를 호출하지 않고 즉시 반환.

## 5. 테스트

기존 `test_seoul_api.py` / `test_collector.py` 패턴을 그대로 따른다.

- `test_mmca_api.py`: mock 응답 주입해 정상 파싱 + `data`가 빈 경우(`congestion_nm=None`) 파싱 확인.
- `test_collector.py`에 케이스 추가: 영업시간 내/외 각각에서 `collect_mmca_once` 호출 시 API 호출 여부(mock call count) 확인, 8개 중 1개 실패해도 나머지 7개는 저장되는지 확인.

## 6. 의사결정 요약

| 항목 | 결정 | 이유 |
|---|---|---|
| 폴링 대상 | 서울관 8개 전시실 전부 | 어느 방에서 전시가 열리는지 몰라 전부 폴링이 안전, 트래픽 한도 내에서 가능 |
| 다른 관(과천/청주/덕수궁) | 이번엔 제외 | 지금 필요한 건 서울관뿐, 코드는 설정값만 늘리면 확장 가능한 구조 |
| 폴링 주기 | 6분 (요일 구분 없이 고정) | 5분으로는 수/토에 1,000건/일 한도 초과, 요일 분기 없이 상수 하나로 코드 단순화 |
| 영업시간 게이트 위치 | 스케줄러가 아니라 수집 함수 내부 | 스케줄러 트리거를 요일별로 쪼개는 것보다 함수 안 시간 체크 한 줄이 더 단순 |
| DB 테이블 | 기존 `RawCongestion`과 분리한 새 테이블 | 인구수 기반 vs 카테고리 기반으로 데이터 모양이 완전히 다름 |
| 프론트엔드/예측 | 이번 단계 제외 | 실제 데이터 모양을 보기 전에는 표시/예측 설계가 근거 없는 추측이 됨 |
