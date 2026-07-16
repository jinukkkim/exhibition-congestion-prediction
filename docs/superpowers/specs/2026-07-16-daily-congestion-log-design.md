# 일별 혼잡도 로그 테이블 — 설계

- 날짜: 2026-07-16
- 목적: `CongestionCard` 아래에 서울시 API가 주는 원본 항목(시각·혼잡도·인구·인구통계)을 전부 나열한 표를 추가해, 하루 단위로 넘겨보며 수집 데이터를 확인할 수 있게 한다.
- 관련 문서: [혼잡도 카드 시각적 개선 설계](./2026-07-15-congestion-card-visual-refresh-design.md)

## 1. 범위

**이번 버전은 빠르게 눈에 보이는 것이 목적** — 실제 배포 전에 다시 다듬을 예정이므로 과설계하지 않는다.

### 포함 (In Scope)
- 새 컴포넌트 `DailyLogTable`을 `CongestionCard` 바로 아래에 배치
- 컬럼 16개, 서울시 API `LIVE_PPLTN_STTS`가 주는 원본 필드를 그대로 반영 (실제 응답으로 필드명 확인 완료):

  | 컬럼 | 서울시 API 필드 |
  |---|---|
  | 시각 | `PPLTN_TIME` |
  | 혼잡도 단계 | `AREA_CONGEST_LVL` |
  | 최소 인구 | `AREA_PPLTN_MIN` |
  | 최대 인구 | `AREA_PPLTN_MAX` |
  | 남성 비율 | `MALE_PPLTN_RATE` |
  | 여성 비율 | `FEMALE_PPLTN_RATE` |
  | 10대 미만 비율 | `PPLTN_RATE_0` |
  | 10대 비율 | `PPLTN_RATE_10` |
  | 20대 비율 | `PPLTN_RATE_20` |
  | 30대 비율 | `PPLTN_RATE_30` |
  | 40대 비율 | `PPLTN_RATE_40` |
  | 50대 비율 | `PPLTN_RATE_50` |
  | 60대 비율 | `PPLTN_RATE_60` |
  | 70대 이상 비율 | `PPLTN_RATE_70` |
  | 상주인구 비율 | `RESNT_PPLTN_RATE` |
  | 비상주인구 비율 | `NON_RESNT_PPLTN_RATE` |

- 날짜 컬럼은 별도로 두지 않음 — 표 상단에 선택된 날짜가 이미 표시되므로, 각 행은 `시각`(시:분)만 표시 (기존 3컬럼 설계의 "날짜" 컬럼은 중복이라 제거)
- 한 줄 = 5분 원본 수집 데이터 그대로, 00:00:00 ~ 다음날 00:00:00 미만 범위 (하루 최대 288줄)
- 16컬럼을 전부 표시하고 가로 스크롤로 대응 (컬럼 접기/펼치기 등은 안 함)
- "이전 날짜" / "다음 날짜" 버튼으로 하루 단위 이동, 기본값은 오늘
- 이전 날짜로만 이동 가능 — 다음 날짜는 오늘에서 막힘 (미래 데이터 없음)
- 데이터 없는 날짜(수집 시작 이전 등)는 "데이터 없음" 표시

### 제외 (Out of Scope, YAGNI)
- 정렬/필터, 페이지네이션 최적화
- 날짜 직접 입력(달력 피커) — 이전/다음 버튼만
- 무한 과거로의 성능 최적화 (지금은 데이터가 며칠 치뿐이라 불필요)
- 시각적 폴리싱, 컬럼 접기/좁은 화면 대응 — 나중에 다시 다듬을 예정
- 서울시 API의 자체 예측치(`FCST_PPLTN`) — 이번 표에는 안 넣음, 필요해지면 별도 논의

## 2. 데이터 흐름

먼저 **수집 단계(`collector.py`)부터** 이 필드들을 저장해야 표에 나올 데이터가 생긴다. 지금은 서울시 API 응답 중 4개 필드만 파싱해서 버리고 있으므로, 나머지 12개 필드도 파싱·저장하도록 확장한다.

```
[서울시 API 응답] → seoul_api.py가 16개 필드 전부 파싱 → RawCongestion에 저장(새 컬럼 12개 추가)
                                                              |
GET /congestion/daily?date=2026-07-16                        |
  → RawCongestion에서 observed_at이 해당 날짜 00:00:00 ~ 다음날 00:00:00 미만인 행 전체 조회, 시간순
  → 16개 필드를 JSON으로 반환
  → 데이터 없으면 빈 배열 (에러 아님)
```

**기존 수집 데이터와의 관계**: 7/15부터 이미 수집 중인 기존 행에는 새 필드가 없다. DB를 새로 만들면 지금까지 쌓은 데이터(14일 예측 학습용)가 날아가므로, 새 컬럼은 **nullable로 추가**하고 기존 SQLite 파일에 `ALTER TABLE`로 붙인다 (마이그레이션 툴 없이 1회성 스크립트). 기존 행은 새 컬럼이 빈 값으로 나오는데, 표에는 그대로 빈 셀로 보여준다 (에러 아님).

