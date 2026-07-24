from datetime import datetime

from sqlalchemy import DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class RawCongestion(Base):
    __tablename__ = "raw_congestion"

    id: Mapped[int] = mapped_column(primary_key=True)
    observed_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    congest_level: Mapped[str] = mapped_column(String)
    population_min: Mapped[int] = mapped_column(Integer)
    population_max: Mapped[int] = mapped_column(Integer)
    male_ppltn_rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    female_ppltn_rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    ppltn_rate_0: Mapped[float | None] = mapped_column(Float, nullable=True)
    ppltn_rate_10: Mapped[float | None] = mapped_column(Float, nullable=True)
    ppltn_rate_20: Mapped[float | None] = mapped_column(Float, nullable=True)
    ppltn_rate_30: Mapped[float | None] = mapped_column(Float, nullable=True)
    ppltn_rate_40: Mapped[float | None] = mapped_column(Float, nullable=True)
    ppltn_rate_50: Mapped[float | None] = mapped_column(Float, nullable=True)
    ppltn_rate_60: Mapped[float | None] = mapped_column(Float, nullable=True)
    ppltn_rate_70: Mapped[float | None] = mapped_column(Float, nullable=True)
    resnt_ppltn_rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    non_resnt_ppltn_rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Full /citydata response body, verbatim — see CongestionReading.raw_response.
    # deferred: existing read paths (history/daily routes, the daily batch)
    # select every column and don't use this one, so eagerly loading a ~20KB
    # blob per row on every query would only add cost with no benefit.
    raw_response: Mapped[str | None] = mapped_column(Text, nullable=True, deferred=True)

    @property
    def population_avg(self) -> float:
        return (self.population_min + self.population_max) / 2


class RawMmcaCongestion(Base):
    __tablename__ = "raw_mmca_congestion"

    id: Mapped[int] = mapped_column(primary_key=True)
    observed_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    space_code: Mapped[str] = mapped_column(String, index=True)
    space_nm: Mapped[str | None] = mapped_column(String, nullable=True)
    agnc_nm: Mapped[str | None] = mapped_column(String, nullable=True)
    congestion_nm: Mapped[str | None] = mapped_column(String, nullable=True)
    # Full /congestion response body, verbatim — same deferred-load rationale
    # as RawCongestion.raw_response.
    raw_response: Mapped[str | None] = mapped_column(Text, nullable=True, deferred=True)
