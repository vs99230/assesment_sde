from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import WorkItem
from app.seed import seed_items
from tests.conftest import ADMIN, LEAD, MEMBER2, SUPPORT_LEAD

BULK = 1500


def _seed_bulk():
    with SessionLocal() as db:
        seed_items(db, BULK)
        db.commit()


def _walk(client, headers, query="", limit=100):
    """Follows nextCursor until the end. Returns every item id in the order received."""
    ids, cursor, pages = [], None, 0
    while True:
        url = f"/items?limit={limit}{query}" + (f"&cursor={cursor}" if cursor else "")
        body = client.get(url, headers=headers).json()
        ids += [i["id"] for i in body["items"]]
        cursor = body["nextCursor"]
        pages += 1
        assert pages < 200, "pagination did not terminate"
        if not cursor:
            return ids


class TestPagination:
    def test_walks_every_item_exactly_once_newest_first(self, client, as_user):
        _seed_bulk()
        ids = _walk(client, as_user(ADMIN))
        assert len(ids) == BULK
        assert len(set(ids)) == BULK  # no duplicates
        assert ids == sorted(ids, reverse=True)  # stable order, no gaps

    def test_new_items_during_paging_do_not_shift_pages(self, client, as_user, make_item):
        _seed_bulk()
        h = as_user(ADMIN)
        first = client.get("/items?limit=50", headers=h).json()
        make_item(by=LEAD)  # arrives while the user is on page 1
        second = client.get(f"/items?limit=50&cursor={first['nextCursor']}", headers=h).json()
        assert not ({i["id"] for i in first["items"]} & {i["id"] for i in second["items"]})

    def test_limit_and_cursor_are_validated(self, client, as_user):
        h = as_user(LEAD)
        assert client.get("/items?limit=0", headers=h).status_code == 422
        assert client.get("/items?limit=101", headers=h).status_code == 422
        assert client.get("/items?cursor=abc", headers=h).status_code == 422
        assert client.get("/items?status=bogus", headers=h).status_code == 422


class TestFilters:
    def test_only_own_team_items_are_listed(self, client, as_user):
        _seed_bulk()
        ids = _walk(client, as_user(MEMBER2))  # Payments only
        with SessionLocal() as db:
            expected = db.scalar(select(func.count()).select_from(WorkItem).where(WorkItem.team_id == 1))
            others = db.scalar(select(func.count()).select_from(WorkItem).where(WorkItem.id.in_(ids), WorkItem.team_id != 1))
        assert len(ids) == expected and others == 0

    def test_status_priority_type_assignee_filters(self, client, as_user):
        _seed_bulk()
        h = as_user(ADMIN)
        rows = client.get("/items?status=open&priority=urgent&assignee=unassigned&limit=100", headers=h).json()["items"]
        assert rows and all(r["status"] == "open" and r["priority"] == "urgent" and r["assignee"] is None for r in rows)

        rows = client.get("/items?type=payment&teamId=1&limit=100", headers=h).json()["items"]
        assert rows and all(r["type"] == "payment" and r["team"]["id"] == 1 for r in rows)

        me = client.get("/auth/me", headers=as_user(LEAD)).json()["id"]
        rows = client.get("/items?assignee=me&limit=100", headers=as_user(LEAD)).json()["items"]
        assert rows and all(r["assignee"]["id"] == me for r in rows)

    def test_search_title_and_description_and_ops_id(self, client, as_user, make_item):
        h = as_user(LEAD)
        a = make_item(title="Settlement mismatch for batch 42", description="nothing special")
        b = make_item(title="Something else entirely", description="Mentions the SETTLEMENT queue")
        make_item(title="Unrelated", description="Unrelated")

        found = {i["id"] for i in client.get("/items?q=settlement", headers=h).json()["items"]}
        assert found == {a["id"], b["id"]}  # case-insensitive, title OR description

        by_id = client.get(f"/items?q=OPS-{a['id']}", headers=h).json()["items"]
        assert [i["id"] for i in by_id] == [a["id"]]

    def test_search_treats_percent_and_underscore_literally(self, client, as_user, make_item):
        h = as_user(LEAD)
        hit = make_item(title="Discount of 100% applied", description="x")
        make_item(title="Discount of 1000 applied", description="x")
        make_item(title="snake_case name", description="x")
        make_item(title="snakeXcase name", description="x")

        assert [i["id"] for i in client.get("/items?q=100%25", headers=h).json()["items"]] == [hit["id"]]
        names = [i["title"] for i in client.get("/items?q=snake_case", headers=h).json()["items"]]
        assert names == ["snake_case name"]


class TestDashboard:
    def test_views_match_their_definitions_and_totals_are_exact(self, client, as_user):
        _seed_bulk()
        body = client.get("/dashboard", headers=as_user(LEAD)).json()
        me = client.get("/auth/me", headers=as_user(LEAD)).json()["id"]

        mine, urgent, approval = body["assignedToMe"], body["unassignedUrgent"], body["awaitingMyApproval"]
        assert all(i["assignee"]["id"] == me and i["status"] not in ("resolved", "closed") for i in mine["items"])
        assert all(i["priority"] == "urgent" and i["assignee"] is None and i["status"] == "open" for i in urgent["items"])
        assert all(i["status"] == "awaiting_approval" and i["team"]["id"] == 1 for i in approval["items"])  # Priya leads Payments only
        assert len(mine["items"]) <= 5 and mine["total"] >= len(mine["items"])

        with SessionLocal() as db:
            expect_urgent = db.scalar(
                select(func.count()).select_from(WorkItem).where(
                    WorkItem.team_id.in_((1, 2)),
                    WorkItem.assignee_id.is_(None),
                    WorkItem.priority == "urgent",
                    WorkItem.status == "open",
                )
            )
            expect_approval = db.scalar(
                select(func.count()).select_from(WorkItem).where(WorkItem.team_id == 1, WorkItem.status == "awaiting_approval")
            )
        assert urgent["total"] == expect_urgent
        assert approval["total"] == expect_approval

    def test_view_filter_on_list_matches_dashboard_total(self, client, as_user):
        _seed_bulk()
        h = as_user(SUPPORT_LEAD)
        total = client.get("/dashboard", headers=h).json()["awaitingMyApproval"]["total"]
        assert len(_walk(client, h, "&view=awaiting_my_approval")) == total

    def test_member_never_sees_approval_queue(self, client, as_user):
        _seed_bulk()
        assert client.get("/dashboard", headers=as_user(MEMBER2)).json()["awaitingMyApproval"]["total"] == 0


class TestQueryPlans:
    """Guards the indexes: the hot queries must not scan the whole table."""

    def test_list_and_dashboard_use_indexes(self):
        _seed_bulk()
        from sqlalchemy import text

        with SessionLocal() as db:
            db.execute(text("ANALYZE work_items"))
            plans = {
                "list by team/status": "SELECT id FROM work_items WHERE team_id IN (1,2) AND status = 'open' ORDER BY id DESC LIMIT 21",
                "unassigned urgent": "SELECT id FROM work_items WHERE team_id IN (1,2) AND assignee_id IS NULL AND priority='urgent' AND status='open' ORDER BY id DESC LIMIT 5",
                "assigned to me": "SELECT id FROM work_items WHERE assignee_id = 2 AND status NOT IN ('resolved','closed') ORDER BY id DESC LIMIT 5",
            }
            for name, sql in plans.items():
                plan = "\n".join(r[0] for r in db.execute(text("EXPLAIN " + sql)))
                assert "Index" in plan or "Bitmap" in plan, f"{name} is not using an index:\n{plan}"