날짜 파싱/비교는 기존 코드베이스 컨벤션과 동일하게 naive datetime(서울시 API의 KST wall-clock 그대로) 기준으로 처리한다 — 기존 `/congestion/history`, `prediction/batch.py`와 동일한 전제.

## 3. 백엔드 변경

- `backend/app/seoul_api.py`: `CongestionReading`에 12개 필드 추가 (성별 2 + 연령대 8 + 상주/비상주 2), `fetch_congestion`이 전부 파싱
- `backend/app/models.py`: `RawCongestion`에 같은 12개 컬럼 추가, 전부 `nullable=True` (과거 행 호환)
- 1회성 스키마 반영 스크립트: 로컬 `congestion.db`에 `ALTER TABLE raw_congestion ADD COLUMN ...` 12번 실행 (기존 데이터 보존)
- `backend/app/collector.py`: `RawCongestion(...)` 생성 시 새 필드도 같이 저장
- `backend/app/routes/congestion.py`에 `GET /congestion/daily` 라우트 추가
  - 쿼리 파라미터 `date: str` (예: `"2026-07-16"`), 없으면 오늘 날짜로 기본 처리
  - `datetime.strptime(date, "%Y-%m-%d")`로 해당 날짜의 00:00:00 ~ 다음날 00:00:00 범위로 필터
  - 기존 `SessionLocal`/`RawCongestion` 패턴 재사용
- `backend/app/schemas.py`에 `DailyLogPoint` 추가 — 16개 필드 전부 포함 (시각, 혼잡도, 최소/최대 인구, 성별 2, 연령대 8, 상주/비상주 2)

## 4. 프론트엔드 변경

- `frontend/src/api/congestion.ts`: `fetchDaily(date: string): Promise<DailyLogPoint[]>` 추가 (타입에 16개 필드 전부 포함)
- `frontend/src/components/DailyLogTable.tsx` (신규):
  - `selectedDate` state (기본값: 오늘, `YYYY-MM-DD` 문자열)
  - 이전/다음 버튼: 날짜를 ±1일 이동, 다음 버튼은 오늘일 때 비활성화
  - 테이블: 16컬럼, 혼잡도 셀은 `CongestionCard`의 상태색(`STATUS_COLOR`/`FALLBACK_COLOR`) 재사용, 나머지는 숫자/비율 그대로 표시
  - 표 컨테이너에 `overflow-x: auto`(가로 스크롤) + `max-height` + `overflow-y: auto`(세로 스크롤, 최대 288행 대응)
  - 값이 없는(과거 데이터) 셀은 빈 칸으로 표시
  - 데이터 배열 자체가 비어있으면 "데이터 없음" 텍스트
- `frontend/src/App.tsx`: `<CongestionCard .../>` 아래에 `<DailyLogTable />` 추가 (자체적으로 데이터를 fetch하는 독립 컴포넌트라 App은 배치만 담당)

## 5. 에러 처리

- `/congestion/daily` 호출 실패 시: 테이블 영역에 "불러오지 못했습니다" 표시, 나머지 화면(카드/차트)에는 영향 없음 (기존 패턴과 동일한 독립 실패 원칙)

## 6. 테스트

- 백엔드:
  - `seoul_api.fetch_congestion` — 확장된 fixture(16개 필드 포함)로 전부 파싱되는지
  - `/congestion/daily` — 특정 날짜 데이터만 반환(다른 날짜 제외), 데이터 없는 날짜는 빈 배열, 새 필드 12개가 응답에 포함되는지
- 프론트: `DailyLogTable` — 데이터 렌더링(16컬럼), 이전/다음 버튼 클릭 시 날짜가 바뀌고 재요청되는지, 오늘일 때 다음 버튼 비활성화

## 7. 의사결정 요약

| 항목 | 결정 | 이유 |
|---|---|---|
| 데이터 단위 | 5분 원본 그대로 | 사용자가 명시적으로 요청, 집계 없이 빠르게 구현 |
| 컬럼 범위 | 서울시 API `LIVE_PPLTN_STTS`의 인구 관련 필드 16개 전부 | 사용자 요청, 실제 API 응답으로 필드명 확인 완료 |
| 넓은 표 대응 | 가로 스크롤 | 컬럼 접기/반응형은 지금 단계에서 과함(사용자: 배포 전 다시 다듬을 예정) |
| 엔드포인트 | 새 `/congestion/daily?date=` | 기존 `/history`(롤링 윈도우)와 목적이 달라 분리, 기존 단일 책임 패턴 유지 |
| 날짜 이동 범위 | 과거로만 | 미래 데이터가 없으므로 다음 버튼은 오늘에서 막음 |
| DB 스키마 변경 | 기존 SQLite 파일에 nullable 컬럼 12개를 `ALTER TABLE`로 추가 | 지금까지 쌓은 14일 예측용 데이터를 유지해야 함 — DB 재생성 시 수집 처음부터 다시 시작해야 함 |
| 스코프 | 최소 기능만, 폴리싱 제외 | 사용자가 명시: 배포 전 다시 다듬을 예정이라 지금은 눈에 보이는 것 우선 |
