# Ops Under Pressure: Backend

FastAPI + PostgreSQL + SQLAlchemy + Alembic. Matches [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md), so the React frontend works against it by setting `VITE_USE_MOCK=false`.

Design decisions and trade-offs: [`ENGINEERING_DECISIONS.md`](ENGINEERING_DECISIONS.md).

## Run with Docker (one command)

```bash
docker compose up --build
```

This starts PostgreSQL, the API (runs migrations, seeds 5,000 demo items on first start) and the outbox worker.

- API: http://localhost:8000 (interactive docs at `/docs`, health at `/health`)
- Frontend: in its `.env` set `VITE_USE_MOCK=false` and `VITE_API_BASE_URL=http://localhost:8000`, then `npm run dev` (http://localhost:5173)

Demo logins (password for all: `Password@123`): `admin@ops.test`, `priya.lead@ops.test` (Payments lead), `rohan.lead@ops.test` (Support lead), `ishita@ops.test` (member), `vikram@ops.test` (member), `meera@ops.test` (viewer). Full list in `app/seed.py`.

## Run without Docker

Needs Python 3.12+ and PostgreSQL 14+ (with the `pg_trgm` extension, included in standard installs; the database must be UTF-8).

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env            # edit DATABASE_URL / JWT_SECRET

alembic upgrade head            # create tables
python -m app.seed              # demo data (use --items 10000 for more)
uvicorn app.main:app --reload   # API on :8000
python -m app.worker            # in a second terminal: delivers outbox jobs
```

## Tests

Tests need a **real PostgreSQL** database whose name ends in `_test` (its contents are deleted; the suite refuses to run otherwise).

```bash
createdb ops_test                                   # once
export TEST_DATABASE_URL=postgresql+psycopg://ops:ops@localhost:5432/ops_test
pytest
```

With Docker: `docker compose run --rm -e TEST_DATABASE_URL=postgresql+psycopg://ops:ops@db:5432/ops_test api pytest`
(the `ops_test` database is created automatically the first time the volume is created).

What the 63 tests cover:

| Area | Examples |
|---|---|
| Atomic claim | 4 users claim at once: exactly one 200, three 409; one activity row; version +1 |
| Optimistic locking | stale edit/move rejected with the latest item; two simultaneous edits, one wins |
| Idempotency | 6 simultaneous identical creates make 1 item; reused key with other body rejected |
| Workflow + authorization | invalid jumps, Lead-only approval, viewers read-only, other teams' items are 404 everywhere |
| Atomicity | if the outbox job can't be written, the change is not saved |
| Outbox worker | retry with backoff, permanent failure, idempotent handler, 3 concurrent workers handle each job once |
| Lists | pagination over 1,500 items has no gaps/duplicates; filters; search; dashboard totals; index use |

The race tests use a barrier so that both requests read before either writes, which is the interleaving that
breaks naive code. They fail if the corresponding guard in `app/services/items.py` is removed.

## Where things are

```
app/
  main.py            app, CORS, error handlers
  models.py          tables and constraints
  schemas.py         request/response shapes (camelCase JSON)
  permissions.py     ALL role and workflow rules (change rules here)
  services/items.py  claim, versioned updates, transitions, idempotent create, listing
  services/outbox.py enqueue + worker batch processing + handlers
  worker.py          python -m app.worker
  seed.py            demo data
alembic/versions/    migrations (indexes, trigram search)
tests/               pytest suite
```

## Making a change during a review

| Change | Where |
|---|---|
| Who may do X (e.g. "Leads can reassign") | `app/permissions.py` |
| Add a status | `TRANSITIONS` in `permissions.py`, `STATUSES` in `models.py` and `schemas.py`, a new migration for the CHECK constraint, and the frontend labels |
| Add a work-item field | `models.py`, a migration, `schemas.py`, `services/items.py` |
| New notification rule | `handle_item_event` in `services/outbox.py` |

## Notes

- Set a strong `JWT_SECRET` outside development.
- `docker-compose.yml` has not been executed in the environment this was built in (no Docker available there); everything else was run against a real PostgreSQL 16.
