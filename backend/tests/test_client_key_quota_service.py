from __future__ import annotations

from typing import Any

import pytest

from app.services.client_key_quota_service import (
    USD_TICKS,
    ClientKeyQuotaService,
    _parse_prefix,
)

SK_PREFIX = "abcdefghijkl"
SK_PAYLOAD = SK_PREFIX + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
SK_KEY = f"sk-{SK_PAYLOAD}"


class FakeGrok2APIClient:
    def __init__(
        self,
        *,
        keys: dict[str, Any] | None = None,
        secrets: dict[str, str] | None = None,
    ) -> None:
        self.keys_payload = keys or {"items": [], "total": 0, "page": 1, "pageSize": 20}
        self.secrets = secrets or {}
        self.list_client_keys_calls: list[dict[str, Any]] = []
        self.secret_calls: list[str] = []

    async def list_client_keys(self, **params: Any) -> dict[str, Any]:
        self.list_client_keys_calls.append(params)
        return self.keys_payload

    async def get_client_key_secret(self, key_id: str) -> str:
        self.secret_calls.append(key_id)
        return self.secrets.get(key_id, "")


def test_parse_prefix_accepts_sk_and_legacy_g2a() -> None:
    assert len(SK_PAYLOAD) == 48
    assert _parse_prefix(SK_KEY) == SK_PREFIX
    assert _parse_prefix(f"  {SK_KEY}  ") == SK_PREFIX
    assert _parse_prefix("g2a_aaaa_secretvalue") == "aaaa"
    assert _parse_prefix("g2a_quality-guard-internal_secret_value") == "quality-guard-internal"


@pytest.mark.parametrize(
    "value",
    [
        "",
        "sk-",
        "sk-" + ("a" * 47),
        "sk-" + ("a" * 49),
        "sk-" + ("+" * 48),
        "sk-" + ("/" * 48),
        "sk_abc123_secret",
        "g2a_",
        "g2a__secret",
        "other_abc123_secret",
        "gbp_abc123_old_secret",
    ],
)
def test_parse_prefix_rejects_invalid_keys(value: str) -> None:
    assert _parse_prefix(value) is None


def _quota_client(*, secret: str = SK_KEY) -> FakeGrok2APIClient:
    return FakeGrok2APIClient(
        keys={
            "items": [
                {
                    "id": "1",
                    "name": "ops-sk",
                    "prefix": SK_PREFIX,
                    "enabled": True,
                    "billingLimitUsdTicks": 2 * USD_TICKS,
                    "billedUsageUsdTicks": int(0.5 * USD_TICKS),
                }
            ],
            "total": 1,
            "page": 1,
            "pageSize": 20,
        },
        secrets={"1": secret},
    )


@pytest.mark.asyncio
async def test_lookup_accepts_sk_client_keys() -> None:
    client = _quota_client()
    service = ClientKeyQuotaService(client)  # type: ignore[arg-type]

    result = await service.lookup(f"  {SK_KEY}  ", client_ip="127.0.0.1")

    assert result["found"] is True
    assert result["name"] == "ops-sk"
    assert result["prefix"] == SK_PREFIX
    assert result["remainingUsd"] == pytest.approx(1.5)
    assert client.list_client_keys_calls == [
        {"search": SK_PREFIX, "page": 1, "pageSize": 20}
    ]
    assert client.secret_calls == ["1"]


@pytest.mark.asyncio
async def test_lookup_rejects_invalid_sk_keys_without_listing() -> None:
    client = _quota_client()
    service = ClientKeyQuotaService(client)  # type: ignore[arg-type]

    result = await service.lookup("sk-" + ("a" * 47), client_ip="127.0.0.1")

    assert result == {"found": False}
    assert client.list_client_keys_calls == []
    assert client.secret_calls == []


@pytest.mark.asyncio
async def test_lookup_sk_key_requires_matching_secret() -> None:
    client = _quota_client(secret=SK_KEY)
    service = ClientKeyQuotaService(client)  # type: ignore[arg-type]
    wrong = "sk-" + SK_PREFIX + ("B" * 36)

    result = await service.lookup(wrong, client_ip="127.0.0.1")

    assert result == {"found": False}
    assert client.list_client_keys_calls
    assert client.secret_calls == ["1"]


@pytest.mark.asyncio
async def test_lookup_still_accepts_legacy_g2a_keys() -> None:
    client = FakeGrok2APIClient(
        keys={
            "items": [
                {
                    "id": "2",
                    "name": "ops-a",
                    "prefix": "aaaa",
                    "enabled": True,
                    "billingLimitUsdTicks": USD_TICKS,
                    "billedUsageUsdTicks": 0,
                }
            ],
            "total": 1,
            "page": 1,
            "pageSize": 20,
        },
        secrets={"2": "g2a_aaaa_secretvalue"},
    )
    service = ClientKeyQuotaService(client)  # type: ignore[arg-type]

    result = await service.lookup("g2a_aaaa_secretvalue", client_ip="10.0.0.1")

    assert result["found"] is True
    assert result["name"] == "ops-a"
    assert client.list_client_keys_calls[0]["search"] == "aaaa"
    assert client.secret_calls == ["2"]
