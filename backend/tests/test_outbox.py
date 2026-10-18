import threading
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import Notification, OutboxJob
from app.services import outbox
from tests.conftest import LEAD, MEMBER, item_body
from tests.helpers import race


def _jobs():
    with SessionLocal() as db:
        return db.scalars(select(OutboxJob).order_by(OutboxJob.id)).all()


def _notifications():
    with SessionLocal() as db:
        return db.scalars(select(Notification).order_by(Notification.id)).all()


def _run_worker(now=None, batch=50):
    with SessionLocal() as db:
        return outbox.process_batch(db, batch_size=batch, now=now)


def _to_awaiting_approval(client, as_user, make_item):
    item = make_item(by=MEMBER)
    item = client.post(f"/items/{item['id']}/claim", headers=as_user(MEMBER)).json()
    for to in ("in_progress", "awaiting_approval"):
        item = client.post(
            f"/items/{item['id']}/transition", headers=as_user(MEMBER), json={"to": to, "version": item["version"]}
        ).json()
    return item


class TestOutboxWriting:
    def test_job_is_written_together_with_the_change(self, client, as_user):
        res = client.post(
            "/items", headers={**as_user(LEAD), "Idempotency-Key": "o1"}, json=item_body(assigneeId=7)
        )
        assert res.status_code == 201
        jobs = _jobs()
        assert len(jobs) == 1
        assert jobs[0].status == "pending" and jobs[0].attempts == 0
        assert jobs[0].payload["itemId"] == res.json()["id"] and jobs[0].payload["assigneeId"] == 7

    def test_if_the_job_cannot_be_written_the_change_is_not_saved(self, as_user, make_item, monkeypatch):
        """Atomicity: no item without its job, and no job without its item."""
        from fastapi.testclient import TestClient

        from app.main import app
        from tests.helpers import count_events, fetch_item

        item = make_item()
        before_jobs = len(_jobs())

        def boom(*a, **k):
            raise RuntimeError("queue is down")

        monkeypatch.setattr(outbox, "enqueue_item_event", boom)
        quiet = TestClient(app, raise_server_exceptions=False)

        # claim
        res = quiet.post(f"/items/{item['id']}/claim", headers=as_user(MEMBER))
        assert res.status_code == 500 and res.json()["error"]["code"] == "UNKNOWN"
        stored = fetch_item(item["id"])
        assert stored.assignee_id is None and stored.version == item["version"]
        assert count_events(item["id"], "assignee_changed") == 0

        # create
        res = quiet.post("/items", headers={**as_user(MEMBER), "Idempotency-Key": "boom"}, json=item_body(title="Never saved"))
        assert res.status_code == 500
        assert len(_jobs()) == before_jobs
        with SessionLocal() as db:
            assert db.scalar(select(func.count()).select_from(Notification)) == 0

        # once the queue is back, the same key works (the failed attempt did not burn it)
        monkeypatch.undo()
        ok = quiet.post("/items", headers={**as_user(MEMBER), "Idempotency-Key": "boom"}, json=item_body(title="Never saved"))
        assert ok.status_code == 201


