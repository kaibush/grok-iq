from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request, Response

from app.services.status_account_service import StatusAccountService
from app.web.schemas import (
    StatusAccountUpdateInput,
    StatusInviteCreateInput,
    StatusInviteUpdateInput,
)

from ._shared import disable_client_cache


def build_status_accounts_router(status_accounts: StatusAccountService) -> APIRouter:
    router = APIRouter()

    @router.get("/status-invite-codes")
    def list_status_invite_codes(
        response: Response,
        q: str = Query(default=""),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=50, ge=1, le=100),
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return status_accounts.list_invites(query=q, page=page, page_size=page_size)

    @router.post("/status-invite-codes")
    def create_status_invite_code(
        payload: StatusInviteCreateInput,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        admin = getattr(request.state, "auth_user", None) or {}
        admin_id = int(admin["id"]) if admin.get("id") is not None else None
        return status_accounts.create_invite(
            note=payload.note,
            max_uses=payload.max_uses,
            admin_id=admin_id,
        )

    @router.get("/status-invite-codes/{invite_id}")
    def get_status_invite_code(invite_id: int, response: Response) -> dict[str, Any]:
        disable_client_cache(response)
        return status_accounts.get_invite(invite_id)

    @router.patch("/status-invite-codes/{invite_id}")
    def patch_status_invite_code(
        invite_id: int,
        payload: StatusInviteUpdateInput,
        response: Response,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return status_accounts.update_invite(
            invite_id,
            note=payload.note,
            max_uses=payload.max_uses,
            enabled=payload.enabled,
        )

    @router.get("/status-accounts")
    def list_status_accounts(
        response: Response,
        q: str = Query(default=""),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=50, ge=1, le=100),
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return status_accounts.list_accounts(query=q, page=page, page_size=page_size)

    @router.patch("/status-accounts/{account_id}")
    def patch_status_account(
        account_id: int,
        payload: StatusAccountUpdateInput,
        response: Response,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        if payload.enabled is None:
            raise ValueError("请指定账号启用状态")
        return status_accounts.set_account_enabled(account_id, payload.enabled)

    @router.delete("/status-accounts/{account_id}", status_code=204)
    def delete_status_account(account_id: int) -> Response:
        status_accounts.delete_account(account_id)
        return Response(status_code=204)

    return router
