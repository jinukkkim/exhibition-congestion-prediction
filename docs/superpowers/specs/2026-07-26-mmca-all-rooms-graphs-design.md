# MMCA 전체 전시실 그래프 확대 — 설계

- 날짜: 2026-07-26
- 배경: 과천관 2개 전시실(1전시실 곡선, 어린이미술관 계단형)로 비교해본 결과 곡선 쪽으로 정해짐. 이제 서울관·과천관·덕수궁관의 모든 전시실(17개)에 동일한 곡선 그래프 카드를 적용한다.

## 1. 목표 & 범위

**무엇을 만드나**: 3개 관, 17개 전시실 전부를 `MmcaRoomChartCard`(곡선)로 렌더링. 작은 상태 카드(`RoomCongestionCard`)는 완전히 제거.

### 포함 (In Scope)
- 서울관 8실, 과천관 8실, 덕수궁관 1실 — 전부 곡선 그래프 카드
- 레이아웃: `lg:grid-cols-2`(2열), 전시실이 1개뿐인 관(덕수궁)은 전체 폭 1열
- `RoomCongestionCard` 컴포넌트·테스트 삭제
- **성능**: 카드마다 각자 `/mmca/daily`를 fetch하던 걸 `MmcaPage`가 한 번만 fetch해서 `daily` prop으로 내려주는 구조로 변경 (전시실 8개 페이지에서 동일 요청 8번 나가던 문제)
- **정확성**: 덕수궁 월요일 휴무를 프론트 `mmcaBusinessHours`에도 반영 (지금은 과천 스코프였을 때 만들어져서 관별 휴무일 개념이 없음)
- 계단형(step) 경로 계산 코드 제거 (더 이상 아무 데서도 안 씀)

### 제외 (Out of Scope, YAGNI)
- 새 백엔드 변경 없음 — 기존 `/mmca/rooms`, `/mmca/daily` 그대로 재사용
- 폴링 로그 표(`MmcaDailyLogTable`)는 그대로 유지, 변경 없음

## 2. 핵심 결정

### 2.1 데이터 흐름 재구성 — 카드는 순수 렌더 컴포넌트로

지금 `MmcaRoomChartCard`는 `venue`/`spaceCode`만 받고 자기가 직접 `fetchMmcaDaily`를 60초 주기로 호출한다. 전시실 1~2개일 땐 괜찮았지만 8개가 되면 페이지 하나에서 동일한 `/mmca/daily?venue=X&date=오늘` 요청이 8번 중복으로 나간다.

**변경**: `MmcaPage`가 `fetchMmcaDaily(venue, todayString())`를 한 번만 60초 주기로 fetch하고, 결과(`daily: MmcaDailyLogPoint[] | null`)를 각 카드에 prop으로 내려준다. `MmcaRoomChartCard`는 더 이상 `venue` prop도, 내부 `useEffect`/fetch/polling 상태도 필요 없어진다 — 순수하게 `(spaceCode, room, daily, open, close, isOpen)`을 받아 그리기만 하는 컴포넌트가 된다. 호버 상태(`hoverIndex`)만 컴포넌트 내부에 남는다.

### 2.2 영업시간 — 관별 휴무일 반영

`mmcaBusinessHours(date: Date)` → `mmcaBusinessHours(venue: MmcaVenue, date: Date)`로 확장, 반환값에 `isOpenToday: boolean` 추가. 백엔드 `collector.py`의 `_VENUE_CLOSED_DAYS = {"deoksugung": {0}}`(Python: 월=0)와 동일한 규칙을 JS 요일 규약(`Date.getDay()`: 일=0, 월=1)으로 옮겨 `{ deoksugung: new Set([1]) }`.

`open`/`close` 시각(10:00, 18:00/21:00)은 3개 관 전부 동일 — 값 자체는 안 바뀌고, 오늘 문 닫는 요일인지만 관별로 추가된다. `MmcaPage`가 한 번 계산해서 모든 카드에 같은 `open`/`close`/`isOpen`을 내려준다(방마다 다시 계산할 필요 없음 — 같은 페이지 안에서 관이 하나뿐이므로).

