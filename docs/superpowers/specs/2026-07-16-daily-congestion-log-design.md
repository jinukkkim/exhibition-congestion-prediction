# 일별 혼잡도 로그 테이블 — 설계

- 날짜: 2026-07-16
- 목적: `CongestionCard` 아래에 날짜/시간/혼잡도를 나열한 표를 추가해, 하루 단위로 넘겨보며 원본 수집 데이터를 확인할 수 있게 한다.
- 관련 문서: [혼잡도 카드 시각적 개선 설계](./2026-07-15-congestion-card-visual-refresh-design.md)

## 1. 범위

**이번 버전은 빠르게 눈에 보이는 것이 목적** — 실제 배포 전에 다시 다듬을 예정이므로 과설계하지 않는다.

### 포함 (In Scope)
- 새 컴포넌트 `DailyLogTable`을 `CongestionCard` 바로 아래에 배치
- 컬럼: 날짜, 시간, 혼잡도 (3개)
- 한 줄 = 5분 원본 수집 데이터 그대로, 00:00:00 ~ 다음날 00:00:00 미만 범위 (하루 최대 288줄, 세로 스크롤)
- "이전 날짜" / "다음 날짜" 버튼으로 하루 단위 이동, 기본값은 오늘
- 이전 날짜로만 이동 가능 — 다음 날짜는 오늘에서 막힘 (미래 데이터 없음)
- 데이터 없는 날짜(수집 시작 이전 등)는 "데이터 없음" 표시

### 제외 (Out of Scope, YAGNI)
- 인원수 컬럼, 정렬/필터, 페이지네이션 최적화
- 날짜 직접 입력(달력 피커) — 이전/다음 버튼만
- 무한 과거로의 성능 최적화 (지금은 데이터가 며칠 치뿐이라 불필요)
- 시각적 폴리싱 — 나중에 다시 다듬을 예정

## 2. 데이터 흐름

```
GET /congestion/daily?date=2026-07-16
  → RawCongestion에서 observed_at이 해당 날짜 00:00:00~23:59:59인 행 전체 조회 (observed_at 인덱스 활용), 시간순
  → [{observed_at: str, congest_level: str}, ...] 반환 (population 제외)
  → 데이터 없으면 빈 배열 (에러 아님)
```

날짜 파싱/비교는 기존 코드베이스 컨벤션과 동일하게 naive datetime(서울시 API의 KST wall-clock 그대로) 기준으로 처리한다 — 기존 `/congestion/history`, `prediction/batch.py`와 동일한 전제.

## 3. 백엔드 변경

- `backend/app/routes/congestion.py`에 `GET /congestion/daily` 라우트 추가
  - 쿼리 파라미터 `date: str` (예: `"2026-07-16"`), 없으면 오늘 날짜로 기본 처리
  - `datetime.strptime(date, "%Y-%m-%d")`로 해당 날짜의 00:00:00 ~ 다음날 00:00:00 범위로 필터
  - 기존 `SessionLocal`/`RawCongestion` 패턴 재사용
- `backend/app/schemas.py`에 `DailyLogPoint(observed_at: str, congest_level: str)` 추가

## 4. 프론트엔드 변경

- `frontend/src/api/congestion.ts`: `fetchDaily(date: string): Promise<DailyLogPoint[]>` 추가
- `frontend/src/components/DailyLogTable.tsx` (신규):
  - `selectedDate` state (기본값: 오늘, `YYYY-MM-DD` 문자열)
  - 이전/다음 버튼: 날짜를 ±1일 이동, 다음 버튼은 오늘일 때 비활성화
  - 테이블: 날짜/시간/혼잡도 3컬럼, 혼잡도 셀은 `CongestionCard`의 상태색(`STATUS_COLOR`/`FALLBACK_COLOR`) 재사용
  - `max-height` + `overflow-y: auto`로 스크롤 처리 (최대 288행 대응)
  - 데이터 빈 배열이면 "데이터 없음" 텍스트
- `frontend/src/App.tsx`: `<CongestionCard .../>` 아래에 `<DailyLogTable />` 추가 (자체적으로 데이터를 fetch하는 독립 컴포넌트라 App은 배치만 담당)

## 5. 에러 처리

- `/congestion/daily` 호출 실패 시: 테이블 영역에 "불러오지 못했습니다" 표시, 나머지 화면(카드/차트)에는 영향 없음 (기존 패턴과 동일한 독립 실패 원칙)

## 6. 테스트

- 백엔드: `/congestion/daily` — 특정 날짜 데이터만 반환(다른 날짜 제외), 데이터 없는 날짜는 빈 배열
- 프론트: `DailyLogTable` — 데이터 렌더링, 이전/다음 버튼 클릭 시 날짜가 바뀌고 재요청되는지, 오늘일 때 다음 버튼 비활성화

## 7. 의사결정 요약

| 항목 | 결정 | 이유 |
|---|---|---|
| 데이터 단위 | 5분 원본 그대로 | 사용자가 명시적으로 요청, 집계 없이 빠르게 구현 |
| 엔드포인트 | 새 `/congestion/daily?date=` | 기존 `/history`(롤링 윈도우)와 목적이 달라 분리, 기존 단일 책임 패턴 유지 |
| 날짜 이동 범위 | 과거로만 | 미래 데이터가 없으므로 다음 버튼은 오늘에서 막음 |
| 스코프 | 최소 기능만, 폴리싱 제외 | 사용자가 명시: 배포 전 다시 다듬을 예정이라 지금은 눈에 보이는 것 우선 |
