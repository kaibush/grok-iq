from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from app.core.clock import app_day_key, app_isoformat, utc_now
from app.core.config import Settings
from app.persistence.account_repository import AccountRepository
from app.persistence.database import Database
from app.persistence.probe_repository import ProbeRepository
from app.persistence.request_audit_repository import RequestAuditRepository
from app.services.account_service import AccountService


class CooldownClient:
    def __init__(self, accounts: list[dict[str, Any]] | None = None) -> None:
        self.accounts = {int(item["id"]): dict(item) for item in (accounts or [])}
        self.missing_thinking: list[dict[str, Any]] = []
        self.enabled_calls: list[tuple[int, bool]] = []
        self.list_calls: list[dict[str, Any]] = []
        self.list_missing_calls: list[dict[str, Any]] = []
        self.clear_calls: list[int] = []

    async def list_all_accounts(self, **params: Any) -> list[dict[str, Any]]:
        self.list_calls.append(params)
        return [dict(item) for item in self.accounts.values()]

    async def list_missing_thinking(self, **params: Any) -> dict[str, Any]:
        self.list_missing_calls.append(params)
        state = str(params.get("state") or "").strip()
        search = str(params.get("search") or "").strip().lower()
        items = [dict(item) for item in self.missing_thinking]
        if state:
            items = [item for item in items if str(item.get("state") or "") == state]
        if search:
            items = [
                item
                for item in items
                if search in str(item.get("accountName") or "").lower()
                or search == str(item.get("accountId") or "")
            ]
        page = int(params.get("page") or 1)
        page_size = int(params.get("pageSize") or 20)
        start = (page - 1) * page_size
        return {
            "items": items[start : start + page_size],
            "page": page,
            "pageSize": page_size,
            "total": len(items),
            "totals": _missing_thinking_totals(items),
        }

    async def get_account(self, account_id: int) -> dict[str, Any]:
        return dict(self.accounts[account_id])

    async def get_accounts_by_ids(self, account_ids: set[int]) -> list[dict[str, Any]]:
        return [
            dict(self.accounts[account_id])
            for account_id in sorted(account_ids)
            if account_id in self.accounts
        ]

    async def set_account_enabled(self, account_id: int, enabled: bool) -> dict[str, Any]:
        self.enabled_calls.append((account_id, enabled))
        account = self.accounts.setdefault(account_id, {"id": account_id})
        account["enabled"] = enabled
        for item in self.missing_thinking:
            if int(item.get("accountId") or 0) != account_id:
                continue
            item["state"] = "enabled" if enabled else "permanent_disabled"
            if enabled:
                item["disableUntil"] = None
                item["restorePending"] = False
                item["lastAction"] = "enable"
        return dict(account)

    async def clear_account_cooldown(self, account_id: int) -> dict[str, Any]:
        self.clear_calls.append(account_id)
        account = self.accounts[account_id]
        account["cooldownUntil"] = None
        return dict(account)


def _missing_thinking_totals(items: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "accounts": len(items),
        "timedDisabled": sum(1 for item in items if item.get("state") == "timed_disabled"),
        "permanentDisabled": sum(1 for item in items if item.get("state") == "permanent_disabled"),
        "enabled": sum(1 for item in items if item.get("state") == "enabled"),
        "deleted": sum(1 for item in items if item.get("state") == "deleted"),
        "hits": sum(int(item.get("totalHits") or 0) for item in items),
    }


