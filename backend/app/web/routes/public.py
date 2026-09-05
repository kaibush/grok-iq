from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, ConfigDict

from app.integrations.grok2api.client import Grok2APIClient
from app.services.account_service import AccountService
from app.services.auth_service import AuthenticationError, AuthService
from app.services.client_key_quota_service import ClientKeyQuotaService
from app.services.client_key_usage_service import ClientKeyUsageService
from app.services.page_visit_service import VISITOR_COOKIE_NAME, PageVisitService
from app.services.request_audit_service import RequestAuditService
from app.web.schemas import ClientKeyQuotaInput, ClientKeyUsageInput

from ._shared import disable_client_cache


class PageVisitInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    path: str = ""
    referrer: str = ""


def build_public_router(
    account_service: AccountService,
    client: Grok2APIClient,
    auth_service: AuthService,
    request_audits: RequestAuditService | None = None,
    page_visits: PageVisitService | None = None,
) -> APIRouter:
    router = APIRouter()
    quota_service = ClientKeyQuotaService(client)
    usage_service = ClientKeyUsageService(client, quota_service=quota_service)

    @router.get("/public/upstream-accounts")
    async def public_upstream_accounts(
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return await account_service.public_upstream_account_summary(
            include_inventory=_has_admin_session(auth_service, request.headers.get("authorization") or "")
        )

    @router.post("/public/client-key-quota")
    async def public_client_key_quota(
        payload: ClientKeyQuotaInput,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return await quota_service.lookup(payload.api_key, client_ip=_client_ip(request))

    @router.post("/public/client-key-usage")
    async def public_client_key_usage(
        payload: ClientKeyUsageInput,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return await usage_service.lookup_public_usage(
            payload.api_key,
            client_ip=_client_ip(request),
            period=payload.period,
            start=payload.start,
            end=payload.end,
        )

    @router.get("/public/upstream-usage")
    async def public_upstream_usage(
        response: Response,
        period: str = Query(default="24h"),
        timezone: str = Query(default="Asia/Shanghai"),
        refresh: str = Query(default=""),
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return await usage_service.public_usage_overview(
            period=period,
            timezone=timezone,
            refresh=refresh.strip().lower() in {"1", "true", "yes"},
        )

    if request_audits is not None:

        @router.get("/public/upstream-health")
        async def public_upstream_health(response: Response) -> dict[str, Any]:
            disable_client_cache(response)
            return request_audits.recent_request_health()

    if page_visits is not None:

        @router.post("/public/page-visits")
        async def public_page_visits(
            request: Request,
            response: Response,
            payload: PageVisitInput | None = None,
        ) -> dict[str, Any]:
            disable_client_cache(response)
            body = payload or PageVisitInput()
            result = page_visits.record_visit(
                path=body.path,
                referrer=body.referrer,
                user_agent=request.headers.get("user-agent") or "",
                client_ip=_client_ip(request),
                authorization=request.headers.get("authorization") or "",
                visitor_cookie=request.cookies.get(VISITOR_COOKIE_NAME) or "",
                request_host=request.headers.get("host") or (request.base_url.hostname or ""),
                country=request.headers.get("cf-ipcountry") or "",
                language=request.headers.get("accept-language") or "",
            )
            if result.get("set_cookie") and result.get("visitor_id"):
                response.set_cookie(
                    key=VISITOR_COOKIE_NAME,
                    value=str(result["visitor_id"]),
                    max_age=31536000,
                    path="/",
                    httponly=True,
                    samesite="lax",
                    secure=_cookie_secure(request),
                )
            return {"recorded": bool(result.get("recorded"))}

        @router.get("/public/page-stats")
        async def public_page_stats(
            response: Response,
            period: str = Query(default="24h"),
            timezone: str = Query(default="Asia/Shanghai"),
        ) -> dict[str, Any]:
            disable_client_cache(response)
            return page_visits.overview(period=period, timezone=timezone)

    return router


def _cookie_secure(request: Request) -> bool:
    forwarded = (request.headers.get("x-forwarded-proto") or "").split(",", 1)[0].strip().lower()
    if forwarded:
        return forwarded == "https"
    return request.url.scheme == "https"


def _client_ip(request: Request) -> str:
    for header in ("cf-connecting-ip", "true-client-ip", "x-real-ip"):
        value = (request.headers.get(header) or "").strip()
        if value:
            return value
    forwarded = (request.headers.get("x-forwarded-for") or "").split(",", 1)[0].strip()
    if forwarded:
        return forwarded
    host = request.client.host if request.client else ""
    return host or "unknown"


def _has_admin_session(auth_service: AuthService, authorization: str) -> bool:
    if not authorization.strip():
        return False
    try:
        auth_service.authenticate_authorization(authorization)
    except AuthenticationError:
        return False
    return True
