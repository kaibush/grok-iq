from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import select

from app.core.clock import utc_now

from .database import Database
from .models import WeChatAlertState, model_dict


class WeChatAlertRepository:
    """Persistence boundary for metric WeChat alert open/closed state."""

    def __init__(self, database: Database):
        self.database = database

    def get(self, rule_id: str, subject_id: str) -> dict[str, Any] | None:
        with self.database.session() as session:
            row = session.scalar(
                select(WeChatAlertState).where(
                    WeChatAlertState.rule_id == rule_id,
                    WeChatAlertState.subject_id == subject_id,
                )
            )
            return model_dict(row) if row is not None else None

    def upsert(
        self,
        *,
        rule_id: str,
        subject_id: str,
        status: str,
        last_value: float,
        last_fired_at: datetime | None = None,
        last_recovered_at: datetime | None = None,
        extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = utc_now()
        with self.database.transaction() as session:
            row = session.scalar(
                select(WeChatAlertState).where(
                    WeChatAlertState.rule_id == rule_id,
                    WeChatAlertState.subject_id == subject_id,
                )
            )
            if row is None:
                row = WeChatAlertState(
                    rule_id=rule_id,
                    subject_id=subject_id,
                    status=status,
                    last_value=last_value,
                    last_fired_at=last_fired_at,
                    last_recovered_at=last_recovered_at,
                    extra=dict(extra or {}),
                    updated_at=now,
                )
                session.add(row)
            else:
                row.status = status
                row.last_value = last_value
                if last_fired_at is not None:
                    row.last_fired_at = last_fired_at
                if last_recovered_at is not None:
                    row.last_recovered_at = last_recovered_at
                if extra is not None:
                    row.extra = dict(extra)
                row.updated_at = now
            session.flush()
            return model_dict(row)