def _live_missing_thinking_record(
    *,
    account_id: int,
    name: str,
    state: str = "timed_disabled",
    disable_until: datetime | None = None,
    first_detected_at: datetime | None = None,
    last_detected_at: datetime | None = None,
    last_reason: str = "missing_reasoning",
    total_hits: int = 3,
    restore_pending: bool = True,
    last_restored_at: datetime | None = None,
) -> dict[str, Any]:
    now = utc_now()
    first = first_detected_at or now - timedelta(minutes=10)
    last = last_detected_at or now - timedelta(minutes=1)
    return {
        "accountId": str(account_id),
        "provider": "grok_build",
        "accountName": name,
        "state": state,
        "priority": 0,
        "authStatus": "active",
        "totalHits": total_hits,
        "hits1h": total_hits,
        "hits24h": total_hits,
        "hits7d": total_hits,
        "firstDetectedAt": first.isoformat(),
        "lastDetectedAt": last.isoformat(),
        "lastRequestId": f"req-{account_id}",
        "lastModel": "grok-4",
        "lastReason": last_reason,
        "disabledAt": None if state == "enabled" else first.isoformat(),
        "disableUntil": disable_until.isoformat() if disable_until else None,
        "restorePending": restore_pending and state == "timed_disabled",
        "recoveryPriority": 0,
        "restoreCount": 1 if last_restored_at else 0,
        "lastRestoredAt": last_restored_at.isoformat() if last_restored_at else None,
        "lastAction": "enable" if state == "enabled" else "disable",
        "lastActionAt": last.isoformat(),
    }


def _service(
    tmp_path: Path,
) -> tuple[
    RequestAuditRepository,
    AccountRepository,
    CooldownClient,
    AccountService,
]:
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    accounts = AccountRepository(database)
    probes = ProbeRepository(database)
    request_audits = RequestAuditRepository(database)
    client = CooldownClient(
        [
            {
                "id": "1",
                "name": "Alpha",
                "email": "alpha@example.test",
                "enabled": False,
            },
            {
                "id": "2",
                "name": "Bravo",
                "email": "bravo@example.test",
                "enabled": True,
            },
        ]
    )
    service = AccountService(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            request_audit_tps_only_min_count=3,
            request_audit_tps_cooldown_minutes=5,
        ),
        client=client,  # type: ignore[arg-type]
        accounts=accounts,
        probes=probes,
        request_audits=request_audits,
    )
    return request_audits, accounts, client, service


def _seed_cooldown(
    repository: RequestAuditRepository,
    *,
    upstream_id: str,
    account_id: int,
    action_status: str,
    cooled_at: datetime,
    cooldown_until: datetime | None = None,
    expired_at: datetime | None = None,
    disabled_by_cooldown: bool = True,
    minutes: int = 5,
    tps_streak: int = 3,
    audit_tps: float = 88.5,
    released_manually: bool = False,
    max_tps: float | None = 120.0,
    checked_at: datetime | None = None,
) -> None:
    repository.upsert_records(
        [
            {
                "upstream_id": upstream_id,
                "request_id": upstream_id,
                "day_key": cooled_at.date().isoformat(),
                "provider": "grok_build",
                "operation": "chat",
                "model_public_id": "grok-4.6",
                "model_upstream_model": "Build/grok-4.6",
                "account_id": account_id,
                "account_name": f"account-{account_id}",
                "client_key_id": "",
                "client_key_name": "",
                "egress_node_name": "",
                "egress_ip": "",
                "egress_mode": "",
                "egress_scope": "",
                "status_code": 200,
                "streaming": False,
                "input_tokens": 0,
                "media_input_images": 0,
                "output_tokens": 0,
                "reasoning_tokens": 0,
                "reasoning_tokens_reported": False,
                "total_tokens": 0,
                "duration_ms": 1000,
                "tps": audit_tps,
                "risk_level": "high",
                "risk_reasons": ["fast_risk"],
                "raw": {},
                "created_at": cooled_at,
                "fetched_at": cooled_at,
            }
        ]
    )
    recommendation: dict[str, Any] = {
        "kind": "tps_cooldown",
        "type": "tps_cooldown",
        "label": "高速 TPS 冷却",
        "reason": f"连续 {tps_streak} 次高速 TPS，冷却 {minutes} 分钟",
        "cooledAt": cooled_at.isoformat(),
        "disabledByCooldown": disabled_by_cooldown,
        "minutes": minutes,
        "tpsStreak": tps_streak,
    }
    if cooldown_until is not None:
        recommendation["cooldownUntil"] = cooldown_until.isoformat()
    if expired_at is not None:
        recommendation["expiredAt"] = expired_at.isoformat()
    if released_manually:
        recommendation["releasedManually"] = True
    if max_tps is not None:
        recommendation["maxTps"] = max_tps
    repository.create_verification(
        {
            "account_id": account_id,
            "audit_upstream_id": upstream_id,
            "audit_created_at": cooled_at,
            "audit_tps": audit_tps,
            "status": "sso_skipped",
            "sso_verdict": "skipped",
            "bot_flag": {},
            "proxy_used": False,
            "status_code": 0,
            "response_ms": 0,
            "check_error": "",
            "action_status": action_status,
            "action_error": "",
            "egress_recommendation": recommendation,
            "checked_at": checked_at or expired_at or cooled_at,
            "created_at": cooled_at,
        }
    )


