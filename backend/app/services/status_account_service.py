from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from jwt import InvalidTokenError
from sqlalchemy.exc import IntegrityError

from app.core.clock import app_isoformat, utc_now
from app.core.config import Settings
from app.core.rate_limit import RateLimitExceeded, SlidingWindowRateLimiter
from app.persistence.status_account_repository import StatusAccountRepository
from app.services.auth_service import AuthenticationError

PASSWORD_ITERATIONS = 310_000
JWT_ALGORITHM = "HS256"
JWT_ISSUER = "grok-iq"
STATUS_ACCOUNT_AUDIENCE = "grok-iq-status-account"
STATUS_ACCOUNT_COOKIE_NAME = "grokiq_status_account"
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
INVITE_PATTERN = re.compile(r"^[A-Z0-9_-]+$")
SHORT_LIMIT = 12
SHORT_WINDOW_SECONDS = 60.0
LONG_LIMIT = 40
LONG_WINDOW_SECONDS = 15 * 60.0
INVITE_CODE_ATTEMPTS = 8


class StatusAccountService:
    """Invite-gated local accounts for the public /status page."""

    def __init__(
        self,
        settings: Settings,
        repository: StatusAccountRepository,
        secret: str,
        *,
        limiter: SlidingWindowRateLimiter | None = None,
    ):
        self.settings = settings
        self.repository = repository
        self.secret = secret
        self.limiter = limiter or SlidingWindowRateLimiter()

    def register(
        self,
        username: str,
        password: str,
        confirm_password: str,
        invite_code: str,
        *,
        client_ip: str = "",
    ) -> dict[str, Any]:
        self._consume_rate_limit(client_ip)
        normalized_username = self._validate_username(username)
        self._validate_password(password)
        if password != confirm_password:
            raise ValueError("两次输入的密码不一致")
        normalized_invite = self._normalize_invite_code(invite_code)
        salt = secrets.token_bytes(16)
        account = self.repository.create_account(
            username=normalized_username,
            password_salt=base64.urlsafe_b64encode(salt).decode("ascii"),
            password_hash=self._hash_password(password, salt, PASSWORD_ITERATIONS),
            password_iterations=PASSWORD_ITERATIONS,
            invite_code=normalized_invite,
            now=utc_now(),
        )
        refreshed = self.repository.touch_login(int(account["id"]), utc_now()) or account
        return self._session(refreshed)

    def login(
        self,
        username: str,
        password: str,
        *,
        client_ip: str = "",
    ) -> dict[str, Any]:
        self._consume_rate_limit(client_ip)
        normalized_username = str(username or "").strip()
        account = self.repository.find_account_by_username(normalized_username)
        if account is None:
            self._hash_password(str(password or ""), bytes(16), PASSWORD_ITERATIONS)
            raise AuthenticationError("用户名或密码错误")
        if not self._password_matches(password, account):
            raise AuthenticationError("用户名或密码错误")
        if not bool(account.get("enabled", True)):
            raise AuthenticationError("账号已停用")
        refreshed = self.repository.touch_login(int(account["id"]), utc_now()) or account
        return self._session(refreshed)

    def logout_account(self, account: dict[str, Any]) -> None:
        if not self.repository.bump_token_version(int(account["id"])):
            raise AuthenticationError("登录已失效")

    def user_from_cookie(self, cookie: str) -> dict[str, Any] | None:
        token = (cookie or "").strip()
        if not token:
            return None
        try:
            payload = jwt.decode(
                token,
                self.secret,
                algorithms=[JWT_ALGORITHM],
                audience=STATUS_ACCOUNT_AUDIENCE,
                issuer=JWT_ISSUER,
                options={
                    "require": [
                        "exp",
                        "iat",
                        "nbf",
                        "sub",
                        "uid",
                        "ver",
                        "iss",
                        "aud",
                    ]
                },
            )
            account_id = int(payload["uid"])
            token_version = int(payload["ver"])
        except (InvalidTokenError, KeyError, TypeError, ValueError):
            return None
        account = self.repository.get_account(account_id)
        if account is None:
            return None
        if int(account.get("token_version") or 0) != token_version:
            return None
        if not bool(account.get("enabled", True)):
            return None
        token_sub = str(payload.get("sub") or "")
        username = str(account.get("username") or "")
        if len(token_sub) != len(username) or not hmac.compare_digest(
            token_sub, username
        ):
            return None
        return account

    def touch_seen(self, account_id: int) -> None:
        self.repository.touch_seen(account_id, utc_now())

    def encode_session(self, account: dict[str, Any]) -> str:
        token, _expires_at = self._encode_session(account)
        return token

    def public_account(self, account: dict[str, Any] | None) -> dict[str, Any] | None:
        if not account:
            return None
        return {
            "id": int(account["id"]),
            "username": str(account.get("username") or ""),
            "enabled": bool(account.get("enabled", True)),
            "loginCount": int(account.get("login_count") or 0),
            "lastLoginAt": app_isoformat(_as_datetime(account.get("last_login_at"))),
            "lastSeenAt": app_isoformat(_as_datetime(account.get("last_seen_at"))),
            "createdAt": app_isoformat(_as_datetime(account.get("created_at"))),
            "inviteCode": str(account.get("invite_code") or ""),
            "inviteCodeId": int(account["invite_code_id"]),
        }

    def public_invite(
        self,
        invite: dict[str, Any] | None,
        invited_users: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any] | None:
        if not invite:
            return None
        max_uses = int(invite.get("max_uses") or 0)
        used_count = int(invite.get("used_count") or 0)
        return {
            "id": int(invite["id"]),
            "code": str(invite.get("code") or ""),
            "note": str(invite.get("note") or ""),
            "maxUses": max_uses,
            "usedCount": used_count,
            "remaining": max(0, max_uses - used_count),
            "enabled": bool(invite.get("enabled", True)),
            "createdAt": app_isoformat(_as_datetime(invite.get("created_at"))),
            "updatedAt": app_isoformat(_as_datetime(invite.get("updated_at"))),
            "invitedUsers": [
                self._public_invited_user(user) for user in (invited_users or [])
            ],
        }

    def create_invite(
        self,
        note: str = "",
        max_uses: int = 1,
        admin_id: int | None = None,
    ) -> dict[str, Any]:
        cleaned_note = str(note or "").strip()[:200]
        resolved_max_uses = self._validate_max_uses(max_uses)
        now = utc_now()
        last_error: Exception | None = None
        for _ in range(INVITE_CODE_ATTEMPTS):
            code = secrets.token_hex(5).upper()
            try:
                invite = self.repository.create_invite(
                    code,
                    cleaned_note,
                    resolved_max_uses,
                    admin_id,
                    now,
                )
            except IntegrityError as exc:
                last_error = exc
                continue
            return self.public_invite(invite, invited_users=[]) or {}
        raise ValueError("邀请码生成失败，请重试") from last_error

    def get_invite(self, invite_id: int) -> dict[str, Any]:
        invite = self.repository.get_invite(invite_id)
        if invite is None:
            raise ValueError("邀请码不存在")
        invited = self.repository.list_accounts_for_invite(invite_id)
        return self.public_invite(invite, invited_users=invited) or {}

    def list_invites(
        self,
        *,
        query: str = "",
        page: int = 1,
        page_size: int = 50,
    ) -> dict[str, Any]:
        resolved_page, resolved_size, offset = _page_window(page, page_size)
        rows, total = self.repository.list_invites(
            query=query,
            offset=offset,
            limit=resolved_size,
        )
        items = []
        for row in rows:
            invited = self.repository.list_accounts_for_invite(int(row["id"]))
            items.append(self.public_invite(row, invited_users=invited))
        return {
            "page": resolved_page,
            "pageSize": resolved_size,
            "total": total,
            "items": items,
        }

    def update_invite(
        self,
        invite_id: int,
        note: str | None = None,
        max_uses: int | None = None,
        enabled: bool | None = None,
    ) -> dict[str, Any]:
        invite = self.repository.get_invite(invite_id)
        if invite is None:
            raise ValueError("邀请码不存在")
        fields: dict[str, Any] = {}
        if note is not None:
            fields["note"] = str(note).strip()[:200]
        if max_uses is not None:
            resolved_max_uses = self._validate_max_uses(max_uses)
            if resolved_max_uses < int(invite.get("used_count") or 0):
                raise ValueError("可用人数不能小于已使用次数")
            fields["max_uses"] = resolved_max_uses
        if enabled is not None:
            fields["enabled"] = bool(enabled)
        if fields:
            invite = self.repository.update_invite(invite_id, **fields) or invite
        invited = self.repository.list_accounts_for_invite(invite_id)
        return self.public_invite(invite, invited_users=invited) or {}

    def set_account_enabled(self, account_id: int, enabled: bool) -> dict[str, Any]:
        updated = self.repository.set_account_enabled(account_id, enabled)
        if updated is None:
            raise ValueError("账号不存在")
        return self.public_account(updated) or {}

    def delete_account(self, account_id: int) -> None:
        if not self.repository.delete_account(account_id):
            raise ValueError("账号不存在")

    def list_accounts(
        self,
        *,
        query: str = "",
        page: int = 1,
        page_size: int = 50,
    ) -> dict[str, Any]:
        resolved_page, resolved_size, offset = _page_window(page, page_size)
        rows, total = self.repository.list_accounts(
            query=query,
            offset=offset,
            limit=resolved_size,
        )
        return {
            "page": resolved_page,
            "pageSize": resolved_size,
            "total": total,
            "items": [self.public_account(row) for row in rows],
        }

    def _session(self, account: dict[str, Any]) -> dict[str, Any]:
        token, expires_at = self._encode_session(account)
        return {
            "account": self.public_account(account),
            "expiresAt": app_isoformat(expires_at),
            "sessionToken": token,
        }

    def _encode_session(self, account: dict[str, Any]) -> tuple[str, datetime]:
        issued_at = datetime.now(UTC)
        expires_at = issued_at + timedelta(seconds=self.settings.jwt_ttl_seconds)
        token = jwt.encode(
            {
                "sub": str(account["username"]),
                "uid": int(account["id"]),
                "role": "status-account",
                "ver": int(account.get("token_version") or 1),
                "iat": issued_at,
                "nbf": issued_at,
                "exp": expires_at,
                "iss": JWT_ISSUER,
                "aud": STATUS_ACCOUNT_AUDIENCE,
            },
            self.secret,
            algorithm=JWT_ALGORITHM,
        )
        return token, expires_at

    def _consume_rate_limit(self, client_ip: str) -> None:
        key = (client_ip or "unknown").strip() or "unknown"
        allowed_short, retry_short = self.limiter.allow(
            f"status-account:{key}:1m",
            limit=SHORT_LIMIT,
            window_seconds=SHORT_WINDOW_SECONDS,
        )
        allowed_long, retry_long = self.limiter.allow(
            f"status-account:{key}:15m",
            limit=LONG_LIMIT,
            window_seconds=LONG_WINDOW_SECONDS,
        )
        if not allowed_short or not allowed_long:
            raise RateLimitExceeded(retry_after=max(retry_short, retry_long, 1))

    @staticmethod
    def _validate_username(username: str) -> str:
        normalized = str(username or "").strip()
        if not normalized or not 3 <= len(normalized) <= 32:
            raise ValueError("用户名长度需为 3 到 32 个字符")
        if not USERNAME_PATTERN.fullmatch(normalized):
            raise ValueError("用户名仅允许字母、数字、下划线和短横线")
        return normalized

    @staticmethod
    def _validate_password(password: str) -> None:
        if len(password or "") < 8:
            raise ValueError("密码至少需要 8 个字符")
        if len(password or "") > 256:
            raise ValueError("密码最多 256 个字符")

    @staticmethod
    def _normalize_invite_code(raw: str) -> str:
        text = "".join(str(raw or "").split()).upper()
        if not text or not 4 <= len(text) <= 32:
            raise ValueError("邀请码格式无效")
        if not INVITE_PATTERN.fullmatch(text):
            raise ValueError("邀请码格式无效")
        return text

    @staticmethod
    def _validate_max_uses(max_uses: int) -> int:
        try:
            value = int(max_uses)
        except (TypeError, ValueError) as exc:
            raise ValueError("可用人数需在 1 到 1000 之间") from exc
        if value < 1 or value > 1000:
            raise ValueError("可用人数需在 1 到 1000 之间")
        return value

    @staticmethod
    def _hash_password(password: str, salt: bytes, iterations: int) -> str:
        return hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, iterations
        ).hex()

    def _password_matches(self, password: str, account: dict[str, Any]) -> bool:
        try:
            salt = base64.urlsafe_b64decode(str(account["password_salt"]).encode("ascii"))
            iterations = int(account.get("password_iterations") or PASSWORD_ITERATIONS)
            expected = str(account["password_hash"])
        except (KeyError, TypeError, ValueError, base64.binascii.Error):
            return False
        actual = self._hash_password(str(password or ""), salt, iterations)
        return hmac.compare_digest(actual, expected)

    @staticmethod
    def _public_invited_user(user: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": int(user["id"]),
            "username": str(user.get("username") or ""),
            "createdAt": app_isoformat(_as_datetime(user.get("created_at"))),
            "lastLoginAt": app_isoformat(_as_datetime(user.get("last_login_at"))),
            "enabled": bool(user.get("enabled", True)),
        }


def _page_window(page: int, page_size: int) -> tuple[int, int, int]:
    resolved_page = max(1, int(page or 1))
    resolved_size = min(100, max(1, int(page_size or 50)))
    return resolved_page, resolved_size, (resolved_page - 1) * resolved_size


def _as_datetime(value: Any) -> datetime | None:
    return value if isinstance(value, datetime) else None
