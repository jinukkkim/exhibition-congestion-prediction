# MMCA 전시실 이름 결측 보완 — 설계

- 날짜: 2026-07-28 (개정: 2026-07-28 저녁)
- 배경: `space_nm`은 폴링마다 data.go.kr MMCA API에서 그대로 받아오는 값인데, 같은 전시실이라도 어느 폴링에서는 null로 온다(로컬 DB 확인 결과 17개 space_code 중 9개가 최신 row 기준 null). 현재 `/mmca/rooms`, `/mmca/daily`는 각 시점의 row를 그대로 반환하고, 프론트는 `room.space_nm ?? spaceCode`로 방어만 하고 있어 하필 최신 폴링이 null이면 카드/표에 `MMCA-SPACE-2001` 같은 코드가 그대로 노출된다.
- **개정 사유**: 최초 버전은 "DB에 쌓인 과거 non-null `space_nm`을 재사용"하는 쿼리 기반 fallback으로 구현됐다(아래 3절 참고, 커밋 `bdafece`/`c6419fb`/`9c2d8c5`). 이후 사용자가 MMCA 공식 전시실 코드표(`전시실코드_v1.xlsx`)를 제공했고, 여기엔 17개 space_code 전부의 실명이 정확히 나와 있었다(이미 관측된 8개 이름과 100% 일치, 나머지 9개도 신뢰 가능한 출처로 확보). 전시실 이름은 사실상 불변값이므로, 정적 매핑을 배제했던 최초 이유("8~17개 값을 직접 조사해야 하는 유지보수 부담")가 사라졌다 — 이미 조사가 끝났기 때문. 그래서 쿼리 기반 fallback을 정적 딕셔너리로 교체했다(커밋 `d7c87e5`).

## 1. 목표 & 범위

**무엇을 만드나**: `space_nm`이 null인 row에 대해, space_code → 한글 이름 정적 매핑(`MMCA_SPACE_NAMES`)으로 채워서 응답한다.

### 포함 (In Scope)
- `backend/app/config.py`: `MMCA_SPACE_NAMES: dict[str, str]` — 17개 space_code 전체를 다루는 정적 매핑, 출처는 `전시실코드_v1.xlsx`
- `backend/app/routes/mmca.py`: `/mmca/rooms`, `/mmca/daily` 양쪽에서 `row.space_nm or MMCA_SPACE_NAMES.get(code)` 적용 — 두 엔드포인트 모두 사용자가 보는 화면(카드, 일별 로그 표)에 이름이 노출되므로 일관되게 처리

### 제외 (Out of Scope, YAGNI)
- 쿼리 기반 "최근에 확인된 non-null space_nm" 조회: 정적 매핑이 같은 문제를 쿼리 없이, 그리고 "그 이름이 그 시점에 진짜 알려져 있었는가"라는 역사적 정확성 문제(구 버전 리뷰에서 지적된 한계) 없이 해결
- 프론트의 `?? spaceCode` fallback 제거: 향후 새 전시실이 추가돼 매핑에 없는 space_code가 생기는 경우를 위한 최후 방어선으로 유지
- `MMCA_SPACE_NAMES`를 DB나 외부 설정 파일로 분리: 17개 고정값이고 코드 자체가 변경 이력을 git으로 추적하므로 파일 하나(`config.py`)로 충분

## 2. 아키텍처

```
[/mmca/rooms, /mmca/daily] --row.space_nm--> [raw_mmca_congestion]
        |
        v
row.space_nm or MMCA_SPACE_NAMES.get(space_code)   # 그래도 없으면 None → 프론트가 spaceCode로 fallback
```

쿼리가 전혀 추가되지 않는다 — 딕셔너리 조회이므로 요청당 비용은 무시할 수준.

## 3. 백엔드 구현

`backend/app/config.py`에 정적 매핑 추가:

```python
# official MMCA space-code -> room-name table (전시실코드_v1.xlsx). Room
# names for a given code don't change, so this is hardcoded rather than
# read live off the (sometimes null) polling API.
MMCA_SPACE_NAMES: dict[str, str] = {
    "MMCA-SPACE-1001": "1전시실",
    "MMCA-SPACE-1002": "2전시실",
    "MMCA-SPACE-1003": "3전시실",
    "MMCA-SPACE-1004": "4전시실",
    "MMCA-SPACE-1005": "5전시실",
    "MMCA-SPACE-1006": "6전시실",
    "MMCA-SPACE-1007": "7전시실",
    "MMCA-SPACE-1008": "8전시실",
    "MMCA-SPACE-2001": "1전시실",
    "MMCA-SPACE-2002": "2전시실",
    "MMCA-SPACE-2003": "3전시실",
    "MMCA-SPACE-2004": "4전시실",
    "MMCA-SPACE-2005": "5전시실",
    "MMCA-SPACE-2006": "6전시실",
    "MMCA-SPACE-2007": "1원형전시실",
    "MMCA-SPACE-2008": "1층 어린이미술관",
    "MMCA-SPACE-4001": "1전시실",
}
```

`backend/app/routes/mmca.py`에서 두 엔드포인트 모두 응답 생성 시 다음 한 줄로 적용:

```python
space_nm=row.space_nm or MMCA_SPACE_NAMES.get(row.space_code)
```

(`/mmca/daily`는 버킷에 room이 아예 없는 경우도 같은 방식으로 처리 — `congestion_nm`은 실제 측정값 결측이라 `None`을 유지하지만, `space_nm`은 라벨이라 매핑에서 채워진다.)

## 4. 테스트

- `test_routes_mmca.py`: 최신 row가 null인 space_code에 대해 `/mmca/rooms`, `/mmca/daily` 둘 다 정적 매핑의 이름을 반환하는지. 버킷에 room이 아예 없는 경우도 매핑 이름이 채워지고 `congestion_nm`만 null인지
- 프론트 테스트는 변경 없음 — 이미 있는 `?? spaceCode` fallback 테스트가 "매핑에도 없는 새 space_code" 케이스를 계속 커버

## 5. 의사결정 요약

| 항목 | 결정 | 이유 |
|---|---|---|
| 이름 출처 | 정적 매핑(`MMCA_SPACE_NAMES`), 출처는 공식 전시실 코드표 | 전시실 이름은 불변값이고 전수 조사가 이미 끝나서, 쿼리보다 단순하고 역사적 정확성 문제도 없음 |
| (구) 쿼리 기반 fallback | 폐기 | 정적 매핑이 상위 호환 — 쿼리 비용 없음, "그 시점에 이름이 알려져 있었는가" 문제 자체가 사라짐 |
| 적용 범위 | `/mmca/rooms` + `/mmca/daily` 둘 다 | 카드와 일별 로그 표 모두 사용자가 보는 화면이라 일관성 필요 |
| 프론트 fallback | 유지 | 매핑에 없는 신규 전시실을 위한 최후 방어선 |
| 매핑 저장 위치 | `config.py`의 모듈 상수 (DB/외부 파일 아님) | 17개 고정값, git으로 변경 이력 추적 충분 |
