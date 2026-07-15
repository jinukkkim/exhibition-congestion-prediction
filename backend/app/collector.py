import httpx

from app.cache import set_latest
from app.config import settings
from app.db import SessionLocal
from app.models import RawCongestion
from app.seoul_api import CongestionReading, fetch_congestion


def collect_once(session_factory=SessionLocal) -> CongestionReading:
    with httpx.Client() as client:
        reading = fetch_congestion(client, settings.seoul_area_name, settings.seoul_api_key)

    with session_factory() as session:
        session.add(
            RawCongestion(
                observed_at=reading.observed_at,
                congest_level=reading.congest_level,
                population_min=reading.population_min,
                population_max=reading.population_max,
            )
        )
        session.commit()

    set_latest(reading)
    return reading
