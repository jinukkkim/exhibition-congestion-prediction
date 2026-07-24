from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    seoul_api_key: str
    seoul_area_name: str = "국립중앙박물관·용산가족공원"
    mmca_api_key: str
    mmca_space_codes: list[str] = [f"MMCA-SPACE-100{i}" for i in range(1, 9)]
    database_url: str = "sqlite:///./congestion.db"
    redis_url: str = "redis://localhost:6379/0"

    model_config = SettingsConfigDict(env_file=".env")


settings = Settings()
