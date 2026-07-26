# 국중박·국현미 미술관별 페이지 분리 — 설계

- 날짜: 2026-07-24
- 배경: 지금은 프론트엔드가 국립중앙박물관(국중박) 데이터만 단일 화면(`App.tsx`)에 보여준다. 국립현대미술관(MMCA, 국현미) 수집 파이프라인은 백엔드에 이미 존재하지만(서울관 8개 전시실, 6분 간격, `raw_mmca_congestion` 테이블) 이를 노출하는 API 라우트도 화면도 없다. 두 미술관을 각자 페이지로 분리하고, 향후 미술관이 더 추가돼도 구조를 갈아엎지 않도록 만든다.

## 1. 목표 & 범위

**무엇을 만드나**: 홈에서 미술관을 선택하면 각 미술관 전용 페이지로 이동하는 구조. 국중박 페이지는 기존 기능(현재 카드·예측 차트·일별 로그) 그대로, 국현미 페이지는 신규로 "전시실별 현재 혼잡도 등급" 조회 화면만 만든다.

### 포함 (In Scope)
- `react-router-dom` 도입, 홈(`/`)·국중박(`/venues/national-museum`)·국현미(`/venues/mmca`) 3개 라우트
- 미술관 목록을 한 곳에서 관리하는 레지스트리(`venues.ts`) — 다음 미술관 추가 시 항목 하나만 늘리면 되도록
- 백엔드 `GET /mmca/rooms`: 전시실별 최신 혼잡도 등급 조회 (DB 직접 조회, 캐시 없음 — 기존 수집 파이프라인 범위와 동일)
- 국현미 페이지: 전시실 카드 8개, 등급 배지 + 마지막 갱신 시각

### 제외 (Out of Scope, YAGNI)
- 국현미 예측 모델·baseline·일별 로그 — 데이터가 인구수가 아니라 등급 텍스트라 국중박과 같은 예측 파이프라인을 그대로 쓸 수 없고, 실제 수집된 데이터를 보기 전엔 설계 근거가 없음
- 국현미 실시간 스트림(SSE) — 백엔드에 캐시/pub-sub 자체가 없음. 국현미 페이지는 60초 폴링으로 대체
- 미술관이 3개 이상일 때의 홈 화면 레이아웃 고민(그리드/검색 등) — 지금은 2개, 카드 리스트로 충분
- 과천관/청주관/덕수궁관 등 MMCA 다른 분관 — 수집 자체가 서울관 8실만 대상

## 2. 아키텍처

```
[HomePage] --venues.ts 기반 카드 클릭--> react-router 네비게이션
     |
     +--> /venues/national-museum --> [NationalMuseumPage] (기존 App.tsx 내용 이전)
     |                                     |
     |                                     +--> GET /congestion/current, /congestion/prediction, /congestion/daily (기존, 무변경)
     |
     +--> /venues/mmca --> [MmcaPage] (신규)
                               |
                               +--> GET /mmca/rooms (신규) --60초 폴링-->
```

### 2.1 프론트엔드 라우팅 — `App.tsx`

```tsx
import { BrowserRouter, Routes, Route } from "react-router-dom";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/venues/national-museum" element={<NationalMuseumPage />} />
        <Route path="/venues/mmca" element={<MmcaPage />} />
      </Routes>
    </BrowserRouter>
  );
}
```

### 2.2 미술관 레지스트리 — `src/venues.ts`

```ts
export interface Venue {
  id: string;
  name: string;
  path: string;
}

export const VENUES: Venue[] = [
  { id: "national-museum", name: "국립중앙박물관", path: "/venues/national-museum" },
  { id: "mmca", name: "국립현대미술관", path: "/venues/mmca" },
];
```

`HomePage`는 이 배열을 map으로 순회해 카드를 그린다. 미술관이 늘면 이 배열에 항목 추가 + 라우트 하나 + 페이지 컴포넌트 하나만 추가하면 된다.

### 2.3 백엔드 라우트 — `backend/app/routes/mmca.py` (신규)

```python
from fastapi import APIRouter, HTTPException
from sqlalchemy import func

from app.db import SessionLocal
from app.models import RawMmcaCongestion
from app.schemas import MmcaRoomStatus

router = APIRouter()


@router.get("/mmca/rooms", response_model=list[MmcaRoomStatus])
def mmca_rooms() -> list[MmcaRoomStatus]:
    with SessionLocal() as session:
        # space_code별 최신 observed_at 행만: 서브쿼리로 최신 id를 구한 뒤 join
        latest_ids = (
            session.query(func.max(RawMmcaCongestion.id))
            .group_by(RawMmcaCongestion.space_code)
            .all()
        )
        ids = [row[0] for row in latest_ids]
        rows = (
            session.query(RawMmcaCongestion)
            .filter(RawMmcaCongestion.id.in_(ids))
            .order_by(RawMmcaCongestion.space_code)
            .all()
        )

    if not rows:
        raise HTTPException(status_code=503, detail="no MMCA congestion data yet")

    return [
        MmcaRoomStatus(
            space_code=row.space_code,
            space_nm=row.space_nm,
            congestion_nm=row.congestion_nm,
            observed_at=row.observed_at.isoformat(),
        )
        for row in rows
    ]
```

