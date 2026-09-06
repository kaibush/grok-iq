from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response

from app.services.request_audit_service import RequestAuditService
from app.web.schemas import RequestAuditScanInput

from ._shared import disable_client_cache


def build_request_audits_router(service: RequestAuditService) -> APIRouter:
    router = APIRouter()

    @router.get("/request-audits")
    async def request_audits(
        response: Response,
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=50, ge=1, le=200, alias="pageSize"),
        account: str = "",
        account_id: int | None = Query(default=None, ge=1, alias="accountId"),
        risk: str = Query(
            default="",
            pattern="^(|risky|normal|watch|high)$",
        ),
        client_key: str = Query(default="", alias="clientKey"),
        egress_node_id: int | None = Query(
            default=None,
            ge=1,
            alias="egressNodeId",
        ),
        window_preset: str = Query(
            default="today",
            alias="window",
            pattern="^(today|1h|3h|6h|24h|7d|30d|custom)$",
        ),
        start_at: str | None = Query(default=None, alias="startAt"),
        end_at: str | None = Query(default=None, alias="endAt"),
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return await service.list_page(
            page=page,
            page_size=page_size,
            account=account,
            account_id=account_id,
            risk=risk,
            client_key=client_key,
            egress_node_id=egress_node_id,
            window_preset=window_preset,
            start_at=start_at,
            end_at=end_at,
        )

    @router.get("/request-audits/summary")
    async def request_audit_summary(
        response: Response,
        window_preset: str = Query(
            default="today",
            alias="window",
            pattern="^(today|1h|3h|6h|24h|7d|30d|custom)$",
        ),
        start_at: str | None = Query(default=None, alias="startAt"),
        end_at: str | None = Query(default=None, alias="endAt"),
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return await service.summary(
            window_preset=window_preset,
            start_at=start_at,
            end_at=end_at,
        )

    @router.get("/request-audits/account-history")
    def request_audit_account_history(
        response: Response,
        account: str = "",
        account_id: int | None = Query(default=None, ge=1, alias="accountId"),
        risk: str = Query(
            default="",
            pattern="^(|risky|normal|watch|high)$",
        ),
        client_key: str = Query(default="", alias="clientKey"),
        egress_node_id: int | None = Query(
            default=None,
            ge=1,
            alias="egressNodeId",
        ),
        window_preset: str = Query(
            default="today",
            alias="window",
            pattern="^(today|1h|3h|6h|24h|7d|30d|custom)$",
        ),
        start_at: str | None = Query(default=None, alias="startAt"),
        end_at: str | None = Query(default=None, alias="endAt"),
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return service.account_history(
            account=account,
            account_id=account_id,
            risk=risk,
            client_key=client_key,
            egress_node_id=egress_node_id,
            window_preset=window_preset,
            start_at=start_at,
            end_at=end_at,
        )

    @router.get("/request-audits/status")
    def request_audit_status(response: Response) -> dict[str, Any]:
        disable_client_cache(response)
        return service.status()

    @router.get("/request-audits/probe-context")
    def request_audit_probe_context(
        response: Response,
        request_id: str = Query(default="", alias="requestId"),
        audit_id: int | None = Query(default=None, ge=1, alias="auditId"),
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return service.probe_context(request_id=request_id, audit_id=audit_id)

    @router.get("/request-audits/{audit_id}")
    async def request_audit_detail(
        audit_id: str,
        response: Response,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        try:
            return await service.get_detail(audit_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc) or "请求审计不存在") from exc

    @router.post("/request-audits/scan")
    async def scan_request_audits(
        response: Response,
        payload: RequestAuditScanInput | None = None,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        value = payload or RequestAuditScanInput()
        return await service.scan(
            trigger="manual",
            window_preset=value.window_preset,
            start_at=value.start_at,
            end_at=value.end_at,
        )

    return router
