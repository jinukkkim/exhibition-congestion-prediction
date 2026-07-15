# 혼잡도 카드 시각적 개선 — 설계

- 날짜: 2026-07-15
- 목적: MVP 화면(혼잡도 카드 + 예측 차트)이 텍스트 위주라 "뭔가 보인다"는 느낌이 약함. 시각적으로 다듬고, 최근 추이를 한눈에 보여주는 스파크라인을 추가한다.
- 관련 문서: [MVP 설계](./2026-07-15-exhibition-congestion-prediction-design.md)

## 1. 범위

### 포함 (In Scope)
- `CongestionCard`를 Minimal 스타일로 리디자인 — 여백 확대, 큰 숫자 하나 중심, 상태색 포인트
- 카드 안에 최근 6시간 인원 추이 스파크라인 추가
- 백엔드에 히스토리 조회용 엔드포인트 1개 추가 (`GET /congestion/history?hours=6`)
- `PredictionChart`는 새 카드와 톤이 어긋나지 않게 여백/타이포만 맞춤 (베이스라인 vs 모델 비교 구조는 유지)

### 제외 (Out of Scope, YAGNI)
- 새로운 인터랙션(시간 클릭, 과거 트렌드 조회 등) — 이번엔 순수 시각 개선 + 스파크라인만
- 스파크라인 실시간(초 단위) 갱신 — 페이지 로드 시 1회 조회로 충분
- 다크모드 — 기존 화면도 라이트 전용이라 이번 범위에서 제외
- 여러 장소 확장 — MVP 설계 문서의 기존 결정 유지

## 2. 비주얼 디자인

브라우저 목업 3안(Minimal / Dashboard / Status Hero) 중 **Minimal**을 채택.

- 카드 배경: 흰색, 넉넉한 패딩
- 상단: 작은 라벨("국립중앙박물관 현재 혼잡도")
- 중앙: 큰 숫자/텍스트로 혼잡도 상태 하나만 강조, 옆에 인원수 · 관측 시각을 작은 회색 텍스트로
- 하단: 최근 6시간 추이 스파크라인 (얇은 선, 상태색)

### 상태 색상

혼잡도는 4단계 고정값(`여유`/`보통`/`약간붐빔`/`붐빔`)이라 임의 카테고리 색이 아니라 **상태(status) 전용 팔레트**를 쓴다 (dataviz 스킬의 검증된 고정 4색):

| 레벨 | 역할 | hex |
|---|---|---|
| 여유 | good | `#0ca30c` |
| 보통 | warning | `#fab219` |
| 약간붐빔 | serious | `#ec835a` |
| 붐빔 | critical | `#d03b3b` |

색만으로 상태를 구분하지 않고 텍스트 라벨을 항상 같이 표시한다 (이미 텍스트로 표시 중이라 자연 충족). 프론트에 `congestLevelColor: Record<string, string>` 형태의 매핑을 두고, 목록에 없는 값이 오면 회색(`#94a3b8`)으로 폴백한다 (서울시 API가 새 레벨 문자열을 추가하더라도 화면이 깨지지 않게).

## 3. 데이터 흐름

```
GET /congestion/history?hours=6
  → RawCongestion 테이블에서 observed_at >= now - 6h 조회 (observed_at 인덱스 범위 쿼리)
  → [{observed_at: str, population_avg: float}, ...] 시간순 반환
```

- 프론트는 페이지 로드 시 `fetchCurrent`, `fetchPrediction`과 함께 `fetchHistory(6)`도 함께 호출
- 스파크라인은 SSE로 실시간 갱신하지 않음 — 5분 간격 추이 트렌드만 보여주면 충분하고, 매 SSE 메시지마다 다시 그리는 건 과설계
- `population_avg`는 기존 `/congestion/current`와 동일하게 `(population_min + population_max) / 2`로 backend에서 계산해 반환 (프론트는 그대로 그리기만 함)

## 4. 백엔드 변경

- `backend/app/routes/congestion.py`에 `GET /congestion/history` 라우트 추가
  - 쿼리 파라미터 `hours: int = 6`
  - `RawCongestion`을 `observed_at`로 필터링해 조회 (기존 DB 세션/모델 재사용, 새 테이블 불필요)
  - 데이터 없으면 빈 배열 반환 (에러 아님 — 콜드 스타트 상태와 동일하게 취급)
- `backend/app/schemas.py`에 응답 스키마 추가

## 5. 프론트엔드 변경

- `frontend/src/api/congestion.ts`: `fetchHistory(hours: number)` 추가
- `frontend/src/components/CongestionCard.tsx`: Minimal 레이아웃으로 리디자인, 상태색 매핑 적용, 스파크라인 SVG(기존 `PredictionChart`의 `toPoints` 헬퍼와 동일한 패턴 재사용) 추가
- `frontend/src/components/PredictionChart.tsx`: 여백/타이포만 `CongestionCard`와 톤 맞춤 (구조 변경 없음)
- `frontend/src/App.tsx`: `fetchHistory(6)` 호출 추가, `CongestionCard`에 history prop 전달

## 6. 에러 처리

- `/congestion/history` 호출 실패 시: 스파크라인만 조용히 숨김 (카드 자체는 정상 렌더링). 현재값/예측은 기존과 동일하게 각자 독립적으로 동작 — 하나가 실패해도 나머지는 영향 없음 (기존 패턴 유지)

## 7. 테스트

- 백엔드: `test_routes_congestion.py`에 `/congestion/history` 케이스 추가 — 정상 반환, 데이터 없을 때 빈 배열
- 프론트: `CongestionCard.test.tsx`에 스파크라인 렌더링(데이터 있을 때/없을 때) 케이스 추가

## 8. 의사결정 요약

| 항목 | 결정 | 이유 |
|---|---|---|
| 히스토리 조회 방식 | 새 REST 엔드포인트, DB 직접 쿼리 | SSE 누적(새로고침 시 빈 차트) 대비 즉시 표시 가능, Redis 별도 캐싱(중복 저장) 대비 단순함 |
| 스파크라인 갱신 방식 | 페이지 로드 시 1회 조회 | 5분 간격 추이 트렌드가 목적이라 실시간 갱신 불필요 |
| 상태 색상 | dataviz 스킬의 고정 status 팔레트 4색 | 임의 색 대신 색맹 대비까지 검증된 값, 텍스트 라벨 병행으로 색맹 접근성 확보 |
| 스코프 | 시각 개선 + 스파크라인만, 새 인터랙션 제외 | 이번 목표는 "뭔가 보이는 느낌"이지 새 기능 추가가 아님 (YAGNI) |
