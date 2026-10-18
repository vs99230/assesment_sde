# Ops Under Pressure

An internal web app where teams **create, assign, track and resolve operational work items** (incidents, customer issues, payments, compliance, tasks), built for the Newtonite Software Engineering Challenge.

The app is intentionally small. The effort goes into what breaks under pressure: two people acting on the same item at once, retried requests, people seeing things they shouldn't, and notifications that must not get lost.

| | |
|---|---|
| **Frontend** | React 18, TypeScript, Vite, TanStack Query |
| **Backend** | FastAPI, SQLAlchemy 2, Alembic, PostgreSQL 16 |
| **Background work** | Transactional outbox + separate worker process |
| **Tests** | pytest on real PostgreSQL (63 tests), Vitest (28 tests) |
| **Run it** | Docker Compose (one command), or manually |

---

## Contents

1. [Quick start](#quick-start)
2. [Demo accounts](#demo-accounts)
3. [What to try (2 minutes)](#what-to-try-2-minutes)
4. [Architecture](#architecture)
5. [Critical behaviours](#critical-behaviours)
6. [Roles and workflow](#roles-and-workflow)
7. [Tests](#tests)
8. [Project structure](#project-structure)
9. [API](#api)
10. [Engineering decisions and limitations](#engineering-decisions-and-limitations)

---

## Quick start

Ports used: frontend `5173`, API `8000`, PostgreSQL `5432`.

### Option A: Full stack with Docker (recommended)

Requires Docker with Compose.

```bash
# 1. Backend: database + API + worker (migrates and seeds 5,000 demo items on first start)
cd backend
docker compose up --build
```

API is ready when http://localhost:8000/health returns `{"status":"ok"}` (docs at http://localhost:8000/docs).

```bash
# 2. Frontend (new terminal)
cd frontend
cp .env.example .env
# edit .env:  VITE_USE_MOCK=false
npm install
npm run dev
```

Open http://localhost:5173.

### Option B: Frontend only, no backend (mock data)

The frontend ships with a built-in mock API that behaves like the real server (permissions, version conflicts, double-claim, idempotency).

```bash
cd frontend
npm install
npm run dev          # .env already has VITE_USE_MOCK=true
```

Switch between mock and real backend with one line in `frontend/.env`:

```
VITE_USE_MOCK=true                   # built-in demo data
VITE_USE_MOCK=false                  # real backend
VITE_API_BASE_URL=http://localhost:8000
```

Restart `npm run dev` after changing `.env`.

### Option C: Backend without Docker

Requires Python 3.12+ and PostgreSQL 14+ (UTF-8 database, `pg_trgm` extension available, which standard installs include).

```bash
cd backend
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt

createdb ops                                           # or create the database any way you like
cp .env.example .env                                   # set DATABASE_URL and JWT_SECRET

alembic upgrade head                                   # create tables
python -m app.seed                                     # demo data (5,000 items; --items 10000 for more)
uvicorn app.main:app --reload                          # API on :8000
python -m app.worker                                   # second terminal: delivers outbox jobs
```

Then start the frontend as in Option A, step 2.

---

## Demo accounts

Password for every account: `Password@123`

| Email | Roles |
|---|---|
| `admin@ops.test` | Admin in all four teams |
| `priya.lead@ops.test` | **Lead** in Payments, Member in Support |
| `rohan.lead@ops.test` | **Lead** in Support, Viewer in Compliance |
| `ishita@ops.test` | Member in Payments and Support |
| `vikram@ops.test` | Member in Payments only |
| `meera@ops.test` | Viewer in Payments and Support |

Teams: Payments, Support, Compliance, Platform. More accounts are listed in `backend/app/seed.py`. In mock mode the login page lists them and fills the form on click.

---

## What to try (2 minutes)

| Scenario | Steps | Expected |
|---|---|---|
| **Two people claim the same item** | Open the same unassigned item in two browser profiles as `ishita@ops.test` and `vikram@ops.test`. Click **Claim** in both. | One wins. The other sees "Someone else claimed this item first" and the screen refreshes to the real state. |
| **Stale edit** | Open an item as Priya and click **Edit details**. In another profile, edit and save the same item as Admin. Now save in Priya's window. | Priya's save is rejected, nothing is overwritten, and the latest version is shown. |
| **Approval is Lead-only** | As Ishita: claim an item, **Start work**, **Submit for approval**. Then try the same item as Vikram (no approve button). Sign in as Priya and **Approve & resolve**. | Only a Lead sees and can use approve. |
| **Double-click create** | Create an item and click **Create item** repeatedly. | Exactly one item. |
| **Team isolation** | As `vikram@ops.test` (Payments only), open an item ID that belongs to Support. | "Item not found" (the server returns 404, not 403). |
| **Read-only viewer** | Sign in as `meera@ops.test`. | No claim, edit, or create buttons, and the API would refuse them anyway. |
| **Notifications** | Do the approval flow above, then `docker compose logs worker` or look at the `notifications` table. | Leads get "waiting for your approval". |

---

## Architecture

```
  Browser (React)
       |  JSON over HTTP, Bearer token, Idempotency-Key on create
       v
  FastAPI  ──────────────────────────────►  PostgreSQL 16
  - auth, validation                         work_items (version column)
  - permissions.py (single policy)           activity_events (append-only)
  - services/items.py                        idempotency_keys
       |                                     outbox_jobs   <── written in the SAME
       |  one transaction per write              ^              transaction as the change
       |                                         |
       └──────────────────────────────────  Worker (python -m app.worker)
                                             polls outbox_jobs (FOR UPDATE SKIP LOCKED),
                                             retries with backoff, writes notifications
```

Every write is **one database transaction** containing: the state change, its activity-log row, and (when relevant) an outbox job. Either all of it commits or none of it does.

---

## Critical behaviours

| Behaviour | How it works | Code | Test |
|---|---|---|---|
| **Atomic claim** | One conditional `UPDATE ... WHERE assignee_id IS NULL`. The database picks a single winner; losers get `409 ALREADY_CLAIMED` plus the current item. | `backend/app/services/items.py` `claim_item` | `test_concurrency.py::TestAtomicClaim` |
| **Stale-update handling** (optimistic locking) | Edits and status moves send the `version` they saw. `UPDATE ... WHERE version = :seen`; zero rows means `409 VERSION_CONFLICT` with the latest item. | `update_item`, `transition_item` | `TestOptimisticLocking` |
| **Idempotency** | `POST /items` needs an `Idempotency-Key`. The key is reserved with `INSERT ... ON CONFLICT` in the same transaction as the create; retries replay the stored response. | `create_item` | `TestIdempotentCreate` |
| **Workflow rules** | Allowed transitions live in one table on the server; the UI only mirrors it. Invalid jump gives `422`, wrong role gives `403`. | `backend/app/permissions.py` `TRANSITIONS` | `test_items_workflow.py` |
| **Resource-level authorization** | One policy module. Every query is scoped to the caller's teams. Other teams' items return `404`. | `backend/app/permissions.py` | `test_auth_and_permissions.py` |
| **Reliable async jobs** (transactional outbox) | Job row committed with the change. Worker claims with `SKIP LOCKED`, retries with exponential backoff, marks `failed` after max attempts. Handlers are idempotent. | `backend/app/services/outbox.py` | `test_outbox.py` |
| **Optimistic UI reconciliation** | Claim and status buttons update instantly, roll back on error, and adopt the server's latest copy on a `409`. | `frontend/src/hooks/useItemMutations.ts` | Manual (see "What to try") |

The race tests use a barrier so both requests read before either writes, which is the interleaving that breaks naive code. They fail if the matching guard is removed from the service.

---

## Roles and workflow

Roles are **per team**: `viewer`, `member`, `lead`, `admin`.

| Action | Viewer | Member | Lead | Admin |
|---|:-:|:-:|:-:|:-:|
| Read items of own teams | yes | yes | yes | yes |
| Create, comment, claim | no | yes | yes | yes |
| Edit fields | no | own items | yes | yes |
| Reassign / assign on create | no | no | yes | yes |
| Approve, send back, close | no | no | yes | yes |

```
Open ──► In progress ──► Awaiting approval ──► Resolved ──► Closed
              ▲                  │
              └── send back ─────┘   (Lead only)
```

- Starting work needs an assignee (claim it first).
- Moving to **Resolved** is **Lead/Admin only**.
- Closed items cannot be edited.
- Every change is recorded in the item's activity log, in the same transaction.

---

## Tests

### Backend (63 tests, real PostgreSQL)

Tests need a database whose name ends in `_test`. Its contents are wiped, and the suite refuses to run against any other name.

```bash
cd backend
createdb ops_test
export TEST_DATABASE_URL=postgresql+psycopg://ops:ops@localhost:5432/ops_test
pytest
```

With Docker:

```bash
cd backend
docker compose run --rm -e TEST_DATABASE_URL=postgresql+psycopg://ops:ops@db:5432/ops_test api pytest
```

Covers: simultaneous claims, stale edits, idempotent creates under concurrency, workflow and permissions, atomicity (nothing saved if the outbox job can't be written), worker retries and concurrent workers, pagination over 1,500 items, filters/search, dashboard totals, and index usage.

### Frontend (28 tests)

```bash
cd frontend
npm test            # unit tests: mock API behaviour, rules, validation
npm run build       # typecheck + production build
```

---

## Project structure

```
.
├── README.md
├── backend/
│   ├── app/
│   │   ├── main.py             app, CORS, error handlers
│   │   ├── models.py           tables, constraints, indexes
│   │   ├── schemas.py          request/response shapes (camelCase JSON)
│   │   ├── permissions.py      ALL role and workflow rules
│   │   ├── services/items.py   claim, versioned updates, transitions, idempotent create, listing
│   │   ├── services/outbox.py  outbox enqueue, worker batch, handlers
│   │   ├── worker.py           python -m app.worker
│   │   └── seed.py             demo data
│   ├── alembic/versions/       migrations
│   ├── tests/
│   ├── docs/API_CONTRACT.md
│   ├── ENGINEERING_DECISIONS.md
│   ├── Dockerfile
│   └── docker-compose.yml
└── frontend/
    ├── src/
    │   ├── api/                contract.ts, http.ts (real), mock/ (fake backend)
    │   ├── pages/              Login, Dashboard, Items, Item detail, Create
    │   ├── hooks/              queries and optimistic mutations
    │   ├── lib/                rules, validation, formatting
    │   └── test/
    ├── docs/API_CONTRACT.md
    └── .env.example
```

---

## API

Full request/response shapes, error codes and rules: [`backend/docs/API_CONTRACT.md`](backend/docs/API_CONTRACT.md). Interactive docs when running: http://localhost:8000/docs.

| Method and path | Purpose |
|---|---|
| `POST /auth/login`, `GET /auth/me` | Sign in, current user and team roles |
| `GET /teams/{id}/members` | Assignable people for a team |
| `GET /dashboard` | Assigned to me, Unassigned urgent, Awaiting my approval |
| `GET /items` | List with filters, search and cursor pagination |
| `POST /items` | Create (needs `Idempotency-Key`) |
| `GET /items/{id}`, `PATCH /items/{id}` | Read, edit (needs `version`) |
| `POST /items/{id}/claim` | Atomic claim |
| `POST /items/{id}/transition` | Workflow move (needs `version`) |
| `GET /items/{id}/activity`, `POST /items/{id}/comments` | History and comments |

Errors always look like `{ "error": { "code", "message", "details" } }`. A `409` carries the current item in `details.latest`.

---

## Engineering decisions and limitations

- Reasoning, options considered and trade-offs for each critical behaviour: [`backend/ENGINEERING_DECISIONS.md`](backend/ENGINEERING_DECISIONS.md)
- Known limitations (also listed there): no rate limiting or token revocation, auth token kept in `localStorage` in the frontend, idempotency keys and finished outbox jobs are never purged, notifications are database rows only (no email or push), search is substring-based rather than ranked full-text.
- Scaling notes: keyset pagination and targeted indexes are already in place; the next steps at 10x would be partitioning `activity_events`, a read replica, a dedicated queue, and full-text search.