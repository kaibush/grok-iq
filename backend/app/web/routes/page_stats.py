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

    @router.get("/page-stats/visits")
    async def page_stat_visits(
        response: Response,
        period: str = Query(default="24h"),
        timezone: str = Query(default="Asia/Shanghai"),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=50, ge=1, le=100),
        device: str = Query(default=""),
        audience: str = Query(default="all"),
        q: str = Query(default=""),
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return page_visits.visit_ledger(
            period=period,
            timezone=timezone,
            page=page,
            page_size=page_size,
            device=device,
            audience=audience,
            q=q,
        )

    return router
