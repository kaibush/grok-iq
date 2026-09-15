"""add linuxdo user enabled

Revision ID: d1a8e4c7b902
Revises: c6f8d2a1e407
Create Date: 2026-09-15 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d1a8e4c7b902"
down_revision: str | Sequence[str] | None = "c6f8d2a1e407"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("linuxdo_users") as batch_op:
        batch_op.add_column(
            sa.Column(
                "enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.true(),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("linuxdo_users") as batch_op:
        batch_op.drop_column("enabled")
