from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import jwt
import pytest

from app.core.config import Settings
from app.persistence.database import Database
from app.persistence.status_account_repository import StatusAccountRepository
from app.services.auth_service import AuthenticationError
from app.services.linuxdo_oauth_service import StatusLoginRequired
from app.services.status_account_service import (
    STATUS_ACCOUNT_AUDIENCE,
    StatusAccountService,
)
from app.web.routes.public import authorize_status_request


def _build(tmp_path: Path) -> tuple[Database, StatusAccountService]:
    settings = Settings(
        _env_file=None,
        database_path=tmp_path / "grokiq.db",
        jwt_secret_key="s" * 48,
        jwt_ttl_seconds=7 * 24 * 60 * 60,
        status_linuxdo_oauth_enabled=True,
    )
    database = Database(settings.database_path)
    database.initialize()
    service = StatusAccountService(
        settings,
        StatusAccountRepository(database),
        settings.jwt_secret_key,
    )
    return database, service


def test_register_requires_invite_code(tmp_path: Path):
    database, service = _build(tmp_path)
    with pytest.raises(ValueError, match="邀请码"):
        service.register("alice", "password123", "password123", "")
    database.dispose()


def test_invite_max_uses_blocks_second_registration(tmp_path: Path):
    database, service = _build(tmp_path)
    invite = service.create_invite(note="once", max_uses=1, admin_id=1)
    first = service.register("alice", "password123", "password123", invite["code"])
    assert first["account"]["username"] == "alice"
    with pytest.raises(ValueError, match="邀请码无效或已用完"):
        service.register("bob", "password123", "password123", invite["code"])
    loaded = service.get_invite(invite["id"])
    assert loaded["usedCount"] == 1
    assert loaded["remaining"] == 0
    database.dispose()


def test_register_and_login_issue_status_account_jwt(tmp_path: Path):
    database, service = _build(tmp_path)
    invite = service.create_invite(note="login", max_uses=2, admin_id=1)
    registered = service.register("alice", "password123", "password123", invite["code"])
    token = registered["sessionToken"]
    payload = jwt.decode(
        token,
        service.secret,
        algorithms=["HS256"],
        audience=STATUS_ACCOUNT_AUDIENCE,
        issuer="grok-iq",
    )
    assert payload["aud"] == STATUS_ACCOUNT_AUDIENCE
    assert payload["role"] == "status-account"
    assert payload["sub"] == "alice"
    assert int(payload["exp"]) - int(payload["iat"]) == 7 * 24 * 60 * 60
    loaded = service.user_from_cookie(token)
    assert loaded is not None
    assert loaded["username"] == "alice"

    logged_in = service.login("Alice", "password123")
    assert logged_in["account"]["username"] == "alice"
    assert service.user_from_cookie(logged_in["sessionToken"])["username"] == "alice"
    database.dispose()


def test_wrong_password_does_not_reveal_account(tmp_path: Path):
    database, service = _build(tmp_path)
    invite = service.create_invite(note="secret", max_uses=1, admin_id=1)
    service.register("alice", "password123", "password123", invite["code"])
    with pytest.raises(AuthenticationError, match="用户名或密码错误"):
        service.login("alice", "wrong-password")
    with pytest.raises(AuthenticationError, match="用户名或密码错误"):
        service.login("missing-user", "password123")
    database.dispose()


def test_logout_revokes_existing_jwt(tmp_path: Path):
    database, service = _build(tmp_path)
    invite = service.create_invite(note="logout", max_uses=1, admin_id=1)
    registered = service.register("alice", "password123", "password123", invite["code"])
    account = service.user_from_cookie(registered["sessionToken"])
    assert account is not None
    service.logout_account(account)
    assert service.user_from_cookie(registered["sessionToken"]) is None
    database.dispose()


def test_admin_invite_list_includes_invited_users(tmp_path: Path):
    database, service = _build(tmp_path)
    invite = service.create_invite(note="friends", max_uses=3, admin_id=1)
    service.register("alice", "password123", "password123", invite["code"])
    updated = service.update_invite(invite["id"], max_uses=5, note="updated")
    assert updated["maxUses"] == 5
    assert updated["note"] == "updated"
    listed = service.list_invites()
    assert listed["total"] == 1
    item = listed["items"][0]
    assert item["code"] == invite["code"]
    assert item["usedCount"] == 1
    assert item["remaining"] == 4
    assert [user["username"] for user in item["invitedUsers"]] == ["alice"]
    database.dispose()


def test_max_uses_cannot_drop_below_used_count(tmp_path: Path):
    database, service = _build(tmp_path)
    invite = service.create_invite(note="limit", max_uses=2, admin_id=1)
    service.register("alice", "password123", "password123", invite["code"])
    service.register("bob", "password123", "password123", invite["code"])
    with pytest.raises(ValueError, match="不能小于已使用次数"):
        service.update_invite(invite["id"], max_uses=1)
    still = service.get_invite(invite["id"])
    assert still["maxUses"] == 2
    assert still["usedCount"] == 2
    database.dispose()


