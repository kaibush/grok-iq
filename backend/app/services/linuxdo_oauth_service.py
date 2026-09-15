from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlparse

import jwt
from jwt import InvalidTokenError

from app.core.clock import app_isoformat, utc_now
from app.core.config import Settings
from app.integrations.linuxdo.oauth import (
    LinuxDoConnectError,
    LinuxDoOAuthClient,
    build_authorize_url,
    generate_pkce_pair,
)
from app.persistence.linuxdo_user_repository import LinuxDoUserRepository
from app.services.auth_service import AuthenticationError, AuthService

JWT_ALGORITHM = "HS256"
JWT_ISSUER = "grok-iq"
SESSION_AUDIENCE = "grok-iq-status"
OAUTH_STATE_AUDIENCE = "grok-iq-linuxdo-oauth"
SESSION_COOKIE_NAME = "grokiq_linuxdo"
OAUTH_COOKIE_NAME = "grokiq_linuxdo_oauth"
OAUTH_STATE_TTL_SECONDS = 10 * 60
DEFAULT_RETURN_TO = "/status"


class LinuxDoOAuthError(ValueError):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


class StatusLoginRequired(Exception):
    def __init__(self, message: str = "请先登录后再查看状态页"):
        super().__init__(message)
        self.message = message
        self.code = "linuxdo_login_required"


