"""
Business logic for work items.

Concurrency rules used here (see ENGINEERING_DECISIONS.md):
  * claim        -> ONE conditional UPDATE ("... WHERE assignee_id IS NULL"). The database decides the winner.
  * edit / move  -> UPDATE ... WHERE version = <what the client saw>. Zero rows updated = someone got there first.
  * create       -> Idempotency-Key row is inserted first; a duplicate request waits for, then reuses, the first.
  * every write  -> activity row + outbox job are written in the SAME transaction, then ONE commit.
"""

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app import permissions as perm
from app.errors import ApiError, invalid_transition, not_found, validation_error
from app.models import ActivityEvent, IdempotencyKey, Membership, User, WorkItem
from app.schemas import (
    ActivityOut,
    CommentIn,
    CreateItemIn,
    DashboardOut,
    DashboardSection,
    TransitionIn,
    UpdateItemIn,
    UserRef,
    WorkItemOut,
)
from app.services import outbox

DASHBOARD_LIMIT = 5


# ---------- small helpers ----------


def _reload(db: Session, item_id: int) -> WorkItem | None:
    """Fresh copy straight from the database (ignores anything cached in the session)."""
    return db.execute(
        select(WorkItem).where(WorkItem.id == item_id).execution_options(populate_existing=True)
    ).scalar_one_or_none()


def get_item_for_user(db: Session, user: User, item_id: int) -> tuple[WorkItem, str]:
    """The item and the caller's role in its team. Items of teams the caller isn't in do not exist (404)."""
    item = _reload(db, item_id)
    if item is None:
        raise not_found("Item not found.")
    return item, perm.visible_role(user, item.team_id)


def _conflict(db: Session, item_id: int, code: str = "VERSION_CONFLICT", message: str | None = None) -> ApiError:
    """409 that carries the item's CURRENT state, so the client can show it instead of its stale copy."""
    db.rollback()
    latest = _reload(db, item_id)
    details = {"latest": jsonable_encoder(WorkItemOut.model_validate(latest))} if latest else None
    return ApiError(409, code, message or "The item was modified by someone else.", details)


def _event(
    db: Session,
    item_id: int,
    type_: str,
    actor_id: int,
    from_value: str | None = None,
    to_value: str | None = None,
    body: str | None = None,
) -> ActivityEvent:
    ev = ActivityEvent(
        item_id=item_id, type=type_, actor_id=actor_id, from_value=from_value, to_value=to_value, body=body
    )
    db.add(ev)
    return ev


def _assert_assignable(db: Session, team_id: int, user_id: int) -> User:
    membership = db.get(Membership, (user_id, team_id))
    if membership is None or not perm.assignable(membership.role):
        raise validation_error({"assigneeId": "Choose a team member who can work on items."})
    return db.get(User, user_id)  # type: ignore[return-value]


def activity_out(ev: ActivityEvent, actor: User | None = None) -> ActivityOut:
    who = actor or ev.actor
    return ActivityOut(
        id=ev.id,
        item_id=ev.item_id,
        type=ev.type,  # type: ignore[arg-type]
        actor=UserRef(id=who.id, name=who.name),
        from_=ev.from_value,
        to=ev.to_value,
        body=ev.body,
        created_at=ev.created_at,
    )


# ---------- reading ----------


@dataclass
class ItemFilters:
    status: str | None = None
    priority: str | None = None
    type: str | None = None
    team_id: int | None = None
    assignee: str | None = None
    q: str | None = None
    view: str | None = None


def _escape_like(text_: str) -> str:
    return text_.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")


def _view_condition(user: User, view: str):
    if view == "assigned_to_me":
        return and_(WorkItem.assignee_id == user.id, WorkItem.status.notin_(("resolved", "closed")))
    if view == "unassigned_urgent":
        return and_(WorkItem.assignee_id.is_(None), WorkItem.priority == "urgent", WorkItem.status == "open")
    if view == "awaiting_my_approval":
        return and_(WorkItem.status == "awaiting_approval", WorkItem.team_id.in_(perm.lead_team_ids(user)))
    raise validation_error({"view": "Unknown view."})


