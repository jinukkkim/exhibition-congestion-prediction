from pydantic import BaseModel


class CurrentCongestion(BaseModel):
    observed_at: str
    congest_level: str
    population_avg: float


class CongestionHistoryPoint(BaseModel):
    observed_at: str
    population_avg: float


class DailyLogPoint(BaseModel):
    observed_at: str
    congest_level: str
    population_min: int
    population_max: int
    male_ppltn_rate: float | None = None
    female_ppltn_rate: float | None = None
    ppltn_rate_0: float | None = None
    ppltn_rate_10: float | None = None
    ppltn_rate_20: float | None = None
    ppltn_rate_30: float | None = None
    ppltn_rate_40: float | None = None
    ppltn_rate_50: float | None = None
    ppltn_rate_60: float | None = None
    ppltn_rate_70: float | None = None
    resnt_ppltn_rate: float | None = None
    non_resnt_ppltn_rate: float | None = None
