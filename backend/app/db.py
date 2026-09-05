from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


# SQLite's default busy timeout is 5s, and deploy/backup_db.sh holds a read lock
# on the file for the length of its snapshot — measured at 7.24s against 218MB
# on production. The backup runs at 00:33 KST and the collector that writes at
# that hour is Seoul's, on */5: the lock clears ~113s before its 00:35 tick, so
# the two do not meet today. MMCA is on */2, so :33 being odd puts it off that
# grid as well — but nothing rests on that, because MMCA writes nothing at
# midnight either way: closed venues return from _is_venue_open before any
# request or session. That is what carried this margin while the grid was every
# minute and no offset could avoid it at all.
#
# That 113s margin shrinks as the DB grows, and the cost of losing the race is
# a collection cycle that can never be re-collected. 30s turns a collision into
# a wait instead of "database is locked".
#
# Guarded on the driver: `timeout` is a sqlite3 connect argument, and
# database_url is documented as accepting Postgres even though it has never
# been deployed that way.
_connect_args = {"timeout": 30} if settings.database_url.startswith("sqlite") else {}
engine = create_engine(settings.database_url, connect_args=_connect_args)
SessionLocal = sessionmaker(bind=engine)


def init_db() -> None:
    Base.metadata.create_all(engine)
