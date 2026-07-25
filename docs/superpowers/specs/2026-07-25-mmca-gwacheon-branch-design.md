# MMCA 과천관 추가 — 설계

- 날짜: 2026-07-25
- 배경: 서울관 8실은 어제(7/24)부터 오늘(7/25)까지 계속 `resultCode: 0002`(진행 중인 전시 없음)로 데이터가 안 뜬다. 반면 오늘 라이브 API로 확인한 결과 **과천관(`MMCA-SPACE-2001~2008`)과 청주관(`MMCA-SPACE-3001~`)은 이미 실제 혼잡도 데이터를 반환 중**이다. 사용자가 제공한 `전시실코드_v1.xlsx`로 관별 space_code 전체 매핑을 확인했고, 이 중 과천관만 이번 범위로 추가한다.

## 1. 목표 & 범위

**무엇을 만드나**: 과천관 8개 전시실을 수집 파이프라인에 추가하고, 홈 화면 미술관 목록과 전용 페이지를 신설한다.

### 포함 (In Scope)
- 과천관 8개 전시실(`MMCA-SPACE-2001~2008`) 수집 대상에 추가
- `GET /mmca/rooms`에 관 구분 쿼리파라미터 추가 (서울/과천 데이터 분리 반환)
- 홈 화면 `VENUES`에 과천 항목 추가
- 과천 전용 페이지(`/venues/mmca-gwacheon`) 신설 — 기존 `MmcaPage`를 관 파라미터화해서 재사용
- 폴링 간격 6분 → 12분 조정 (16실로 늘어난 API 호출량이 1,000건/일 한도를 넘지 않도록)

### 제외 (Out of Scope, YAGNI)
- 청주관·덕수궁관 — 사용자가 이번엔 과천만 요청함. 코드는 `mmca_venue_space_codes`에 항목만 추가하면 확장 가능한 구조로 만들어 둠. **(→ 같은 PR 내에서 덕수궁관이 추가됨, 하단 "추가 변경" 참고)**
- 예측 모델, SSE 실시간 스트림 — 기존 MMCA 서울 페이지도 60초 폴링만 쓰고 있고 과천도 동일 패턴을 그대로 따름.
- 3개 이상 관을 위한 홈 화면 레이아웃 개선 — 카드 리스트로 충분(기존 venue-pages 설계와 동일 근거).

## 2. 아키텍처

기존 서울관 파이프라인·페이지의 구조를 그대로 재사용하고, "관(venue)"을 1급 개념으로 승격해 서울/과천이 같은 코드 경로를 공유하도록 파라미터화한다.

### 2.1 설정 — `app/config.py`

기존 평면 리스트 `mmca_space_codes`를 관별 딕셔너리로 교체한다.

```python
mmca_venue_space_codes: dict[str, list[str]] = {
    "seoul": [f"MMCA-SPACE-100{i}" for i in range(1, 9)],
    "gwacheon": [f"MMCA-SPACE-200{i}" for i in range(1, 9)],
}
```

이 딕셔너리가 수집 대상 코드와 API 필터링 기준의 단일 소스가 된다.

### 2.2 수집기 — `app/collector.py`

`collect_mmca_once`가 순회하는 목록을 `mmca_venue_space_codes`의 전체 값(두 관 코드 16개 합집합)으로 바꾼다. 방 하나 실패해도 나머지는 계속 수집하는 기존 동작은 그대로 유지.

**가정**: 과천관 영업시간 정보가 별도로 확인되지 않아, 기존 `_is_seoul_branch_open` 게이트(월화목금일 10–18시, 수토 10–21시)를 두 관 모두에 그대로 적용한다. 과천관이 실제로 다른 시간에 운영된다면(예: 폐관일이 다름) 이 게이트 때문에 데이터가 비게 될 수 있음 — 실 데이터를 보고 나중에 조정.

폴링 간격은 6분 → **12분**으로 변경(3절 참조).

### 2.3 API 라우트 — `app/routes/mmca.py`

`venue` 쿼리파라미터를 필수로 받는다.

```python
@router.get("/mmca/rooms", response_model=list[MmcaRoomStatus])
def mmca_rooms(venue: str) -> list[MmcaRoomStatus]:
    codes = settings.mmca_venue_space_codes.get(venue)
    if codes is None:
        raise HTTPException(status_code=400, detail=f"unknown venue: {venue}")
    # 기존 로직과 동일하되 space_code IN codes 필터만 추가
    ...
```

`agnc_nm` DB 컬럼은 필터 기준으로 쓰지 않는다 — 전시가 없어 `resultCode: 0002`인 방은 `agnc_nm`이 `null`로 저장되므로, 그 방을 관별 목록에서 누락시키게 된다.

