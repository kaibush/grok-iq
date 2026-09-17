from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from app.core.config import Settings
from app.persistence.client_key_repository import ClientKeyRepository
from app.persistence.database import Database
from app.services.client_key_service import ClientKeyService, yuan_to_cents


class FakeGrok2APIClient:
    def __init__(self, items: list[dict[str, Any]] | None = None) -> None:
        self.items = items or []
        self.list_all_calls: list[dict[str, Any]] = []

    async def list_all_client_keys(self, **params: Any) -> list[dict[str, Any]]:
        self.list_all_calls.append(params)
        return list(self.items)


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
) -> dict[str, Any]:
    return {
        "id": key_id,
        "name": name,
        "scheme": scheme,
        "prefix": prefix,
        "enabled": enabled,
        "expiresAt": None,
        "rpmLimit": 120,
        "maxConcurrent": 8,
        "billingLimitUsdTicks": 10_000_000_000,
        "billedUsageUsdTicks": 1_000_000_000,
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

    updated = service.update_key(
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
    service.update_key("1", paid=True, plan_type="day", recharge_yuan=5)
    service.update_key("2", paid=True, plan_type="week", recharge_yuan=20)

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
        service.update_key("1", paid=True)
    with pytest.raises(ValueError, match="天卡、周卡或月卡"):
        service.update_key("1", paid=True, plan_type="none")
    updated = service.update_key(
        "1",
        paid=True,
        plan_type="day",
        recharge_yuan=8,
    )
    assert updated["planType"] == "day"
    assert updated["rechargeYuan"] == pytest.approx(8)
    cleared = service.update_key("1", paid=False)
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

