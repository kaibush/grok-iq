"""store WeChat metric alert open/closed state

Revision ID: f2a8c1d4e907
Revises: e9f1a2b3c4d5
Create Date: 2026-09-07 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f2a8c1d4e907"
down_revision: str | Sequence[str] | None = "e9f1a2b3c4d5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "wechat_alert_states",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("rule_id", sa.String(length=40), nullable=False),
        sa.Column("subject_id", sa.String(length=160), nullable=False),
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="closed",
        ),
        sa.Column("last_value", sa.Float(), nullable=False, server_default="0"),
        sa.Column("last_fired_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_recovered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "extra",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "rule_id",
            "subject_id",
            name="uq_wechat_alert_rule_subject",
        ),
    )
    op.create_index(
        "ix_wechat_alert_states_rule",
        "wechat_alert_states",
        ["rule_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_wechat_alert_states_rule", table_name="wechat_alert_states")
    op.drop_table("wechat_alert_states")
