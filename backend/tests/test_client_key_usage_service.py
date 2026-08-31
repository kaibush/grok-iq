from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.services.client_key_quota_service import USD_TICKS
from app.services.client_key_usage_service import (
    MAX_AUDIT_KEYS,
    ClientKeyUsageService,
    resolve_audit_window,
)

KEY_FIELDS = {
    "id",
    "name",
    "prefix",
    "enabled",
    "expired",
    "expiresAt",
    "lastUsedAt",
    "unlimited",
    "billingLimitUsd",
    "billedUsageUsd",
    "remainingUsd",
    "usagePercent",
}


class FakeGrok2APIClient:
    def __init__(
        self,
        *,
        keys: dict[str, Any] | None = None,
        audits: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        self.keys_payload = keys or {"items": [], "total": 0, "page": 1, "pageSize": 50}
        self.audits_by_key = audits or {}
        self.list_client_keys_calls: list[dict[str, Any]] = []
        self.list_request_audits_calls: list[dict[str, Any]] = []

    async def list_client_keys(self, **params: Any) -> dict[str, Any]:
        self.list_client_keys_calls.append(params)
        return self.keys_payload

    async def list_request_audits(self, **params: Any) -> dict[str, Any]:
        self.list_request_audits_calls.append(params)
        key = str(params.get("key") or "")
        return self.audits_by_key.get(
            key,
            {"items": [], "hasMore": False, "nextCursor": ""},
        )


@pytest.mark.asyncio
async def test_list_keys_normalizes_quota_remaining_unlimited_and_expired() -> None:
    client = FakeGrok2APIClient(
        keys={
            "items": [
                {
                    "id": "unlimited",
                    "name": "ops-free",
                    "prefix": "aaaa",
                    "enabled": True,
                    "secret": "g2a_aaaa_should-not-leak",
                    "billingLimitUsdTicks": 0,
                    "billedUsageUsdTicks": 5_000_000_000,
                    "expiresAt": "",
                    "lastUsedAt": "2026-08-30T12:00:00Z",
                },
                {
                    "id": "limited",
                    "name": "ops-capped",
                    "prefix": "bbbb",
                    "enabled": True,
                    "billingLimitUsdTicks": 2 * USD_TICKS,
                    "billedUsageUsdTicks": int(0.5 * USD_TICKS),
                    "expiresAt": "2099-12-31T00:00:00Z",
                    "lastUsedAt": None,
                },
                {
                    "id": "expired",
                    "name": "ops-old",
                    "prefix": "cccc",
                    "enabled": False,
                    "billing_limit_usd_ticks": 10 * USD_TICKS,
                    "billed_usage_usd_ticks": 12 * USD_TICKS,
                    "expires_at": "2020-01-01T00:00:00Z",
                    "last_used_at": "2020-01-02T00:00:00Z",
                },
            ],
            "total": 3,
            "page": 2,
            "pageSize": 50,
        }
    )
    service = ClientKeyUsageService(client)  # type: ignore[arg-type]

    result = await service.list_keys(page=2, page_size=50, search=" ops ")

    assert client.list_client_keys_calls == [
        {"page": 2, "pageSize": 50, "search": "ops"}
    ]
    assert result["total"] == 3
    assert result["page"] == 2
    assert result["pageSize"] == 50
    by_id = {item["id"]: item for item in result["items"]}
    assert set(by_id) == {"unlimited", "limited", "expired"}
    for item in result["items"]:
        assert set(item) == KEY_FIELDS
        assert "secret" not in item

    unlimited = by_id["unlimited"]
    assert unlimited["unlimited"] is True
    assert unlimited["expired"] is False
    assert unlimited["expiresAt"] is None
    assert unlimited["billingLimitUsd"] == 0.0
    assert unlimited["billedUsageUsd"] == 0.5
    assert unlimited["remainingUsd"] == 0.0
    assert unlimited["usagePercent"] == 0.0
    assert unlimited["lastUsedAt"] == "2026-08-30T12:00:00Z"

    limited = by_id["limited"]
    assert limited["unlimited"] is False
    assert limited["expired"] is False
    assert limited["billingLimitUsd"] == 2.0
    assert limited["billedUsageUsd"] == 0.5
    assert limited["remainingUsd"] == 1.5
    assert limited["usagePercent"] == 25.0
    assert limited["expiresAt"] == "2099-12-31T00:00:00Z"

    expired = by_id["expired"]
    assert expired["enabled"] is False
    assert expired["expired"] is True
    assert expired["unlimited"] is False
    assert expired["billingLimitUsd"] == 10.0
    assert expired["billedUsageUsd"] == 12.0
    assert expired["remainingUsd"] == 0.0
    assert expired["usagePercent"] == 100.0
    assert expired["expiresAt"] == "2020-01-01T00:00:00Z"
    assert expired["lastUsedAt"] == "2020-01-02T00:00:00Z"


@pytest.mark.asyncio
async def test_audit_summary_filters_keys_and_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.services.client_key_usage_service.utc_now",
        lambda: datetime(2026, 8, 31, 12, 0, tzinfo=UTC),
    )
    client = FakeGrok2APIClient(
        audits={
            "1": {
                "items": [
                    {
                        "clientKeyId": "1",
                        "clientKeyName": "ops-a",
                        "statusCode": 200,
                        "inputTokens": 10,
                        "cachedInputTokens": 2,
                        "outputTokens": 5,
                        "reasoningTokens": 1,
                        "totalTokens": 15,
                        "estimatedCostInUsdTicks": 20_000_000_000,
                        "durationMs": 100,
                        "createdAt": "2026-08-30T18:00:00Z",
                    },
                    {
                        "clientKeyId": "12",
                        "clientKeyName": "other",
                        "statusCode": 200,
                        "totalTokens": 999,
                        "estimatedCostInUsdTicks": 99_000_000_000,
                        "durationMs": 10,
                        "createdAt": "2026-08-30T18:00:00Z",
                    },
                    {
                        "clientKeyId": "1",
                        "clientKeyName": "ops-a",
                        "statusCode": 500,
                        "errorCode": "upstream",
                        "totalTokens": 3,
                        "estimatedCostInUsdTicks": 1_000_000_000,
                        "durationMs": 50,
                        "createdAt": "2026-08-20T18:00:00Z",
                    },
                ],
                "hasMore": False,
                "nextCursor": "",
            },
            "2": {
                "items": [
                    {
                        "clientKeyId": "2",
                        "clientKeyName": "ops-b",
                        "statusCode": 200,
                        "inputTokens": 4,
                        "outputTokens": 6,
                        "totalTokens": 10,
                        "estimatedCostInUsdTicks": 5_000_000_000,
                        "durationMs": 80,
                        "createdAt": "2026-08-30T19:00:00Z",
                    }
                ],
                "hasMore": False,
                "nextCursor": "",
            },
        }
    )
    service = ClientKeyUsageService(client)  # type: ignore[arg-type]

    result = await service.audit_summary(
        key_ids=["1", "2", "1"],
        period="custom",
        start="2026-08-30T00:00:00Z",
        end="2026-08-31T00:00:00Z",
    )

    assert result["period"] == "custom"
    assert result["sourcePeriod"] == "7d"
    assert result["truncated"] is False
    assert result["range"] == {
        "start": "2026-08-30T00:00:00Z",
        "end": "2026-08-31T00:00:00Z",
    }
    assert result["total"]["requests"] == 2
    assert result["total"]["successfulRequests"] == 2
    assert result["total"]["failedRequests"] == 0
    assert result["total"]["estimatedCostInUsdTicks"] == 25_000_000_000
    assert result["total"]["totalTokens"] == 25
    assert result["total"]["successRate"] == 100.0
    assert [item["id"] for item in result["keys"]] == ["1", "2"]
    by_id = {item["id"]: item for item in result["keys"]}
    assert by_id["1"]["name"] == "ops-a"
    assert by_id["1"]["requests"] == 1
    assert by_id["2"]["name"] == "ops-b"
    assert by_id["2"]["requests"] == 1
    assert {call["key"] for call in client.list_request_audits_calls} == {"1", "2"}
    for call in client.list_request_audits_calls:
        assert call["page_size"] == 200
        assert call["period"] == "7d"
        assert call["sort_by"] == "createdAt"
        assert call["sort_order"] == "desc"
        assert call["timeout"] == 60


