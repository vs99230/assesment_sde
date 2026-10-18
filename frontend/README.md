# Ops Under Pressure — Frontend

React + TypeScript + Vite + TanStack Query. Works fully on its own with built-in mock data, and switches to the real backend with one line in `.env`.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
```

## Mock data on/off

Edit `.env`:

```
VITE_USE_MOCK=true                    # built-in demo data, no backend needed
VITE_USE_MOCK=false                   # use the real backend
VITE_API_BASE_URL=http://localhost:8000
VITE_MOCK_LATENCY_MS=300              # fake network delay in mock mode (0 = none)
```

Restart `npm run dev` after changing `.env`.

## Demo logins (mock mode)

Password for everyone: `Password@123` (the login page also lists them; click one to fill the form).

| Email | Roles |
|---|---|
| admin@ops.test | Admin in all teams |
| priya.lead@ops.test | Lead in Payments, Member in Support |
| rohan.lead@ops.test | Lead in Support, Viewer in Compliance |
| ishita@ops.test | Member in Payments and Support |
| vikram@ops.test | Member in Payments only |
| meera@ops.test | Viewer in Payments and Support |

~520 seeded items. Changes are saved in the browser (localStorage); use **Reset demo data** in the footer to start over.

## Things to try in mock mode

- **Two people claim the same item:** open an item in two browsers/profiles as different users, claim in both. The second gets a "claimed first by someone else" message and the screen refreshes.
- **Stale edit (optimistic locking):** open an item, press **Simulate edit by another user** in the side panel, then Claim / change status / Save. Nothing is overwritten; you get a conflict message and the latest version.
- **Approval is Lead-only:** as Ishita submit an item for approval, then sign in as Priya to approve it.
- **Double click Create:** the form sends one idempotency key per request, so only one item is created.
- **Viewer:** sign in as Meera. Everything is read-only.

## Switching to the real backend

1. Build the backend to match [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md).
2. Enable CORS for `http://localhost:5173`.
3. Set `VITE_USE_MOCK=false`, restart `npm run dev`.

The mock API (`src/api/mock/`) implements the same rules as the contract, so it doubles as an executable spec.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` | Typecheck + production build into `dist/` |
| `npm run typecheck` | TypeScript only |
| `npm test` | Unit tests (mock API behaviours, rules, validation) |

## Structure

```
src/
  api/            contract.ts (interface), http.ts (real), mock/ (fake backend), session.ts, errors.ts
  auth/           login state, protected routes
  hooks/          TanStack Query hooks, optimistic claim/transition mutations
  lib/            rules (permissions + workflow), validation, labels, formatting
  pages/          Login, Dashboard, Items (filters + pagination), Item detail, Create item
  components/     table, badges, activity feed, forms, banners
  test/           vitest tests
```

## Notes

- Hiding a button is **not** security. The server must enforce permissions; `src/lib/rules.ts` only mirrors them for the UI.
- The auth token is kept in `localStorage`. Fine for an assignment; a production app would prefer httpOnly cookies.
- Dashboard refreshes every 30 seconds (polling).
