from tests.conftest import ADMIN, LEAD, MEMBER, MEMBER2, VIEWER, item_body
from tests.helpers import count_events, fetch_item


def move(client, headers, item, to, version=None):
    return client.post(
        f"/items/{item['id']}/transition",
        headers=headers,
        json={"to": to, "version": version if version is not None else item["version"]},
    )


class TestWorkflow:
    def test_happy_path_to_closed(self, client, as_user, make_item):
        item = make_item(by=MEMBER)
        item = client.post(f"/items/{item['id']}/claim", headers=as_user(MEMBER)).json()
        assert item["status"] == "open" and item["assignee"]["name"] == "Ishita Member"

        for actor, to in [
            (MEMBER, "in_progress"),
            (MEMBER, "awaiting_approval"),
            (LEAD, "resolved"),
            (LEAD, "closed"),
        ]:
            before = item["version"]
            res = move(client, as_user(actor), item, to)
            assert res.status_code == 200, res.text
            item = res.json()
            assert item["status"] == to
            assert item["version"] == before + 1

    def test_invalid_jumps_are_rejected(self, client, as_user, make_item):
        item = make_item()
        for to in ("closed", "resolved", "awaiting_approval", "open"):
            res = move(client, as_user(ADMIN), item, to)
            assert res.status_code == 422, (to, res.text)
            assert res.json()["error"]["code"] == "INVALID_TRANSITION"
        assert fetch_item(item["id"]).status == "open"

    def test_cannot_start_work_without_an_assignee(self, client, as_user, make_item):
        item = make_item()
        res = move(client, as_user(LEAD), item, "in_progress")
        assert res.status_code == 422
        assert res.json()["error"]["code"] == "INVALID_TRANSITION"

    def test_only_a_lead_can_approve_and_member_gets_403(self, client, as_user, make_item):
        item = make_item(by=MEMBER)
        item = client.post(f"/items/{item['id']}/claim", headers=as_user(MEMBER)).json()
        item = move(client, as_user(MEMBER), item, "in_progress").json()
        item = move(client, as_user(MEMBER), item, "awaiting_approval").json()

        res = move(client, as_user(MEMBER), item, "resolved")  # approving your own work
        assert res.status_code == 403
        assert fetch_item(item["id"]).status == "awaiting_approval"

        res = move(client, as_user(MEMBER2), item, "resolved")  # another member
        assert res.status_code == 403

        assert move(client, as_user(LEAD), item, "resolved").status_code == 200

    def test_lead_can_send_back_for_rework(self, client, as_user, make_item):
        item = make_item(by=MEMBER)
        item = client.post(f"/items/{item['id']}/claim", headers=as_user(MEMBER)).json()
        item = move(client, as_user(MEMBER), item, "in_progress").json()
        item = move(client, as_user(MEMBER), item, "awaiting_approval").json()
        back = move(client, as_user(LEAD), item, "in_progress")
        assert back.status_code == 200 and back.json()["status"] == "in_progress"

    def test_only_the_assignee_or_a_lead_can_work_the_item(self, client, as_user, make_item):
        item = make_item(by=MEMBER)
        item = client.post(f"/items/{item['id']}/claim", headers=as_user(MEMBER)).json()
        assert move(client, as_user(MEMBER2), item, "in_progress").status_code == 403
        assert move(client, as_user(VIEWER), item, "in_progress").status_code == 403
        assert move(client, as_user(LEAD), item, "in_progress").status_code == 200

    def test_stale_version_on_a_move_is_a_conflict(self, client, as_user, make_item):
        item = make_item()
        claimed = client.post(f"/items/{item['id']}/claim", headers=as_user(LEAD)).json()
        res = move(client, as_user(LEAD), claimed, "in_progress", version=claimed["version"] - 1)
        assert res.status_code == 409
        assert res.json()["error"]["details"]["latest"]["version"] == claimed["version"]
        assert fetch_item(item["id"]).status == "open"

    def test_closed_items_cannot_be_edited(self, client, as_user, make_item):
        item = make_item(by=MEMBER)
        item = client.post(f"/items/{item['id']}/claim", headers=as_user(MEMBER)).json()
        for actor, to in [(MEMBER, "in_progress"), (MEMBER, "awaiting_approval"), (LEAD, "resolved"), (LEAD, "closed")]:
            item = move(client, as_user(actor), item, to).json()
        res = client.patch(f"/items/{item['id']}", headers=as_user(ADMIN), json={"version": item["version"], "title": "Nope nope"})
        assert res.status_code == 422
        assert "closed" in res.json()["error"]["message"].lower()

    def test_claiming_a_non_open_item_is_rejected(self, client, as_user, make_item):
        item = make_item(by=LEAD, assigneeId=None)
        item = client.post(f"/items/{item['id']}/claim", headers=as_user(MEMBER)).json()
        item = move(client, as_user(MEMBER), item, "in_progress").json()
        assert client.post(f"/items/{item['id']}/claim", headers=as_user(MEMBER2)).status_code == 409


