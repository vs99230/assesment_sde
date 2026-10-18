"""
Transactional outbox.

Why: "save the item" and "tell people about it" must not disagree. If we notified directly and the
process crashed in between, we would either lose the notification or announce a change that never
committed. Instead the API writes a job row IN THE SAME TRANSACTION as the change. A separate worker
(app/worker.py) delivers jobs later, with retries.

Delivery guarantee: at-least-once. A crash mid-job means the job runs again, so handlers must be
idempotent (here: UNIQUE(job_id, user_id) on notifications + ON CONFLICT DO NOTHING).
"""

import logging
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Membership, Notification, OutboxJob, WorkItem

log = logging.getLogger("ops.outbox")

ITEM_EVENT = "item_event"


def enqueue(db: Session, job_type: str, payload: dict[str, Any]) -> OutboxJob:
    """Adds a job to the CURRENT transaction. The caller commits."""
    job = OutboxJob(type=job_type, payload=payload, max_attempts=settings.outbox_max_attempts)
    db.add(job)
    return job


def enqueue_item_event(db: Session, item_id: int, event: str, actor_id: int, **extra: Any) -> OutboxJob:
    return enqueue(db, ITEM_EVENT, {"itemId": item_id, "event": event, "actorId": actor_id, **extra})


# ---------- handlers ----------


def handle_item_event(db: Session, job: OutboxJob) -> None:
    p = job.payload
    item = db.get(WorkItem, p["itemId"])
    if item is None:
        return  # item no longer exists, nothing to tell anyone
    code = f"OPS-{item.id}"
    wanted: dict[int, str] = {}

    event = p["event"]
    if event in ("created", "assigned"):
        if p.get("assigneeId"):
            wanted[p["assigneeId"]] = f"{code} was assigned to you: {item.title}"
    elif event == "status_changed":
        to, frm = p.get("to"), p.get("from")
        if to == "awaiting_approval":
            lead_ids = db.scalars(
                select(Membership.user_id).where(
                    Membership.team_id == item.team_id, Membership.role.in_(("lead", "admin"))
                )
            ).all()
            for uid in lead_ids:
                wanted[uid] = f"{code} is waiting for your approval: {item.title}"
        elif to == "resolved":
            for uid in {item.created_by_id, item.assignee_id} - {None}:
                wanted[uid] = f"{code} was resolved: {item.title}"
        elif to == "in_progress" and frm == "awaiting_approval" and item.assignee_id:
            wanted[item.assignee_id] = f"{code} was sent back for more work: {item.title}"

    wanted.pop(p.get("actorId"), None)  # don't notify people about their own actions

    for user_id, message in wanted.items():
        db.execute(
            pg_insert(Notification)
            .values(job_id=job.id, user_id=user_id, item_id=item.id, message=message[:500])
            .on_conflict_do_nothing(constraint="uq_notifications_job_user")
        )


HANDLERS: dict[str, Callable[[Session, OutboxJob], None]] = {ITEM_EVENT: handle_item_event}


# ---------- worker side ----------


def _backoff(attempts: int) -> timedelta:
    return timedelta(seconds=min(300, 5 * 2 ** max(0, attempts - 1)))


def process_batch(db: Session, batch_size: int | None = None, now: datetime | None = None) -> int:
    """
    Runs up to `batch_size` due jobs. Returns how many jobs were picked up.

    - FOR UPDATE SKIP LOCKED: several workers can run at once without ever taking the same job.
    - Each handler runs inside a SAVEPOINT, so a failing handler leaves no half-written rows.
    - The row locks are held until commit, so if the worker dies mid-batch the jobs simply stay
      pending and are retried by the next worker.
    """
    now = now or datetime.now(timezone.utc)
    size = batch_size or settings.outbox_batch_size
    jobs = db.scalars(
        select(OutboxJob)
        .where(OutboxJob.status == "pending", OutboxJob.next_run_at <= now)
        .order_by(OutboxJob.id)
        .limit(size)
        .with_for_update(skip_locked=True)
    ).all()

    for job in jobs:
        job.attempts += 1
        try:
            handler = HANDLERS.get(job.type)
            if handler is None:
                raise RuntimeError(f"No handler for job type {job.type!r}")
            with db.begin_nested():
                handler(db, job)
            job.status = "done"
            job.processed_at = now
            job.last_error = None
        except Exception as exc:  # noqa: BLE001 - any failure must be recorded, never crash the worker
            job.last_error = f"{type(exc).__name__}: {exc}"[:1000]
            if job.attempts >= job.max_attempts:
                job.status = "failed"
                log.error("Outbox job %s failed permanently: %s", job.id, job.last_error)
            else:
                job.next_run_at = now + _backoff(job.attempts)
                log.warning("Outbox job %s failed (attempt %s), will retry: %s", job.id, job.attempts, job.last_error)
    db.commit()
    return len(jobs)
