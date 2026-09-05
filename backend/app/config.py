import holidays
from pydantic_settings import BaseSettings, SettingsConfigDict

# 한국 공휴일 달력. 예측 배치(오늘 + 6일의 is_holiday 플래그)와
# scripts/purge_out_of_hours_mmca.py 가 공유한다 — 걷어낸 prediction/model.py 에
# 얹혀 있던 것을 두 소비자 어느 쪽도 아닌 자리로 옮겼다.
KR_HOLIDAYS = holidays.country_holidays("KR")

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

    model_config = SettingsConfigDict(env_file=".env")


settings = Settings()
