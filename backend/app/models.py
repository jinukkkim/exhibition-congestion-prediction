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
    # Trimmed /citydata response body — see CongestionReading.raw_response.
    # deferred: existing read paths (history/daily routes, the daily batch)
    # select every column and don't use this one, so eagerly loading a ~7KB
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
    # No raw_response here — see MmcaCongestionReading. The column that used to
    # hold it is dropped by scripts/migrate_drop_mmca_raw_response.py.


class ForecastCongestion(Base):
    """서울시's own congestion forecast, one row per revision.

    Bitemporal on purpose: a forecast for a given target_at is reissued and
    revised through the day (10 revisions for a single afternoon slot is
    typical), and how far ahead it was issued dominates how accurate it was.
    Collapsing to one row per target_at would throw away exactly the axis a
    forecast-vs-actual comparison needs, and backtesting our own model against
    the observed value instead of the forecast that was knowable at the time
    is straightforward look-ahead bias.

    Only revisions are stored — the same forecast repeats on all 288 daily
    polls, so 97.8% of what the API hands us is a duplicate of the last row.
    """

    __tablename__ = "forecast_congestion"

    id: Mapped[int] = mapped_column(primary_key=True)
    # When we first saw this value, i.e. the poll's observed_at.
    issued_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    # The hour the forecast is about.
    target_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    congest_level: Mapped[str | None] = mapped_column(String, nullable=True)
    population_min: Mapped[int | None] = mapped_column(Integer, nullable=True)
    population_max: Mapped[int | None] = mapped_column(Integer, nullable=True)


class ForecastWeather(Base):
    """24-hour weather forecast, same revision-only shape as ForecastCongestion."""

    __tablename__ = "forecast_weather"

    id: Mapped[int] = mapped_column(primary_key=True)
    issued_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    target_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    temp: Mapped[float | None] = mapped_column(Float, nullable=True)
    # "-" when there's none, a millimetre reading otherwise — kept verbatim
    # rather than coerced, since the API mixes both into one field.
    precipitation: Mapped[str | None] = mapped_column(String, nullable=True)
    precpt_type: Mapped[str | None] = mapped_column(String, nullable=True)
    rain_chance: Mapped[float | None] = mapped_column(Float, nullable=True)
    sky_stts: Mapped[str | None] = mapped_column(String, nullable=True)