@pytest.mark.asyncio
async def test_cooldown_zone_lists_cooling_accounts_and_search(tmp_path: Path):
    repository, _accounts, _client, service = _service(tmp_path)
    now = utc_now()
    _seed_cooldown(
        repository,
        upstream_id="tps-alpha",
        account_id=1,
        action_status="cooled",
        cooled_at=now - timedelta(minutes=1),
        cooldown_until=now + timedelta(minutes=5),
    )
    _seed_cooldown(
        repository,
        upstream_id="tps-bravo",
        account_id=2,
        action_status="cooled",
        cooled_at=now - timedelta(minutes=2),
        cooldown_until=now + timedelta(minutes=8),
    )

    page = await service.list_cooldown_zone(page=1, page_size=50)
    assert page["total"] == 2
    assert [item["id"] for item in page["items"]] == [1, 2]
    first = page["items"][0]
    assert first["name"] == "Alpha"
    assert first["email"] == "alpha@example.test"
    assert first["status"] == "cooling"
    assert first["remainingSeconds"] > 0
    assert first["nextAction"] == "isolate"
    assert first["source"] == "request_audit"
    assert first["tpsMinCount"] == 3
    assert first["tpsStreak"] == 3
    assert first["maxTps"] == 120.0
    assert first["auditTps"] == 88.5
    assert first["auditId"] == "tps-alpha"
    assert first["disabledByCooldown"] is True
    assert first["cooldownCount"] == 1

    searched = await service.list_cooldown_zone(page=1, page_size=50, search="1")
    assert searched["total"] == 1
    assert searched["items"][0]["id"] == 1

    by_audit = await service.list_cooldown_zone(page=1, page_size=50, search="tps-bravo")
    assert by_audit["total"] == 1
    assert by_audit["items"][0]["id"] == 2


@pytest.mark.asyncio
async def test_cooldown_zone_hides_expired_from_cooling_and_lists_expired_in_range(
    tmp_path: Path,
):
    repository, _accounts, _client, service = _service(tmp_path)
    now = utc_now()
    _seed_cooldown(
        repository,
        upstream_id="tps-cooling",
        account_id=1,
        action_status="cooled",
        cooled_at=now - timedelta(minutes=1),
        cooldown_until=now + timedelta(minutes=5),
    )
    expired_at = now - timedelta(hours=2)
    _seed_cooldown(
        repository,
        upstream_id="tps-expired",
        account_id=2,
        action_status="cooldown_expired",
        cooled_at=expired_at - timedelta(minutes=5),
        cooldown_until=expired_at,
        expired_at=expired_at,
        disabled_by_cooldown=True,
    )
    old_expired_at = now - timedelta(days=3)
    _seed_cooldown(
        repository,
        upstream_id="tps-old",
        account_id=3,
        action_status="cooldown_expired",
        cooled_at=old_expired_at - timedelta(minutes=5),
        cooldown_until=old_expired_at,
        expired_at=old_expired_at,
    )

    cooling = await service.list_cooldown_zone(page=1, page_size=50)
    assert [item["id"] for item in cooling["items"]] == [1]
    assert cooling["items"][0]["status"] == "cooling"

    window_start = app_isoformat(now - timedelta(hours=6))
    window_end = app_isoformat(now + timedelta(minutes=1))
    expired = await service.list_cooldown_zone(
        page=1,
        page_size=50,
        status="expired",
        start=window_start,
        end=window_end,
    )
    assert expired["total"] == 1
    assert expired["items"][0]["id"] == 2
    assert expired["items"][0]["status"] == "expired"
    assert expired["items"][0]["remainingSeconds"] == 0