@pytest.mark.asyncio
async def test_audit_summary_rejects_empty_and_too_many_keys() -> None:
    service = ClientKeyUsageService(FakeGrok2APIClient())  # type: ignore[arg-type]

    with pytest.raises(ValueError, match="请选择要统计的密钥"):
        await service.audit_summary(key_ids=[])
    with pytest.raises(ValueError, match="请选择要统计的密钥"):
        await service.audit_summary(key_ids=["", "  ", ","])
    with pytest.raises(ValueError, match=f"单次最多统计 {MAX_AUDIT_KEYS} 个密钥"):
        await service.audit_summary(key_ids=[str(index) for index in range(MAX_AUDIT_KEYS + 1)])


def test_resolve_audit_window_custom_validation() -> None:
    now = datetime(2026, 8, 31, 12, 0, tzinfo=UTC)

    with pytest.raises(ValueError, match="自定义时间窗口需要开始和结束时间"):
        resolve_audit_window("custom", now=now)
    with pytest.raises(ValueError, match="自定义时间窗口需要开始和结束时间"):
        resolve_audit_window("custom", start="2026-08-30T00:00:00Z", now=now)
    with pytest.raises(ValueError, match="结束时间必须晚于开始时间"):
        resolve_audit_window(
            "custom",
            start="2026-08-31T00:00:00Z",
            end="2026-08-30T00:00:00Z",
            now=now,
        )
    with pytest.raises(ValueError, match="时间窗口仅支持 24h、7d、30d、90d 或 custom"):
        resolve_audit_window("1h", now=now)

    window = resolve_audit_window("24h", now=now)
    assert window["period"] == "24h"
    assert window["sourcePeriod"] == "24h"
    assert window["clamped"] is False
    assert (now - window["start"]).total_seconds() == 24 * 3600

    custom = resolve_audit_window(
        "custom",
        start="2026-08-20T00:00:00Z",
        end="2026-08-22T00:00:00Z",
        now=now,
    )
    assert custom["period"] == "custom"
    assert custom["sourcePeriod"] == "30d"
    assert custom["start"].isoformat().startswith("2026-08-20")
    assert custom["clamped"] is False

    clamped = resolve_audit_window(
        "custom",
        start="2026-01-01T00:00:00Z",
        end="2026-08-31T12:00:00Z",
        now=now,
    )
    assert clamped["clamped"] is True
    assert clamped["sourcePeriod"] == "90d"
    assert clamped["start"] == now - timedelta(days=90)
    assert clamped["end"] == now
