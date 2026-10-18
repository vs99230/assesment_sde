# API Contract (frontend ⇄ backend)

The frontend talks to the backend only through `src/api/contract.ts`. Two implementations exist:
the in-browser mock (`VITE_USE_MOCK=true`) and the real HTTP client (`src/api/http.ts`, `VITE_USE_MOCK=false`).
**Build the real backend to match this file** and the frontend works without changes.

- Base URL: `VITE_API_BASE_URL` (default `http://localhost:8000`). Enable CORS for `http://localhost:5173`.
- All bodies are JSON. Field names are **camelCase**.
- Auth: `Authorization: Bearer <token>` on every request except `POST /auth/login`.
- Dates: `dueDate` is `YYYY-MM-DD`; timestamps are ISO-8601 UTC strings.

## Error format

Every non-2xx response:

```json
{ "error": { "code": "VERSION_CONFLICT", "message": "Human readable text", "details": { } } }
```

| HTTP | code | When | `details` |
|---|---|---|---|
| 401 | `UNAUTHENTICATED` | Missing/invalid token, bad login | – |
| 403 | `FORBIDDEN` | Authenticated, but role is too low | – |
| 404 | `NOT_FOUND` | Missing item **or item of a team the caller is not in** | – |
| 409 | `VERSION_CONFLICT` | `version` sent by client is stale | `{ "latest": WorkItem }` |
| 409 | `ALREADY_CLAIMED` | Claim lost the race | `{ "latest": WorkItem }` |
| 422 | `VALIDATION_ERROR` | Bad input | `{ "fields": { "title": "…" } }` |
| 422 | `INVALID_TRANSITION` | Workflow move not allowed | – |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Same key, different body | – |

The UI relies on `details.latest` for 409s: it replaces its stale copy with that item.

## Types

```
Role      = "viewer" | "member" | "lead" | "admin"
Status    = "open" | "in_progress" | "awaiting_approval" | "resolved" | "closed"
Priority  = "low" | "medium" | "high" | "urgent"
ItemType  = "incident" | "customer_issue" | "payment" | "compliance" | "task"

User      = { id, name, email, memberships: [{ teamId, teamName, role }] }
WorkItem  = { id, title, description, type, priority, status,
              team: {id,name}, assignee: {id,name}|null, createdBy: {id,name},
              dueDate: string|null, version: number, createdAt, updatedAt }
Activity  = { id, itemId, type, actor:{id,name}, from, to, body, createdAt }
            type = "created" | "status_changed" | "assignee_changed" |
                   "priority_changed" | "field_updated" | "comment"
Page<T>   = { items: T[], nextCursor: string | null }
```

## Endpoints

### Auth
| Method & path | Body | Response |
|---|---|---|
| `POST /auth/login` | `{ email, password }` | `{ token, user: User }` |
| `GET /auth/me` | – | `User` |
| `GET /teams/{teamId}/members` | – | `[{ id, name, role }]` (404 if caller not in team) |

### Items
| Method & path | Notes |
|---|---|
| `GET /items` | Query: `status, priority, type, teamId, assignee (me｜unassigned), q, view, cursor, limit`. Returns `Page<WorkItem>`, newest first. Only items of the caller's teams. |
| `POST /items` | Header `Idempotency-Key` (required). Body: `{ title, description, type, priority, teamId, dueDate, assigneeId }`. Returns the new `WorkItem`. Same key + same body ⇒ **same response, no second item**. |
| `GET /items/{id}` | `WorkItem` |
| `PATCH /items/{id}` | Body: `{ version, title?, description?, priority?, dueDate?, assigneeId? }`. `version` required. Stale ⇒ 409. Only Leads/Admins may change `assigneeId`. Returns the updated item (version +1). |
| `POST /items/{id}/claim` | No body. Succeeds only if currently unassigned (atomic conditional update). Otherwise 409 `ALREADY_CLAIMED`. |
| `POST /items/{id}/transition` | Body: `{ to, version }`. Stale ⇒ 409. |
| `GET /items/{id}/activity` | `Page<Activity>`, newest first. Query: `cursor, limit`. |
| `POST /items/{id}/comments` | Body: `{ body }` ⇒ `Activity` (type `comment`). |
| `GET /dashboard` | `{ assignedToMe, unassignedUrgent, awaitingMyApproval }`, each `{ total, items: WorkItem[] (max 5) }` |

`view` filter (also used by the dashboard):
- `assigned_to_me`: assignee is caller and status not resolved/closed
- `unassigned_urgent`: no assignee, priority urgent, status open
- `awaiting_my_approval`: status `awaiting_approval` in teams where caller is Lead/Admin

## Rules the server must enforce (the UI only mirrors them)

Roles are per team. Rank: viewer < member < lead < admin.

| Action | Minimum role |
|---|---|
| Read | viewer |
| Create / comment / claim | member |
| Edit fields | lead, or member who is the assignee (or creator of an unassigned item) |
| Reassign / assign on create | lead |
| Approve (awaiting_approval → resolved), send back, close | lead |

Workflow (anything else ⇒ 422 `INVALID_TRANSITION`):

```
open → in_progress                 (assignee or lead; needs an assignee)
in_progress → awaiting_approval    (assignee or lead)
awaiting_approval → resolved       (lead only)
awaiting_approval → in_progress    (lead only, "send back")
resolved → closed                  (lead only)
```

Every successful write bumps `version` by exactly 1 and appends an activity row **in the same transaction**.
Closed items cannot be edited.

## Pagination

Cursor-based. `cursor` is opaque to the client; the mock uses "last id seen". Send `nextCursor` back as `cursor`.
`limit` defaults to 20, max 100.
