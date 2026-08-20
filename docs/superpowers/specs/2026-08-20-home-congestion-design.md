# 홈 화면 혼잡도 노출 설계

## 배경

홈(`frontend/src/pages/HomePage.tsx`)은 현재 `VENUES` 4개를 이름만 적힌 링크
카드로 나열한다. 어느 관이 지금 붐비는지는 관 상세 페이지에 들어가야만 알 수
있어서, 홈은 관 선택 메뉴 역할만 하고 있다.

관별 현재 혼잡도를 홈 카드에 노출해 "지금 어디로 갈까"를 홈에서 판단할 수
있게 한다.

## 범위

프론트엔드 전용. 백엔드 라우트·스키마·수집기 변경 없음.

노출 대상은 이미 있는 두 API뿐이다.

| 관 | API | 데이터 |
| --- | --- | --- |
| 국립중앙박물관 | `GET /congestion/current` | 단일 `congest_level` + `population_avg` |
| 국립현대미술관 서울/과천/덕수궁관 | `GET /mmca/rooms?venue=` | 방별 `congestion_nm` 목록 |

홈에서 4개를 병렬 호출한다. 백엔드에 관 요약 엔드포인트를 새로 만들지 않는다 —
요약 규칙이 순수 표시 로직이고, 상세 페이지들이 이미 이 두 API를 쓰고 있어서
추가 부하가 카드 한 장 수준이다.

## 카드 표시 규칙

### 정상 상태

- 국립중앙박물관: `보통 · 1,240명` (레벨 + 인원수)
- MMCA 각 관: `여유 4 · 보통 2` (레벨별 방 개수)

두 형태 모두 아래에 `14:20 기준`을 붙인다. 인원수는 `CongestionCard`와 같게
`Math.round` 후 천 단위 구분자를 넣는다. 레벨 텍스트는
`statusOf(level).text` 색, 앞에 `core` 색 점을 둔다.

MMCA 카운트 규칙:

- `DISABLED_MMCA_SPACE_CODES`에 속한 방과 `congestion_nm`이 `null`인 방은 집계
  대상에서 제외한다.
- 순서는 `여유 → 보통 → 약간 붐빔 → 붐빔`, 개수가 0인 레벨은 생략한다. 4단계를
  전부 적으면 카드 한 줄을 넘기고, 0인 레벨은 정보를 주지 않는다.
- 위 4단계에 없는 미지 레벨이 오면 뒤에 이어 붙이고 회색 fallback 토큰으로
  그린다 (`statusOf`의 기존 동작).
- 기준 시각은 집계에 포함된 방들의 `observed_at` 최댓값.

### 무데이터 상태

혼잡도 자리에 이유를 그대로 적고, 카드 전체를 `opacity-60`으로 흐리게 한다.
링크는 계속 살려 둔다 — 상세 페이지에는 지난주 곡선 등 볼 것이 남아 있다.

판정 순서 (위에서 먼저 걸리는 것이 이긴다):

| 조건 | 표시 |
| --- | --- |
| 데이터 아직 없음, 에러도 아님 | `불러오는 중` |
| 에러 + 표시할 데이터 없음 | `정보 없음` |
| MMCA 전 객실 disabled (덕수궁관) | `서비스 예정` |
| MMCA `!isOpenToday` (덕수궁관 월요일) | `휴관일` |
| 현재 시각 < 개관 | `운영 전` |
| 현재 시각 > 폐관 | `운영 종료` |
| MMCA 활성 객실 판독 0건 | `집계 중` |
| 그 외 | 위 정상 상태 |

`서비스 예정`이 시각 판정보다 위인 이유: 덕수궁관은 시간과 무관하게 영구적으로
수집 대상이 아니므로, 밤에 `운영 종료`로 적으면 아침에는 값이 나올 것처럼 읽힌다.

문구는 관 상세 페이지가 이미 쓰는 어휘를 따른다 (`서비스 예정`, `휴관일`은
`MmcaPage`의 `inactiveReason`과 동일, `운영 전`/`운영 종료`는 `CongestionCard`의
`openBadge`와 같은 판정).

`집계 중`이 필요한 이유: 수집기의 당일 첫 폴은 개관 10분 뒤에 돌고
(`backend/app/collector.py`의 `_COLLECTION_START`), `/mmca/rooms`는 당일 판독만
반환한다. 그 사이 창은 "정보 없음"이 아니라 정상적인 대기 상태다.

