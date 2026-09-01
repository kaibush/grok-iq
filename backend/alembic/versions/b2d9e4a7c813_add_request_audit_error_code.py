"""store request-audit upstream error codes

Revision ID: b2d9e4a7c813
Revises: e8c3a1f6d904
Create Date: 2026-09-01 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b2d9e4a7c813"
down_revision: str | Sequence[str] | None = "e8c3a1f6d904"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("request_audit_records") as batch_op:
        batch_op.add_column(
            sa.Column(
                "error_code",
                sa.String(length=120),
                nullable=False,
                server_default="",
            )
        )
    op.execute(
        "UPDATE request_audit_records "
        "SET error_code = TRIM(CAST(json_extract(raw, '$.errorCode') AS TEXT)) "
        "WHERE error_code = '' "
        "AND json_valid(raw) "
        "AND COALESCE(TRIM(CAST(json_extract(raw, '$.errorCode') AS TEXT)), '') != ''"
    )


def downgrade() -> None:
    with op.batch_alter_table("request_audit_records") as batch_op:
        batch_op.drop_column("error_code")
