from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Response

from app.services.client_key_service import ClientKeyService
from app.services.scheduler import SchedulerService
from app.web.schemas import (
    BulkIdsInput,
    ClientKeyBatchEnabledInput,
    ClientKeyUpdateInput,
    ClientKeyUsageSummaryInput,
)

from ._shared import disable_client_cache


def build_client_keys_router(
    service: ClientKeyService,
    scheduler: SchedulerService | None = None,
) -> APIRouter:
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

    @router.patch("/client-keys/batch")
    async def batch_set_client_keys_enabled(
        payload: ClientKeyBatchEnabledInput,
        response: Response,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return await service.set_enabled_many(payload.ids, payload.enabled)

    @router.delete("/client-keys")
    async def delete_client_keys(
        payload: BulkIdsInput,
        response: Response,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return await service.delete_keys(payload.ids)

    @router.get("/client-keys/ids")
    def list_client_key_ids(
        response: Response,
        q: str = Query(default=""),
        paid: str = Query(default=""),
        plan_type: str = Query(default="", alias="planType"),
        enabled: str = Query(default=""),
        upstream: str = Query(default=""),
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return service.list_ids(
            query=q,
            paid=paid,
            plan_type=plan_type,
            enabled=enabled,
            upstream=upstream,
        )

    @router.post("/client-keys/usage-summary")
    async def client_key_usage_summary(
        payload: ClientKeyUsageSummaryInput,
        response: Response,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return await service.usage_summary(
            payload.ids,
            payload.period,
            start=payload.start,
            end=payload.end,
        )

    @router.post("/client-keys/auto-topup/run")
    async def run_paid_key_auto_topup(response: Response) -> dict[str, Any]:
        disable_client_cache(response)
        if scheduler is None:
            raise ValueError("付费密钥自动加额调度未启用")
        return await scheduler.run_paid_key_topup_now()

    @router.patch("/client-keys/{key_id}")
    async def patch_client_key(
        key_id: str,
        payload: ClientKeyUpdateInput,
        response: Response,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        fields = payload.model_fields_set
        has_local = bool(
            fields
            & {"paid", "plan_type", "recharge_yuan", "note"}
        )
        has_upstream = bool(
            fields
            & {
                "name",
                "enabled",
                "expires_at",
                "rpm_limit",
                "max_concurrent",
                "billing_limit_usd",
            }
        )
        if not has_local and not has_upstream:
            raise ValueError("请指定要更新的字段")
        return await service.update_key(
            key_id,
            paid=payload.paid if "paid" in fields else None,
            plan_type=payload.plan_type if "plan_type" in fields else None,
            recharge_yuan=(
                payload.recharge_yuan if "recharge_yuan" in fields else None
            ),
            note=payload.note if "note" in fields else None,
            name=payload.name if "name" in fields else None,
            enabled=payload.enabled if "enabled" in fields else None,
            expires_at=payload.expires_at if "expires_at" in fields else None,
            set_expires_at="expires_at" in fields,
            rpm_limit=payload.rpm_limit if "rpm_limit" in fields else None,
            max_concurrent=(
                payload.max_concurrent if "max_concurrent" in fields else None
            ),
            billing_limit_usd=(
                payload.billing_limit_usd
                if "billing_limit_usd" in fields
                else None
            ),
        )

    @router.delete("/client-keys/{key_id}")
    async def delete_client_key(key_id: str, response: Response) -> dict[str, Any]:
        disable_client_cache(response)
        return await service.delete_key(key_id)

    @router.get("/client-keys/{key_id}/secret")
    async def get_client_key_secret(
        key_id: str,
        response: Response,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return await service.get_secret(key_id)

    return router
