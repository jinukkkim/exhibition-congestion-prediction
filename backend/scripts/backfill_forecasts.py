"""One-off backfill: rebuild forecast_congestion / forecast_weather from the
forecast blocks already archived inside raw_congestion.raw_response.

Ordering against scripts/trim_existing_raw_responses.py matters: that script
strips FCST24HOURS out of stored bodies, so running it first would lose the
historical weather forecasts for good. It calls this module before trimming
anything, so there's nothing to sequence by hand. 서울시's congestion forecast
survives either way — it sits inside LIVE_PPLTN_STTS, which the trim keeps.

Not in deploy.sh — a data backfill, not a schema migration. Re-running is safe:
rows are replayed in observed_at order through the same revision-only rule the
collector uses, so an already-populated table just yields zero new revisions.
"""

import json

from app.collector import store_forecast_revisions
from app.db import SessionLocal, init_db
from app.models import ForecastCongestion, ForecastWeather, RawCongestion
from app.seoul_api import parse_congestion_forecasts, parse_weather_forecasts

BATCH = 500


def sections(raw: str) -> dict:
    """The section dict, whether the row predates the collector trim or not."""
    body = json.loads(raw)
    return body.get("CITYDATA", body)


def main(session_factory=SessionLocal) -> None:
    # The app creates these on startup, but this can run before the service is
    # restarted onto the new code, so don't count on that having happened.
    init_db()

    congestion = weather = rows_read = 0

    with session_factory() as session:
        last_id = 0
        while True:
            rows = (
                session.query(RawCongestion.id, RawCongestion.observed_at, RawCongestion.raw_response)
                .filter(RawCongestion.id > last_id, RawCongestion.raw_response.isnot(None))
                .order_by(RawCongestion.id)
                .limit(BATCH)
                .all()
            )
            if not rows:
                break

            for row_id, observed_at, raw in rows:
                last_id = row_id
                rows_read += 1
                city = sections(raw)
                live = (city.get("LIVE_PPLTN_STTS") or [{}])[0]
                congestion += store_forecast_revisions(
                    session, ForecastCongestion, observed_at, parse_congestion_forecasts(live)
                )
                weather += store_forecast_revisions(
                    session, ForecastWeather, observed_at, parse_weather_forecasts(city)
                )
            session.commit()

    print(f"read {rows_read} rows")
    print(f"congestion forecast revisions: {congestion}")
    print(f"weather forecast revisions:    {weather}")


if __name__ == "__main__":
    main()
