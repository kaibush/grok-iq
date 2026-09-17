from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from app.core.config import Settings
from app.integrations.grok2api.client import IntegrationError
from app.persistence.client_key_repository import ClientKeyRepository
from app.persistence.database import Database
from app.services.client_key_service import USD_TICKS, ClientKeyService, yuan_to_cents


class FakeGrok2APIClient:
    def __init__(self, items: list[dict[str, Any]] | None = None) -> None:
        self.items = items or []
        self.list_all_calls: list[dict[str, Any]] = []
        self.update_calls: list[dict[str, Any]] = []
        self.batch_enabled_calls: list[dict[str, Any]] = []
        self.delete_calls: list[str] = []
        self.delete_many_calls: list[list[str]] = []
        self.secret_calls: list[str] = []
        self.usage_calls: list[dict[str, Any]] = []
        self.secrets: dict[str, str] = {}
        self.delete_error: IntegrationError | None = None
        self.update_error: IntegrationError | None = None

    async def list_all_client_keys(self, **params: Any) -> list[dict[str, Any]]:
        self.list_all_calls.append(params)
        return [dict(item) for item in self.items]

    async def update_client_key(
        self, key_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        self.update_calls.append({"id": key_id, "payload": dict(payload)})
        if self.update_error is not None:
            raise self.update_error
        for item in self.items:
            if str(item.get("id")) != str(key_id):
                continue
            if "name" in payload:
                item["name"] = payload["name"]
            if "enabled" in payload:
                item["enabled"] = payload["enabled"]
            if "expiresAt" in payload:
                item["expiresAt"] = payload["expiresAt"] or None
            if "rpmLimit" in payload:
                item["rpmLimit"] = payload["rpmLimit"]
            if "maxConcurrent" in payload:
                item["maxConcurrent"] = payload["maxConcurrent"]
            if "billingLimitUsdTicks" in payload:
                item["billingLimitUsdTicks"] = payload["billingLimitUsdTicks"]
            return dict(item)
        raise IntegrationError("not found", status_code=404)

    async def set_client_keys_enabled(
        self, key_ids: list[str], enabled: bool
    ) -> dict[str, Any]:
        self.batch_enabled_calls.append(
            {"ids": list(key_ids), "enabled": bool(enabled)}
        )
        wanted = {str(key_id) for key_id in key_ids}
        updated = 0
        for item in self.items:
            if str(item.get("id")) in wanted:
                item["enabled"] = bool(enabled)
                updated += 1
        return {"updated": updated}

    async def delete_client_key(self, key_id: str) -> None:
        self.delete_calls.append(key_id)
        if self.delete_error is not None:
            raise self.delete_error
        self.items = [
            item for item in self.items if str(item.get("id")) != str(key_id)
        ]

    async def delete_client_keys(self, key_ids: list[str]) -> dict[str, Any]:
        self.delete_many_calls.append(list(key_ids))
        wanted = {str(key_id) for key_id in key_ids}
        before = len(self.items)
        self.items = [
            item for item in self.items if str(item.get("id")) not in wanted
        ]
        return {"deleted": before - len(self.items)}

    async def get_client_key_secret(self, key_id: str) -> str:
        self.secret_calls.append(key_id)
        return self.secrets.get(str(key_id), f"sk-secret-{key_id}")

    async def client_key_usage_summary(
        self,
        *,
        ids: list[str],
        period: str,
        start: str = "",
        end: str = "",
    ) -> dict[str, Any]:
        self.usage_calls.append(
            {"ids": list(ids), "period": period, "start": start, "end": end}
        )
        return {
            "ids": list(ids),
            "period": period,
            "start": start,
            "end": end,
            "total": {"requests": 0},
        }


def _build(
    tmp_path: Path,
    items: list[dict[str, Any]] | None = None,
) -> tuple[Database, FakeGrok2APIClient, ClientKeyService]:
    settings = Settings(
        _env_file=None,
        database_path=tmp_path / "grokiq.db",
        probe_route_prefix="grokiq-probe",
    )
    database = Database(settings.database_path)
    database.initialize()
    client = FakeGrok2APIClient(items)
    service = ClientKeyService(settings, client, ClientKeyRepository(database))  # type: ignore[arg-type]
    return database, client, service


def _key(
    key_id: str,
    *,
    name: str,
    prefix: str = "abcdefghijkl",
    enabled: bool = True,
    scheme: str = "sk",
    billing_limit_usd_ticks: int = 10_000_000_000,
    billed_usage_usd_ticks: int = 1_000_000_000,
    expires_at: str | None = None,
) -> dict[str, Any]:
    return {
        "id": key_id,
        "name": name,
        "scheme": scheme,
        "prefix": prefix,
        "enabled": enabled,
        "expiresAt": expires_at,
        "rpmLimit": 120,
        "maxConcurrent": 8,
        "billingLimitUsdTicks": billing_limit_usd_ticks,
        "billedUsageUsdTicks": billed_usage_usd_ticks,
        "lastUsedAt": "2026-09-16T12:00:00Z",
        "createdAt": "2026-09-01T00:00:00Z",
    }


@pytest.mark.asyncio
async def test_sync_keeps_paid_marks_and_skips_probe_keys(tmp_path: Path) -> None:
    database, client, service = _build(
        tmp_path,
        [
            _key("1", name="alice"),
            _key("2", name="bob", prefix="bbbbbbbbbbbb"),
            _key("9", name="grokiq-probe-abc123"),
        ],
    )
    first = await service.sync_from_upstream()
    assert first["fetched"] == 2
    assert first["created"] == 2
    assert first["skippedProbeKeys"] == 1
    assert first["skippedSystemKeys"] == 0
    assert client.list_all_calls == [{"pageSize": 200}]

    updated = await service.update_key(
        "1",
        paid=True,
        plan_type="month",
        recharge_yuan="19.9",
        note="月卡用户",
    )
    assert updated["paid"] is True
    assert updated["planType"] == "month"
    assert updated["rechargeYuan"] == pytest.approx(19.9)
    assert updated["note"] == "月卡用户"
    assert updated["remainingPercent"] == pytest.approx(90)
    assert client.update_calls == []

    client.items = [
        _key("2", name="bob-renamed", prefix="bbbbbbbbbbbb", enabled=False),
        _key("3", name="carol", prefix="cccccccccccc"),
        _key("9", name="grokiq-probe-abc123"),
    ]
    second = await service.sync_from_upstream()
    assert second["created"] == 1
    assert second["updated"] == 1
    assert second["missing"] == 1

    listed = service.list_keys()
    by_id = {item["id"]: item for item in listed["items"]}
    assert listed["summary"]["total"] == 3
    assert listed["summary"]["paid"] == 1
    assert listed["summary"]["month"] == 1
    assert listed["summary"]["missing"] == 1
    assert listed["summary"]["rechargeYuan"] == pytest.approx(19.9)
    assert by_id["1"]["paid"] is True
    assert by_id["1"]["planType"] == "month"
    assert by_id["1"]["upstreamMissing"] is True
    assert by_id["1"]["name"] == "alice"
    assert by_id["2"]["name"] == "bob-renamed"
    assert by_id["2"]["enabled"] is False
    assert by_id["2"]["paid"] is False
    assert by_id["3"]["name"] == "carol"
    database.dispose()


@pytest.mark.asyncio
async def test_paid_filter_and_plan_type(tmp_path: Path) -> None:
    database, _client, service = _build(
        tmp_path,
        [
            _key("1", name="day-user"),
            _key("2", name="week-user"),
            _key("3", name="free-user"),
        ],
    )
    await service.sync_from_upstream()
    await service.update_key("1", paid=True, plan_type="day", recharge_yuan=5)
    await service.update_key("2", paid=True, plan_type="week", recharge_yuan=20)

    paid = service.list_keys(paid="paid")
    assert [item["id"] for item in paid["items"]] == ["1", "2"]
    assert paid["summary"]["paid"] == 2
    assert paid["summary"]["unpaid"] == 0

    week = service.list_keys(plan_type="week")
    assert [item["id"] for item in week["items"]] == ["2"]
    unpaid = service.list_keys(paid="unpaid")
    assert [item["id"] for item in unpaid["items"]] == ["3"]
    searched = service.list_keys(query="day-user")
    assert [item["id"] for item in searched["items"]] == ["1"]
    database.dispose()


@pytest.mark.asyncio
async def test_paid_user_requires_card_type(tmp_path: Path) -> None:
    database, _client, service = _build(tmp_path, [_key("1", name="alice")])
    await service.sync_from_upstream()
    with pytest.raises(ValueError, match="天卡、周卡或月卡"):
        await service.update_key("1", paid=True)
    with pytest.raises(ValueError, match="天卡、周卡或月卡"):
        await service.update_key("1", paid=True, plan_type="none")
    updated = await service.update_key(
        "1",
        paid=True,
        plan_type="day",
        recharge_yuan=8,
    )
    assert updated["planType"] == "day"
    assert updated["rechargeYuan"] == pytest.approx(8)
    cleared = await service.update_key("1", paid=False)
    assert cleared["paid"] is False
    assert cleared["planType"] == "none"
    assert cleared["rechargeYuan"] == pytest.approx(8)
    database.dispose()


def test_yuan_to_cents_rounds_half_up() -> None:
    assert yuan_to_cents("19.9") == 1990
    assert yuan_to_cents("1.005") == 101
    with pytest.raises(ValueError, match="有效金额"):
        yuan_to_cents("abc")
    with pytest.raises(ValueError, match="有效金额"):
        yuan_to_cents("nan")
    with pytest.raises(ValueError, match="有效金额"):
        yuan_to_cents("inf")


@pytest.mark.asyncio
async def test_expired_flag_from_upstream_expiry(tmp_path: Path) -> None:
    expired_at = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    database, _client, service = _build(
        tmp_path,
        [
            {
                **_key("1", name="expired"),
                "expiresAt": expired_at,
            }
        ],
    )
    await service.sync_from_upstream()
    listed = service.list_keys()
    assert listed["items"][0]["expired"] is True
    database.dispose()


@pytest.mark.asyncio
async def test_sync_skips_system_managed_keys(tmp_path: Path) -> None:
    database, _client, service = _build(
        tmp_path,
        [
            _key("1", name="alice"),
            _key("2", name="[system] Egress Quality Guard"),
            _key(
                "3",
                name="thinking-standby",
                prefix="thinking-standby-internal",
                scheme="g2a",
            ),
        ],
    )
    result = await service.sync_from_upstream()
    assert result["fetched"] == 1
    assert result["skippedSystemKeys"] == 2
    listed = service.list_keys()
    assert [item["id"] for item in listed["items"]] == ["1"]
    database.dispose()


@pytest.mark.asyncio
async def test_update_key_writes_upstream_fields(tmp_path: Path) -> None:
    database, client, service = _build(tmp_path, [_key("1", name="alice")])
    await service.sync_from_upstream()
    updated = await service.update_key(
        "1",
        name="alice-renamed",
        enabled=False,
        rpm_limit=60,
        max_concurrent=4,
        billing_limit_usd=25,
        paid=True,
        plan_type="week",
    )
    assert client.update_calls == [
        {
            "id": "1",
            "payload": {
                "name": "alice-renamed",
                "enabled": False,
                "rpmLimit": 60,
                "maxConcurrent": 4,
                "billingLimitUsdTicks": 25 * USD_TICKS,
            },
        }
    ]
    assert updated["name"] == "alice-renamed"
    assert updated["enabled"] is False
    assert updated["rpmLimit"] == 60
    assert updated["maxConcurrent"] == 4
    assert updated["billingLimitUsd"] == pytest.approx(25)
    assert updated["paid"] is True
    assert updated["planType"] == "week"
    assert updated["remainingPercent"] == pytest.approx(99.6)
    database.dispose()


@pytest.mark.asyncio
async def test_update_key_clears_expiry_when_explicitly_set(tmp_path: Path) -> None:
    expires_at = (datetime.now(UTC) + timedelta(days=2)).isoformat()
    database, client, service = _build(
        tmp_path,
        [_key("1", name="alice", expires_at=expires_at)],
    )
    await service.sync_from_upstream()
    updated = await service.update_key("1", expires_at="", set_expires_at=True)
    assert client.update_calls[0]["payload"] == {"expiresAt": ""}
    assert updated["expiresAt"] in {None, ""}
    assert updated["expired"] is False
    database.dispose()


@pytest.mark.asyncio
async def test_local_paid_update_does_not_call_grok2api(tmp_path: Path) -> None:
    database, client, service = _build(tmp_path, [_key("1", name="alice")])
    await service.sync_from_upstream()
    await service.update_key("1", note="仅本地")
    assert client.update_calls == []
    listed = service.list_keys()
    assert listed["items"][0]["note"] == "仅本地"
    database.dispose()


@pytest.mark.asyncio
async def test_delete_and_batch_enable(tmp_path: Path) -> None:
    database, client, service = _build(
        tmp_path,
        [
            _key("1", name="alice"),
            _key("2", name="bob", prefix="bbbbbbbbbbbb"),
        ],
    )
    await service.sync_from_upstream()
    enabled = await service.set_enabled_many(["1", "2"], False)
    assert enabled == {"updated": 2}
    assert client.batch_enabled_calls == [{"ids": ["1", "2"], "enabled": False}]
    listed = service.list_keys()
    assert {item["id"]: item["enabled"] for item in listed["items"]} == {
        "1": False,
        "2": False,
    }

    deleted = await service.delete_key("1")
    assert deleted == {"deleted": True}
    assert client.delete_calls == ["1"]
    remaining = service.list_ids()
    assert remaining["ids"] == ["2"]
    assert remaining["total"] == 1
    assert remaining["truncated"] is False

    client.delete_error = IntegrationError("gone", status_code=404)
    gone = await service.delete_key("2")
    assert gone == {"deleted": True}
    assert service.list_keys()["total"] == 0
    database.dispose()


@pytest.mark.asyncio
async def test_usage_summary_and_secret_pass_through(tmp_path: Path) -> None:
    database, client, service = _build(tmp_path, [_key("1", name="alice")])
    await service.sync_from_upstream()
    client.secrets["1"] = "sk-live-secret"
    secret = await service.get_secret("1")
    assert secret == {"secret": "sk-live-secret"}
    usage = await service.usage_summary(["1"], "24h", start="a", end="b")
    assert usage["period"] == "24h"
    assert client.usage_calls == [
        {"ids": ["1"], "period": "24h", "start": "a", "end": "b"}
    ]
    database.dispose()
