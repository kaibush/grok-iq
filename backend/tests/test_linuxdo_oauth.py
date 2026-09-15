from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import jwt
import pytest

from app.core.clock import utc_now
from app.core.config import Settings
from app.persistence.database import Database
from app.persistence.linuxdo_user_repository import LinuxDoUserRepository
from app.services.auth_service import AuthenticationError
from app.services.linuxdo_oauth_service import (
    SESSION_AUDIENCE,
    LinuxDoOAuthError,
    LinuxDoOAuthService,
    sanitize_return_to,
)


class FakeClient:
    def __init__(self, profile: dict | None = None):
        self.exchange_code = AsyncMock(
            return_value={"access_token": "linuxdo-access-token"}
        )
        self.fetch_userinfo = AsyncMock(
            return_value=profile
            or {
                "sub": "42",
                "username": "alice",
                "name": "Alice",
                "email": "alice@example.com",
                "avatar_url": "https://cdn.example/alice.png",
                "trust_level": 2,
                "active": True,
                "silenced": False,
            }
        )


def _build(
    tmp_path: Path,
    *,
    enabled: bool = False,
    client_id: str = "linuxdo-client",
    client_secret: str = "linuxdo-secret",
    client: FakeClient | None = None,
) -> LinuxDoOAuthService:
    settings = Settings(
        _env_file=None,
        database_path=tmp_path / "grokiq.db",
        jwt_secret_key="x" * 48,
        status_linuxdo_oauth_enabled=enabled,
        linuxdo_oauth_client_id=client_id,
        linuxdo_oauth_client_secret=client_secret,
    )
    database = Database(settings.database_path)
    database.initialize()
    return LinuxDoOAuthService(
        settings,
        LinuxDoUserRepository(database),
        settings.jwt_secret_key,
        client=client or FakeClient(),
    )


async def _login(service: LinuxDoOAuthService) -> tuple[dict, str]:
    _url, cookie = service.start_login(
        return_to="/status",
        request_origin="https://status.example",
    )
    state = jwt.decode(
        cookie,
        service.secret,
        algorithms=["HS256"],
        audience="grok-iq-linuxdo-oauth",
        issuer="grok-iq",
    )["state"]
    user, session_cookie, _return_to = await service.complete_login(
        code="auth-code",
        state=state,
        oauth_cookie=cookie,
    )
    return user, session_cookie


def test_access_status_switch_off_is_not_required(tmp_path: Path):
    service = _build(tmp_path, enabled=False)
    auth = MagicMock()
    auth.authenticate_authorization.side_effect = AuthenticationError("请先登录")
    status = service.access_status("", "", auth)
    assert status["required"] is False
    assert status["configured"] is True
    assert status["admin"] is False
    assert status["user"] is None
    assert service.is_status_authorized("", "", auth) is True


def test_switch_on_requires_linuxdo_or_admin(tmp_path: Path):
    service = _build(tmp_path, enabled=True)
    auth = MagicMock()
    auth.authenticate_authorization.side_effect = AuthenticationError("请先登录")
    assert service.access_status("", "", auth)["required"] is True
    assert service.is_status_authorized("", "", auth) is False

    auth.authenticate_authorization.side_effect = None
    auth.authenticate_authorization.return_value = {"id": 1, "username": "admin"}
    assert service.is_status_authorized("Bearer admin", "", auth) is True


def test_start_login_requires_config(tmp_path: Path):
    service = _build(tmp_path, client_id="", client_secret="")
    with pytest.raises(LinuxDoOAuthError, match="尚未配置"):
        service.start_login(return_to="/status", request_origin="https://status.example")


def test_start_login_builds_authorize_url(tmp_path: Path):
    service = _build(tmp_path)
    url, cookie = service.start_login(
        return_to="/status",
        request_origin="https://status.example",
    )
    assert "client_id=linuxdo-client" in url
    assert "code_challenge=" in url
    assert "code_challenge_method=S256" in url
    assert "scope=openid+profile+email" in url or "scope=openid%20profile%20email" in url
    assert "state=" in url
    assert cookie


