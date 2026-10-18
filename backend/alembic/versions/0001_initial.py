"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-10-17
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

ROLES = "'viewer', 'member', 'lead', 'admin'"
STATUSES = "'open', 'in_progress', 'awaiting_approval', 'resolved', 'closed'"
PRIORITIES = "'low', 'medium', 'high', 'urgent'"
TYPES = "'incident', 'customer_issue', 'payment', 'compliance', 'task'"
EVENT_TYPES = "'created', 'status_changed', 'assignee_changed', 'priority_changed', 'field_updated', 'comment'"


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    op.create_table(
        "users",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("email", sa.String(255), nullable=False, unique=True),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "teams",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String(120), nullable=False, unique=True),
    )
    op.create_table(
        "memberships",
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("team_id", sa.Integer, sa.ForeignKey("teams.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("role", sa.String(16), nullable=False),
        sa.CheckConstraint(f"role IN ({ROLES})", name="ck_memberships_role"),
    )
    op.create_table(
        "work_items",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("priority", sa.String(16), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="open"),
        sa.Column("team_id", sa.Integer, sa.ForeignKey("teams.id"), nullable=False),
        sa.Column("assignee_id", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_by_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("due_date", sa.Date, nullable=True),
        sa.Column("version", sa.Integer, nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(f"status IN ({STATUSES})", name="ck_work_items_status"),
        sa.CheckConstraint(f"priority IN ({PRIORITIES})", name="ck_work_items_priority"),
        sa.CheckConstraint(f"type IN ({TYPES})", name="ck_work_items_type"),
        sa.CheckConstraint("version >= 1", name="ck_work_items_version"),
    )
    op.create_index("ix_work_items_team_status_id", "work_items", ["team_id", "status", "id"])
    op.create_index("ix_work_items_assignee_status", "work_items", ["assignee_id", "status"])
    op.create_index(
        "ix_work_items_unassigned_urgent",
        "work_items",
        ["team_id", "id"],
        postgresql_where=sa.text("assignee_id IS NULL AND priority = 'urgent' AND status = 'open'"),
    )
    op.create_index(
        "ix_work_items_awaiting_approval",
        "work_items",
        ["team_id", "id"],
        postgresql_where=sa.text("status = 'awaiting_approval'"),
    )
    op.execute("CREATE INDEX ix_work_items_title_trgm ON work_items USING gin (title gin_trgm_ops)")
    op.execute("CREATE INDEX ix_work_items_description_trgm ON work_items USING gin (description gin_trgm_ops)")

    op.create_table(
        "activity_events",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("item_id", sa.Integer, sa.ForeignKey("work_items.id", ondelete="CASCADE"), nullable=False),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("actor_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("from_value", sa.String(255), nullable=True),
        sa.Column("to_value", sa.String(255), nullable=True),
        sa.Column("body", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(f"type IN ({EVENT_TYPES})", name="ck_activity_events_type"),
    )
    op.create_index("ix_activity_events_item_id_id", "activity_events", ["item_id", "id"])

    op.create_table(
        "idempotency_keys",
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("key", sa.String(255), primary_key=True),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("response", postgresql.JSONB, nullable=True),
        sa.Column("status_code", sa.Integer, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "outbox_jobs",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("type", sa.String(64), nullable=False),
        sa.Column("payload", postgresql.JSONB, nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer, nullable=False, server_default="5"),
        sa.Column("next_run_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_error", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("status IN ('pending', 'done', 'failed')", name="ck_outbox_jobs_status"),
    )
    op.create_index(
        "ix_outbox_jobs_pending",
        "outbox_jobs",
        ["next_run_at", "id"],
        postgresql_where=sa.text("status = 'pending'"),
    )

    op.create_table(
        "notifications",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("job_id", sa.Integer, sa.ForeignKey("outbox_jobs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("item_id", sa.Integer, sa.ForeignKey("work_items.id", ondelete="CASCADE"), nullable=False),
        sa.Column("message", sa.String(500), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("job_id", "user_id", name="uq_notifications_job_user"),
    )
    op.create_index("ix_notifications_user_id_id", "notifications", ["user_id", "id"])


def downgrade() -> None:
    for table in (
        "notifications",
        "outbox_jobs",
        "idempotency_keys",
        "activity_events",
        "work_items",
        "memberships",
        "teams",
        "users",
    ):
        op.drop_table(table)
