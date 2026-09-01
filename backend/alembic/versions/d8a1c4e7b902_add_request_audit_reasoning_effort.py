"""store request-audit reasoning effort

Revision ID: d8a1c4e7b902
Revises: c9d2e4f7a813
Create Date: 2026-09-01 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d8a1c4e7b902"
down_revision: str | Sequence[str] | None = "c9d2e4f7a813"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("request_audit_records") as batch_op:
        batch_op.add_column(
            sa.Column(
                "reasoning_effort",
                sa.String(length=16),
                nullable=False,
                server_default="",
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("request_audit_records") as batch_op:
        batch_op.drop_column("reasoning_effort")
