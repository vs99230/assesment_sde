# Engineering Decisions

> DRAFT written for review. Before submitting, read every section, check it against the code, and
> rewrite it in your own words. In the live discussion you must be able to defend each point.

The brief rewards judgement over feature count, so this app is small on purpose and spends its effort on
the places where "operations under pressure" actually breaks: two people acting at once, retries, and
people seeing things they shouldn't.

Stack: FastAPI, PostgreSQL 16, SQLAlchemy 2, Alembic, React (separate repo). Every guarantee below is
enforced **by the database**, not by application memory, so it still holds with several API processes.

---

## 1. Claiming an item: one conditional UPDATE

**Context.** Two people click "Claim" on the same item at the same moment. Exactly one must win, and the
loser must be told clearly.

**Options.**
1. Read the item, check `assignee IS NULL`, then write. *Rejected:* both requests can read "unassigned" before either writes (check-then-act race).
2. `SELECT ... FOR UPDATE`, then write. Correct, but holds a row lock across several statements and round-trips.
3. One statement: `UPDATE work_items SET assignee_id = :me, version = version + 1 WHERE id = :id AND assignee_id IS NULL AND status = 'open'`.

**Choice.** Option 3. PostgreSQL serialises concurrent updates to one row; the second statement re-checks the
`WHERE` after the first commits, matches nothing, and reports 0 rows. We turn that into `409 ALREADY_CLAIMED`
with the current item attached.

**Trade-off.** The rule lives in a SQL `WHERE`, so it is slightly less readable than an `if`. In return there is
no lock to forget, no deadlock risk, and no window between check and write.
*Test:* `test_exactly_one_of_four_simultaneous_claims_wins` (repeated 8×; fails if the `IS NULL` is removed).

## 2. Concurrent edits: optimistic locking with a `version` column

**Context.** A user opens an item, goes for tea, and saves an edit based on stale data. Silently overwriting
somebody else's work is the worst outcome.

**Options.** Pessimistic locks while a form is open (bad: abandoned locks); last-write-wins (loses data); version check.

**Choice.** Every item has `version`. Edits and status moves must send the version they saw, and the write is
`UPDATE ... WHERE id = :id AND version = :seen`. Zero rows means someone changed it first: we return
`409 VERSION_CONFLICT` containing the **latest** item, so the UI can show the truth instead of asking the user
to guess. Every successful write bumps the version by exactly 1.

**Trade-off.** The user may have to redo an edit. We accept that: correct and visible beats silent and wrong.
A cheap pre-check (`data.version != item.version`) rejects the common stale case early; the `WHERE version = ...`
is what makes it safe when two requests arrive together.
*Test:* the race tests force both requests to read before either writes (a barrier), and fail if the version
guard is removed.

## 3. Retries and double-clicks: Idempotency-Key

**Context.** A flaky network or an impatient double-click sends "create item" twice. We must not create two.

**Options.** Disable the button only (not enough: retries after timeouts); dedupe by title (wrong: legitimate
duplicates exist); client-supplied idempotency key.

**Choice.** `POST /items` requires an `Idempotency-Key` header. In the **same transaction** as the create we
`INSERT ... ON CONFLICT DO NOTHING` a row `(user_id, key, sha256(body))`. If the insert fails because the key
exists, the request waits for the first transaction to finish (PostgreSQL blocks on the unique index), then
replays the stored response. Same key with a different body gets `422 IDEMPOTENCY_KEY_REUSED`. Keys are scoped per user.
A request that fails validation, or rolls back, does not consume the key.

**Trade-off.** Keys are stored forever for now; production needs a TTL clean-up job (e.g. 24 h). The replayed
response is the snapshot from creation time, which is the standard behaviour for idempotency keys.
*Test:* six simultaneous identical requests create exactly one item, one activity row and one outbox job.

## 4. Notifications: transactional outbox

**Context.** When an item is assigned or needs approval, people should be told. "Save, then send" can disagree:
crash in between and we either lose the message or announce something that never committed.

**Options.** Send inside the request (slow, and not atomic); fire-and-forget background task (lost on crash);
message broker + dual write (same atomicity problem); outbox.

**Choice.** The API writes a row into `outbox_jobs` **in the same transaction** as the change. A separate worker
(`python -m app.worker`) claims due jobs with `FOR UPDATE SKIP LOCKED` (so many workers never take the same job),
runs the handler inside a savepoint, and retries failures with exponential backoff up to `max_attempts`, then marks
the job `failed` with the last error. Delivery is **at-least-once**, so the handler is idempotent:
`UNIQUE(job_id, user_id)` plus `ON CONFLICT DO NOTHING`.

**Trade-off.** Delay of up to the poll interval (1 s), and polling adds a little load. Exactly-once delivery is not
promised; idempotent handlers make "at least once" safe in practice. At much higher volume we would move to a
dedicated queue and keep the outbox only as the reliable hand-off.
*Tests:* job written atomically with the change (and nothing is saved if it can't be), retry/backoff/failed, partial work rolled back,
three concurrent workers handle 30 jobs exactly once.

## 5. Authorization: one module, applied to every query

**Context.** Permission bugs are usually "one endpoint forgot to check".

**Choice.** All role logic lives in `app/permissions.py` (roles, who may edit, the transition table). Routers and
services call it; none compares roles itself. Visibility is enforced in the query: every list/count includes
`team_id IN (my teams)`, and single-item lookups return **404, not 403**, for other teams' items so their
existence isn't revealed. The workflow itself is data (`TRANSITIONS`), so adding a status or changing who may approve is a one-place change.

**Trade-off.** Roles are read from the user's memberships on each request (no caching), which costs one small
query but means role changes apply immediately. The frontend mirrors these rules only to hide buttons; the server is the authority.

## 6. Listing at scale: keyset pagination and targeted indexes

Lists page by `id < cursor ORDER BY id DESC` instead of `OFFSET`, so page 500 costs the same as page 1 and
concurrent inserts can't duplicate or skip rows. Indexes match the hot queries (team + status, assignee, partial
indexes for "unassigned urgent" and "awaiting approval", trigram indexes for search). A test asserts those queries
use an index. Seed data is 5,000 items; the design does not change at 10×.

---

## Known limitations (honest list)

- No rate limiting or account lock-out on login.
- JWTs are not revocable and there is no refresh token (12 h expiry). The frontend keeps the token in `localStorage`.
- Idempotency keys and finished outbox jobs are never purged (needs scheduled clean-up).
- Notifications are rows in the database only: no email/push, and no endpoint to read them yet.
- Search is substring (`ILIKE` + trigram), not ranked full-text search.
- A user's role in a team is changed by editing the database; there is no admin API.
- Docker Compose files were written but could not be executed in the environment where this was built (no Docker daemon).
  The tests and the app were run against a real local PostgreSQL 16 instead.

## What I would change at 10× scale

Partition `activity_events` by month; read replica for list/dashboard queries; PgBouncer for connections; replace
`ILIKE` with PostgreSQL full-text or OpenSearch; move delivery to a real queue; add a TTL job for idempotency keys.
