from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Response

from app.integrations.grok2api.client import Grok2APIClient
from app.services.client_key_usage_service import ClientKeyUsageService

from ._shared import disable_client_cache


def build_client_keys_router(client: Grok2APIClient) -> APIRouter:
    router = APIRouter()
    service = ClientKeyUsageService(client)

    @router.get("/client-keys")
    async def list_client_keys(
        response: Response,
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=50, ge=1, le=100, alias="pageSize"),
        search: str = "",
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return await service.list_keys(page=page, page_size=page_size, search=search)

    @router.get("/client-keys/usage")
    async def client_key_usage(
        response: Response,
        key_ids: list[str] = Query(default=[], alias="keyIds"),
        period: str = Query(default="24h", pattern="^(24h|7d|30d|90d|custom)$"),
        start: str = "",
        end: str = "",
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return await service.audit_summary(
            key_ids=key_ids,
            period=period,
            start=start,
            end=end,
        )

    return router
