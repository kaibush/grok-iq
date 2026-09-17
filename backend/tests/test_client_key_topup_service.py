from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from app.core.config import Settings
from app.persistence.client_key_repository import ClientKeyRepository
from app.persistence.database import Database
from app.services.client_key_service import USD_TICKS, ClientKeyService
from app.services.client_key_topup_service import ClientKeyTopupService
from tests.test_client_key_service import FakeGrok2APIClient, _key


def _build(
    tmp_path: Path,
    items: list[dict[str, Any]],
    *,
    enabled: bool = True,
    threshold: float = 30,
    amount: float = 100,
) -> tuple[Database, FakeGrok2APIClient, ClientKeyTopupService, ClientKeyService]:
    settings = Settings(
        _env_file=None,
        database_path=tmp_path / "grokiq.db",
        probe_route_prefix="grokiq-probe",
        paid_key_auto_topup_enabled=enabled,
        paid_key_auto_topup_threshold_percent=threshold,
        paid_key_auto_topup_amount_usd=amount,
    )
    database = Database(settings.database_path)
    database.initialize()
    client = FakeGrok2APIClient(items)
    keys = ClientKeyService(settings, client, ClientKeyRepository(database))  # type: ignore[arg-type]
    service = ClientKeyTopupService(settings=settings, client_keys=keys)
    return database, client, service, keys


@pytest.mark.asyncio
async def test_paid_low_remaining_is_topped_up(tmp_path: Path) -> None:
    database, client, service, keys = _build(
        tmp_path,
        [
            _key(
                "1",
                name="paid-low",
                billing_limit_usd_ticks=100 * USD_TICKS,
                billed_usage_usd_ticks=80 * USD_TICKS,
            )
        ],
    )
    await keys.sync_from_upstream()
    await keys.update_key("1", paid=True, plan_type="month")

    result = await service.run()
    assert result["ok"] is True
    assert result["skipped"] == 0
    assert result["scanned"] == 1
    assert result["eligible"] == 1
    assert result["toppedUp"] == 1
    assert result["failed"] == 0
    assert result["amountUsd"] == 100
    assert result["thresholdPercent"] == 30
    assert client.update_calls == [
        {
            "id": "1",
            "payload": {"billingLimitUsdTicks": 200 * USD_TICKS},
        }
    ]
    listed = keys.list_keys()
    assert listed["items"][0]["billingLimitUsd"] == pytest.approx(200)
    assert result["items"][0]["id"] == "1"
    assert result["items"][0]["remainingPercent"] == pytest.approx(20)
    assert result["items"][0]["addedUsd"] == pytest.approx(100)
    database.dispose()


@pytest.mark.asyncio
async def test_unpaid_expired_and_unlimited_are_skipped(tmp_path: Path) -> None:
    expired_at = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    database, client, service, keys = _build(
        tmp_path,
        [
            _key(
                "1",
                name="unpaid",
                billing_limit_usd_ticks=100 * USD_TICKS,
                billed_usage_usd_ticks=90 * USD_TICKS,
            ),
            _key(
                "2",
                name="expired",
                prefix="bbbbbbbbbbbb",
                billing_limit_usd_ticks=100 * USD_TICKS,
                billed_usage_usd_ticks=90 * USD_TICKS,
                expires_at=expired_at,
            ),
            _key(
                "3",
                name="unlimited",
                prefix="cccccccccccc",
                billing_limit_usd_ticks=0,
                billed_usage_usd_ticks=10 * USD_TICKS,
            ),
        ],
    )
    await keys.sync_from_upstream()
    await keys.update_key("2", paid=True, plan_type="week")
    await keys.update_key("3", paid=True, plan_type="day")

    result = await service.run()
    assert result["ok"] is True
    assert result["scanned"] == 2
    assert result["eligible"] == 0
    assert result["toppedUp"] == 0
    assert result["skipped"] == 2
    assert client.update_calls == []
    by_id = {item["id"]: item for item in keys.list_keys()["items"]}
    assert by_id["1"]["billingLimitUsd"] == pytest.approx(100)
    assert by_id["2"]["billingLimitUsd"] == pytest.approx(100)
    assert by_id["3"]["unlimited"] is True
    database.dispose()


@pytest.mark.asyncio
async def test_remaining_at_or_above_threshold_is_skipped(tmp_path: Path) -> None:
    database, client, service, keys = _build(
        tmp_path,
        [
            _key(
                "1",
                name="exact-30",
                billing_limit_usd_ticks=100 * USD_TICKS,
                billed_usage_usd_ticks=70 * USD_TICKS,
            ),
            _key(
                "2",
                name="above-30",
                prefix="bbbbbbbbbbbb",
                billing_limit_usd_ticks=100 * USD_TICKS,
                billed_usage_usd_ticks=69 * USD_TICKS,
            ),
        ],
    )
    await keys.sync_from_upstream()
    await keys.update_key("1", paid=True, plan_type="month")
    await keys.update_key("2", paid=True, plan_type="month")

    result = await service.run()
    assert result["eligible"] == 0
    assert result["toppedUp"] == 0
    assert result["skipped"] == 2
    assert client.update_calls == []
    database.dispose()


@pytest.mark.asyncio
async def test_disabled_auto_topup_is_skipped(tmp_path: Path) -> None:
    database, client, service, keys = _build(
        tmp_path,
        [
            _key(
                "1",
                name="paid-low",
                billing_limit_usd_ticks=100 * USD_TICKS,
                billed_usage_usd_ticks=90 * USD_TICKS,
            )
        ],
        enabled=False,
    )
    await keys.sync_from_upstream()
    await keys.update_key("1", paid=True, plan_type="month")

    result = await service.run()
    assert result["ok"] is True
    assert result["skipped"] is True
    assert result["scanned"] == 0
    assert result["eligible"] == 0
    assert result["toppedUp"] == 0
    assert result["error"] == "付费密钥自动加额已关闭"
    assert client.update_calls == []
    database.dispose()
