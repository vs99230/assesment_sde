from app.models import User, WorkItem
from app.permissions import can_edit_item, check_transition, has_role
from app.errors import ApiError
import pytest

from tests.conftest import ADMIN, LEAD, MEMBER, MEMBER2, SUPPORT_LEAD, VIEWER, item_body


class TestAuthentication:
    def test_login_returns_token_and_memberships(self, client):
        res = client.post("/auth/login", json={"email": "PRIYA.lead@ops.test ", "password": "Password@123"})
        assert res.status_code == 200
        body = res.json()
        assert body["token"]
        roles = {m["teamName"]: m["role"] for m in body["user"]["memberships"]}
        assert roles == {"Payments": "lead", "Support": "member"}

    def test_wrong_password_and_unknown_email_look_the_same(self, client):
        a = client.post("/auth/login", json={"email": "priya.lead@ops.test", "password": "nope"})
        b = client.post("/auth/login", json={"email": "nobody@ops.test", "password": "nope"})
        assert a.status_code == b.status_code == 401
        assert a.json() == b.json()

    def test_requests_without_or_with_bad_token_are_401(self, client):
        assert client.get("/items").status_code == 401
        res = client.get("/items", headers={"Authorization": "Bearer not-a-token"})
        assert res.status_code == 401
        assert res.json()["error"]["code"] == "UNAUTHENTICATED"

    def test_me(self, client, as_user):
        res = client.get("/auth/me", headers=as_user(LEAD))
        assert res.status_code == 200
        assert res.json()["email"] == LEAD

    def test_error_format_for_unknown_route(self, client):
        res = client.get("/nope")
        assert res.status_code == 404
        assert set(res.json()["error"]) >= {"code", "message"}


class TestTeamScoping:
    """Outsiders must not be able to read OR write items of other teams, and must not learn they exist."""

    def test_other_teams_items_are_invisible_everywhere(self, client, as_user, make_item):
        support_item = make_item(by=SUPPORT_LEAD, teamId=2, type="customer_issue")
        outsider = as_user(MEMBER2)  # Payments only

        assert client.get(f"/items/{support_item['id']}", headers=outsider).status_code == 404
        assert client.get(f"/items/{support_item['id']}/activity", headers=outsider).status_code == 404
        assert client.post(f"/items/{support_item['id']}/claim", headers=outsider).status_code == 404
        assert client.post(f"/items/{support_item['id']}/comments", json={"body": "hi"}, headers=outsider).status_code == 404
        res = client.patch(f"/items/{support_item['id']}", json={"version": 1, "title": "Hacked title"}, headers=outsider)
        assert res.status_code == 404
        res = client.post(f"/items/{support_item['id']}/transition", json={"to": "in_progress", "version": 1}, headers=outsider)
        assert res.status_code == 404

        listing = client.get("/items", headers=outsider).json()["items"]
        assert support_item["id"] not in [i["id"] for i in listing]
        assert client.get("/items?teamId=2", headers=outsider).json()["items"] == []
        assert client.get("/teams/2/members", headers=outsider).status_code == 404

    def test_dashboard_only_counts_own_teams(self, client, as_user, make_item):
        make_item(by=SUPPORT_LEAD, teamId=2, type="customer_issue", priority="urgent")
        d = client.get("/dashboard", headers=as_user(MEMBER2)).json()
        assert d["unassignedUrgent"]["total"] == 0

    def test_admin_sees_every_team(self, client, as_user, make_item):
        a = make_item(by=SUPPORT_LEAD, teamId=2, type="customer_issue")
        b = make_item(by=LEAD, teamId=1)
        ids = [i["id"] for i in client.get("/items", headers=as_user(ADMIN)).json()["items"]]
        assert {a["id"], b["id"]} <= set(ids)


class TestRolePermissions:
    def test_viewer_is_read_only(self, client, as_user, make_item):
        item = make_item()
        v = as_user(VIEWER)
        assert client.get(f"/items/{item['id']}", headers=v).status_code == 200
        assert client.post("/items", json=item_body(), headers={**v, "Idempotency-Key": "v1"}).status_code == 403
        assert client.post(f"/items/{item['id']}/claim", headers=v).status_code == 403
        assert client.post(f"/items/{item['id']}/comments", json={"body": "x"}, headers=v).status_code == 403
        assert client.patch(f"/items/{item['id']}", json={"version": 1, "priority": "high"}, headers=v).status_code == 403

    def test_cannot_create_in_a_team_you_are_not_in(self, client, as_user):
        res = client.post("/items", json=item_body(teamId=3), headers={**as_user(MEMBER2), "Idempotency-Key": "k"})
        assert res.status_code == 403

    def test_only_leads_can_assign_on_create_or_reassign(self, client, as_user, make_item):
        res = client.post(
            "/items",
            json=item_body(assigneeId=7),
            headers={**as_user(MEMBER), "Idempotency-Key": "m-assign"},
        )
        assert res.status_code == 403

        item = make_item(by=MEMBER, assigneeId=None)
        claimed = client.post(f"/items/{item['id']}/claim", headers=as_user(MEMBER)).json()
        res = client.patch(
            f"/items/{item['id']}", json={"version": claimed["version"], "assigneeId": 7}, headers=as_user(MEMBER)
        )
        assert res.status_code == 403

        res = client.patch(
            f"/items/{item['id']}", json={"version": claimed["version"], "assigneeId": 7}, headers=as_user(LEAD)
        )
        assert res.status_code == 200
        assert res.json()["assignee"]["id"] == 7

    def test_cannot_assign_a_viewer_or_outsider(self, client, as_user, make_item):
        item = make_item()
        for bad_user in (10, 3):  # Meera (viewer in Payments), Rohan (not in Payments)
            res = client.patch(
                f"/items/{item['id']}", json={"version": item["version"], "assigneeId": bad_user}, headers=as_user(LEAD)
            )
            assert res.status_code == 422, res.text
            assert "assigneeId" in res.json()["error"]["details"]["fields"]

    def test_member_can_only_edit_own_items(self, client, as_user, make_item):
        item = make_item(by=LEAD)  # created by a lead, unassigned
        res = client.patch(
            f"/items/{item['id']}", json={"version": item["version"], "title": "Member edit"}, headers=as_user(MEMBER)
        )
        assert res.status_code == 403


class TestPermissionFunctionsDirectly:
    """Unit tests for the single permission module, no HTTP involved."""

    def _item(self, **kw):
        base = dict(status="open", assignee_id=None, created_by_id=1)
        base.update(kw)
        return WorkItem(**base)

    def test_role_ranking(self):
        assert has_role("admin", "lead") and has_role("lead", "member")
        assert not has_role("viewer", "member") and not has_role(None, "viewer")

    def test_edit_rules(self):
        assert can_edit_item(self._item(), "lead", 99)
        assert can_edit_item(self._item(assignee_id=5), "member", 5)
        assert not can_edit_item(self._item(assignee_id=5), "member", 6)
        assert not can_edit_item(self._item(status="closed"), "admin", 1)

    def test_only_leads_approve(self):
        item = self._item(status="awaiting_approval", assignee_id=5)
        with pytest.raises(ApiError) as e:
            check_transition(item, "resolved", "member", 5)
        assert e.value.status == 403
        check_transition(item, "resolved", "lead", 9)  # no exception

    def test_invalid_jump_rejected(self):
        with pytest.raises(ApiError) as e:
            check_transition(self._item(assignee_id=5), "closed", "admin", 1)
        assert e.value.code == "INVALID_TRANSITION"
