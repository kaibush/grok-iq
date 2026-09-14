from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.core.rate_limit import RateLimitExceeded
from app.integrations.grok2api.client import IntegrationError
from app.integrations.wechat.client import WeChatIntegrationError
from app.persistence.auth_repository import AdminAlreadyExistsError
from app.persistence.probe_repository import QueueFullError, RunStateError
from app.services.auth_service import AuthenticationError
from app.services.chat_service import ChatUpstreamError
from app.services.linuxdo_oauth_service import LinuxDoOAuthError, StatusLoginRequired
from app.services.sso_report_service import SsoReportNotFoundError

from .auth import AdminAuthenticationRequired

logger = logging.getLogger(__name__)
NO_STORE_HEADERS = {"Cache-Control": "no-store", "Pragma": "no-cache"}


def _error_response(
    status_code: int,
    exc: Exception,
    *,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        headers=headers,
        content={"detail": str(exc)},
    )


def install_exception_handlers(app: FastAPI) -> None:
    """Register the HTTP-boundary exception policy in one place."""

    @app.exception_handler(AdminAuthenticationRequired)
    async def admin_authentication_required(
        _: Request,
        exc: AdminAuthenticationRequired,
    ) -> JSONResponse:
        return JSONResponse(
            status_code=401,
            headers=NO_STORE_HEADERS,
            content={
                "detail": exc.message,
                "code": (
                    "setup_required"
                    if exc.setup_required
                    else "authentication_required"
                ),
                "setupRequired": exc.setup_required,
            },
        )

    @app.exception_handler(AuthenticationError)
    async def authentication_error(
        _: Request,
        exc: AuthenticationError,
    ) -> JSONResponse:
        return _error_response(401, exc, headers=NO_STORE_HEADERS)

    @app.exception_handler(StatusLoginRequired)
    async def status_login_required(
        _: Request,
        exc: StatusLoginRequired,
    ) -> JSONResponse:
        return JSONResponse(
            status_code=401,
            headers=NO_STORE_HEADERS,
            content={"detail": exc.message, "code": exc.code},
        )

    @app.exception_handler(LinuxDoOAuthError)
    async def linuxdo_oauth_error(
        _: Request,
        exc: LinuxDoOAuthError,
    ) -> JSONResponse:
        status_code = exc.status_code if 400 <= exc.status_code < 600 else 400
        return _error_response(status_code, exc, headers=NO_STORE_HEADERS)

    @app.exception_handler(AdminAlreadyExistsError)
    @app.exception_handler(RunStateError)
    async def conflict_error(_: Request, exc: Exception) -> JSONResponse:
        return _error_response(409, exc)

    @app.exception_handler(QueueFullError)
    async def queue_full_error(_: Request, exc: QueueFullError) -> JSONResponse:
        return _error_response(429, exc)

    @app.exception_handler(RateLimitExceeded)
    async def rate_limit_exceeded(_: Request, exc: RateLimitExceeded) -> JSONResponse:
        return _error_response(
            429,
            exc,
            headers={**NO_STORE_HEADERS, "Retry-After": str(exc.retry_after)},
        )

    @app.exception_handler(SsoReportNotFoundError)
    async def sso_report_not_found(
        _: Request,
        exc: SsoReportNotFoundError,
    ) -> JSONResponse:
        return _error_response(404, exc)

    @app.exception_handler(ChatUpstreamError)
    async def chat_upstream_error(
        _: Request,
        exc: ChatUpstreamError,
    ) -> JSONResponse:
        status_code = exc.status_code if 400 <= exc.status_code < 600 else 502
        return _error_response(status_code, exc)

    @app.exception_handler(IntegrationError)
    @app.exception_handler(WeChatIntegrationError)
    async def upstream_error(_: Request, exc: Exception) -> JSONResponse:
        return _error_response(502, exc)

    @app.exception_handler(ValueError)
    async def invalid_operation(_: Request, exc: ValueError) -> JSONResponse:
        return _error_response(400, exc)

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        logger.error(
            "unhandled request error method=%s path=%s",
            request.method,
            request.url.path,
            exc_info=(type(exc), exc, exc.__traceback__),
        )
        return JSONResponse(
            status_code=500,
            content={"detail": "服务器内部错误"},
        )
