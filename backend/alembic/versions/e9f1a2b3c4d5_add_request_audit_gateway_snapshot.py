"""store compact grok2api request-audit extras

Revision ID: e9f1a2b3c4d5
Revises: d8a1c4e7b902
Create Date: 2026-09-06 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e9f1a2b3c4d5"
down_revision: str | Sequence[str] | None = "d8a1c4e7b902"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("request_audit_records") as batch_op:
        batch_op.add_column(
            sa.Column(
                "gateway",
                sa.JSON(),
                nullable=False,
                server_default=sa.text("'{}'"),
            )
        )
        batch_op.add_column(
            sa.Column(
                "request_headers",
                sa.JSON(),
                nullable=False,
                server_default=sa.text("'{}'"),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("request_audit_records") as batch_op:
        batch_op.drop_column("request_headers")
        batch_op.drop_column("gateway")
