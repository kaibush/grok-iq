"""store request-audit thinking and output samples

Revision ID: c9d2e4f7a813
Revises: b2d9e4a7c813
Create Date: 2026-09-01 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c9d2e4f7a813"
down_revision: str | Sequence[str] | None = "b2d9e4a7c813"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("request_audit_records") as batch_op:
        batch_op.add_column(
            sa.Column(
                "stream_sample",
                sa.JSON(),
                nullable=False,
                server_default=sa.text("'{}'"),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("request_audit_records") as batch_op:
        batch_op.drop_column("stream_sample")
