from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Response

from app.services.linuxdo_oauth_service import LinuxDoOAuthService
from app.web.schemas import LinuxDoUserUpdateInput

from ._shared import disable_client_cache


def build_linuxdo_users_router(linuxdo_oauth: LinuxDoOAuthService) -> APIRouter:
    router = APIRouter()

    @router.get("/linuxdo-users")
    def list_linuxdo_users(
        response: Response,
        q: str = Query(default=""),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=50, ge=1, le=100),
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return linuxdo_oauth.list_users(query=q, page=page, page_size=page_size)

    @router.patch("/linuxdo-users/{user_id}")
    def patch_linuxdo_user(
        user_id: int,
        payload: LinuxDoUserUpdateInput,
        response: Response,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        if payload.enabled is None:
            raise ValueError("请指定用户启用状态")
        return linuxdo_oauth.set_user_enabled(user_id, payload.enabled)

    @router.delete("/linuxdo-users/{user_id}", status_code=204)
    def delete_linuxdo_user(user_id: int) -> Response:
        linuxdo_oauth.delete_user(user_id)
        return Response(status_code=204)

    return router
