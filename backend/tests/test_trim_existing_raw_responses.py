import json

from scripts.trim_existing_raw_responses import trim_body

FULL_BODY = json.dumps(
    {
        "list_total_count": 1,
        "RESULT": {"RESULT.CODE": "INFO-000"},
        "CITYDATA": {
            "AREA_NM": "국립중앙박물관·용산가족공원",
            "LIVE_PPLTN_STTS": [{"AREA_CONGEST_LVL": "보통"}],
            "WEATHER_STTS": [{"TEMP": "30.2", "FCST24HOURS": [{"FCST_DT": "202608141100"}]}],
            "CHARGER_STTS": [{"STAT_NM": "국립 중앙 박물관"}],
            "PRK_STTS": [{"PRK_NM": "가족공원 부설주차장"}],
        },
    },
    ensure_ascii=False,
)


def test_trim_body_keeps_only_the_archived_sections():
    trimmed = json.loads(trim_body(FULL_BODY))

    assert set(trimmed) == {"LIVE_PPLTN_STTS", "WEATHER_STTS"}
    assert trimmed["WEATHER_STTS"][0] == {"TEMP": "30.2"}


def test_trim_body_reports_already_trimmed_rows():
    """Rows collected after the collector change have no CITYDATA wrapper."""
    already = trim_body(json.dumps({"LIVE_PPLTN_STTS": [{"AREA_CONGEST_LVL": "보통"}]}))

    assert already is None