### 2.3 계단형 코드 제거

과천관 1전시실/어린이미술관 비교 실험용으로 만든 `curve` prop과 `stepPath`/`areaPath`(계단형용) 함수는 이제 아무 데서도 `curve={false}`로 안 쓰이므로 삭제. `smoothPath`/`curveAreaPath`(→ 이름을 `smoothPath`/`areaPath`로 단순화)만 남긴다.

### 2.4 레이아웃

```tsx
{rooms.length > 1 ? (
  <section className="grid gap-6 lg:grid-cols-2">{...}</section>
) : (
  <section className="grid gap-6">{...}</section>  // 덕수궁: 전체 폭 1열
)}
```

### 2.5 `RoomCongestionCard` 삭제

`frontend/src/components/RoomCongestionCard.tsx`, `frontend/tests/RoomCongestionCard.test.tsx` 삭제 — `MmcaPage.tsx` 외에 쓰는 곳 없음을 확인함(grep 완료).

## 3. 컴포넌트 인터페이스 변경

### `MmcaRoomChartCard` (수정)

```tsx
{
  spaceCode: string;
  room: MmcaRoomStatus | undefined;
  daily: MmcaDailyLogPoint[] | null;
  open: number;
  close: number;
  isOpen: boolean;
}
```
`venue`, `curve` prop 제거. 내부 fetch/polling 로직 전부 제거.

### `mmcaBusinessHours` (수정)

```ts
export function mmcaBusinessHours(
  venue: MmcaVenue,
  date: Date
): { open: number; close: number; isOpenToday: boolean }
```

### `MmcaPage` (수정)

`heroSpaceCodes` prop 제거(더 이상 "일부만 크게" 개념이 없음 — 전부 다 그래프). `daily` fetch를 여기서 수행, `mmcaBusinessHours(venue, new Date())` 한 번 호출해 모든 카드에 전달.

### `App.tsx` (수정)

3개 라우트 전부 `heroSpaceCodes` prop 제거 — 방 목록은 API가 주는 `rooms`를 그대로 쓰므로 라우트에서 관별 space_code를 하드코딩할 필요가 아예 없어짐.

## 4. 테스트

- `MmcaRoomChartCard.test.tsx`: prop 기반으로 전면 재작성(fetch mock 불필요, `daily`/`open`/`close`/`isOpen`을 직접 prop으로 줌)
- `mmcaBusinessHours.test.ts` 신규: 관별 휴무일 분기(덕수궁 월요일 vs 서울/과천 항상 열림) 직접 테스트
- `MmcaPage.test.tsx`: 전체 재작성 — 방 개수만큼 카드가 뜨는지, `daily`가 한 번만 fetch되는지(카드 개수와 무관하게 호출 1회), 방 1개일 때 레이아웃이 1열인지
- `RoomCongestionCard.test.tsx` 삭제
- e2e: 기존 목 데이터가 관마다 1개 방만 주므로 카드 개수 검증은 자연히 1개로 줄어듦 — 기존 어서션 값만 조정

## 5. 의사결정 요약

| 항목 | 결정 | 이유 |
|---|---|---|
| 소형 카드 | 완전 제거 | 모든 전시실이 그래프가 되므로 더 이상 필요 없음(사용자 확인) |
| 레이아웃 | 2열, 1개실 관은 전체 폭 | 8개면 세로로 너무 길어지는 것 방지 + 사용자 확인 |
| daily fetch | 카드별 → 페이지별 1회 | 카드 8개=요청 8배 중복이던 걸 해소(파이널 리뷰 사전 지적) |
| 덕수궁 휴무 | 프론트에도 반영 | 지금까지 과천 스코프였어서 없었는데, 이제 실제로 덕수궁 카드가 뜨니 필요 |
| 계단형 코드 | 삭제 | 전부 곡선으로 결정되어 다른 경로가 죽은 코드가 됨 |
| 백엔드 | 변경 없음 | 기존 `/mmca/rooms`, `/mmca/daily`로 충분 |
