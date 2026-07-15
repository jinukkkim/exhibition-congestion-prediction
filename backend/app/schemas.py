from pydantic import BaseModel


class CurrentCongestion(BaseModel):
    observed_at: str
    congest_level: str
    population_avg: float


class CongestionHistoryPoint(BaseModel):
    observed_at: str
    population_avg: float
