"""
Demo data. Same teams/users/password as the frontend's mock mode, so the UI behaves identically.

    python -m app.seed                 # users, teams and SEED_ITEMS items (default 5000)
    python -m app.seed --items 10000
    python -m app.seed --if-empty      # do nothing if users already exist (used by docker compose)
"""

import argparse
import random
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, insert, select, text
from sqlalchemy.orm import Session

from app.config import settings
from app.db import SessionLocal
from app.models import ActivityEvent, Membership, Team, User, WorkItem
from app.security import hash_password

DEMO_PASSWORD = "Password@123"

TEAMS = [(1, "Payments"), (2, "Support"), (3, "Compliance"), (4, "Platform")]

# id, name, email, [(team_id, role)]
USERS: list[tuple[int, str, str, list[tuple[int, str]]]] = [
    (1, "Aarav Admin", "admin@ops.test", [(1, "admin"), (2, "admin"), (3, "admin"), (4, "admin")]),
    (2, "Priya Lead", "priya.lead@ops.test", [(1, "lead"), (2, "member")]),
    (3, "Rohan Lead", "rohan.lead@ops.test", [(2, "lead"), (3, "viewer")]),
    (4, "Neha Lead", "neha.lead@ops.test", [(3, "lead"), (4, "member")]),
    (5, "Karan Lead", "karan.lead@ops.test", [(4, "lead")]),
    (6, "Ishita Member", "ishita@ops.test", [(1, "member"), (2, "member")]),
    (7, "Vikram Member", "vikram@ops.test", [(1, "member")]),
    (8, "Ananya Member", "ananya@ops.test", [(3, "member"), (4, "member")]),
    (9, "Sahil Member", "sahil@ops.test", [(2, "member")]),
    (10, "Meera Viewer", "meera@ops.test", [(1, "viewer"), (2, "viewer")]),
]

TITLES = {
    "incident": [
        "Checkout API returning intermittent 5xx errors",
        "Database replica lag above threshold",
        "SSO login failures for enterprise tenants",
        "Webhook deliveries delayed by more than 10 minutes",
        "Search service latency spike in the evening",
        "Background worker queue not draining",
    ],
    "customer_issue": [
        "Customer cannot download monthly statement",
        "Duplicate notification emails received",
        "Refund shown as pending for 7 days",
        "Account locked after password reset",
        "Mobile app crashes on opening invoices",
        "Wrong currency displayed on receipt",
    ],
    "payment": [
        "Settlement mismatch for yesterday’s batch",
        "Chargeback evidence due this week",
        "Payout stuck in processing for merchant",
        "UPI collect requests timing out",
        "Reconcile failed card transactions",
        "Fee rounding difference on invoices",
    ],
    "compliance": [
        "KYC documents expiring for 14 merchants",
        "Quarterly audit evidence collection",
        "Data retention review for support tickets",
        "Update privacy notice wording",
        "Access review for production database",
        "Sanctions screening alert needs review",
    ],
    "task": [
        "Update on-call runbook after last incident",
        "Archive resolved items older than 90 days",
        "Prepare weekly operations summary",
        "Clean up unused alert rules",
        "Document escalation path for payments",
        "Review dashboard filters with the team",
    ],
}
TYPE_BY_TEAM = {
    1: ["payment", "payment", "incident", "task"],
    2: ["customer_issue", "customer_issue", "customer_issue", "task", "incident"],
    3: ["compliance", "compliance", "task"],
    4: ["incident", "incident", "task"],
}
DESCRIPTIONS = [
    "Reported by the on-call engineer. Needs investigation and a clear owner.",
    "Several users have reported this over the last two days. Logs attached in the ticket.",
    "Raised during the weekly review. Please confirm impact before changing anything.",
    "Blocking a downstream team. Update the thread when there is progress.",
    "Low risk, but it keeps coming back. Worth fixing properly this time.",
]
COMMENTS = [
    "Looking into this now.",
    "Reproduced it on staging. Checking the logs.",
    "Waiting for a reply from the customer.",
    "Shared the findings in the team channel.",
    "This looks related to last week’s change.",
    "Fix is ready, needs a review.",
]
ORDER = ["open", "in_progress", "awaiting_approval", "resolved", "closed"]


def _weighted(rnd: random.Random, pairs: list[tuple[object, int]]):
    return rnd.choices([p[0] for p in pairs], weights=[p[1] for p in pairs], k=1)[0]


def seed_core(db: Session, password_hash: str | None = None) -> None:
    """Teams, users and memberships. Safe to call once on an empty database."""
    # One hash for every demo account keeps seeding fast; real accounts would each get a unique salt.
    pw = password_hash or hash_password(DEMO_PASSWORD)
    db.add_all([Team(id=i, name=n) for i, n in TEAMS])
    db.add_all([User(id=i, name=n, email=e, password_hash=pw) for i, n, e, _ in USERS])
    db.flush()
    db.add_all([Membership(user_id=i, team_id=t, role=r) for i, _, _, ms in USERS for t, r in ms])
    db.flush()
    _reset_sequence(db, "users")
    _reset_sequence(db, "teams")


