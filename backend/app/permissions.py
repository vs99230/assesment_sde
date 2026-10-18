"""
THE one place that decides who may do what. Routers and services never compare roles themselves;
they call a function from this file. To change a rule ("Leads can reassign", "add a status"),
change it here.

Rules mirror the frontend's src/lib/rules.ts and docs/API_CONTRACT.md.
"""

from app.errors import forbidden, invalid_transition, not_found
from app.models import User, WorkItem

ROLE_RANK = {"viewer": 0, "member": 1, "lead": 2, "admin": 3}

# from-status -> {to-status: who may do it}
#   "assignee": the assignee, or a Lead/Admin of the team
#   "lead":     only a Lead/Admin of the team
TRANSITIONS: dict[str, dict[str, str]] = {
    "open": {"in_progress": "assignee"},
    "in_progress": {"awaiting_approval": "assignee"},
    "awaiting_approval": {"resolved": "lead", "in_progress": "lead"},
    "resolved": {"closed": "lead"},
    "closed": {},
}


# ---------- roles ----------


def role_in_team(user: User, team_id: int) -> str | None:
    for m in user.memberships:
        if m.team_id == team_id:
            return m.role
    return None


def has_role(role: str | None, minimum: str) -> bool:
    return role is not None and ROLE_RANK[role] >= ROLE_RANK[minimum]


def is_lead(role: str | None) -> bool:
    return has_role(role, "lead")


def team_ids(user: User) -> list[int]:
    """Teams whose items the user may see at all."""
    return [m.team_id for m in user.memberships]


def lead_team_ids(user: User) -> list[int]:
    return [m.team_id for m in user.memberships if is_lead(m.role)]


# ---------- guards (raise ApiError) ----------


def visible_role(user: User, team_id: int) -> str:
    """Role in the item's team, or 404. Outsiders must not even learn the item exists."""
    role = role_in_team(user, team_id)
    if role is None:
        raise not_found("Item not found.")
    return role


def require_member(role: str | None, action: str = "do that") -> None:
    if not has_role(role, "member"):
        raise forbidden(f"You need the Member role in this team to {action}.")


def require_lead(role: str | None, message: str) -> None:
    if not is_lead(role):
        raise forbidden(message)


def can_edit_item(item: WorkItem, role: str | None, user_id: int) -> bool:
    if item.status == "closed":
        return False
    if is_lead(role):
        return True
    if role != "member":
        return False
    return item.assignee_id == user_id or (item.assignee_id is None and item.created_by_id == user_id)


def require_can_edit(item: WorkItem, role: str | None, user_id: int) -> None:
    require_member(role, "edit items")
    if not can_edit_item(item, role, user_id):
        raise forbidden("You can only edit items that are assigned to you.")


def check_transition(item: WorkItem, to: str, role: str | None, user_id: int) -> None:
    rule = TRANSITIONS[item.status].get(to)
    if rule is None:
        raise invalid_transition(f'An item cannot move from "{item.status}" to "{to}".')
    require_member(role)
    if item.status == "open" and to == "in_progress" and item.assignee_id is None:
        raise invalid_transition("Claim the item (or ask a Lead to assign it) before starting work.")
    if rule == "lead" and not is_lead(role):
        raise forbidden("Only a Lead of this team can do that.")
    if rule == "assignee" and not is_lead(role) and item.assignee_id != user_id:
        raise forbidden("Only the assignee or a Lead can do that.")


def assignable(membership_role: str | None) -> bool:
    """Viewers can't work on items, so they can't be assignees."""
    return membership_role is not None and membership_role != "viewer"
