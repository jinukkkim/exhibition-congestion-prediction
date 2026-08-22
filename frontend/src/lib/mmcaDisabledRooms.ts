// Rooms whose card/page stays visible but shows "서비스 예정" instead of
// live data — mirrors the backend's MMCA_DISABLED_SPACE_CODES
// (backend/app/config.py). The collector no longer polls these, so any
// congestion_nm shown for them would just be frozen, stale data.
export const DISABLED_MMCA_SPACE_CODES = new Set(["MMCA-SPACE-4001", "MMCA-SPACE-2008"]);

// 전시실 전부가 disabled 인 관 — 방 목록을 받아봐야 결론이 "서비스 예정"으로
// 정해져 있으므로, 목록을 기다리는 동안의 기본 답으로 쓴다. 덕수궁관은
// 백엔드 settings.mmca_venue_space_codes 상 MMCA-SPACE-4001 한 칸뿐이고 그것이
// 위 목록에 있다.
//
// 덮어쓰기가 아니라 기본값이다: 목록이 도착하면 그 내용이 판정을 대신하므로,
// 수집이 재개되면 이 상수를 지우지 않아도 화면은 곧 정상으로 돌아온다.
export const DISABLED_MMCA_VENUES = new Set(["deoksugung"]);
