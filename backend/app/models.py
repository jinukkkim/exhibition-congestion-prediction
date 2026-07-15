from datetime import datetime

from sqlalchemy import DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class RawCongestion(Base):
    __tablename__ = "raw_congestion"

    id: Mapped[int] = mapped_column(primary_key=True)
    observed_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    congest_level: Mapped[str] = mapped_column(String)
    population_min: Mapped[int] = mapped_column(Integer)
    population_max: Mapped[int] = mapped_column(Integer)

    @property
    def population_avg(self) -> float:
        return (self.population_min + self.population_max) / 2