def test_status_account_cookie_authorizes_when_linuxdo_required(tmp_path: Path):
    database, service = _build(tmp_path)
    invite = service.create_invite(note="access", max_uses=1, admin_id=1)
    registered = service.register("alice", "password123", "password123", invite["code"])
    linuxdo = MagicMock()
    linuxdo.is_status_authorized.return_value = False
    auth = MagicMock()
    with pytest.raises(StatusLoginRequired, match="请先登录后再查看状态页"):
        authorize_status_request(linuxdo, service, auth, "", "", "")
    authorize_status_request(
        linuxdo,
        service,
        auth,
        "",
        "",
        registered["sessionToken"],
    )
    linuxdo.is_status_authorized.assert_called()
    database.dispose()


def test_disabled_invite_rejects_register(tmp_path: Path):
    database, service = _build(tmp_path)
    invite = service.create_invite(note="paused", max_uses=2, admin_id=1)
    service.update_invite(invite["id"], enabled=False)
    with pytest.raises(ValueError, match="邀请码无效或已用完"):
        service.register("alice", "password123", "password123", invite["code"])
    loaded = service.get_invite(invite["id"])
    assert loaded["usedCount"] == 0
    assert loaded["enabled"] is False
    database.dispose()


def test_duplicate_username_does_not_consume_invite(tmp_path: Path):
    database, service = _build(tmp_path)
    invite = service.create_invite(note="dup", max_uses=2, admin_id=1)
    service.register("alice", "password123", "password123", invite["code"])
    with pytest.raises(ValueError, match="用户名已被使用"):
        service.register("Alice", "password123", "password123", invite["code"])
    loaded = service.get_invite(invite["id"])
    assert loaded["usedCount"] == 1
    assert loaded["remaining"] == 1
    database.dispose()


def test_invite_search_matches_invited_username(tmp_path: Path):
    database, service = _build(tmp_path)
    invite = service.create_invite(note="friends", max_uses=2, admin_id=1)
    other = service.create_invite(note="other", max_uses=1, admin_id=1)
    service.register("alice", "password123", "password123", invite["code"])
    listed = service.list_invites(query="alice")
    assert listed["total"] == 1
    assert listed["items"][0]["id"] == invite["id"]
    missed = service.list_invites(query=other["code"])
    assert missed["total"] == 1
    assert missed["items"][0]["id"] == other["id"]
    database.dispose()


def test_touch_seen_updates_last_seen_without_login_count(tmp_path: Path):
    database, service = _build(tmp_path)
    invite = service.create_invite(note="seen", max_uses=1, admin_id=1)
    registered = service.register("alice", "password123", "password123", invite["code"])
    account_id = int(registered["account"]["id"])
    before = service.repository.get_account(account_id)
    assert before is not None
    login_count = int(before["login_count"] or 0)
    last_login = before.get("last_login_at")
    service.touch_seen(account_id)
    after = service.repository.get_account(account_id)
    assert after is not None
    assert int(after["login_count"] or 0) == login_count
    assert after.get("last_login_at") == last_login
    assert after.get("last_seen_at") is not None
    database.dispose()


def test_admin_can_disable_and_delete_status_account(tmp_path: Path):
    database, service = _build(tmp_path)
    invite = service.create_invite(note="manage", max_uses=2, admin_id=1)
    registered = service.register("alice", "password123", "password123", invite["code"])
    token = registered["sessionToken"]
    account_id = int(registered["account"]["id"])
    linuxdo = MagicMock()
    linuxdo.is_status_authorized.return_value = False
    auth = MagicMock()

    disabled = service.set_account_enabled(account_id, False)
    assert disabled["enabled"] is False
    assert service.user_from_cookie(token) is None
    with pytest.raises(AuthenticationError, match="账号已停用"):
        service.login("alice", "password123")
    with pytest.raises(StatusLoginRequired, match="请先登录后再查看状态页"):
        authorize_status_request(linuxdo, service, auth, "", "", token)

    enabled = service.set_account_enabled(account_id, True)
    assert enabled["enabled"] is True
    assert service.user_from_cookie(token) is None
    logged_in = service.login("alice", "password123")
    fresh_token = logged_in["sessionToken"]
    assert service.user_from_cookie(fresh_token)["username"] == "alice"
    authorize_status_request(linuxdo, service, auth, "", "", fresh_token)

    service.delete_account(account_id)
    assert service.repository.get_account(account_id) is None
    assert service.user_from_cookie(fresh_token) is None
    with pytest.raises(AuthenticationError, match="用户名或密码错误"):
        service.login("alice", "password123")
    listed = service.list_accounts()
    assert listed["total"] == 0
    leftover_invite = service.get_invite(invite["id"])
    assert leftover_invite["usedCount"] == 1
    database.dispose()
