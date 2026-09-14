"""add linuxdo users and visit identity

Revision ID: a3d9c1e7f204
Revises: f2a8c1d4e907
Create Date: 2026-09-14 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a3d9c1e7f204"
down_revision: str | Sequence[str] | None = "f2a8c1d4e907"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "linuxdo_users",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("linuxdo_id", sa.String(length=64), nullable=False),
        sa.Column("username", sa.String(length=80), nullable=False, server_default=""),
        sa.Column("name", sa.String(length=120), nullable=False, server_default=""),
        sa.Column("email", sa.String(length=200), nullable=False, server_default=""),
        sa.Column(
            "avatar_url",
            sa.String(length=400),
            nullable=False,
            server_default="",
        ),
        sa.Column("trust_level", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("silenced", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("login_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "profile",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_linuxdo_users_linuxdo_id",
        "linuxdo_users",
        ["linuxdo_id"],
        unique=True,
    )
    op.create_index("ix_linuxdo_users_username", "linuxdo_users", ["username"])
    with op.batch_alter_table("page_visits") as batch_op:
        batch_op.add_column(sa.Column("linuxdo_user_id", sa.Integer(), nullable=True))
        batch_op.add_column(
            sa.Column(
                "linuxdo_username",
                sa.String(length=80),
                nullable=False,
                server_default="",
            )
        )
        batch_op.add_column(
            sa.Column(
                "linuxdo_name",
                sa.String(length=120),
                nullable=False,
                server_default="",
            )
        )
        batch_op.add_column(
            sa.Column(
                "linuxdo_avatar_url",
                sa.String(length=400),
                nullable=False,
                server_default="",
            )
        )
        batch_op.add_column(
            sa.Column("linuxdo_trust_level", sa.Integer(), nullable=True)
        )
        batch_op.create_index(
            "ix_page_visits_linuxdo_user_id",
            ["linuxdo_user_id"],
            unique=False,
        )


def downgrade() -> None:
    with op.batch_alter_table("page_visits") as batch_op:
        batch_op.drop_index("ix_page_visits_linuxdo_user_id")
        batch_op.drop_column("linuxdo_trust_level")
        batch_op.drop_column("linuxdo_avatar_url")
        batch_op.drop_column("linuxdo_name")
        batch_op.drop_column("linuxdo_username")
        batch_op.drop_column("linuxdo_user_id")
    op.drop_index("ix_linuxdo_users_username", table_name="linuxdo_users")
    op.drop_index("ix_linuxdo_users_linuxdo_id", table_name="linuxdo_users")
    op.drop_table("linuxdo_users")
