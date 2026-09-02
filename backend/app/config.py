from pydantic_settings import BaseSettings, SettingsConfigDict

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

# Rooms whose page/card stays visible but shows "서비스 예정" instead of live
# data — the collector skips these entirely. Deoksugung (only
# MMCA-SPACE-4001) and Gwacheon's children's museum are disabled; everything
# else still polls normally.
#
# The reason was quota: at the old 1,000-call/day cap these two would not fit
# in the 10-minute poll. The cap is now 100,000/day, so nothing here is paying
# for itself any more. Turning them on is a frontend change as much as a
# backend one (App.tsx redirects the Deoksugung page away, the cards say
# 서비스 예정, venues.ts carries a placeholder earliestDate), so it is its own
# piece of work rather than a line deleted here.
MMCA_DISABLED_SPACE_CODES: set[str] = {"MMCA-SPACE-4001", "MMCA-SPACE-2008"}


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
