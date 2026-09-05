from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import delete, select

from .database import Database
from .models import PageVisit, model_dict


class PageVisitRepository:
    """Persistence boundary for public status-page visit events."""

    def __init__(self, database: Database):
        self.database = database

    def record(self, values: dict[str, Any]) -> None:
        with self.database.transaction() as session:
            session.add(PageVisit(**values))

    def recent_visitor_hit(self, visitor_id: str, path: str, since: datetime) -> bool:
        with self.database.session() as session:
            value = session.scalar(
                select(PageVisit.id)
                .where(
                    PageVisit.visitor_id == visitor_id,
                    PageVisit.path == path,
                    PageVisit.visited_at >= since,
                )
                .limit(1)
            )
            return value is not None

    def list_between(self, start: datetime, end: datetime) -> list[dict[str, Any]]:
        with self.database.session() as session:
            values = session.scalars(
                select(PageVisit)
                .where(
                    PageVisit.visited_at >= start,
                    PageVisit.visited_at < end,
                )
                .order_by(PageVisit.visited_at.asc(), PageVisit.id.asc())
            ).all()
            return [model_dict(value) for value in values]

    def prune_before(self, cutoff: datetime) -> int:
        with self.database.transaction() as session:
            result = session.execute(
                delete(PageVisit).where(PageVisit.visited_at < cutoff)
            )
            return int(result.rowcount or 0)
