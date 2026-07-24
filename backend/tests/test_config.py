import os

def test_settings_reads_env(monkeypatch):
    monkeypatch.setenv("SEOUL_API_KEY", "test-key")
    monkeypatch.setenv("DATABASE_URL", "sqlite:///:memory:")
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/1")

    from app.config import Settings
    settings = Settings()

    assert settings.seoul_api_key == "test-key"
    assert settings.seoul_area_name == "국립중앙박물관·용산가족공원"
    assert settings.database_url == "sqlite:///:memory:"
    assert settings.redis_url == "redis://localhost:6379/1"


def test_settings_reads_mmca_env(monkeypatch):
    monkeypatch.setenv("SEOUL_API_KEY", "test-key")
    monkeypatch.setenv("MMCA_API_KEY", "mmca-test-key")
    monkeypatch.setenv("DATABASE_URL", "sqlite:///:memory:")
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/1")

    from app.config import Settings
    settings = Settings()

    assert settings.mmca_api_key == "mmca-test-key"
    assert settings.mmca_space_codes == [
        "MMCA-SPACE-1001",
        "MMCA-SPACE-1002",
        "MMCA-SPACE-1003",
        "MMCA-SPACE-1004",
        "MMCA-SPACE-1005",
        "MMCA-SPACE-1006",
        "MMCA-SPACE-1007",
        "MMCA-SPACE-1008",
    ]
