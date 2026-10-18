from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel

Role = Literal["viewer", "member", "lead", "admin"]
Status = Literal["open", "in_progress", "awaiting_approval", "resolved", "closed"]
Priority = Literal["low", "medium", "high", "urgent"]
ItemType = Literal["incident", "customer_issue", "payment", "compliance", "task"]
ActivityType = Literal["created", "status_changed", "assignee_changed", "priority_changed", "field_updated", "comment"]
DashboardView = Literal["assigned_to_me", "unassigned_urgent", "awaiting_my_approval"]


class CamelModel(BaseModel):
    """JSON uses camelCase (as the frontend expects); Python uses snake_case."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)


# ---------- output ----------


class UserRef(CamelModel):
    id: int
    name: str


class TeamRef(CamelModel):
    id: int
    name: str


class MembershipOut(CamelModel):
    team_id: int
    team_name: str
    role: Role


class UserOut(CamelModel):
    id: int
    name: str
    email: str
    memberships: list[MembershipOut]


class TeamMemberOut(CamelModel):
    id: int
    name: str
    role: Role


class LoginOut(CamelModel):
    token: str
    user: UserOut


class WorkItemOut(CamelModel):
    id: int
    title: str
    description: str
    type: ItemType
    priority: Priority
    status: Status
    team: TeamRef
    assignee: UserRef | None
    created_by: UserRef
    due_date: date | None
    version: int
    created_at: datetime
    updated_at: datetime


class ActivityOut(CamelModel):
    id: int
    item_id: int
    type: ActivityType
    actor: UserRef
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None
    body: str | None = None
    created_at: datetime


class ItemPage(CamelModel):
    items: list[WorkItemOut]
    next_cursor: str | None = None


class ActivityPage(CamelModel):
    items: list[ActivityOut]
    next_cursor: str | None = None


class DashboardSection(CamelModel):
    total: int
    items: list[WorkItemOut]


class DashboardOut(CamelModel):
    assigned_to_me: DashboardSection
    unassigned_urgent: DashboardSection
    awaiting_my_approval: DashboardSection


# ---------- input ----------


class LoginIn(CamelModel):
    email: str = Field(max_length=255)
    password: str = Field(max_length=200)


def _title(value: str) -> str:
    value = value.strip()
    if len(value) < 3:
        raise ValueError("Title must be at least 3 characters.")
    if len(value) > 120:
        raise ValueError("Title must be at most 120 characters.")
    return value


def _description(value: str) -> str:
    value = value.strip()
    if len(value) > 4000:
        raise ValueError("Description must be at most 4000 characters.")
    return value


class CreateItemIn(CamelModel):
    title: str
    description: str = ""
    type: ItemType
    priority: Priority
    team_id: int
    due_date: date | None = None
    assignee_id: int | None = None

    _v_title = field_validator("title")(_title)
    _v_description = field_validator("description")(_description)


class UpdateItemIn(CamelModel):
    version: int
    title: str | None = None
    description: str | None = None
    priority: Priority | None = None
    due_date: date | None = None
    assignee_id: int | None = None

    @field_validator("title")
    @classmethod
    def _t(cls, v: str | None) -> str | None:
        return None if v is None else _title(v)

    @field_validator("description")
    @classmethod
    def _d(cls, v: str | None) -> str | None:
        return None if v is None else _description(v)


class TransitionIn(CamelModel):
    to: Status
    version: int


class CommentIn(CamelModel):
    body: str

    @field_validator("body")
    @classmethod
    def _body(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Write something before posting.")
        if len(v) > 2000:
            raise ValueError("Comments must be at most 2000 characters.")
        return v
