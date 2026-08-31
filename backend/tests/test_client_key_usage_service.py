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


class FakeGrok2APIClient:
    def __init__(
        self,
        *,
        keys: dict[str, Any] | None = None,
        audits: dict[str, dict[str, Any]] | None = None,
        secrets: dict[str, str] | None = None,
    ) -> None:
        self.keys_payload = keys or {"items": [], "total": 0, "page": 1, "pageSize": 20}
        self.audits_by_key = audits or {}
        self.secrets = secrets or {}
        self.list_client_keys_calls: list[dict[str, Any]] = []
        self.list_request_audits_calls: list[dict[str, Any]] = []
        self.secret_calls: list[str] = []

    async def list_client_keys(self, **params: Any) -> dict[str, Any]:
        self.list_client_keys_calls.append(params)
        return self.keys_payload

    async def get_client_key_secret(self, key_id: str) -> str:
        self.secret_calls.append(key_id)
        return self.secrets.get(key_id, "")

    async def list_request_audits(self, **params: Any) -> dict[str, Any]:
        self.list_request_audits_calls.append(params)
        key = str(params.get("key") or "")
        return self.audits_by_key.get(
            key,
            {"items": [], "hasMore": False, "nextCursor": ""},
        )


@pytest.mark.asyncio
async def test_lookup_public_usage_requires_secret_and_hides_key_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime(2026, 8, 31, 12, 0, tzinfo=UTC)
    monkeypatch.setattr("app.services.client_key_usage_service.utc_now", lambda: now)
    client = FakeGrok2APIClient(
        keys={
            "items": [
                {
                    "id": "1",
                    "name": "ops-a",
                    "prefix": "aaaa",
                    "enabled": True,
                    "secret": "g2a_aaaa_should-not-leak",
                    "billingLimitUsdTicks": 2 * USD_TICKS,
                    "billedUsageUsdTicks": int(0.5 * USD_TICKS),
                }
            ],
            "total": 1,
            "page": 1,
            "pageSize": 20,
        },
        secrets={"1": "g2a_aaaa_secretvalue"},
        audits={
            "1": {
                "items": [
                    {
                        "clientKeyId": "1",
                        "clientKeyName": "ops-a",
                        "statusCode": 200,
                        "totalTokens": 12,
                        "estimatedCostInUsdTicks": 20_000_000_000,
                        "durationMs": 40,
                        "createdAt": "2026-08-31T08:00:00Z",
                    }
                ],
                "hasMore": False,
                "nextCursor": "",
            }
        },
    )
    service = ClientKeyUsageService(client)  # type: ignore[arg-type]

    missing = await service.lookup_public_usage(
        "g2a_aaaa_wrongsecret",
        client_ip="127.0.0.1",
        period="24h",
    )
    assert missing == {"found": False}
    assert client.list_request_audits_calls == []

    result = await service.lookup_public_usage(
        "g2a_aaaa_secretvalue",
        client_ip="127.0.0.1",
        period="24h",
    )
    assert result["found"] is True
    assert "id" not in result
    assert "keys" not in result
    assert "secret" not in result
    assert result["period"] == "24h"
    assert result["truncated"] is False
    assert result["usage"]["requests"] == 1
    assert result["usage"]["successfulRequests"] == 1
    assert result["usage"]["totalTokens"] == 12
    assert result["usage"]["estimatedCostInUsdTicks"] == 20_000_000_000
    assert client.secret_calls == ["1", "1"]
    assert {call["key"] for call in client.list_request_audits_calls} == {"1"}


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