@pytest.mark.asyncio
async def test_cooldown_stats_separates_inventory_from_range_events(tmp_path: Path):
    repository, accounts, _client, service = _service(tmp_path)
    now = utc_now()
    _seed_cooldown(
        repository,
        upstream_id="tps-cooling",
        account_id=1,
        action_status="cooled",
        cooled_at=now - timedelta(minutes=3),
        cooldown_until=now + timedelta(minutes=5),
        disabled_by_cooldown=True,
    )
    expired_at = now - timedelta(minutes=10)
    _seed_cooldown(
        repository,
        upstream_id="tps-expired",
        account_id=2,
        action_status="cooldown_expired",
        cooled_at=now - timedelta(minutes=20),
        cooldown_until=expired_at,
        expired_at=expired_at,
    )
    old_expired_at = now - timedelta(days=3)
    _seed_cooldown(
        repository,
        upstream_id="tps-old",
        account_id=3,
        action_status="cooldown_expired",
        cooled_at=old_expired_at - timedelta(minutes=5),
        cooldown_until=old_expired_at,
        expired_at=old_expired_at,
    )
    accounts.set_manual_status(
        account_id=2,
        status="quarantined",
        note="isolated after cooldown",
        quarantine_until=None,
        previous_upstream_enabled=True,
        disabled_by_monitor=True,
        recovery_guarded=False,
        source="request_audit",
    )

    stats = await service.cooldown_stats(
        start=app_isoformat(now - timedelta(hours=12)),
        end=app_isoformat(now + timedelta(hours=12)),
    )
    assert stats["policy"]["minCount"] == 3
    assert stats["policy"]["cooldownMinutes"] == 5
    assert stats["zone"]["cooling"] == 1
    assert stats["zone"]["disabledByCooldown"] == 1
    assert stats["zone"]["avgRemainingSeconds"] is not None
    assert stats["zone"]["avgRemainingSeconds"] > 0
    assert stats["events"]["cooled"] == 2
    assert stats["events"]["uniqueAccounts"] == 2
    assert stats["events"]["expired"] == 1
    assert stats["events"]["released"] == 1
    assert stats["events"]["isolatedAfter"] == 1
    today = app_day_key(now)
    assert any(
        item["day"] == today and item["cooled"] == 2 and item["expired"] == 1 for item in stats["trend"]
    )


@pytest.mark.asyncio
async def test_cooldown_zone_prefers_current_cooling_over_old_expired(tmp_path: Path):
    repository, _accounts, _client, service = _service(tmp_path)
    now = utc_now()
    old_expired_at = now - timedelta(hours=3)
    _seed_cooldown(
        repository,
        upstream_id="tps-old",
        account_id=1,
        action_status="cooldown_expired",
        cooled_at=old_expired_at - timedelta(minutes=5),
        cooldown_until=old_expired_at,
        expired_at=old_expired_at,
        checked_at=old_expired_at,
    )
    _seed_cooldown(
        repository,
        upstream_id="tps-new",
        account_id=1,
        action_status="cooled",
        cooled_at=now - timedelta(minutes=1),
        cooldown_until=now + timedelta(minutes=5),
        checked_at=now,
    )

    cooling = await service.list_cooldown_zone(page=1, page_size=50)
    assert cooling["total"] == 1
    assert cooling["items"][0]["id"] == 1
    assert cooling["items"][0]["status"] == "cooling"
    assert cooling["items"][0]["auditId"] == "tps-new"
    assert cooling["items"][0]["cooldownCount"] == 2

    combined = await service.list_cooldown_zone(page=1, page_size=50, status="all")
    assert combined["total"] == 1
    assert combined["items"][0]["status"] == "cooling"

    expired = await service.list_cooldown_zone(page=1, page_size=50, status="expired")
    assert expired["total"] == 0


