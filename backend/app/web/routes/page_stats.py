from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Response

from app.services.page_visit_service import PageVisitService

from ._shared import disable_client_cache


def build_page_stats_router(page_visits: PageVisitService) -> APIRouter:
    router = APIRouter()

    @router.get("/page-stats")
    async def page_stats(
        response: Response,
        period: str = Query(default="24h"),
        timezone: str = Query(default="Asia/Shanghai"),
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return page_visits.details(period=period, timezone=timezone)

    return router
