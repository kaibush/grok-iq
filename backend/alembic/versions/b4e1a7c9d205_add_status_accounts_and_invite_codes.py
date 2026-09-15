"""add status accounts and invite codes

Revision ID: b4e1a7c9d205
Revises: a3d9c1e7f204
Create Date: 2026-09-15 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b4e1a7c9d205"
down_revision: str | Sequence[str] | None = "a3d9c1e7f204"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "status_invite_codes",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("code", sa.String(length=32), nullable=False),
        sa.Column("note", sa.String(length=200), nullable=False, server_default=""),
        sa.Column("max_uses", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("used_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_by_admin_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_status_invite_codes_code",
        "status_invite_codes",
        ["code"],
        unique=True,
    )
    op.create_table(
        "status_accounts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("username", sa.String(length=64), nullable=False),
        sa.Column("password_salt", sa.String(length=128), nullable=False),
        sa.Column("password_hash", sa.String(length=128), nullable=False),
        sa.Column(
            "password_iterations",
            sa.Integer(),
            nullable=False,
            server_default="310000",
        ),
        sa.Column("token_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("invite_code_id", sa.Integer(), nullable=False),
        sa.Column("invite_code", sa.String(length=32), nullable=False),
        sa.Column("login_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["invite_code_id"],
            ["status_invite_codes.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_status_accounts_username",
        "status_accounts",
        ["username"],
        unique=True,
    )
    op.create_index(
        "ix_status_accounts_invite_code_id",
        "status_accounts",
        ["invite_code_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_status_accounts_invite_code_id", table_name="status_accounts")
    op.drop_index("ix_status_accounts_username", table_name="status_accounts")
    op.drop_table("status_accounts")
    op.drop_index("ix_status_invite_codes_code", table_name="status_invite_codes")
    op.drop_table("status_invite_codes")
