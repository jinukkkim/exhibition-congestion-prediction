from datetime import datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app.models import RawCongestion


def test_raw_congestion_round_trip():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    with Session() as session:
        row = RawCongestion(
            observed_at=datetime(2026, 7, 15, 14, 30),
            congest_level="보통",
            population_min=1000,
            population_max=2000,
        )
        session.add(row)
        session.commit()

        fetched = session.query(RawCongestion).one()
        assert fetched.congest_level == "보통"
        assert fetched.population_avg == 1500.0
