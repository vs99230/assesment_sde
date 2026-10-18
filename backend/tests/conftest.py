"""
Tests run against a REAL PostgreSQL database. Concurrency guarantees (one claim winner, version
checks, idempotency) are properties of the database, so a fake or SQLite would prove nothing.

Point TEST_DATABASE_URL at a database whose name ends in "_test". Its contents are wiped.
"""

import logging
import os
from pathlib import Path

TEST_URL = os.environ.get("TEST_DATABASE_URL", "postgresql+psycopg://ops:ops@localhost:5432/ops_test")
if not TEST_URL.rsplit("/", 1)[-1].split("?")[0].endswith("_test"):
    raise RuntimeError("Refusing to run tests: the database name must end with '_test' (its data is deleted).")

# Must be set BEFORE the app is imported.
os.environ["DATABASE_URL"] = TEST_URL
os.environ["PASSWORD_ITERATIONS"] = "1000"
os.environ["JWT_SECRET"] = "test-secret-test-secret-test-secret-123456"
os.environ["PGTZ"] = "UTC"

import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.db import SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Base  # noqa: E402
from app.security import hash_password  # noqa: E402
from app.seed import DEMO_PASSWORD, seed_core  # noqa: E402

logging.getLogger("httpx2").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)

ROOT = Path(__file__).resolve().parent.parent
_PASSWORD_HASH = hash_password(DEMO_PASSWORD, iterations=1000)
TABLES = ", ".join(t.name for t in Base.metadata.sorted_tables)


@pytest.fixture(scope="session", autouse=True)
def _migrated_database():
    """Build the schema with the REAL migrations, so a broken migration fails the tests."""
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
    command.upgrade(Config(str(ROOT / "alembic.ini")), "head")
    yield
    engine.dispose()


@pytest.fixture(autouse=True)
def _clean_database(_migrated_database):
    """Every test starts from: 4 teams, 10 demo users, no items."""
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {TABLES} RESTART IDENTITY CASCADE"))
    with SessionLocal() as db:
        seed_core(db, _PASSWORD_HASH)
        db.commit()
    yield


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def db():
    with SessionLocal() as session:
        yield session


def _headers(client: TestClient, email: str) -> dict[str, str]:
    res = client.post("/auth/login", json={"email": email, "password": DEMO_PASSWORD})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['token']}"}


@pytest.fixture
def as_user(client):
    """as_user('priya.lead@ops.test') -> auth headers."""
    cache: dict[str, dict[str, str]] = {}

    def get(email: str) -> dict[str, str]:
        if email not in cache:
            cache[email] = _headers(client, email)
        return cache[email]

    return get


# Convenience accounts (see app/seed.py)
ADMIN = "admin@ops.test"
LEAD = "priya.lead@ops.test"  # Payments lead, Support member
MEMBER = "ishita@ops.test"  # Payments + Support member
MEMBER2 = "vikram@ops.test"  # Payments member
VIEWER = "meera@ops.test"  # Payments + Support viewer
SUPPORT_LEAD = "rohan.lead@ops.test"  # Support lead, Compliance viewer


def item_body(**over):
    body = {
        "title": "Test item for payments",
        "description": "Created by a test.",
        "type": "task",
        "priority": "medium",
        "teamId": 1,
        "dueDate": None,
        "assigneeId": None,
    }
    body.update(over)
    return body


@pytest.fixture
def make_item(client, as_user):
    counter = {"n": 0}

    def make(by: str = LEAD, **over) -> dict:
        counter["n"] += 1
        res = client.post(
            "/items", json=item_body(**over), headers={**as_user(by), "Idempotency-Key": f"fixture-{counter['n']}"}
        )
        assert res.status_code == 201, res.text
        return res.json()

    return make