def _conditions(user: User, f: ItemFilters) -> list[Any]:
    # Team scoping is applied to EVERY query: items of other teams never leave the database.
    conds: list[Any] = [WorkItem.team_id.in_(perm.team_ids(user))]
    if f.status:
        conds.append(WorkItem.status == f.status)
    if f.priority:
        conds.append(WorkItem.priority == f.priority)
    if f.type:
        conds.append(WorkItem.type == f.type)
    if f.team_id:
        conds.append(WorkItem.team_id == f.team_id)
    if f.assignee == "me":
        conds.append(WorkItem.assignee_id == user.id)
    elif f.assignee == "unassigned":
        conds.append(WorkItem.assignee_id.is_(None))
    elif f.assignee and f.assignee.isdigit():
        conds.append(WorkItem.assignee_id == int(f.assignee))
    if f.q and f.q.strip():
        q = f.q.strip()
        m = re.fullmatch(r"(?i)ops-(\d+)", q)
        if m:
            conds.append(WorkItem.id == int(m.group(1)))
        else:
            pattern = f"%{_escape_like(q)}%"
            conds.append(
                or_(WorkItem.title.ilike(pattern, escape="\\"), WorkItem.description.ilike(pattern, escape="\\"))
            )
    if f.view:
        conds.append(_view_condition(user, f.view))
    return conds


def _parse_cursor(cursor: str | None) -> int | None:
    if cursor is None or cursor == "":
        return None
    if not cursor.isdigit() or len(cursor) > 18:
        raise validation_error({"cursor": "Invalid cursor."}, "Invalid cursor.")
    return int(cursor)


def list_items(
    db: Session, user: User, f: ItemFilters, cursor: str | None, limit: int
) -> tuple[list[WorkItem], str | None]:
    """Keyset pagination on id: constant cost per page however deep, and no skipped/duplicated rows."""
    conds = _conditions(user, f)
    before = _parse_cursor(cursor)
    if before is not None:
        conds.append(WorkItem.id < before)
    rows = db.scalars(select(WorkItem).where(*conds).order_by(WorkItem.id.desc()).limit(limit + 1)).all()
    page = list(rows[:limit])
    next_cursor = str(page[-1].id) if len(rows) > limit and page else None
    return page, next_cursor


def dashboard(db: Session, user: User) -> DashboardOut:
    def section(view: str) -> DashboardSection:
        conds = _conditions(user, ItemFilters(view=view))
        total = db.scalar(select(func.count()).select_from(WorkItem).where(*conds)) or 0
        items = db.scalars(select(WorkItem).where(*conds).order_by(WorkItem.id.desc()).limit(DASHBOARD_LIMIT)).all()
        return DashboardSection(total=total, items=[WorkItemOut.model_validate(i) for i in items])

    return DashboardOut(
        assigned_to_me=section("assigned_to_me"),
        unassigned_urgent=section("unassigned_urgent"),
        awaiting_my_approval=section("awaiting_my_approval"),
    )


def list_activity(
    db: Session, user: User, item_id: int, cursor: str | None, limit: int
) -> tuple[list[ActivityEvent], str | None]:
    get_item_for_user(db, user, item_id)
    conds: list[Any] = [ActivityEvent.item_id == item_id]
    before = _parse_cursor(cursor)
    if before is not None:
        conds.append(ActivityEvent.id < before)
    rows = db.scalars(select(ActivityEvent).where(*conds).order_by(ActivityEvent.id.desc()).limit(limit + 1)).all()
    page = list(rows[:limit])
    return page, (str(page[-1].id) if len(rows) > limit and page else None)


def team_members(db: Session, user: User, team_id: int) -> list[dict[str, Any]]:
    if perm.role_in_team(user, team_id) is None:
        raise not_found("Team not found.")
    rows = db.execute(
        select(User.id, User.name, Membership.role)
        .join(Membership, Membership.user_id == User.id)
        .where(Membership.team_id == team_id)
        .order_by(User.name)
    ).all()
    return [{"id": r.id, "name": r.name, "role": r.role} for r in rows]