@pytest.mark.asyncio
async def test_complete_login_rejects_bad_state(tmp_path: Path):
    service = _build(tmp_path)
    _url, cookie = service.start_login(
        return_to="/status",
        request_origin="https://status.example",
    )
    with pytest.raises(LinuxDoOAuthError, match="状态无效"):
        await service.complete_login(code="abc", state="wrong", oauth_cookie=cookie)


@pytest.mark.asyncio
async def test_complete_login_upserts_user_and_issues_status_jwt(tmp_path: Path):
    service = _build(tmp_path)
    _url, cookie = service.start_login(
        return_to="/status",
        request_origin="https://status.example",
    )
    state = jwt.decode(
        cookie,
        service.secret,
        algorithms=["HS256"],
        audience="grok-iq-linuxdo-oauth",
        issuer="grok-iq",
    )["state"]
    user, session_cookie, return_to = await service.complete_login(
        code="auth-code",
        state=state,
        oauth_cookie=cookie,
    )
    assert return_to == "/status"
    assert user["username"] == "alice"
    assert user["linuxdoId"] == "42"
    payload = jwt.decode(
        session_cookie,
        service.secret,
        algorithms=["HS256"],
        audience=SESSION_AUDIENCE,
        issuer="grok-iq",
    )
    assert payload["aud"] == SESSION_AUDIENCE
    assert payload["role"] == "linuxdo"
    assert payload["sub"] == "42"
    loaded = service.user_from_cookie(session_cookie)
    assert loaded is not None
    assert loaded["username"] == "alice"


def test_sanitize_return_to_rejects_open_redirects():
    assert sanitize_return_to("https://evil.example") == "/status"
    assert sanitize_return_to("//evil.example") == "/status"
    assert sanitize_return_to("/admin") == "/status"
    assert sanitize_return_to("/status?tab=usage") == "/status?tab=usage"


@pytest.mark.asyncio
async def test_admin_can_disable_and_delete_linuxdo_user(tmp_path: Path):
    service = _build(tmp_path)
    user, session_cookie = await _login(service)
    user_id = int(user["id"])
    assert service.user_from_cookie(session_cookie) is not None
    assert user["enabled"] is True

    disabled = service.set_user_enabled(user_id, False)
    assert disabled["enabled"] is False
    assert service.user_from_cookie(session_cookie) is None
    with pytest.raises(LinuxDoOAuthError, match="账号已停用"):
        await _login(service)
    stored = service.repository.get(user_id)
    assert stored is not None
    assert stored["login_count"] == 1
    assert stored["enabled"] is False

    enabled = service.set_user_enabled(user_id, True)
    assert enabled["enabled"] is True
    assert service.user_from_cookie(session_cookie) is not None
    relogin, _cookie = await _login(service)
    assert relogin["id"] == user_id
    assert relogin["loginCount"] == 2

    service.delete_user(user_id)
    assert service.repository.get(user_id) is None
    assert service.user_from_cookie(session_cookie) is None
    created, new_cookie = await _login(service)
    assert created["enabled"] is True
    assert created["loginCount"] == 1
    assert created["linuxdoId"] == "42"
    loaded = service.user_from_cookie(new_cookie)
    assert loaded is not None
    assert loaded["linuxdo_id"] == "42"


def test_linuxdo_upsert_does_not_overwrite_admin_enabled(tmp_path: Path):
    service = _build(tmp_path)
    now = utc_now()
    created = service.repository.upsert_from_profile(
        {
            "sub": "42",
            "username": "alice",
            "name": "Alice",
            "active": True,
            "silenced": False,
        },
        now=now,
    )
    service.repository.set_enabled(int(created["id"]), False)
    updated = service.repository.upsert_from_profile(
        {
            "sub": "42",
            "username": "alice-new",
            "name": "Alice",
            "active": False,
            "silenced": True,
        },
        now=now,
    )
    assert updated["enabled"] is False
    assert updated["username"] == "alice-new"
    assert updated["active"] is False
    assert updated["silenced"] is True
    assert updated["login_count"] == 2
