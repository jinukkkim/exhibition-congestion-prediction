import json
from datetime import date
from pathlib import Path

import holidays
from pydantic_settings import BaseSettings, SettingsConfigDict

# 한국 공휴일 달력. 예측 배치(오늘 + 6일의 is_holiday 플래그)와
# scripts/purge_out_of_hours_mmca.py 가 공유한다 — 걷어낸 prediction/model.py 에
# 얹혀 있던 것을 두 소비자 어느 쪽도 아닌 자리로 옮겼다.
KR_HOLIDAYS = holidays.country_holidays("KR")

# 미술관 휴관일 달력. KR_HOLIDAYS 와 **다른 것**이다 — 저쪽은 예측 배치의
# is_holiday 피처가 쓰는 관공서 공휴일이고, 이쪽은 관이 실제로 문을 닫는 날이다.
# 근로자의날처럼 공휴일이지만 미술관이 여는 날이 있어 겹치지 않는다.
#
# 프론트 src/lib/museumCalendar.ts 가 같은 파일을 import 한다. 규칙은 양쪽에
# 각각 있지만(짧다) 목록은 여기 하나뿐이라 어긋날 수 없다.
_CALENDAR = json.loads(
    (Path(__file__).resolve().parents[2] / "shared" / "museum-holidays.json").read_text(
        encoding="utf-8"
    )
)

MUSEUM_PUBLIC_HOLIDAYS: frozenset[str] = frozenset(_CALENDAR["publicHolidays"])
MUSEUM_CLOSED_DAYS: dict[str, frozenset[str]] = {
    venue: frozenset(days) for venue, days in _CALENDAR["closed"].items()
}
MUSEUM_CALENDAR_CHECKED_THROUGH: date = date.fromisoformat(_CALENDAR["checkedThrough"])

# Official MMCA space-code -> room-name table (전시실코드_v1.xlsx). Room
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


class Settings(BaseSettings):
    seoul_api_key: str
    seoul_area_name: str = "국립중앙박물관·용산가족공원"
    mmca_api_key: str
    mmca_venue_space_codes: dict[str, list[str]] = {
        "seoul": [f"MMCA-SPACE-100{i}" for i in range(1, 9)],
        "gwacheon": [f"MMCA-SPACE-200{i}" for i in range(1, 9)],
        "deoksugung": ["MMCA-SPACE-4001"],
    }
    database_url: str = "sqlite:///./congestion.db"
    redis_url: str = "redis://localhost:6379/0"
    # Where deploy/backup_db.sh lands its snapshots. Only read here, for the
    # freshness figure /health/collection reports — nothing writes it.
    # Absent on dev machines, which is why that figure is nullable.
    backup_dir: str = "/home/ubuntu/backups"
    # Caddy 가 쓰는 접근 로그. /analytics/visits 가 방문 집계를 여기서 읽는다
    # (deploy/Caddyfile 의 log 블록과 같은 경로여야 한다). 개발 머신에는 없고,
    # 없으면 트래픽 0 으로 읽힌다.
    caddy_access_log: str = "/var/log/caddy/access.log"

    model_config = SettingsConfigDict(env_file=".env")


settings = Settings()