# ---------- writing ----------


def create_item(db: Session, user: User, data: CreateItemIn, idempotency_key: str) -> dict[str, Any]:
    role = perm.role_in_team(user, data.team_id)
    perm.require_member(role, "create items")
    if data.assignee_id is not None:
        perm.require_lead(role, "Only Leads can assign an item when creating it.")
        _assert_assignable(db, data.team_id, data.assignee_id)

    request_hash = hashlib.sha256(
        json.dumps(
            {
                "title": data.title,
                "description": data.description,
                "type": data.type,
                "priority": data.priority,
                "teamId": data.team_id,
                "dueDate": data.due_date.isoformat() if data.due_date else None,
                "assigneeId": data.assignee_id,
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()

    # Reserve the key. If another request with the same (user, key) is still in flight, this INSERT
    # BLOCKS until that transaction finishes, then does nothing, so a double-click can never create two items.
    reserved = db.execute(
        pg_insert(IdempotencyKey)
        .values(user_id=user.id, key=idempotency_key, request_hash=request_hash)
        .on_conflict_do_nothing()
        .returning(IdempotencyKey.key)
    ).first()

    if reserved is None:  # seen before: replay the stored answer
        prior = db.execute(
            select(IdempotencyKey)
            .where(IdempotencyKey.user_id == user.id, IdempotencyKey.key == idempotency_key)
            .execution_options(populate_existing=True)
        ).scalar_one()
        if prior.request_hash != request_hash:
            raise ApiError(422, "IDEMPOTENCY_KEY_REUSED", "This request key was already used with different data.")
        if prior.response is None:  # cannot normally happen: the row and its response commit together
            raise ApiError(409, "UNKNOWN", "A request with this key is still being processed. Retry shortly.")
        return prior.response

    assignee = db.get(User, data.assignee_id) if data.assignee_id is not None else None
    item = WorkItem(
        title=data.title,
        description=data.description,
        type=data.type,
        priority=data.priority,
        status="open",
        team_id=data.team_id,
        assignee_id=data.assignee_id,
        created_by_id=user.id,
        due_date=data.due_date,
        version=1,
    )
    db.add(item)
    db.flush()
    _event(db, item.id, "created", user.id)
    if assignee is not None:
        _event(db, item.id, "assignee_changed", user.id, None, assignee.name)
    outbox.enqueue_item_event(db, item.id, "created", user.id, assigneeId=data.assignee_id)

    fresh = _reload(db, item.id)
    response = jsonable_encoder(WorkItemOut.model_validate(fresh))
    db.execute(
        update(IdempotencyKey)
        .where(IdempotencyKey.user_id == user.id, IdempotencyKey.key == idempotency_key)
        .values(response=response, status_code=201)
    )
    db.commit()
    return response


def update_item(db: Session, user: User, item_id: int, data: UpdateItemIn) -> WorkItem:
    item, role = get_item_for_user(db, user, item_id)
    perm.require_member(role, "edit items")
    if item.status == "closed":
        raise validation_error(message="Closed items cannot be edited.")
    perm.require_can_edit(item, role, user.id)
    if data.version != item.version:  # quick rejection; the UPDATE below is what makes it race-proof
        raise _conflict(db, item.id)

    sent = data.model_fields_set
    changes: dict[str, Any] = {}
    edited: list[str] = []
    priority_change: tuple[str, str] | None = None
    assignee_change: tuple[str | None, User, int] | None = None

    if data.title is not None and data.title != item.title:
        changes["title"] = data.title
        edited.append("title")
    if data.description is not None and data.description != item.description:
        changes["description"] = data.description
        edited.append("description")
    if "due_date" in sent and data.due_date != item.due_date:
        changes["due_date"] = data.due_date
        edited.append("due date")
    if data.priority is not None and data.priority != item.priority:
        priority_change = (item.priority, data.priority)
        changes["priority"] = data.priority
    if "assignee_id" in sent:
        if data.assignee_id is None:
            raise validation_error({"assigneeId": "Choose a team member."})
        if data.assignee_id != item.assignee_id:
            perm.require_lead(role, "Only Leads can reassign items.")
            new_assignee = _assert_assignable(db, item.team_id, data.assignee_id)
            assignee_change = (item.assignee.name if item.assignee else None, new_assignee, new_assignee.id)
            changes["assignee_id"] = new_assignee.id

    if not changes:
        return item  # nothing to do: no version bump, no noise in the activity log

    result = db.execute(
        update(WorkItem)
        .where(WorkItem.id == item.id, WorkItem.version == data.version)  # <- the optimistic lock
        .values(**changes, version=data.version + 1, updated_at=func.now())
        .execution_options(synchronize_session=False)
    )
    if result.rowcount == 0:
        raise _conflict(db, item.id)

    if edited:
        _event(db, item.id, "field_updated", user.id, None, ", ".join(edited))
    if priority_change:
        _event(db, item.id, "priority_changed", user.id, *priority_change)
    if assignee_change:
        old_name, new_user, _ = assignee_change
        _event(db, item.id, "assignee_changed", user.id, old_name, new_user.name)
        outbox.enqueue_item_event(db, item.id, "assigned", user.id, assigneeId=new_user.id)
    db.commit()
    return _reload(db, item.id)  # type: ignore[return-value]


def claim_item(db: Session, user: User, item_id: int) -> WorkItem:
    item, role = get_item_for_user(db, user, item_id)
    perm.require_member(role, "claim items")

    # The whole race is decided by this single statement: only one concurrent caller can match
    # "assignee_id IS NULL"; the others update zero rows. No read-then-write gap, no explicit lock.
    result = db.execute(
        update(WorkItem)
        .where(WorkItem.id == item.id, WorkItem.assignee_id.is_(None), WorkItem.status == "open")
        .values(assignee_id=user.id, version=WorkItem.version + 1, updated_at=func.now())
        .execution_options(synchronize_session=False)
    )
    if result.rowcount == 0:
        current = _reload(db, item.id)
        if current is not None and current.assignee_id is not None:
            raise _conflict(db, item.id, "ALREADY_CLAIMED", "This item has already been claimed.")
        db.rollback()
        raise invalid_transition("Only open items can be claimed.")

    _event(db, item.id, "assignee_changed", user.id, None, user.name)
    outbox.enqueue_item_event(db, item.id, "assigned", user.id, assigneeId=user.id)
    db.commit()
    return _reload(db, item.id)  # type: ignore[return-value]


def transition_item(db: Session, user: User, item_id: int, data: TransitionIn) -> WorkItem:
    item, role = get_item_for_user(db, user, item_id)
    perm.require_member(role)
    if data.version != item.version:
        raise _conflict(db, item.id)
    perm.check_transition(item, data.to, role, user.id)

    previous = item.status
    result = db.execute(
        update(WorkItem)
        .where(WorkItem.id == item.id, WorkItem.version == data.version, WorkItem.status == previous)
        .values(status=data.to, version=data.version + 1, updated_at=func.now())
        .execution_options(synchronize_session=False)
    )
    if result.rowcount == 0:
        raise _conflict(db, item.id)

    _event(db, item.id, "status_changed", user.id, previous, data.to)
    outbox.enqueue_item_event(db, item.id, "status_changed", user.id, **{"from": previous, "to": data.to})
    db.commit()
    return _reload(db, item.id)  # type: ignore[return-value]


def add_comment(db: Session, user: User, item_id: int, data: CommentIn) -> ActivityEvent:
    item, role = get_item_for_user(db, user, item_id)
    perm.require_member(role, "comment")
    ev = _event(db, item.id, "comment", user.id, body=data.body)
    db.commit()
    db.refresh(ev)  # loads id and created_at
    return ev