@pytest.mark.asyncio
async def test_release_cooldown_zone_reenables_and_marks_manual(tmp_path: Path):
    repository, _accounts, client, service = _service(tmp_path)
    now = utc_now()
    _seed_cooldown(
        repository,
        upstream_id="tps-alpha",
        account_id=1,
        action_status="cooled",
        cooled_at=now - timedelta(minutes=1),
        cooldown_until=now + timedelta(minutes=5),
        disabled_by_cooldown=True,
    )
    assert client.accounts[1]["enabled"] is False

    result = await service.release_cooldown_zone(account_ids=[1, 1, 0])
    assert result["requested"] == 1
    assert result["eligible"] == 1
    assert result["released"] == 1
    assert result["reenabled"] == 1
    assert result["skippedNotCoolingAccountIds"] == []
    assert client.accounts[1]["enabled"] is True
    assert client.enabled_calls == [(1, True)]

    cooling = await service.list_cooldown_zone(page=1, page_size=50)
    assert cooling["total"] == 0

    expired = await service.list_cooldown_zone(page=1, page_size=50, status="expired")
    assert expired["total"] == 1
    assert expired["items"][0]["releasedManually"] is True
    assert expired["items"][0]["actionStatus"] == "cooldown_expired"
    stored = repository.latest_tps_cooldowns_for_accounts([1])[1]
    assert stored["action_status"] == "cooldown_expired"
    assert stored["egress_recommendation"]["releasedManually"] is True


@pytest.mark.asyncio
async def test_release_cooldown_zone_skips_accounts_that_are_not_cooling(
    tmp_path: Path,
):
    repository, _accounts, client, service = _service(tmp_path)
    now = utc_now()
    expired_at = now - timedelta(minutes=10)
    _seed_cooldown(
        repository,
        upstream_id="tps-expired",
        account_id=2,
        action_status="cooldown_expired",
        cooled_at=now - timedelta(minutes=20),
        cooldown_until=expired_at,
        expired_at=expired_at,
        disabled_by_cooldown=True,
    )

    result = await service.release_cooldown_zone(account_ids=[2, 9])
    assert result["requested"] == 2
    assert result["eligible"] == 0
    assert result["released"] == 0
    assert result["reenabled"] == 0
    assert result["skippedNotCoolingAccountIds"] == [2, 9]
    assert client.enabled_calls == []

    with pytest.raises(ValueError, match="至少选择一个账号"):
        await service.release_cooldown_zone(account_ids=[0, -3])


def test_live_missing_thinking_mapper_uses_upstream_state_and_reason():
    now = utc_now()
    from app.services.cooldown_stats import build_missing_thinking_cooldown_item_from_live

    item = build_missing_thinking_cooldown_item_from_live(
        _live_missing_thinking_record(
            account_id=21,
            name="Thinker",
            state="timed_disabled",
            disable_until=now + timedelta(minutes=12),
            first_detected_at=now - timedelta(minutes=8),
            total_hits=7,
            last_reason="missing_reasoning",
        ),
        quarantined=False,
        now=now,
    )
    assert item["id"] == 21
    assert item["name"] == "Thinker"
    assert item["status"] == "cooling"
    assert item["enabled"] is False
    assert item["grokState"] == "timed_disabled"
    assert item["label"] == "grok2api 缺思考处理"
    assert item["reason"] == "缺少有效思考内容"
    assert item["cooldownCount"] == 7
    assert item["source"] == "grok2api"
    assert item["remainingSeconds"] == 12 * 60

    permanent = build_missing_thinking_cooldown_item_from_live(
        _live_missing_thinking_record(
            account_id=22,
            name="Permanent",
            state="permanent_disabled",
            restore_pending=False,
        ),
        quarantined=True,
        now=now,
    )
    assert permanent["status"] == "cooling"
    assert permanent["disabledByCooldown"] is True
    assert permanent["remainingSeconds"] is None
    assert permanent["quarantined"] is True


