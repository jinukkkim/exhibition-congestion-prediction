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


def test_raw_congestion_stores_population_breakdown():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    with Session() as session:
        row = RawCongestion(
            observed_at=datetime(2026, 7, 15, 14, 30),
            congest_level="보통",
            population_min=1000,
            population_max=2000,
            male_ppltn_rate=51.8,
            female_ppltn_rate=48.2,
            ppltn_rate_0=3.9,
            ppltn_rate_10=17.8,
            ppltn_rate_20=9.3,
            ppltn_rate_30=12.3,
            ppltn_rate_40=15.7,
            ppltn_rate_50=18.2,
            ppltn_rate_60=13.2,
            ppltn_rate_70=9.8,
            resnt_ppltn_rate=45.1,
            non_resnt_ppltn_rate=54.9,
        )
        session.add(row)
        session.commit()

        fetched = session.query(RawCongestion).one()
        assert fetched.male_ppltn_rate == 51.8
        assert fetched.resnt_ppltn_rate == 45.1


def test_raw_congestion_breakdown_fields_are_nullable():
    """Rows collected before this feature existed have no breakdown data."""
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
        assert fetched.male_ppltn_rate is None
