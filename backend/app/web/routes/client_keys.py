from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Response

from app.services.client_key_service import ClientKeyService
from app.web.schemas import ClientKeyUpdateInput

from ._shared import disable_client_cache


def build_client_keys_router(service: ClientKeyService) -> APIRouter:
    router = APIRouter()

    @router.get("/client-keys")
    def list_client_keys(
        response: Response,
        q: str = Query(default=""),
        paid: str = Query(default=""),
        plan_type: str = Query(default="", alias="planType"),
        enabled: str = Query(default=""),
        upstream: str = Query(default=""),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=50, ge=1, le=100, alias="pageSize"),
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return service.list_keys(
            query=q,
            paid=paid,
            plan_type=plan_type,
            enabled=enabled,
            upstream=upstream,
            page=page,
            page_size=page_size,
        )

    @router.post("/client-keys/sync")
    async def sync_client_keys(response: Response) -> dict[str, Any]:
        disable_client_cache(response)
        return await service.sync_from_upstream()

    @router.patch("/client-keys/{key_id}")
    def patch_client_key(
        key_id: str,
        payload: ClientKeyUpdateInput,
        response: Response,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        if (
            payload.paid is None
            and payload.plan_type is None
            and payload.recharge_yuan is None
            and payload.note is None
        ):
            raise ValueError("请指定要更新的付费标记、卡种、累计充值或备注")
        return service.update_key(
            key_id,
            paid=payload.paid,
            plan_type=payload.plan_type,
            recharge_yuan=payload.recharge_yuan,
            note=payload.note,
        )

    return router
