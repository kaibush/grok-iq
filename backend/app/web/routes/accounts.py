from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from app.services.account_service import AccountService
from app.web.schemas import (
    AccountActionInput,
    AccountBatchActionInput,
    AccountBatchDeleteInput,
    AccountBatchEgressInput,
    AccountBatchUpdateInput,
    AccountOperatorNoteInput,
)


def build_accounts_router(service: AccountService) -> APIRouter:
    router = APIRouter()

    @router.get("/dashboard")
    async def dashboard(
        hours: int = Query(default=168, ge=1, le=8760),
    ) -> dict[str, Any]:
        return await service.dashboard(hours)

    @router.get("/accounts")
    async def accounts(
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=50, ge=1, le=200, alias="pageSize"),
        search: str = "",
        enabled: str = "",
        upstream_status: str = Query(default="", alias="status"),
        monitor_status: str = Query(default="", alias="monitorStatus"),
        recovery_guarded: str = Query(default="", alias="recoveryGuarded"),
        sso_risk: str = Query(default="", alias="ssoRisk"),
        egress_node_id: str = Query(default="", alias="egressNodeId"),
    ) -> dict[str, Any]:
        return await service.list_accounts(
            page=page,
            page_size=page_size,
            search=search,
            enabled=enabled,
            upstream_status=upstream_status,
            monitor_status=monitor_status,
            recovery_guarded=recovery_guarded,
            sso_risk=sso_risk,
            egress_node_id=egress_node_id,
        )

    @router.get("/accounts/selection")
    async def account_selection(
        search: str = "",
        enabled: str = "",
        upstream_status: str = Query(default="", alias="status"),
        monitor_status: str = Query(default="", alias="monitorStatus"),
        recovery_guarded: str = Query(default="", alias="recoveryGuarded"),
        sso_risk: str = Query(default="", alias="ssoRisk"),
        egress_node_id: str = Query(default="", alias="egressNodeId"),
    ) -> dict[str, Any]:
        return await service.select_account_ids(
            search=search,
            enabled=enabled,
            upstream_status=upstream_status,
            monitor_status=monitor_status,
            recovery_guarded=recovery_guarded,
            sso_risk=sso_risk,
            egress_node_id=egress_node_id,
        )

    @router.get("/accounts/options")
    async def account_options(
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=50, ge=1, le=200, alias="pageSize"),
        search: str = "",
        upstream_status: str = Query(default="", alias="status"),
        sso_risk: str = Query(default="", alias="ssoRisk"),
    ) -> dict[str, Any]:
        return await service.list_account_options(
            page=page,
            page_size=page_size,
            search=search,
            upstream_status=upstream_status,
            sso_risk=sso_risk,
        )

    @router.put("/accounts/batch")
    async def batch_update_accounts(
        payload: AccountBatchUpdateInput,
    ) -> dict[str, Any]:
        return await service.set_accounts_enabled(
            account_ids=payload.account_ids,
            enabled=payload.enabled,
        )

    @router.post("/accounts/batch/action")
    async def batch_account_action(
        payload: AccountBatchActionInput,
    ) -> dict[str, Any]:
        return await service.action_many(
            account_ids=payload.account_ids,
            action=payload.action,
            note=payload.note,
            propagate=payload.propagate,
            quarantine_minutes=payload.quarantine_minutes,
            priority=payload.priority,
        )

    @router.delete("/accounts/batch")
    async def batch_delete_accounts(
        payload: AccountBatchDeleteInput,
    ) -> dict[str, Any]:
        return await service.delete_upstream_accounts(
            account_ids=payload.account_ids,
        )

    @router.put("/accounts/batch/egress")
    async def batch_update_account_egress(
        payload: AccountBatchEgressInput,
    ) -> dict[str, Any]:
        return await service.set_accounts_egress(
            account_ids=payload.account_ids,
            egress_node_id=payload.egress_node_id,
        )

    @router.get("/accounts/quarantine/stats")
    def isolation_stats(
        start: str = Query(default="", alias="from"),
        end: str = Query(default="", alias="to"),
    ) -> dict[str, Any]:
        return service.isolation_stats(start=start, end=end)

    @router.get("/accounts/quarantine")
    async def isolation_zone(
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=50, ge=1, le=200, alias="pageSize"),
        search: str = "",
        upstream_status: str = Query(default="", alias="status"),
        sso_risk: str = Query(default="", alias="ssoRisk"),
        egress_node_id: str = Query(default="", alias="egressNodeId"),
        source: str = "",
    ) -> dict[str, Any]:
        return await service.list_isolation_zone(
            page=page,
            page_size=page_size,
            search=search,
            upstream_status=upstream_status,
            sso_risk=sso_risk,
            egress_node_id=egress_node_id,
            source=source,
        )

    @router.delete("/accounts/quarantine/local")
    async def delete_local_quarantine_records(
        payload: AccountBatchDeleteInput,
    ) -> dict[str, Any]:
        return await service.delete_local_quarantine_records(
            account_ids=payload.account_ids,
        )

    @router.delete("/accounts/quarantine/upstream")
    async def delete_quarantine_upstream_accounts(
        payload: AccountBatchDeleteInput,
    ) -> dict[str, Any]:
        return await service.delete_quarantine_upstream_accounts(
            account_ids=payload.account_ids,
        )

    @router.get("/accounts/{account_id}")
    async def account_detail(
        account_id: int,
        limit: int = Query(default=200, ge=10, le=1000),
    ) -> dict[str, Any]:
        return await service.detail(account_id, limit)

    @router.get("/accounts/{account_id}/upstream")
    async def account_upstream(account_id: int) -> dict[str, Any]:
        return await service.get_upstream_account(account_id)

    @router.get("/accounts/{account_id}/samples")
    def account_samples(
        account_id: int,
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=25, ge=1, le=100, alias="pageSize"),
    ) -> dict[str, Any]:
        return service.samples(
            account_id,
            page=page,
            page_size=page_size,
        )

    @router.get("/accounts/{account_id}/timeline")
    def account_timeline(
        account_id: int,
        limit: int = Query(default=50, ge=1, le=200),
    ) -> dict[str, Any]:
        return service.timeline(account_id, limit)

    @router.post("/accounts/{account_id}/operator-notes")
    async def add_operator_note(
        account_id: int,
        payload: AccountOperatorNoteInput,
    ) -> dict[str, Any]:
        return await service.add_operator_note(
            account_id=account_id,
            note=payload.note,
        )

    @router.patch("/accounts/{account_id}/operator-notes/{note_id}")
    async def update_operator_note(
        account_id: int,
        note_id: str,
        payload: AccountOperatorNoteInput,
    ) -> dict[str, Any]:
        return await service.update_operator_note(
            account_id=account_id,
            note_id=note_id,
            note=payload.note,
        )

    @router.delete("/accounts/{account_id}/operator-notes/{note_id}")
    async def delete_operator_note(
        account_id: int,
        note_id: str,
    ) -> dict[str, Any]:
        return await service.delete_operator_note(
            account_id=account_id,
            note_id=note_id,
        )

    @router.post("/accounts/{account_id}/action")
    async def account_action(
        account_id: int,
        payload: AccountActionInput,
    ) -> dict[str, Any]:
        return await service.action(
            account_id=account_id,
            action=payload.action,
            note=payload.note,
            propagate=payload.propagate,
            quarantine_minutes=payload.quarantine_minutes,
            priority=payload.priority,
        )

    @router.delete("/accounts/{account_id}")
    async def delete_account(account_id: int) -> dict[str, Any]:
        return await service.delete_upstream_account(account_id)

    return router