`backend/app/schemas.py`에 추가:

```python
class MmcaRoomStatus(BaseModel):
    space_code: str
    space_nm: str | None
    congestion_nm: str | None
    observed_at: str
```

`main.py`에 라우터 등록 한 줄 추가 (기존 congestion/prediction/stream 라우터와 동일 패턴).

### 2.4 프론트엔드 페이지 — `src/pages/`

- `HomePage.tsx`: `VENUES.map`으로 카드 렌더링, 각 카드는 `<Link to={venue.path}>`
- `NationalMuseumPage.tsx`: 현재 `App.tsx` 본문(useEffect 데이터 로딩 + `CongestionCard`/`PredictionChart`/`DailyLogTable`)을 그대로 이동. 로직 변경 없음.
- `MmcaPage.tsx`: 마운트 시 `fetchMmcaRooms()` 호출, `setInterval(60_000)`으로 재조회(언마운트 시 clear). 8개 `RoomCongestionCard` 렌더링.

### 2.5 컴포넌트 — `src/components/RoomCongestionCard.tsx`

```tsx
export function RoomCongestionCard({ room }: { room: MmcaRoomStatus }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-sm text-gray-500">{room.space_nm ?? room.space_code}</p>
      <p className="text-xl font-bold">{room.congestion_nm ?? "정보 없음"}</p>
      <p className="text-xs text-gray-400">
        마지막 갱신: {new Date(room.observed_at).toLocaleTimeString("ko-KR")}
      </p>
    </div>
  );
}
```

`congestion_nm`이 없는 방(수집 실패 또는 전시 2개 미만)은 "정보 없음"으로 표시해 빈 칸 대신 명시적 상태를 보여준다.

## 3. 데이터 흐름 & 폴백

- **국중박 페이지**: 기존과 완전히 동일 (SSE 실시간 갱신, 캐시 폴백, 503 처리) — 코드 위치만 `pages/`로 이동.
- **국현미 페이지**: `/mmca/rooms`가 503이면(수집 데이터가 아직 없음) 국중박 패턴과 동일한 "불러오는 중" → 에러 안내로 처리. 폴링 중 fetch 실패는 마지막으로 받은 데이터를 유지하고 조용히 다음 주기에 재시도(국중박 SSE 재연결과 같은 철학 — 일시적 실패로 화면을 비우지 않음).
- **영업시간 외**: 백엔드가 수집을 멈추므로 `/mmca/rooms`는 영업 종료 시점의 마지막 값을 계속 반환한다. `observed_at` 표시로 사용자가 데이터 신선도를 판단.

## 4. 테스트

- 백엔드 `test_routes_mmca.py`: 빈 테이블 503, 8개 방 데이터가 있을 때 `space_code`별 최신 1건만 반환하는지(같은 방에 여러 행이 있어도 최신 것만) 확인 — 기존 `test_routes_congestion.py` 패턴 재사용.
- 프론트 `RoomCongestionCard.test.tsx`: 등급 표시, `congestion_nm` null일 때 "정보 없음" 표시.
- 프론트 `MmcaPage.test.tsx`: fetch 성공 시 8개 카드 렌더링, 503/에러 시 안내 문구.
- 라우팅 스모크 테스트: `/`에서 두 미술관 링크 렌더링, `/venues/mmca` 진입 시 `MmcaPage` 렌더링 (기존 `frontend/e2e/congestion.spec.ts`에 케이스 추가 또는 별도 `App.routing.test.tsx`).

## 5. 의사결정 요약

| 항목 | 결정 | 이유 |
|---|---|---|
| 미술관 선택 UI | 홈 화면 카드 → 개별 라우트 (탭 아님) | URL 딥링크/북마크 가능, 미술관 수가 늘어도 카드 리스트 UX가 자연히 확장됨 |
| 라우팅 라이브러리 | `react-router-dom` 신규 도입 | 라우트가 3개뿐이라도 향후 중첩 라우트·쿼리 파라미터가 필요해질 가능성 대비, 직접 구현보다 검증된 라이브러리가 엣지케이스에 안전 |
| 국현미 페이지 범위 | 전시실별 현재 등급만 | 예측/일별 로그는 데이터 형태(등급 텍스트, 인구수 아님)가 국중박과 근본적으로 달라 새 설계가 필요 — 이번 범위 아님 |
| 국현미 실시간성 | 60초 폴링 (SSE 아님) | 백엔드에 MMCA용 캐시/pub-sub이 없음. 6분 수집 주기 대비 60초 폴링이면 충분히 최신 |
| `/mmca/rooms` 캐싱 | 없음, DB 직접 조회 | 방 8개, 6분에 한 번만 갱신되는 저빈도 데이터라 캐시 계층 추가는 과함 |
| 국중박 기존 코드 | `App.tsx` → `pages/NationalMuseumPage.tsx`로 이동만, 로직 무변경 | 기존 동작 회귀 위험 최소화 |