def _reset_sequence(db: Session, table: str) -> None:
    db.execute(
        text(f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), COALESCE((SELECT MAX(id) FROM {table}), 1))")
    )


def seed_items(db: Session, count: int, seed: int = 20261016, now: datetime | None = None) -> None:
    """Many items with a believable history, written in bulk. Deterministic for a given seed."""
    rnd = random.Random(seed)
    now = now or datetime.now(timezone.utc)
    names = {i: n for i, n, _, _ in USERS}
    members: dict[int, list[tuple[int, str]]] = {t: [] for t, _ in TEAMS}
    for uid, _, _, ms in USERS:
        for team_id, role in ms:
            members[team_id].append((uid, role))
    workers = {t: [u for u, r in ms if r != "viewer"] for t, ms in members.items()}
    leads = {t: [u for u, r in ms if r in ("lead", "admin")] for t, ms in members.items()}

    item_rows: list[dict] = []
    event_rows: list[dict] = []
    span = timedelta(days=60)

    for item_id in range(1, count + 1):
        team_id = _weighted(rnd, [(1, 3), (2, 4), (3, 2), (4, 3)])
        kind = rnd.choice(TYPE_BY_TEAM[team_id])
        priority = _weighted(rnd, [("low", 25), ("medium", 40), ("high", 25), ("urgent", 10)])
        status = _weighted(
            rnd, [("open", 30), ("in_progress", 25), ("awaiting_approval", 15), ("resolved", 15), ("closed", 15)]
        )
        creator = rnd.choice(workers[team_id])
        assignee = None
        if status != "open" or rnd.random() < 0.25:
            assignee = rnd.choice(workers[team_id])

        created = min(now, now - span + span * (item_id / max(1, count)))

        def at(hours: float) -> datetime:
            return min(now, created + timedelta(hours=hours))

        evs: list[tuple[datetime, str, int, str | None, str | None, str | None]] = [
            (at(0), "created", creator, None, None, None)
        ]
        changes = 0
        if assignee is not None:
            evs.append((at(1), "assignee_changed", assignee, None, names[assignee], None))
            changes += 1
        for i in range(1, ORDER.index(status) + 1):
            actor = (assignee or rnd.choice(leads[team_id])) if i <= 2 else rnd.choice(leads[team_id])
            evs.append((at(2 + 3 * i), "status_changed", actor, ORDER[i - 1], ORDER[i], None))
            changes += 1
        for c in range(rnd.choice([0, 0, 1, 1, 2])):
            evs.append((at(1.5 + 4 * c), "comment", rnd.choice(workers[team_id]), None, None, rnd.choice(COMMENTS)))
        evs.sort(key=lambda e: e[0])

        last_change = max((e[0] for e in evs if e[1] != "comment"), default=created)
        item_rows.append(
            {
                "id": item_id,
                "title": rnd.choice(TITLES[kind]),
                "description": rnd.choice(DESCRIPTIONS),
                "type": kind,
                "priority": priority,
                "status": status,
                "team_id": team_id,
                "assignee_id": assignee,
                "created_by_id": creator,
                "due_date": (created + timedelta(days=rnd.randint(3, 20))).date() if rnd.random() < 0.55 else None,
                "version": 1 + changes,
                "created_at": created,
                "updated_at": last_change,
            }
        )
        for when, type_, actor, frm, to, body in evs:
            event_rows.append(
                {
                    "item_id": item_id,
                    "type": type_,
                    "actor_id": actor,
                    "from_value": frm,
                    "to_value": to,
                    "body": body,
                    "created_at": when,
                }
            )

    for start in range(0, len(item_rows), 1000):
        db.execute(insert(WorkItem), item_rows[start : start + 1000])
    for start in range(0, len(event_rows), 2000):
        db.execute(insert(ActivityEvent), event_rows[start : start + 2000])
    db.flush()
    _reset_sequence(db, "work_items")
    _reset_sequence(db, "activity_events")


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed demo data")
    parser.add_argument("--items", type=int, default=settings.seed_items)
    parser.add_argument("--if-empty", action="store_true", help="skip if users already exist")
    args = parser.parse_args()

    with SessionLocal() as db:
        if args.if_empty and (db.scalar(select(func.count()).select_from(User)) or 0) > 0:
            print("Database already has data; skipping seed.")
            return
        seed_core(db)
        seed_items(db, args.items)
        db.commit()
    print(f"Seeded {len(TEAMS)} teams, {len(USERS)} users and {args.items} items.")
    print(f"Log in with any demo email (e.g. priya.lead@ops.test) and password: {DEMO_PASSWORD}")


if __name__ == "__main__":
    main()