@pytest.mark.asyncio
async def test_cooldown_zone_splits_local_and_grok2api_sources(tmp_path: Path):
    repository, _accounts, client, service = _service(tmp_path)
    now = utc_now()
    _seed_cooldown(
        repository,
        upstream_id="tps-alpha",
        account_id=1,
        action_status="cooled",
        cooled_at=now - timedelta(minutes=1),
        cooldown_until=now + timedelta(minutes=5),
    )
    client.missing_thinking = [
        _live_missing_thinking_record(
            account_id=21,
            name="Cooling Thinker",
            disable_until=now + timedelta(minutes=25),
            first_detected_at=now - timedelta(minutes=3),
        )
    ]
    client.accounts[21] = {
        "id": "21",
        "name": "Cooling Thinker",
        "enabled": False,
    }

    local = await service.list_cooldown_zone(page=1, page_size=50)
    assert [item["id"] for item in local["items"]] == [1]
    assert local["items"][0]["source"] == "request_audit"
    assert client.list_missing_calls == []

    grok = await service.list_cooldown_zone(page=1, page_size=50, source="grok2api")
    assert [item["id"] for item in grok["items"]] == [21]
    thinker = grok["items"][0]
    assert thinker["source"] == "grok2api"
    assert thinker["label"] == "grok2api 缺思考处理"
    assert thinker["status"] == "cooling"
    assert thinker["enabled"] is False
    assert thinker["grokState"] == "timed_disabled"
    assert thinker["disabledByCooldown"] is False
    assert client.list_missing_calls
    assert client.list_calls == []

    local_stats = await service.cooldown_stats()
    grok_stats = await service.cooldown_stats(source="grok2api")
    assert local_stats["source"] == "local"
    assert local_stats["zone"]["cooling"] == 1
    assert grok_stats["source"] == "grok2api"
    assert grok_stats["zone"]["cooling"] == 1
    assert grok_stats["events"]["cooled"] == 3


@pytest.mark.asyncio
async def test_grok2api_cooldown_zone_reads_live_missing_thinking(
    tmp_path: Path,
):
    _repository, _accounts, client, service = _service(tmp_path)
    now = utc_now()
    client.missing_thinking = [
        _live_missing_thinking_record(
            account_id=21,
            name="Live Thinker",
            disable_until=now + timedelta(minutes=12),
            first_detected_at=now - timedelta(minutes=4),
            total_hits=5,
        ),
        _live_missing_thinking_record(
            account_id=22,
            name="Permanent Thinker",
            state="permanent_disabled",
            restore_pending=False,
            total_hits=9,
        ),
        _live_missing_thinking_record(
            account_id=23,
            name="Enabled Thinker",
            state="enabled",
            last_restored_at=now - timedelta(minutes=2),
            total_hits=2,
        ),
    ]

    async def boom(**_params: Any) -> list[dict[str, Any]]:
        raise RuntimeError("should not list live grok2api accounts")

    client.list_all_accounts = boom  # type: ignore[method-assign]

    cooling = await service.list_cooldown_zone(page=1, page_size=50, source="grok2api")
    assert cooling["total"] == 1
    assert cooling["items"][0]["id"] == 21
    assert cooling["items"][0]["name"] == "Live Thinker"
    assert cooling["items"][0]["grokState"] == "timed_disabled"

    permanent = await service.list_cooldown_zone(
        page=1,
        page_size=50,
        status="permanent_disabled",
        source="grok2api",
    )
    assert [item["id"] for item in permanent["items"]] == [22]
    assert permanent["items"][0]["disabledByCooldown"] is True

    enabled = await service.list_cooldown_zone(
        page=1,
        page_size=50,
        status="expired",
        source="grok2api",
    )
    assert [item["id"] for item in enabled["items"]] == [23]
    assert enabled["items"][0]["status"] == "expired"
    assert enabled["items"][0]["enabled"] is True

    stats = await service.cooldown_stats(source="grok2api")
    assert stats["zone"]["cooling"] == 1
    assert stats["zone"]["disabledByCooldown"] == 1
    assert stats["events"]["expired"] == 1
    assert stats["events"]["cooled"] == 16
    assert stats["trend"] == []


