"""add client key records

Revision ID: e2c9a4b7d108
Revises: d1a8e4c7b902
Create Date: 2026-09-17 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e2c9a4b7d108"
down_revision: str | Sequence[str] | None = "d1a8e4c7b902"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "client_key_records",
        sa.Column("key_id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False, server_default=""),
        sa.Column("scheme", sa.String(length=16), nullable=False, server_default="sk"),
        sa.Column("prefix", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rpm_limit", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_concurrent", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "billing_limit_usd_ticks",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "billed_usage_usd_ticks",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
        ),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("upstream_created_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "upstream_missing",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column("paid", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "plan_type",
            sa.String(length=16),
            nullable=False,
            server_default="none",
        ),
        sa.Column("recharge_cents", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("note", sa.String(length=500), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("key_id"),
        sa.CheckConstraint(
            "plan_type IN ('none', 'day', 'week', 'month')",
            name="ck_client_key_records_plan_type",
        ),
    )
    op.create_index(
        "ix_client_key_records_paid",
        "client_key_records",
        ["paid"],
        unique=False,
    )
    op.create_index(
        "ix_client_key_records_plan_type",
        "client_key_records",
        ["plan_type"],
        unique=False,
    )
    op.create_index(
        "ix_client_key_records_prefix",
        "client_key_records",
        ["prefix"],
        unique=False,
    )
    op.create_index(
        "ix_client_key_records_upstream_missing",
        "client_key_records",
        ["upstream_missing"],
        unique=False,
    )
    op.create_index(
        "ix_client_key_records_enabled",
        "client_key_records",
        ["enabled"],
        unique=False,
    )
    op.create_index(
        "ix_client_key_records_name",
        "client_key_records",
        ["name"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_client_key_records_name", table_name="client_key_records")
    op.drop_index("ix_client_key_records_enabled", table_name="client_key_records")
    op.drop_index(
        "ix_client_key_records_upstream_missing",
        table_name="client_key_records",
    )
    op.drop_index("ix_client_key_records_prefix", table_name="client_key_records")
    op.drop_index("ix_client_key_records_plan_type", table_name="client_key_records")
    op.drop_index("ix_client_key_records_paid", table_name="client_key_records")
    op.drop_table("client_key_records")
