# MMCA 전시실 이름 결측 보완 — 설계

- 날짜: 2026-07-28
- 배경: `space_nm`은 폴링마다 data.go.kr MMCA API에서 그대로 받아오는 값인데, 같은 전시실이라도 어느 폴링에서는 null로 온다(로컬 DB 확인 결과 17개 space_code 중 9개가 최신 row 기준 null). 현재 `/mmca/rooms`, `/mmca/daily`는 각 시점의 row를 그대로 반환하고, 프론트는 `room.space_nm ?? spaceCode`로 방어만 하고 있어 하필 최신 폴링이 null이면 카드/표에 `MMCA-SPACE-2001` 같은 코드가 그대로 노출된다. 정적 이름 매핑 테이블은 코드베이스 어디에도 없다(백엔드/프론트/테스트 전수 확인).

## 1. 목표 & 범위

**무엇을 만드나**: 어떤 space_code에 대해 과거 폴링 중 한 번이라도 실명(non-null `space_nm`)이 온 적 있으면, 최신 row가 null이어도 그 이름을 채워서 응답한다.

### 포함 (In Scope)
- `backend/app/routes/mmca.py`: space_code별 "가장 최근에 확인된 non-null space_nm"을 한 번의 쿼리로 가져오는 헬퍼 추가
- `/mmca/rooms`, `/mmca/daily` 양쪽에 적용 — 두 엔드포인트 모두 사용자가 보는 화면(카드, 일별 로그 표)에 이름이 노출되므로 일관되게 처리

### 제외 (Out of Scope, YAGNI)
- space_code → 한글 이름 정적 매핑 테이블: 유지보수 부담(8~17개 값을 직접 조사/갱신)만 생기고, 실제 API가 결국 이름을 주므로 불필요
- "이 이름이 언제부터 유효했는지" 같은 시간 인과관계 추적: 전시실 이름은 사실상 고정값이라 어느 시점에 알려졌든 상관없이 최신 known 값이면 충분
- 프론트의 `?? spaceCode` fallback 제거: 정말 한 번도 이름이 온 적 없는 신규 전시실을 위한 최후 방어선으로 유지

## 2. 아키텍처

```
[/mmca/rooms, /mmca/daily] --group-by space_code, latest non-null space_nm--> [raw_mmca_congestion]
        |
        v
row.space_nm or last_known_names.get(row.space_code)   # 그래도 없으면 None → 프론트가 spaceCode로 fallback
```

## 3. 백엔드 구현

```python
def _last_known_names(session: Session, codes: list[str]) -> dict[str, str]:
    latest_named_ids = [
        row[0]
        for row in session.query(func.max(RawMmcaCongestion.id))
        .filter(
            RawMmcaCongestion.space_code.in_(codes),
            RawMmcaCongestion.space_nm.isnot(None),
        )
        .group_by(RawMmcaCongestion.space_code)
        .all()
    ]
    rows = session.query(RawMmcaCongestion).filter(RawMmcaCongestion.id.in_(latest_named_ids)).all()
    return {row.space_code: row.space_nm for row in rows}
```

- `/mmca/rooms`: 기존 `latest_ids` 쿼리와 나란히 `_last_known_names(session, codes)` 한 번 더 호출, `space_nm=row.space_nm or last_known.get(row.space_code)`
- `/mmca/daily`: 같은 헬퍼를 하루치 rows 조회와 함께 한 번 호출(버킷마다 반복 쿼리하지 않음), 각 `MmcaDailyRoom` 생성 시 동일하게 `or last_known.get(code)` 적용
- 쿼리는 요청당 1회 추가(기존 `latest_ids`와 동일한 group-by-max 패턴 재사용)이므로 성능 영향 무시 가능

## 4. 테스트

- `test_routes_mmca.py`: 최신 row가 null이고 과거 row에 이름이 있는 space_code에 대해 `/mmca/rooms`, `/mmca/daily` 둘 다 그 이름을 반환하는지. 한 번도 이름이 없었던 space_code는 여전히 `space_nm: null` 반환하는지(프론트 fallback 영역, 회귀 방지)
- 프론트 테스트는 변경 없음 — 이미 있는 `?? spaceCode` fallback 테스트가 "이름이 정말 없을 때"를 계속 커버

## 5. 의사결정 요약

| 항목 | 결정 | 이유 |
|---|---|---|
| 이름 출처 | DB에 이미 쌓인 과거 non-null `space_nm` 재사용 | 정적 매핑 유지보수 없이, 실제 API가 이미 준 데이터를 활용 |
| 적용 범위 | `/mmca/rooms` + `/mmca/daily` 둘 다 | 카드와 일별 로그 표 모두 사용자가 보는 화면이라 일관성 필요 (사용자 확인) |
| 시간 인과관계 | 고려 안 함, 그냥 최신 known 값 사용 | 전시실 이름은 사실상 불변값 |
| 프론트 fallback | 유지 | 진짜 한 번도 이름이 없었던 신규 전시실의 최후 방어선 |
