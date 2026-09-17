from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.core.config import Settings
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
        dashboards: dict[Any, dict[str, Any]] | None = None,
    ) -> None:
        self.keys_payload = keys or {"items": [], "total": 0, "page": 1, "pageSize": 20}
        self.audits_by_key = audits or {}
        self.secrets = secrets or {}
        self.dashboards = dashboards or {}
        self.list_client_keys_calls: list[dict[str, Any]] = []
        self.list_request_audits_calls: list[dict[str, Any]] = []
        self.get_dashboard_calls: list[dict[str, Any]] = []
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

    async def get_dashboard(
        self,
        *,
        period: str = "24h",
        timezone: str = "Asia/Shanghai",
        refresh: bool = False,
    ) -> dict[str, Any]:
        params = {"period": period, "timezone": timezone, "refresh": refresh}
        self.get_dashboard_calls.append(params)
        return self.dashboards.get(
            (period, timezone),
            self.dashboards.get(period, self.dashboards.get("default", {})),
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


@pytest.mark.asyncio
async def test_public_usage_overview_proxies_dashboard_and_strips_resources() -> None:
    client = FakeGrok2APIClient(
        dashboards={
            ("7d", "Asia/Shanghai"): {
                "period": "7d",
                "generatedAt": "2026-08-31T12:00:00Z",
                "range": {
                    "start": "2026-08-24T12:00:00Z",
                    "end": "2026-08-31T12:00:00Z",
                },
                "resources": {
                    "totalAccounts": 1406,
                    "activeAccounts": 675,
                    "buildAccounts": 900,
                    "webAccounts": 400,
                    "consoleAccounts": 106,
                    "activeClientKeys": 12,
                    "totalClientKeys": 20,
                },
                "usage": {
                    "requests": 12000,
                    "successfulRequests": 11800,
                    "failedRequests": 200,
                    "inputTokens": 1000,
                    "cachedInputTokens": 400,
                    "outputTokens": 500,
                    "reasoningTokens": 80,
                    "tokens": 1580,
                    "billedCostUsdTicks": 20_000_000_000,
                    "successRate": 98.3,
                    "averageFirstTokenMs": 420.5,
                    "outputTokensPerSecond": 31.2,
                    "firstTokenSamples": 10,
                    "throughputSamples": 8,
                },
                "series": [
                    {
                        "start": "2026-08-24T00:00:00Z",
                        "end": "2026-08-25T00:00:00Z",
                        "requests": 100,
                        "tokens": 10,
                        "billedCostUsdTicks": 1,
                    }
                ],
                "activity": [{"start": "2026-08-24T00:00:00Z", "requests": 100}],
                "topModels": [
                    {
                        "model": "grok-4",
                        "requests": 9,
                        "tokens": 8,
                        "billedCostUsdTicks": 1,
                    }
                ],
                "providers": [
                    {
                        "provider": "grok_build",
                        "requests": 80,
                        "successfulRequests": 79,
                        "tokens": 7,
                    }
                ],
            }
        }
    )
    service = ClientKeyUsageService(client)  # type: ignore[arg-type]

    result = await service.public_usage_overview(period="7d")
    cached = await service.public_usage_overview(period="7d")

    assert result["reachable"] is True
    assert cached is result
    assert result["period"] == "7d"
    assert "resources" not in result
    assert "windows" not in result
    assert result["usage"]["requests"] == 12000
    assert result["usage"]["tokens"] == 1580
    assert result["usage"]["cacheHitRate"] == 40.0
    assert result["usage"]["successRate"] == 98.3
    assert result["usage"]["averageFirstTokenMs"] == 420.5
    assert result["series"][0]["requests"] == 100
    assert result["activity"][0]["requests"] == 100
    assert result["topModels"][0]["model"] == "grok-4"
    assert result["providers"][0]["provider"] == "grok_build"
    assert client.get_dashboard_calls == [
        {"period": "7d", "timezone": "Asia/Shanghai", "refresh": False}
    ]
    assert client.list_request_audits_calls == []

    refreshed = await service.public_usage_overview(period="7d", refresh=True)
    assert refreshed["usage"]["requests"] == 12000
    assert len(client.get_dashboard_calls) == 2
    assert client.get_dashboard_calls[1]["refresh"] is True

    other = await service.public_usage_overview(period="24h")
    assert other["period"] == "24h"
    assert other["usage"]["requests"] == 0
    assert len(client.get_dashboard_calls) == 3


@pytest.mark.asyncio
async def test_public_usage_overview_hides_upstream_errors() -> None:
    class BrokenClient(FakeGrok2APIClient):
        async def get_dashboard(self, **params: Any) -> dict[str, Any]:
            raise RuntimeError("upstream down")

    service = ClientKeyUsageService(BrokenClient())  # type: ignore[arg-type]
    result = await service.public_usage_overview(period="7d")
    assert result["reachable"] is False
    assert result["period"] == "7d"
    assert result["usage"]["requests"] == 0
    assert result["series"] == []
    assert result["topModels"] == []
    assert "resources" not in result


class FakeRequestAuditRepository:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.calls: list[dict[str, Any]] = []

    def probe_usage_rows(self, start: datetime, end: datetime, *, prefix: str = ""):
        self.calls.append({"start": start, "end": end, "prefix": prefix})
        return [
            row
            for row in self.rows
            if start <= row["created_at"] < end
        ]


def _probe_row(
    created: datetime,
    *,
    status_code: int = 200,
    error_code: str = "",
    input_tokens: int = 10,
    output_tokens: int = 6,
    reasoning_tokens: int = 2,
    total_tokens: int = 16,
    model_public_id: str = "grokiq-probe-7-deadbeef",
    client_key_name: str = "grokiq-probe-abc123",
) -> dict[str, Any]:
    return {
        "created_at": created,
        "status_code": status_code,
        "error_code": error_code,
        "model_public_id": model_public_id,
        "client_key_name": client_key_name,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "reasoning_tokens": reasoning_tokens,
        "total_tokens": total_tokens,
    }


@pytest.mark.asyncio
async def test_public_usage_overview_drops_probe_models_without_local_audits() -> None:
    client = FakeGrok2APIClient(
        dashboards={
            ("7d", "UTC"): {
                "period": "7d",
                "range": {
                    "start": "2026-08-24T12:00:00Z",
                    "end": "2026-08-31T12:00:00Z",
                },
                "usage": {"requests": 12, "successfulRequests": 10, "tokens": 20},
                "topModels": [
                    {"model": "grok-4", "requests": 9, "tokens": 8},
                    {"model": "grokiq-probe-7-deadbeef", "requests": 3, "tokens": 2},
                ],
            }
        }
    )
    service = ClientKeyUsageService(client)  # type: ignore[arg-type]
    result = await service.public_usage_overview(period="7d", timezone="UTC")
    assert [item["model"] for item in result["topModels"]] == ["grok-4"]
    assert result["usage"]["requests"] == 12


@pytest.mark.asyncio
async def test_public_usage_overview_subtracts_local_probe_rows() -> None:
    created = datetime(2026, 8, 24, 16, 0, tzinfo=UTC)
    audits = FakeRequestAuditRepository(
        [
            _probe_row(created),
            _probe_row(created, status_code=503, error_code="upstream_server_error_unavailable"),
            _probe_row(
                datetime(2026, 8, 20, 8, 0, tzinfo=UTC),
                total_tokens=40,
                input_tokens=20,
                output_tokens=18,
                reasoning_tokens=2,
            ),
        ]
    )
    client = FakeGrok2APIClient(
        dashboards={
            ("7d", "UTC"): {
                "period": "7d",
                "generatedAt": "2026-08-31T12:00:00Z",
                "range": {
                    "start": "2026-08-24T12:00:00Z",
                    "end": "2026-08-31T12:00:00Z",
                },
                "usage": {
                    "requests": 100,
                    "successfulRequests": 90,
                    "failedRequests": 10,
                    "inputTokens": 1000,
                    "cachedInputTokens": 400,
                    "outputTokens": 500,
                    "reasoningTokens": 80,
                    "tokens": 1580,
                    "billedCostUsdTicks": 20_000_000_000,
                    "successRate": 90.0,
                    "averageFirstTokenMs": 420.5,
                    "outputTokensPerSecond": 31.2,
                    "firstTokenSamples": 10,
                    "throughputSamples": 8,
                },
                "series": [
                    {
                        "start": "2026-08-24T00:00:00Z",
                        "end": "2026-08-25T00:00:00Z",
                        "requests": 40,
                        "inputTokens": 80,
                        "cachedInputTokens": 10,
                        "outputTokens": 20,
                        "reasoningTokens": 4,
                        "tokens": 100,
                        "billedCostUsdTicks": 1_000_000_000,
                    }
                ],
                "activity": [
                    {"start": "2026-08-20T00:00:00Z", "requests": 12},
                    {"start": "2026-08-24T00:00:00Z", "requests": 40},
                ],
                "topModels": [
                    {
                        "model": "grok-4",
                        "requests": 90,
                        "tokens": 1500,
                        "billedCostUsdTicks": 1,
                    },
                    {
                        "model": "grokiq-probe-7-deadbeef",
                        "requests": 10,
                        "tokens": 80,
                        "billedCostUsdTicks": 1,
                    },
                ],
                "providers": [
                    {
                        "provider": "grok_build",
                        "requests": 80,
                        "successfulRequests": 70,
                        "tokens": 1400,
                    },
                    {
                        "provider": "grok_web",
                        "requests": 20,
                        "successfulRequests": 20,
                        "tokens": 180,
                    },
                ],
            }
        }
    )
    service = ClientKeyUsageService(
        client,  # type: ignore[arg-type]
        settings=Settings(_env_file=None, probe_route_prefix="grokiq-probe"),
        request_audits=audits,  # type: ignore[arg-type]
    )

    result = await service.public_usage_overview(period="7d", timezone="UTC")

    assert result["usage"]["requests"] == 98
    assert result["usage"]["successfulRequests"] == 89
    assert result["usage"]["failedRequests"] == 9
    assert result["usage"]["inputTokens"] == 980
    assert result["usage"]["outputTokens"] == 488
    assert result["usage"]["reasoningTokens"] == 76
    assert result["usage"]["tokens"] == 1548
    assert result["usage"]["cachedInputTokens"] == 400
    assert result["usage"]["billedCostUsdTicks"] == round(
        20_000_000_000 * 1548 / 1580
    )
    assert result["usage"]["averageFirstTokenMs"] == 420.5
    assert result["usage"]["outputTokensPerSecond"] == 31.2
    assert [item["model"] for item in result["topModels"]] == ["grok-4"]
    assert result["series"][0]["requests"] == 38
    assert result["series"][0]["tokens"] == 68
    assert result["activity"][0]["requests"] == 11
    assert result["activity"][1]["requests"] == 38
    assert result["providers"][0] == {
        "provider": "grok_build",
        "requests": 78,
        "successfulRequests": 69,
        "tokens": 1368,
    }
    assert result["providers"][1]["provider"] == "grok_web"
    assert result["providers"][1]["requests"] == 20
    assert audits.calls[0]["prefix"] == "grokiq-probe"


SK_PREFIX = "abcdefghijkl"
SK_PAYLOAD = SK_PREFIX + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
SK_KEY = f"sk-{SK_PAYLOAD}"


@pytest.mark.asyncio
async def test_lookup_public_usage_accepts_sk_client_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime(2026, 8, 31, 12, 0, tzinfo=UTC)
    monkeypatch.setattr("app.services.client_key_usage_service.utc_now", lambda: now)
    client = FakeGrok2APIClient(
        keys={
            "items": [
                {
                    "id": "9",
                    "name": "ops-sk",
                    "prefix": SK_PREFIX,
                    "enabled": True,
                    "billingLimitUsdTicks": USD_TICKS,
                    "billedUsageUsdTicks": 0,
                }
            ],
            "total": 1,
            "page": 1,
            "pageSize": 20,
        },
        secrets={"9": SK_KEY},
        audits={
            "9": {
                "items": [
                    {
                        "clientKeyId": "9",
                        "clientKeyName": "ops-sk",
                        "statusCode": 200,
                        "totalTokens": 4,
                        "estimatedCostInUsdTicks": 1_000_000_000,
                        "durationMs": 20,
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
        "sk-" + ("a" * 47),
        client_ip="127.0.0.1",
        period="24h",
    )
    assert missing == {"found": False}
    assert client.list_client_keys_calls == []
    assert client.secret_calls == []

    result = await service.lookup_public_usage(
        SK_KEY,
        client_ip="127.0.0.1",
        period="24h",
    )
    assert result["found"] is True
    assert result["usage"]["requests"] == 1
    assert result["usage"]["totalTokens"] == 4
    assert client.list_client_keys_calls[0]["search"] == SK_PREFIX
    assert client.secret_calls == ["9"]
    assert {call["key"] for call in client.list_request_audits_calls} == {"9"}