class TestEditing:
    def test_one_save_bumps_version_once_and_logs_each_change(self, client, as_user, make_item):
        item = make_item()
        res = client.patch(
            f"/items/{item['id']}",
            headers=as_user(LEAD),
            json={"version": item["version"], "title": "A new title", "priority": "urgent", "dueDate": "2026-12-01"},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["version"] == item["version"] + 1
        assert (body["title"], body["priority"], body["dueDate"]) == ("A new title", "urgent", "2026-12-01")

        events = client.get(f"/items/{item['id']}/activity", headers=as_user(LEAD)).json()["items"]
        kinds = {e["type"]: e for e in events}
        assert kinds["priority_changed"]["from"] == "medium" and kinds["priority_changed"]["to"] == "urgent"
        assert "title" in kinds["field_updated"]["to"] and "due date" in kinds["field_updated"]["to"]

    def test_saving_without_changes_does_nothing(self, client, as_user, make_item):
        item = make_item()
        res = client.patch(
            f"/items/{item['id']}", headers=as_user(LEAD), json={"version": item["version"], "title": item["title"]}
        )
        assert res.status_code == 200
        assert res.json()["version"] == item["version"]
        assert count_events(item["id"]) == 1  # only "created"

    def test_due_date_can_be_cleared(self, client, as_user, make_item):
        item = make_item(dueDate="2026-12-01")
        res = client.patch(
            f"/items/{item['id']}", headers=as_user(LEAD), json={"version": item["version"], "dueDate": None}
        )
        assert res.status_code == 200 and res.json()["dueDate"] is None

    def test_version_is_required(self, client, as_user, make_item):
        item = make_item()
        res = client.patch(f"/items/{item['id']}", headers=as_user(LEAD), json={"title": "No version sent"})
        assert res.status_code == 422
        assert "version" in res.json()["error"]["details"]["fields"]


class TestCreateAndValidation:
    def test_create_returns_full_item(self, client, as_user):
        res = client.post(
            "/items",
            headers={**as_user(LEAD), "Idempotency-Key": "c1"},
            json=item_body(title="  Padded title  ", assigneeId=7, dueDate="2026-11-20"),
        )
        assert res.status_code == 201
        b = res.json()
        assert b["title"] == "Padded title"
        assert b["status"] == "open" and b["version"] == 1
        assert b["assignee"]["id"] == 7 and b["createdBy"]["name"] == "Priya Lead"
        assert b["team"] == {"id": 1, "name": "Payments"}
        events = client.get(f"/items/{b['id']}/activity", headers=as_user(LEAD)).json()["items"]
        assert {e["type"] for e in events} == {"created", "assignee_changed"}

    def test_validation_errors_name_the_field(self, client, as_user):
        h = {**as_user(LEAD), "Idempotency-Key": "bad"}
        res = client.post("/items", headers=h, json=item_body(title="ab", priority="critical", type="nope"))
        assert res.status_code == 422
        fields = res.json()["error"]["details"]["fields"]
        assert {"title", "priority", "type"} <= set(fields)

    def test_rejected_request_does_not_burn_the_idempotency_key(self, client, as_user):
        h = {**as_user(LEAD), "Idempotency-Key": "retry-me"}
        assert client.post("/items", headers=h, json=item_body(title="x")).status_code == 422
        assert client.post("/items", headers=h, json=item_body(title="Now it is valid")).status_code == 201

    def test_comments(self, client, as_user, make_item):
        item = make_item()
        ok = client.post(f"/items/{item['id']}/comments", headers=as_user(MEMBER), json={"body": "  On it.  "})
        assert ok.status_code == 201
        assert ok.json()["body"] == "On it." and ok.json()["actor"]["name"] == "Ishita Member"
        assert fetch_item(item["id"]).version == item["version"]  # comments do not bump the version

        assert client.post(f"/items/{item['id']}/comments", headers=as_user(MEMBER), json={"body": "   "}).status_code == 422
        too_long = client.post(f"/items/{item['id']}/comments", headers=as_user(MEMBER), json={"body": "x" * 2001})
        assert too_long.status_code == 422

    def test_activity_is_newest_first_and_paginates(self, client, as_user, make_item):
        item = make_item()
        for i in range(5):
            client.post(f"/items/{item['id']}/comments", headers=as_user(MEMBER), json={"body": f"c{i}"})
        first = client.get(f"/items/{item['id']}/activity?limit=4", headers=as_user(LEAD)).json()
        assert [e["body"] for e in first["items"]][:2] == ["c4", "c3"]
        assert first["nextCursor"]
        second = client.get(
            f"/items/{item['id']}/activity?limit=4&cursor={first['nextCursor']}", headers=as_user(LEAD)
        ).json()
        assert len(second["items"]) == 2 and second["nextCursor"] is None
        ids = [e["id"] for e in first["items"] + second["items"]]
        assert ids == sorted(ids, reverse=True) and len(set(ids)) == 6
