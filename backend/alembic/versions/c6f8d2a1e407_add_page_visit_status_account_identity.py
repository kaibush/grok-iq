"""add page visit status account identity

Revision ID: c6f8d2a1e407
Revises: b4e1a7c9d205
Create Date: 2026-09-15 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c6f8d2a1e407"
down_revision: str | Sequence[str] | None = "b4e1a7c9d205"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("page_visits") as batch_op:
        batch_op.add_column(sa.Column("status_account_id", sa.Integer(), nullable=True))
        batch_op.add_column(
            sa.Column(
                "status_account_username",
                sa.String(length=64),
                nullable=False,
                server_default="",
            )
        )
        batch_op.create_index(
            "ix_page_visits_status_account_id",
            ["status_account_id"],
            unique=False,
        )


def downgrade() -> None:
    with op.batch_alter_table("page_visits") as batch_op:
        batch_op.drop_index("ix_page_visits_status_account_id")
        batch_op.drop_column("status_account_username")
        batch_op.drop_column("status_account_id")