class TestWorker:
    def test_assignment_notifies_the_assignee_but_not_the_actor(self, client, as_user):
        client.post("/items", headers={**as_user(LEAD), "Idempotency-Key": "w1"}, json=item_body(assigneeId=7))
        assert _run_worker() == 1
        notes = _notifications()
        assert [(n.user_id) for n in notes] == [7]
        assert "assigned to you" in notes[0].message
        assert _jobs()[0].status == "done"

    def test_self_claim_notifies_nobody(self, client, as_user, make_item):
        item = make_item(by=MEMBER)
        _run_worker()
        client.post(f"/items/{item['id']}/claim", headers=as_user(MEMBER))
        _run_worker()
        assert _notifications() == []

    def test_awaiting_approval_notifies_the_leads_not_the_requester(self, client, as_user, make_item):
        _to_awaiting_approval(client, as_user, make_item)
        _run_worker()
        recipients = {n.user_id for n in _notifications()}
        assert recipients == {2, 1}  # Priya (lead) and Aarav (admin); not Ishita, who did it

    def test_handler_is_idempotent_if_a_job_runs_twice(self, client, as_user, make_item):
        _to_awaiting_approval(client, as_user, make_item)
        _run_worker()
        count = len(_notifications())
        assert count == 2
        with SessionLocal() as db:
            for job in db.scalars(select(OutboxJob)).all():
                outbox.handle_item_event(db, job)  # simulate "worker crashed after sending, job re-delivered"
            db.commit()
        assert len(_notifications()) == count

    def test_failing_job_is_retried_with_backoff_then_marked_failed(self, client, as_user, monkeypatch):
        client.post("/items", headers={**as_user(LEAD), "Idempotency-Key": "f1"}, json=item_body(assigneeId=7))
        calls = []

        def broken(db, job):
            calls.append(job.id)
            raise RuntimeError("email provider timeout")

        monkeypatch.setitem(outbox.HANDLERS, "item_event", broken)
        t0 = datetime.now(timezone.utc)

        assert _run_worker(now=t0) == 1
        job = _jobs()[0]
        assert (job.status, job.attempts) == ("pending", 1)
        assert "email provider timeout" in job.last_error
        assert job.next_run_at > t0  # backed off

        assert _run_worker(now=t0) == 0  # not due yet: not retried immediately
        assert len(calls) == 1

        later = t0
        for _ in range(10):  # keep time moving until it gives up
            later += timedelta(hours=1)
            _run_worker(now=later)
        job = _jobs()[0]
        assert job.status == "failed" and job.attempts == job.max_attempts
        assert len(calls) == job.max_attempts
        assert _run_worker(now=later + timedelta(days=1)) == 0  # failed jobs are left alone
        assert _notifications() == []

    def test_job_that_fails_once_then_succeeds(self, client, as_user, monkeypatch):
        client.post("/items", headers={**as_user(LEAD), "Idempotency-Key": "f2"}, json=item_body(assigneeId=7))
        real = outbox.handle_item_event
        state = {"calls": 0}

        def flaky(db, job):
            state["calls"] += 1
            real(db, job)  # does its writes first...
            if state["calls"] == 1:
                raise RuntimeError("crash after partial work")  # ...then fails

        monkeypatch.setitem(outbox.HANDLERS, "item_event", flaky)
        t0 = datetime.now(timezone.utc)
        _run_worker(now=t0)
        assert _notifications() == []  # the failed attempt's partial writes were rolled back
        _run_worker(now=t0 + timedelta(hours=1))
        assert [n.user_id for n in _notifications()] == [7]
        assert _jobs()[0].status == "done"

    def test_unknown_job_type_fails_cleanly(self):
        with SessionLocal() as db:
            db.add(OutboxJob(type="does_not_exist", payload={}, max_attempts=1))
            db.commit()
        _run_worker()
        job = _jobs()[0]
        assert job.status == "failed" and "No handler" in job.last_error

    def test_concurrent_workers_never_take_the_same_job(self, client, as_user, monkeypatch):
        for i in range(30):
            res = client.post(
                "/items", headers={**as_user(LEAD), "Idempotency-Key": f"bulk-{i}"}, json=item_body(assigneeId=7)
            )
            assert res.status_code == 201

        real = outbox.handle_item_event
        lock = threading.Lock()
        seen: list[int] = []

        def counting(db, job):
            with lock:
                seen.append(job.id)
            real(db, job)

        monkeypatch.setitem(outbox.HANDLERS, "item_event", counting)

        def worker():
            def run():
                total = 0
                with SessionLocal() as db:
                    while True:
                        n = outbox.process_batch(db, batch_size=4)
                        total += n
                        if n == 0:
                            return total

            return run

        totals = race(worker(), worker(), worker())
        assert sum(totals) == 30
        assert len(seen) == 30 and len(set(seen)) == 30  # every job handled exactly once
        assert all(j.status == "done" for j in _jobs())
        assert len(_notifications()) == 30
