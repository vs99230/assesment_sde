"""
The headline behaviours. Each test fires requests from several threads at the same instant,
each thread with its own client, against a real PostgreSQL database.
"""

import threading

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.db import SessionLocal
from app.main import app
from app.models import IdempotencyKey, OutboxJob, WorkItem
from app.services import items as items_service
from tests.conftest import ADMIN, LEAD, MEMBER, MEMBER2, item_body
from tests.helpers import count_events, fetch_item, race

PAYMENTS_USERS = [LEAD, MEMBER, MEMBER2, ADMIN]


@pytest.fixture
def both_read_before_either_writes(monkeypatch):
    """
    Forces the nastiest interleaving: two requests each READ the item (same version), and only then
    either of them WRITES. Without this, thread timing often lets the first request finish before the
    second one even reads, and a missing database-level guard would go unnoticed.
    """
    real = items_service.get_item_for_user
    barrier = threading.Barrier(2)

    def synced(db, user, item_id):
        result = real(db, user, item_id)
        barrier.wait(timeout=10)
        return result

    monkeypatch.setattr(items_service, "get_item_for_user", synced)


def _post_status(headers, path, **kw):
    """A call that uses its OWN client, so threads never share a connection."""

    def call():
        with TestClient(app) as c:
            res = c.post(path, headers=headers, **kw)
            return res.status_code, res.json()

    return call


class TestAtomicClaim:
    def test_exactly_one_of_four_simultaneous_claims_wins(self, as_user, make_item):
        for _ in range(8):  # repeat to give a race a real chance to show up
            item = make_item()
            results = race(*[_post_status(as_user(u), f"/items/{item['id']}/claim") for u in PAYMENTS_USERS])

            codes = sorted(code for code, _ in results)
            assert codes == [200, 409, 409, 409], codes

            winner_body = next(body for code, body in results if code == 200)
            for code, body in results:
                if code == 409:
                    assert body["error"]["code"] == "ALREADY_CLAIMED"
                    # losers are told who won, so the UI can show the truth
                    assert body["error"]["details"]["latest"]["assignee"]["id"] == winner_body["assignee"]["id"]

            stored = fetch_item(item["id"])
            assert stored.assignee_id == winner_body["assignee"]["id"]
            assert stored.version == item["version"] + 1  # bumped exactly once
            assert count_events(item["id"], "assignee_changed") == 1  # and logged exactly once

    def test_same_user_double_click_still_claims_once(self, as_user, make_item):
        item = make_item()
        h = as_user(MEMBER)
        results = race(*[_post_status(h, f"/items/{item['id']}/claim") for _ in range(5)])
        assert sorted(code for code, _ in results) == [200, 409, 409, 409, 409]
        assert fetch_item(item["id"]).version == 2


class TestOptimisticLocking:
    def test_two_edits_from_the_same_version_only_one_applies(
        self, client, as_user, make_item, both_read_before_either_writes
    ):
        item = make_item()
        v = item["version"]

        def patch(user, title):
            def call():
                with TestClient(app) as c:
                    res = c.patch(f"/items/{item['id']}", headers=as_user(user), json={"version": v, "title": title})
                    return res.status_code, res.json()

            return call

        (c1, b1), (c2, b2) = race(patch(LEAD, "Edit from Priya"), patch(ADMIN, "Edit from Aarav"))
        assert sorted([c1, c2]) == [200, 409]

        winner_title = b1["title"] if c1 == 200 else b2["title"]
        loser_body = b2 if c1 == 200 else b1
        assert loser_body["error"]["code"] == "VERSION_CONFLICT"
        assert loser_body["error"]["details"]["latest"]["title"] == winner_title

        stored = fetch_item(item["id"])
        assert stored.title == winner_title  # the loser did NOT overwrite the winner
        assert stored.version == v + 1

    def test_stale_edit_is_rejected_and_changes_nothing(self, client, as_user, make_item):
        item = make_item()
        ok = client.patch(f"/items/{item['id']}", headers=as_user(LEAD), json={"version": 1, "priority": "high"})
        assert ok.status_code == 200 and ok.json()["version"] == 2

        stale = client.patch(
            f"/items/{item['id']}", headers=as_user(ADMIN), json={"version": 1, "title": "Stale overwrite"}
        )
        assert stale.status_code == 409
        err = stale.json()["error"]
        assert err["code"] == "VERSION_CONFLICT"
        assert err["details"]["latest"]["version"] == 2
        assert err["details"]["latest"]["priority"] == "high"

        stored = fetch_item(item["id"])
        assert stored.title == item["title"]
        assert stored.version == 2

    def test_two_simultaneous_status_moves_only_one_applies(
        self, client, as_user, make_item, monkeypatch
    ):
        item = make_item(by=MEMBER2)
        claimed = client.post(f"/items/{item['id']}/claim", headers=as_user(MEMBER2)).json()
        started = client.post(
            f"/items/{item['id']}/transition",
            headers=as_user(MEMBER2),
            json={"to": "in_progress", "version": claimed["version"]},
        ).json()

        def move(user):
            return _post_status(
                as_user(user),
                f"/items/{item['id']}/transition",
                json={"to": "awaiting_approval", "version": started["version"]},
            )

        real = items_service.get_item_for_user
        barrier = threading.Barrier(2)

        def synced(db, user, item_id):
            result = real(db, user, item_id)
            barrier.wait(timeout=10)
            return result

        monkeypatch.setattr(items_service, "get_item_for_user", synced)  # only for the race below

        results = race(move(MEMBER2), move(LEAD))
        assert sorted(code for code, _ in results) == [200, 409]
        stored = fetch_item(item["id"])
        assert stored.status == "awaiting_approval"
        assert stored.version == started["version"] + 1
        assert count_events(item["id"], "status_changed") == 2  # in_progress + awaiting_approval, no duplicate


class TestIdempotentCreate:
    def test_six_simultaneous_identical_requests_create_one_item(self, as_user):
        h = {**as_user(MEMBER), "Idempotency-Key": "double-click-1"}
        body = item_body(title="Created in a race")

        results = race(*[_post_status(h, "/items", json=body) for _ in range(6)])

        assert [code for code, _ in results] == [201] * 6
        assert len({body["id"] for _, body in results}) == 1  # everybody got the SAME item back

        with SessionLocal() as db:
            assert db.scalar(select(func.count()).select_from(WorkItem)) == 1
            assert db.scalar(select(func.count()).select_from(OutboxJob)) == 1  # side effects happen once, too
            assert db.scalar(select(func.count()).select_from(IdempotencyKey)) == 1
        assert count_events(results[0][1]["id"], "created") == 1

    def test_same_key_from_different_users_does_not_collide(self, as_user):
        body = item_body()
        a, b = race(
            _post_status({**as_user(MEMBER), "Idempotency-Key": "shared"}, "/items", json=body),
            _post_status({**as_user(LEAD), "Idempotency-Key": "shared"}, "/items", json=body),
        )
        assert a[0] == b[0] == 201
        assert a[1]["id"] != b[1]["id"]
