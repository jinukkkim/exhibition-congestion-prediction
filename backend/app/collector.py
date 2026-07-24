import json
import logging
from datetime import datetime, time
from zoneinfo import ZoneInfo

import httpx

from app.cache import set_latest
from app.config import settings
from app.db import SessionLocal
from app.mmca_api import MmcaCongestionReading, fetch_congestion as fetch_mmca_congestion
from app.models import RawCongestion, RawMmcaCongestion
from app.seoul_api import CongestionReading, fetch_congestion

logger = logging.getLogger(__name__)


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
                male_ppltn_rate=reading.male_ppltn_rate,
                female_ppltn_rate=reading.female_ppltn_rate,
                ppltn_rate_0=reading.ppltn_rate_0,
                ppltn_rate_10=reading.ppltn_rate_10,
                ppltn_rate_20=reading.ppltn_rate_20,
                ppltn_rate_30=reading.ppltn_rate_30,
                ppltn_rate_40=reading.ppltn_rate_40,
                ppltn_rate_50=reading.ppltn_rate_50,
                ppltn_rate_60=reading.ppltn_rate_60,
                ppltn_rate_70=reading.ppltn_rate_70,
                resnt_ppltn_rate=reading.resnt_ppltn_rate,
                non_resnt_ppltn_rate=reading.non_resnt_ppltn_rate,
                raw_response=reading.raw_response,
            )
        )
        session.commit()

    set_latest(reading)
    return reading


_SEOUL_BRANCH_OPEN = time(10, 0)
_SEOUL_BRANCH_NORMAL_CLOSE = time(18, 0)
_SEOUL_BRANCH_LONG_CLOSE = time(21, 0)
_LONG_DAYS = {2, 5}  # datetime.weekday(): Mon=0 ... 수=2, 토=5
_SEOUL_TZ = ZoneInfo("Asia/Seoul")


def _is_seoul_branch_open(now: datetime) -> bool:
    close = _SEOUL_BRANCH_LONG_CLOSE if now.weekday() in _LONG_DAYS else _SEOUL_BRANCH_NORMAL_CLOSE
    return _SEOUL_BRANCH_OPEN <= now.time() <= close


def collect_mmca_once(session_factory=SessionLocal, now: datetime | None = None) -> list[MmcaCongestionReading]:
    # Server local time isn't guaranteed to be KST (e.g. a UTC container), so
    # pin explicitly to Asia/Seoul instead of a naive datetime.now().
    now = now or datetime.now(_SEOUL_TZ).replace(tzinfo=None)
    if not _is_seoul_branch_open(now):
        return []

    readings: list[MmcaCongestionReading] = []
    with httpx.Client() as client:
        for space_code in settings.mmca_space_codes:
            try:
                readings.append(fetch_mmca_congestion(client, space_code, settings.mmca_api_key))
            except (httpx.HTTPError, json.JSONDecodeError):
                # data.go.kr can return a non-JSON (e.g. XML error) body with a
                # 200 status on key/quota errors — response.json() then raises
                # JSONDecodeError, not HTTPError. Isolate it per-room the same way.
                logger.warning("MMCA fetch failed for %s", space_code)

    with session_factory() as session:
        for reading in readings:
            session.add(
                RawMmcaCongestion(
                    observed_at=reading.observed_at,
                    space_code=reading.space_code,
                    space_nm=reading.space_nm,
                    agnc_nm=reading.agnc_nm,
                    congestion_nm=reading.congestion_nm,
                    raw_response=reading.raw_response,
                )
            )
        session.commit()

    return readings
