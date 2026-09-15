from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, ConfigDict

from app.integrations.grok2api.client import Grok2APIClient
from app.services.account_service import AccountService
from app.services.auth_service import AuthenticationError, AuthService
from app.services.client_key_quota_service import ClientKeyQuotaService
from app.services.client_key_usage_service import ClientKeyUsageService
from app.services.linuxdo_oauth_service import (
    OAUTH_COOKIE_NAME,
    OAUTH_STATE_TTL_SECONDS,
    SESSION_COOKIE_NAME,
    LinuxDoOAuthError,
    LinuxDoOAuthService,
    StatusLoginRequired,
    request_origin,
)
from app.services.page_visit_service import VISITOR_COOKIE_NAME, PageVisitService
from app.services.request_audit_service import RequestAuditService
from app.services.status_account_service import (
    STATUS_ACCOUNT_COOKIE_NAME,
    StatusAccountService,
)
from app.web.schemas import (
    ClientKeyQuotaInput,
    ClientKeyUsageInput,
    StatusAccountLoginInput,
    StatusAccountRegisterInput,
)

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
    linuxdo_oauth: LinuxDoOAuthService | None = None,
    status_accounts: StatusAccountService | None = None,
) -> APIRouter:
    router = APIRouter()
    quota_service = ClientKeyQuotaService(client)
    usage_service = ClientKeyUsageService(client, quota_service=quota_service)

    def require_status_access(request: Request) -> None:
        authorize_status_request(
            linuxdo_oauth,
            status_accounts,
            auth_service,
            request.headers.get("authorization") or "",
            request.cookies.get(SESSION_COOKIE_NAME) or "",
            request.cookies.get(STATUS_ACCOUNT_COOKIE_NAME) or "",
        )

    @router.get("/public/status-access")
    async def public_status_access(
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        account = _status_account_from_cookie(status_accounts, request)
        if linuxdo_oauth is None:
            return {
                "required": False,
                "configured": False,
                "admin": _has_admin_session(
                    auth_service, request.headers.get("authorization") or ""
                ),
                "user": None,
                "account": account,
            }
        payload = linuxdo_oauth.access_status(
            request.headers.get("authorization") or "",
            request.cookies.get(SESSION_COOKIE_NAME) or "",
            auth_service,
        )
        payload["account"] = account
        return payload

    @router.get("/public/linuxdo/login")
    async def public_linuxdo_login(
        request: Request,
        return_to: str = Query(default="/status"),
    ) -> RedirectResponse:
        if linuxdo_oauth is None:
            raise LinuxDoOAuthError("尚未配置 Linux.do OAuth2")
        authorize_url, oauth_cookie = linuxdo_oauth.start_login(
            return_to=return_to,
            request_origin=request_origin(request),
        )
        redirect = RedirectResponse(url=authorize_url, status_code=302)
        redirect.set_cookie(
            key=OAUTH_COOKIE_NAME,
            value=oauth_cookie,
            max_age=OAUTH_STATE_TTL_SECONDS,
            path="/",
            httponly=True,
            samesite="lax",
            secure=_cookie_secure(request),
        )
        return redirect

    @router.get("/public/linuxdo/callback")
    async def public_linuxdo_callback(
        request: Request,
        code: str = Query(default=""),
        state: str = Query(default=""),
        error: str = Query(default=""),
        error_description: str = Query(default=""),
    ) -> RedirectResponse:
        if linuxdo_oauth is None:
            raise LinuxDoOAuthError("尚未配置 Linux.do OAuth2")
        if error.strip():
            raise LinuxDoOAuthError(error_description.strip() or error.strip())
        _user, session_cookie, return_to = await linuxdo_oauth.complete_login(
            code=code,
            state=state,
            oauth_cookie=request.cookies.get(OAUTH_COOKIE_NAME) or "",
        )
        redirect = RedirectResponse(url=return_to, status_code=302)
        redirect.set_cookie(
            key=SESSION_COOKIE_NAME,
            value=session_cookie,
            max_age=int(getattr(linuxdo_oauth.settings, "jwt_ttl_seconds", 7 * 24 * 60 * 60)),
            path="/",
            httponly=True,
            samesite="lax",
            secure=_cookie_secure(request),
        )
        redirect.delete_cookie(OAUTH_COOKIE_NAME, path="/")
        return redirect

    @router.post("/public/linuxdo/logout")
    async def public_linuxdo_logout(request: Request, response: Response) -> dict[str, bool]:
        disable_client_cache(response)
        response.delete_cookie(SESSION_COOKIE_NAME, path="/")
        return {"loggedOut": True}

    @router.get("/public/linuxdo/me")
    async def public_linuxdo_me(request: Request, response: Response) -> dict[str, Any]:
        disable_client_cache(response)
        if linuxdo_oauth is None:
            return {"user": None}
        return {
            "user": linuxdo_oauth.public_user(
                linuxdo_oauth.user_from_cookie(request.cookies.get(SESSION_COOKIE_NAME) or "")
            )
        }

    @router.post("/public/status-account/register")
    async def public_status_account_register(
        payload: StatusAccountRegisterInput,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        if status_accounts is None:
            raise ValueError("状态账号功能未启用")
        result = status_accounts.register(
            payload.username,
            payload.password,
            payload.confirm_password,
            payload.invite_code,
            client_ip=_client_ip(request),
        )
        token = str(result.pop("sessionToken") or "")
        _set_status_account_cookie(request, response, token, status_accounts)
        return result

    @router.post("/public/status-account/login")
    async def public_status_account_login(
        payload: StatusAccountLoginInput,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        if status_accounts is None:
            raise ValueError("状态账号功能未启用")
        result = status_accounts.login(
            payload.username,
            payload.password,
            client_ip=_client_ip(request),
        )
        token = str(result.pop("sessionToken") or "")
        _set_status_account_cookie(request, response, token, status_accounts)
        return result

    @router.post("/public/status-account/logout")
    async def public_status_account_logout(
        request: Request,
        response: Response,
    ) -> dict[str, bool]:
        disable_client_cache(response)
        cookie = request.cookies.get(STATUS_ACCOUNT_COOKIE_NAME) or ""
        if status_accounts is not None:
            account = status_accounts.user_from_cookie(cookie)
            if account is not None:
                status_accounts.logout_account(account)
        response.delete_cookie(STATUS_ACCOUNT_COOKIE_NAME, path="/")
        return {"loggedOut": True}

    @router.get("/public/status-account/me")
    async def public_status_account_me(
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        return {"account": _status_account_from_cookie(status_accounts, request)}

    @router.get("/public/upstream-accounts")
    async def public_upstream_accounts(
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        require_status_access(request)
        return await account_service.public_upstream_account_summary(
            include_inventory=_has_admin_session(
                auth_service, request.headers.get("authorization") or ""
            )
        )

    @router.post("/public/client-key-quota")
    async def public_client_key_quota(
        payload: ClientKeyQuotaInput,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        require_status_access(request)
        return await quota_service.lookup(payload.api_key, client_ip=_client_ip(request))

    @router.post("/public/client-key-usage")
    async def public_client_key_usage(
        payload: ClientKeyUsageInput,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        disable_client_cache(response)
        require_status_access(request)
        return await usage_service.lookup_public_usage(
            payload.api_key,
            client_ip=_client_ip(request),
            period=payload.period,
            start=payload.start,
            end=payload.end,
        )

    @router.get("/public/upstream-usage")
    async def public_upstream_usage(
        request: Request,
        response: Response,
        period: str = Query(default="24h"),
        timezone: str = Query(default="Asia/Shanghai"),
        refresh: str = Query(default=""),
    ) -> dict[str, Any]:
        disable_client_cache(response)
        require_status_access(request)
        return await usage_service.public_usage_overview(
            period=period,
            timezone=timezone,
            refresh=refresh.strip().lower() in {"1", "true", "yes"},
        )

    if request_audits is not None:

        @router.get("/public/upstream-health")
        async def public_upstream_health(
            request: Request,
            response: Response,
        ) -> dict[str, Any]:
            disable_client_cache(response)
            require_status_access(request)
            return request_audits.recent_request_health()

    if page_visits is not None:

        @router.post("/public/page-visits")
        async def public_page_visits(
            request: Request,
            response: Response,
            payload: PageVisitInput | None = None,
        ) -> dict[str, Any]:
            disable_client_cache(response)
            require_status_access(request)
            body = payload or PageVisitInput()
            result = page_visits.record_visit(
                path=body.path,
                referrer=body.referrer,
                user_agent=request.headers.get("user-agent") or "",
                client_ip=_client_ip(request),
                authorization=request.headers.get("authorization") or "",
                visitor_cookie=request.cookies.get(VISITOR_COOKIE_NAME) or "",
                linuxdo_cookie=request.cookies.get(SESSION_COOKIE_NAME) or "",
                status_cookie=request.cookies.get(STATUS_ACCOUNT_COOKIE_NAME) or "",
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
            request: Request,
            response: Response,
            period: str = Query(default="24h"),
            timezone: str = Query(default="Asia/Shanghai"),
        ) -> dict[str, Any]:
            disable_client_cache(response)
            require_status_access(request)
            return page_visits.overview(period=period, timezone=timezone)

    return router


def authorize_status_request(
    linuxdo_oauth: LinuxDoOAuthService | None,
    status_accounts: StatusAccountService | None,
    auth_service: AuthService,
    authorization: str,
    linuxdo_cookie: str,
    status_cookie: str,
) -> None:
    if linuxdo_oauth is None:
        return
    if linuxdo_oauth.is_status_authorized(authorization, linuxdo_cookie, auth_service):
        return
    if status_accounts is not None and status_accounts.user_from_cookie(status_cookie):
        return
    raise StatusLoginRequired("请先登录后再查看状态页")


def _status_account_from_cookie(
    status_accounts: StatusAccountService | None,
    request: Request,
) -> dict[str, Any] | None:
    if status_accounts is None:
        return None
    return status_accounts.public_account(
        status_accounts.user_from_cookie(
            request.cookies.get(STATUS_ACCOUNT_COOKIE_NAME) or ""
        )
    )


def _set_status_account_cookie(
    request: Request,
    response: Response,
    token: str,
    status_accounts: StatusAccountService,
) -> None:
    response.set_cookie(
        key=STATUS_ACCOUNT_COOKIE_NAME,
        value=token,
        max_age=int(getattr(status_accounts.settings, "jwt_ttl_seconds", 7 * 24 * 60 * 60)),
        path="/",
        httponly=True,
        samesite="lax",
        secure=_cookie_secure(request),
    )


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
