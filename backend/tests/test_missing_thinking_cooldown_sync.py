from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

from app.core.clock import utc_now
from app.core.config import Settings
from app.integrations.grok2api.client import IntegrationError
from app.persistence.account_repository import AccountRepository
from app.persistence.database import Database
from app.services.missing_thinking_cooldown_sync import (
    MissingThinkingCooldownSyncService,
)


class FakeClient:
    def __init__(self, accounts: list[dict[str, Any]]) -> None:
        self.accounts = {int(item["id"]): dict(item) for item in accounts}
        self.list_calls: list[dict[str, Any]] = []

    async def list_all_accounts(self, **params: Any) -> list[dict[str, Any]]:
        self.list_calls.append(params)
        return [dict(item) for item in self.accounts.values()]


def _service(
    tmp_path: Path,
    *,
    enabled: bool = True,
    accounts: list[dict[str, Any]] | None = None,
) -> tuple[FakeClient, AccountRepository, MissingThinkingCooldownSyncService]:
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repo = AccountRepository(database)
    now = utc_now()
    client = FakeClient(
        accounts
        or [
            {
                "id": "21",
                "name": "Cooling Thinker",
                "email": "thinker@example.test",
                "enabled": True,
                "lastError": "missing_thinking",
                "cooldownUntil": (now + timedelta(minutes=25)).isoformat(),
                "updatedAt": now.isoformat(),
            },
            {
                "id": "22",
                "name": "Disabled Thinker",
                "email": "disabled@example.test",
                "enabled": False,
                "lastError": "missing_thinking_disabled",
            },
            {
                "id": "23",
                "name": "Expired Thinker",
                "email": "expired@example.test",
                "enabled": True,
                "lastError": "missing_thinking",
                "cooldownUntil": (now - timedelta(minutes=5)).isoformat(),
            },
        ]
    )
    scanner = MissingThinkingCooldownSyncService(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            missing_thinking_cooldown_sync_enabled=enabled,
        ),
        client=client,  # type: ignore[arg-type]
        accounts=repo,
    )
    return client, repo, scanner


@pytest.mark.asyncio
async def test_scan_skips_when_switch_is_off(tmp_path: Path):
    client, _repo, scanner = _service(tmp_path, enabled=False)

    result = await scanner.scan()

    assert result["ok"] is True
    assert result["skipped"] is True
    assert result["reason"] == "disabled"
    assert client.list_calls == []


@pytest.mark.asyncio
async def test_scan_persists_active_missing_thinking_cooldowns(tmp_path: Path):
    client, repo, scanner = _service(tmp_path)

    result = await scanner.scan()

    assert result["ok"] is True
    assert result["skipped"] is False
    assert result["matched"] == 1
    assert result["cooling"] == 1
    assert result["upserted"] == 1
    assert result["expired"] == 0
    assert client.list_calls[0]["status"] == "missingThinking"
    assert client.list_calls[0]["degradeWindow"] == "1h"
    stored = repo.get_account_cooldown(21)
    assert stored is not None
    assert stored["status"] == "cooling"
    assert stored["last_error"] == "missing_thinking"
    assert repo.get_account_cooldown(22) is None
    assert repo.get_account_cooldown(23) is None


@pytest.mark.asyncio
async def test_scan_expires_accounts_that_left_upstream_cooling(tmp_path: Path):
    client, repo, scanner = _service(tmp_path)
    now = utc_now()
    repo.upsert_missing_thinking_cooldown(
        account_id=99,
        cooled_at=now - timedelta(minutes=10),
        cooldown_until=now + timedelta(minutes=10),
        last_error="missing_thinking",
        snapshot={"id": 99, "name": "Stale", "enabled": True},
    )

    result = await scanner.scan()

    assert result["expired"] == 1
    stale = repo.get_account_cooldown(99)
    assert stale is not None
    assert stale["status"] == "expired"
    assert stale["released_manually"] is False
    current = repo.get_account_cooldown(21)
    assert current is not None
    assert current["status"] == "cooling"


@pytest.mark.asyncio
async def test_scan_reports_upstream_errors(tmp_path: Path):
    _client, _repo, scanner = _service(tmp_path)

    async def boom(**_params: Any) -> list[dict[str, Any]]:
        raise IntegrationError("grok2api 请求失败")

    scanner.client.list_all_accounts = boom  # type: ignore[method-assign]

    result = await scanner.scan()

    assert result["ok"] is False
    assert result["reason"] == "upstream_error"
    assert "grok2api" in result["error"]
