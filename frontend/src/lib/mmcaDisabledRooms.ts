// Rooms whose card/page stays visible but shows "서비스 예정" instead of
// live data — mirrors the backend's MMCA_DISABLED_SPACE_CODES
// (backend/app/config.py). The collector no longer polls these, so any
// congestion_nm shown for them would just be frozen, stale data.
export const DISABLED_MMCA_SPACE_CODES = new Set(["MMCA-SPACE-4001", "MMCA-SPACE-2008"]);
