from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

ROLES = ("viewer", "member", "lead", "admin")
STATUSES = ("open", "in_progress", "awaiting_approval", "resolved", "closed")
PRIORITIES = ("low", "medium", "high", "urgent")
ITEM_TYPES = ("incident", "customer_issue", "payment", "compliance", "task")
EVENT_TYPES = (
    "created",
    "status_changed",
    "assignee_changed",
    "priority_changed",
    "field_updated",
    "comment",
)


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    email: Mapped[str] = mapped_column(String(255), unique=True)  # always stored lower-case
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    memberships: Mapped[list["Membership"]] = relationship(
        back_populates="user", lazy="selectin", order_by="Membership.team_id"
    )


class Team(Base):
    __tablename__ = "teams"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (CheckConstraint(_in("role", ROLES), name="ck_memberships_role"),)

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), primary_key=True)
    role: Mapped[str] = mapped_column(String(16))

    user: Mapped[User] = relationship(back_populates="memberships")
    team: Mapped[Team] = relationship(lazy="joined")


class WorkItem(Base):
    __tablename__ = "work_items"
    __table_args__ = (
        CheckConstraint(_in("status", STATUSES), name="ck_work_items_status"),
        CheckConstraint(_in("priority", PRIORITIES), name="ck_work_items_priority"),
        CheckConstraint(_in("type", ITEM_TYPES), name="ck_work_items_type"),
        CheckConstraint("version >= 1", name="ck_work_items_version"),
        # Main list: "items of my teams, newest first, optionally by status".
        Index("ix_work_items_team_status_id", "team_id", "status", "id"),
        Index("ix_work_items_assignee_status", "assignee_id", "status"),
        # Dashboard "Unassigned urgent": tiny partial index, stays small however big the table is.
        Index(
            "ix_work_items_unassigned_urgent",
            "team_id",
            "id",
            postgresql_where=text("assignee_id IS NULL AND priority = 'urgent' AND status = 'open'"),
        ),
        Index("ix_work_items_awaiting_approval", "team_id", "id", postgresql_where=text("status = 'awaiting_approval'")),
        # Substring search (ILIKE '%text%') uses trigram indexes.
        Index("ix_work_items_title_trgm", "title", postgresql_using="gin", postgresql_ops={"title": "gin_trgm_ops"}),
        Index(
            "ix_work_items_description_trgm",
            "description",
            postgresql_using="gin",
            postgresql_ops={"description": "gin_trgm_ops"},
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="", server_default="")
    type: Mapped[str] = mapped_column(String(32))
    priority: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(32), default="open", server_default="open")
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    assignee_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    # Optimistic-locking counter. Every successful write adds exactly 1.
    version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    team: Mapped[Team] = relationship(lazy="joined")
    assignee: Mapped[User | None] = relationship(foreign_keys=[assignee_id], lazy="joined")
    created_by: Mapped[User] = relationship(foreign_keys=[created_by_id], lazy="joined")


class ActivityEvent(Base):
    """Append-only history. Written in the same transaction as the change it describes."""

    __tablename__ = "activity_events"
    __table_args__ = (
        CheckConstraint(_in("type", EVENT_TYPES), name="ck_activity_events_type"),
        Index("ix_activity_events_item_id_id", "item_id", "id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("work_items.id", ondelete="CASCADE"))
    type: Mapped[str] = mapped_column(String(32))
    actor_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    from_value: Mapped[str | None] = mapped_column(String(255), nullable=True)
    to_value: Mapped[str | None] = mapped_column(String(255), nullable=True)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    actor: Mapped[User] = relationship(lazy="joined")


class IdempotencyKey(Base):
    """Remembers the answer to a create request so a retry gets the same answer, not a duplicate."""

    __tablename__ = "idempotency_keys"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    key: Mapped[str] = mapped_column(String(255), primary_key=True)
    request_hash: Mapped[str] = mapped_column(String(64))
    response: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    status_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class OutboxJob(Base):
    """Transactional outbox: written in the same transaction as the business change."""

    __tablename__ = "outbox_jobs"
    __table_args__ = (
        CheckConstraint(_in("status", ("pending", "done", "failed")), name="ck_outbox_jobs_status"),
        Index("ix_outbox_jobs_pending", "next_run_at", "id", postgresql_where=text("status = 'pending'")),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    type: Mapped[str] = mapped_column(String(64))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(16), default="pending", server_default="pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    max_attempts: Mapped[int] = mapped_column(Integer, default=5, server_default="5")
    next_run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Notification(Base):
    """What the outbox worker "delivers". UNIQUE(job_id, user_id) makes the handler safe to repeat."""

    __tablename__ = "notifications"
    __table_args__ = (
        UniqueConstraint("job_id", "user_id", name="uq_notifications_job_user"),
        Index("ix_notifications_user_id_id", "user_id", "id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("outbox_jobs.id", ondelete="CASCADE"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    item_id: Mapped[int] = mapped_column(ForeignKey("work_items.id", ondelete="CASCADE"))
    message: Mapped[str] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
