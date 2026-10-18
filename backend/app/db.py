from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings

engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=30,
)

# expire_on_commit=False: objects stay readable after commit, so we can build the response
# without an extra query. Code that needs fresh state reloads explicitly (see services/items.py).
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    """One session per request. Anything not committed is rolled back when the session closes."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