class LinuxDoOAuthService:
    """Linux.do Connect login for the public /status page."""

    def __init__(
        self,
        settings: Settings,
        repository: LinuxDoUserRepository,
        secret: str,
        client: LinuxDoOAuthClient | None = None,
    ):
        self.settings = settings
        self.repository = repository
        self.secret = secret
        self.client = client or LinuxDoOAuthClient()

    def enabled(self) -> bool:
        return bool(self.settings.status_linuxdo_oauth_enabled)

    def configured(self) -> bool:
        return bool(
            self.settings.linuxdo_oauth_client_id.strip()
            and self.settings.linuxdo_oauth_client_secret
        )

    def access_status(
        self,
        authorization: str,
        linuxdo_cookie: str,
        admin_auth: AuthService,
    ) -> dict[str, Any]:
        return {
            "required": self.enabled(),
            "configured": self.configured(),
            "admin": self._is_admin(admin_auth, authorization),
            "user": self.public_user(self.user_from_cookie(linuxdo_cookie)),
        }

    def is_status_authorized(
        self,
        authorization: str,
        linuxdo_cookie: str,
        admin_auth: AuthService,
    ) -> bool:
        if self._is_admin(admin_auth, authorization):
            return True
        if not self.enabled():
            return True
        return self.user_from_cookie(linuxdo_cookie) is not None

    def require_status_access(
        self,
        authorization: str,
        linuxdo_cookie: str,
        admin_auth: AuthService,
    ) -> None:
        if not self.is_status_authorized(authorization, linuxdo_cookie, admin_auth):
            raise StatusLoginRequired()

    def start_login(
        self,
        *,
        return_to: str = "",
        request_origin: str = "",
    ) -> tuple[str, str]:
        if not self.configured():
            raise LinuxDoOAuthError("尚未配置 Linux.do OAuth2")
        verifier, challenge = generate_pkce_pair()
        state = secrets.token_urlsafe(24)
        redirect_uri = self.redirect_uri(request_origin)
        cookie = self._encode_oauth_state(
            {
                "state": state,
                "verifier": verifier,
                "return_to": sanitize_return_to(return_to),
                "redirect_uri": redirect_uri,
            }
        )
        url = build_authorize_url(
            client_id=self.settings.linuxdo_oauth_client_id.strip(),
            redirect_uri=redirect_uri,
            state=state,
            code_challenge=challenge,
        )
        return url, cookie

    async def complete_login(
        self,
        *,
        code: str,
        state: str,
        oauth_cookie: str,
    ) -> tuple[dict[str, Any], str, str]:
        payload = self._decode_oauth_state(oauth_cookie)
        expected_state = str(payload.get("state") or "")
        if not state or not expected_state or state != expected_state:
            raise LinuxDoOAuthError("Linux.do 登录状态无效")
        code_value = (code or "").strip()
        if not code_value:
            raise LinuxDoOAuthError("缺少 Linux.do 授权码")
        redirect_uri = str(payload.get("redirect_uri") or "").strip()
        if not redirect_uri:
            raise LinuxDoOAuthError("Linux.do 回调地址无效")
        try:
            token_payload = await self.client.exchange_code(
                code=code_value,
                redirect_uri=redirect_uri,
                client_id=self.settings.linuxdo_oauth_client_id.strip(),
                client_secret=self.settings.linuxdo_oauth_client_secret,
                code_verifier=str(payload.get("verifier") or ""),
            )
            profile = await self.client.fetch_userinfo(
                str(token_payload.get("access_token") or "")
            )
        except LinuxDoConnectError as exc:
            raise LinuxDoOAuthError(str(exc), status_code=exc.status_code) from exc
        user = self.repository.upsert_from_profile(profile, now=utc_now())
        return (
            self.public_user(user) or {},
            self._encode_session(user),
            sanitize_return_to(str(payload.get("return_to") or "")),
        )

    def user_from_cookie(self, cookie: str) -> dict[str, Any] | None:
        token = (cookie or "").strip()
        if not token:
            return None
        try:
            payload = jwt.decode(
                token,
                self.secret,
                algorithms=[JWT_ALGORITHM],
                audience=SESSION_AUDIENCE,
                issuer=JWT_ISSUER,
                options={"require": ["exp", "iat", "nbf", "sub", "uid", "iss", "aud"]},
            )
            user_id = int(payload["uid"])
        except (InvalidTokenError, KeyError, TypeError, ValueError):
            return None
        user = self.repository.get(user_id)
        if user is None:
            return None
        if str(user.get("linuxdo_id") or "") != str(payload.get("sub") or ""):
            return None
        return user

    def touch_seen(self, user_id: int) -> None:
        self.repository.touch_seen(user_id, utc_now())

    def list_users(
        self,
        *,
        query: str = "",
        page: int = 1,
        page_size: int = 50,
    ) -> dict[str, Any]:
        resolved_page = max(1, int(page or 1))
        resolved_size = min(100, max(1, int(page_size or 50)))
        rows, total = self.repository.list_page(
            query=query,
            offset=(resolved_page - 1) * resolved_size,
            limit=resolved_size,
        )
        return {
            "page": resolved_page,
            "pageSize": resolved_size,
            "total": total,
            "items": [self.public_user(row) for row in rows],
        }

    def redirect_uri(self, request_origin: str = "") -> str:
        configured = self.settings.linuxdo_oauth_redirect_uri.strip()
        if configured:
            return configured
        origin = (request_origin or "").rstrip("/")
        if not origin:
            raise LinuxDoOAuthError("无法推断 Linux.do 回调地址")
        return f"{origin}/api/public/linuxdo/callback"

    @staticmethod
    def public_user(user: dict[str, Any] | None) -> dict[str, Any] | None:
        if not user:
            return None
        return {
            "id": int(user["id"]),
            "linuxdoId": str(user.get("linuxdo_id") or ""),
            "username": str(user.get("username") or ""),
            "name": str(user.get("name") or ""),
            "email": str(user.get("email") or ""),
            "avatarUrl": str(user.get("avatar_url") or ""),
            "trustLevel": int(user.get("trust_level") or 0),
            "active": bool(user.get("active", True)),
            "silenced": bool(user.get("silenced", False)),
            "loginCount": int(user.get("login_count") or 0),
            "lastLoginAt": app_isoformat(_as_datetime(user.get("last_login_at"))),
            "lastSeenAt": app_isoformat(_as_datetime(user.get("last_seen_at"))),
            "createdAt": app_isoformat(_as_datetime(user.get("created_at"))),
        }

    def _encode_session(self, user: dict[str, Any]) -> str:
        issued_at = datetime.now(UTC)
        expires_at = issued_at + timedelta(seconds=self.settings.jwt_ttl_seconds)
        return jwt.encode(
            {
                "sub": str(user["linuxdo_id"]),
                "uid": int(user["id"]),
                "username": str(user.get("username") or ""),
                "role": "linuxdo",
                "iat": issued_at,
                "nbf": issued_at,
                "exp": expires_at,
                "iss": JWT_ISSUER,
                "aud": SESSION_AUDIENCE,
            },
            self.secret,
            algorithm=JWT_ALGORITHM,
        )

    def _encode_oauth_state(self, values: dict[str, str]) -> str:
        issued_at = datetime.now(UTC)
        expires_at = issued_at + timedelta(seconds=OAUTH_STATE_TTL_SECONDS)
        return jwt.encode(
            {
                **values,
                "iat": issued_at,
                "nbf": issued_at,
                "exp": expires_at,
                "iss": JWT_ISSUER,
                "aud": OAUTH_STATE_AUDIENCE,
            },
            self.secret,
            algorithm=JWT_ALGORITHM,
        )

    def _decode_oauth_state(self, cookie: str) -> dict[str, Any]:
        token = (cookie or "").strip()
        if not token:
            raise LinuxDoOAuthError("Linux.do 登录已过期，请重试")
        try:
            payload = jwt.decode(
                token,
                self.secret,
                algorithms=[JWT_ALGORITHM],
                audience=OAUTH_STATE_AUDIENCE,
                issuer=JWT_ISSUER,
                options={"require": ["exp", "iat", "nbf", "iss", "aud", "state"]},
            )
        except InvalidTokenError as exc:
            raise LinuxDoOAuthError("Linux.do 登录已过期，请重试") from exc
        return payload

    @staticmethod
    def _is_admin(admin_auth: AuthService, authorization: str) -> bool:
        if not (authorization or "").strip():
            return False
        try:
            admin_auth.authenticate_authorization(authorization)
        except AuthenticationError:
            return False
        return True


def sanitize_return_to(value: str) -> str:
    text = (value or "").strip() or DEFAULT_RETURN_TO
    parsed = urlparse(text)
    if parsed.scheme or parsed.netloc:
        return DEFAULT_RETURN_TO
    path = parsed.path or DEFAULT_RETURN_TO
    if path != "/status" and not path.startswith("/status/"):
        return DEFAULT_RETURN_TO
    if parsed.query:
        return f"{path}?{parsed.query}"
    return path


def request_origin(request: Any) -> str:
    forwarded = (request.headers.get("x-forwarded-proto") or "").split(",", 1)[0].strip()
    scheme = forwarded or request.url.scheme
    host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(
        ",", 1
    )[0].strip()
    if not host:
        host = request.base_url.hostname or ""
        port = request.base_url.port
        if port and port not in {80, 443}:
            host = f"{host}:{port}"
    if not host:
        return str(request.base_url).rstrip("/")
    return f"{scheme}://{host}"


def _as_datetime(value: Any) -> datetime | None:
    return value if isinstance(value, datetime) else None