기존 서울 페이지 호출도 `venue=seoul`을 명시하도록 같이 바뀌는 breaking change.

### 2.4 프론트엔드

- `frontend/src/venues.ts`: `{ id: "mmca-gwacheon", name: "국립현대미술관 과천관", path: "/venues/mmca-gwacheon" }` 추가.
- `frontend/src/pages/MmcaPage.tsx`: `venue`(`"seoul" | "gwacheon"`)와 `title` prop을 받도록 일반화. 내부 로직(폴링, 렌더링)은 변경 없음, `fetchMmcaRooms(venue)` 호출과 헤더 텍스트만 prop 기반으로 바뀜.
- `frontend/src/api/mmca.ts`: `fetchMmcaRooms(venue: string)`로 시그니처 변경, `/mmca/rooms?venue=${venue}` 호출.
- `frontend/src/App.tsx`: 라우트 2개가 같은 `MmcaPage`를 다른 prop으로 렌더링.
  ```tsx
  <Route path="/venues/mmca-seoul" element={<MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />} />
  <Route path="/venues/mmca-gwacheon" element={<MmcaPage venue="gwacheon" title="국립현대미술관 과천관 혼잡도" />} />
  ```
- `RoomCongestionCard`는 변경 없이 재사용.

## 3. 폴링 주기 재계산

16실(서울 8 + 과천 8), 1,000건/일 한도 기준으로 재계산.

| 간격 | 평일(8h, 월화목금일) | 수·토(11h) | 한도 초과 여부 |
|---|---|---|---|
| 6분(기존) | 1,296건 | 1,776건 | 초과 |
| 12분(신규) | 656건 | 896건 | OK |

12분으로 늘려 여유를 두고, 요일별 분기 없이 상수 하나로 유지하는 기존 단순화 방침도 그대로 따른다.

## 4. 데이터 흐름 & 폴백

- 기존 서울관과 동일: 개별 room 실패는 나머지에 영향 없음, 영업시간 외엔 API 호출 없음, 혼잡도 없음은 에러가 아니라 `congestion_nm=None` 정상 행.
- 신규: `venue` 쿼리파라미터가 없거나 알 수 없는 값이면 API가 400을 반환(프론트는 항상 유효한 값을 명시적으로 보내므로 실제로는 발생하지 않아야 함).

## 5. 테스트

- `test_routes_mmca.py`: `venue=seoul`/`venue=gwacheon` 각각 해당 관 코드만 반환하는지, 잘못된 venue는 400인지 확인.
- `test_collector.py`: `collect_mmca_once`가 16개 코드 전부를 순회하는지(호출 횟수) 확인.
- 프론트: `MmcaPage.test.tsx`에 과천 prop 케이스 추가(또는 기존 서울 케이스를 파라미터화). e2e에 홈 → 과천 페이지 이동 시나리오 한 개 추가.

## 6. 의사결정 요약

| 항목 | 결정 | 이유 |
|---|---|---|
| 관 분리 방식 | 백엔드 설정의 고정 매핑 + `venue` 쿼리파라미터 | `agnc_nm`은 전시 없을 때 null이라 필터 기준으로 못 씀 |
| 폴링 간격 | 6분 → 12분 | 16실로 늘어난 호출량이 1,000건/일 한도를 넘지 않게 |
| 영업시간 게이트 | 서울관과 동일한 게이트 재사용(가정) | 과천관 영업시간 정보 미확인, 실 데이터 보고 추후 조정 |
| 청주관·덕수궁관 | 이번 범위 제외(→ 덕수궁관은 같은 PR 내에서 추가됨) | 사용자가 과천만 명시적으로 요청, 구조는 확장 가능하게 유지 |
| MmcaPage 컴포넌트 | 관 파라미터화해서 재사용(신규 파일 아님) | 서울/과천 페이지가 로직 100% 동일, 중복 파일 방지 |

## 7. 추가 변경 — 덕수궁관 (같은 PR 내 후속 작업)

당초 범위(§1)에서는 제외했으나, 같은 PR 작업 중 사용자 요청으로 덕수궁관 1개실을 추가했다.

- 전시실 코드: `MMCA-SPACE-4001` (1개실). `전시실코드_v1.xlsx` 기준 확인.
- 폴링 간격: 12분 → 15분 재조정 (17실로 늘어난 호출량이 1,000건/일 한도 내에 여유를 갖도록).
- 영업시간: 서울관과 다름 — 화·목·금·일 10:00–18:00, 수·토 10:00–21:00, **매주 월요일 휴무**. 코드 리뷰 지적사항(§6 "영업시간 게이트" 행)에 따라 관별 휴무일을 반영했다.
- 프론트: `/venues/mmca-deoksugung` 라우트 추가, 과천관과 동일한 패턴.