## 구성

### `lib/venueSummary.ts` (신규)

표시 상태 판정을 담는 순수 함수. DOM·fetch에 의존하지 않아 상태 매트릭스를
그대로 테스트할 수 있다.

```ts
export type VenueSummary =
  | { kind: "inactive"; label: string }
  | { kind: "level"; level: string; population: number; observedAt: string }
  | { kind: "counts"; counts: { level: string; count: number }[]; observedAt: string };

export function nationalMuseumSummary(
  current: CurrentCongestion | null, now: Date
): VenueSummary;

export function mmcaSummary(
  venue: MmcaVenue, rooms: MmcaRoomStatus[] | null, now: Date
): VenueSummary;
```

`now`는 인자로 받는다 — 시각 의존 분기를 테스트에서 고정하기 위해서.

`정보 없음`은 이 함수들이 판정하지 않는다. fetch 실패는 호출부(`HomePage`)의
`catch`가 알고 있는 사실이므로 거기서 `{ kind: "inactive", label: "정보 없음" }`을
직접 넣는다 — 순수 함수에 쓰이지도 않는 `error` 인자를 끼우지 않기 위해서.

### `lib/nationalMuseumBusinessHours.ts` (신규, 이동)

`CongestionCard.tsx`에 private으로 있는 `businessHours()`와 `OPEN_MINUTES` /
`LONG_CLOSE_DAYS`를 그대로 옮기고 `CongestionCard`가 import한다. 홈도 같은
개·폐관 판정을 해야 하므로, 두 번째 사본을 만들지 않기 위한 이동이다. 로직
변경 없음. MMCA 쪽은 `lib/mmcaBusinessHours.ts`가 이미 있어 그대로 쓴다.

### `status.ts`

`export const STATUS_LEVELS = Object.keys(STATUS);` 한 줄 추가. 카운트 표시
순서의 단일 출처이며, `STATUS` 정의 순서를 그대로 따라가 목록이 두 군데로
갈라지지 않는다.

### `venues.ts`

`Venue`에 `mmcaVenue?: MmcaVenue`를 더한다. 값이 있으면 MMCA관(그 값이 API
파라미터), 없으면 국립중앙박물관. 관 종류가 둘뿐이라 판별 유니온까지 갈 이유가
없다.

### `HomePage.tsx`

- `useEffect` 하나에서 `VENUES`를 훑어 관별로 독립적인 fetch를 띄운다
  (`fetchCurrent()` 1건 + `fetchMmcaRooms()` 3건), 60초 폴링
  (`MmcaPage`의 `POLL_INTERVAL_MS`와 동일 주기).
- `Promise.allSettled`로 묶지 않는다 — 묶으면 가장 느린 관이 나머지 세 카드의
  첫 렌더를 붙잡는다. 관별로 도착하는 대로 그린다.
- 상태는 venue id를 키로 하는 `Record<string, VenueSummary>` 하나. 요약은 응답이
  도착한 시점에 계산해 넣는다.
- 실패한 관은 직전 요약을 유지하고, 그 관 요약이 아예 없을 때만 `정보 없음`을
  넣는다.
- 카드는 기존 `Link` 안에 요약 줄과 기준 시각을 덧붙인다. 그리드·라운드·호버
  스타일은 지금 것을 유지한다.

## 테스트

- `tests/venueSummary.test.ts` (신규): 무데이터 판정 매트릭스 전 항목, 카운트
  순서와 0 레벨 생략, disabled 방 제외, `observed_at` 최댓값 선택.
- `tests/HomePage.test.tsx` (수정): fetch를 mock해 `보통 · 1,240명`,
  `여유 4 · 보통 2`가 렌더되는지 확인. 기존 링크 테스트는 카드 안에 텍스트가
  늘어 accessible name이 바뀌므로 정규식 매칭으로 고친다.
- `tests/CongestionCard.test.tsx`: 영업시간 함수 이동은 동작 변화가 없어야 하므로
  기존 테스트가 그대로 통과하는 것이 회귀 검증이다.
- e2e(`e2e/congestion.spec.ts`)는 손대지 않는다.

## 하지 않는 것

- 홈 카드에 스파크라인, 지난주 대비 증감
- 백엔드 관 요약 엔드포인트
- 홈에서 MMCA 방별 목록 노출 (상세 페이지의 역할)
- 카드 정렬을 혼잡도순으로 바꾸는 것 (`VENUES` 순서 유지)