@pytest.mark.asyncio
async def test_release_grok2api_cooldown_enables_disabled_accounts(tmp_path: Path):
    _repository, _accounts, client, service = _service(tmp_path)
    now = utc_now()
    client.missing_thinking = [
        _live_missing_thinking_record(
            account_id=21,
            name="Release Thinker",
            disable_until=now + timedelta(minutes=25),
            first_detected_at=now - timedelta(minutes=2),
        )
    ]
    client.accounts[21] = {
        "id": "21",
        "name": "Release Thinker",
        "email": "thinking21@example.test",
        "enabled": False,
    }

    result = await service.release_cooldown_zone(
        account_ids=[21, 9],
        source="grok2api",
    )
    assert result["released"] == 1
    assert result["reenabled"] == 1
    assert result["skippedNotCoolingAccountIds"] == [9]
    assert client.clear_calls == []
    assert client.enabled_calls == [(21, True)]
    assert client.accounts[21]["enabled"] is True

    cooling = await service.list_cooldown_zone(page=1, page_size=50, source="grok2api")
    assert cooling["total"] == 0
    expired = await service.list_cooldown_zone(
        page=1,
        page_size=50,
        status="expired",
        source="grok2api",
    )
    assert expired["total"] == 1
    assert expired["items"][0]["id"] == 21
    assert expired["items"][0]["enabled"] is True
    assert expired["items"][0]["grokState"] == "enabled"


@pytest.mark.asyncio
async def test_grok2api_enabled_records_show_in_expired_filter(tmp_path: Path):
    _repository, _accounts, client, service = _service(tmp_path)
    now = utc_now()
    client.missing_thinking = [
        _live_missing_thinking_record(
            account_id=31,
            name="Restored Thinker",
            state="enabled",
            last_restored_at=now - timedelta(minutes=3),
            first_detected_at=now - timedelta(minutes=20),
        )
    ]

    cooling = await service.list_cooldown_zone(page=1, page_size=50, source="grok2api")
    assert cooling["total"] == 0

    expired = await service.list_cooldown_zone(
        page=1,
        page_size=50,
        status="expired",
        source="grok2api",
        start=app_isoformat(now - timedelta(hours=1)),
        end=app_isoformat(now + timedelta(minutes=1)),
    )
    assert [item["id"] for item in expired["items"]] == [31]
    assert expired["items"][0]["status"] == "expired"
    assert expired["items"][0]["grokState"] == "enabled"


@pytest.mark.asyncio
async def test_cooldown_zone_rejects_unknown_source(tmp_path: Path):
    _repository, _accounts, _client, service = _service(tmp_path)
    with pytest.raises(ValueError, match="冷却来源仅支持"):
        await service.list_cooldown_zone(page=1, page_size=50, source="probe")
    with pytest.raises(ValueError, match="冷却来源仅支持"):
        await service.cooldown_stats(source="probe")
    with pytest.raises(ValueError, match="冷却来源仅支持"):
        await service.release_cooldown_zone(account_ids=[1], source="probe")

