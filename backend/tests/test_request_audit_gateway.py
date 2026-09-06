from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

from app.core.clock import utc_now
from app.core.config import Settings
from app.persistence.database import Database
from app.persistence.request_audit_repository import RequestAuditRepository
from app.services.request_audit_gateway import (
    apply_gateway_to_payload,
    normalize_attempts,
    normalize_billing,
    normalize_gateway_snapshot,
    normalize_request_headers,
)
from app.services.request_audit_service import RequestAuditService, _gateway_refresh_items


def _build(tmp_path: Path) -> tuple[RequestAuditRepository, RequestAuditService]:
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = RequestAuditRepository(database)
    client = MagicMock()
    client.get_accounts_by_ids = AsyncMock(return_value=[])
    client.get_request_audit = AsyncMock(return_value={})
    service = RequestAuditService(
        settings=Settings(_env_file=None),
        client=client,
        repository=repository,
    )
    return repository, service


def _record(now, **values):
    index = str(values.get("upstream_id") or "1")
    payload = {
        "upstream_id": index,
        "request_id": f"req-{index}",
        "day_key": now.date().isoformat(),
        "provider": "grok_build",
        "operation": "chat",
        "model_public_id": "grok-4.6",
        "model_upstream_model": "Build/grok-4.6",
        "account_id": 7,
        "account_name": "alice",
        "client_key_id": "9",
        "client_key_name": "production",
        "egress_node_id": 3,
        "egress_node_name": "node-3",
        "egress_ip": "",
        "egress_mode": "",
        "egress_scope": "",
        "status_code": 200,
        "error_code": "",
        "streaming": True,
        "input_tokens": 80,
        "media_input_images": 0,
        "output_tokens": 155,
        "reasoning_tokens": 80,
        "reasoning_tokens_reported": True,
        "total_tokens": 235,
        "first_token_ms": 100,
        "duration_ms": 1100,
        "tps": 140,
        "risk_level": "normal",
        "risk_reasons": [],
        "stream_sample": {},
        "gateway": {},
        "request_headers": {},
        "raw": {"id": index},
        "created_at": now,
        "fetched_at": now,
    }
    payload.update(values)
    return payload


def test_normalize_gateway_snapshot_keeps_compact_grok2api_fields():
    snapshot = normalize_gateway_snapshot(
        {
            "clientIp": "203.0.113.8",
            "modelRouteId": "12",
            "usageSource": "upstream",
            "cachedInputTokens": 40,
            "costInUsdTicks": 200_000_000,
            "estimatedCostInUsdTicks": 180_000_000,
            "requestMethod": "post",
            "requestPath": "/v1/messages",
            "attemptCount": 2,
            "numSourcesUsed": 3,
            "billing": {
                "source": "official",
                "method": "official_rates",
                "model": "grok-4",
                "components": [
                    {
                        "kind": "output",
                        "unit": "token",
                        "quantity": 20,
                        "unitPriceInUsdTicks": 1,
                        "subtotalInUsdTicks": 20,
                    }
                ],
                "totalInUsdTicks": 20,
            },
            "ignored": True,
        }
    )
    assert snapshot["clientIp"] == "203.0.113.8"
    assert snapshot["usageSource"] == "upstream"
    assert snapshot["cachedInputTokens"] == 40
    assert snapshot["requestMethod"] == "POST"
    assert snapshot["attemptCount"] == 2
    assert snapshot["billing"]["model"] == "grok-4"
    assert "ignored" not in snapshot


def test_normalize_gateway_snapshot_omits_empty_payloads():
    assert normalize_gateway_snapshot(None) == {}
    assert normalize_gateway_snapshot({}) == {}
    assert normalize_gateway_snapshot({"usageSource": "mystery"}) == {}


def test_normalize_billing_and_headers_are_bounded():
    billing = normalize_billing(
        {
            "source": "upstream",
            "method": "upstream_reported",
            "totalInUsdTicks": 9,
            "components": [{"kind": "bad", "unit": "token"}],
        }
    )
    assert billing["source"] == "upstream"
    assert billing["components"] == []
    headers = normalize_request_headers(
        {"X-Test": ["a", "b"], "Empty": [], "Skip": None}
    )
    assert headers == {"X-Test": ["a", "b"]}


def test_normalize_attempts_keeps_diagnostic_snapshot():
    attempts = normalize_attempts(
        [
            {
                "id": "9",
                "number": 1,
                "source": "upstream_http",
                "stage": "adapter",
                "accountName": "alice",
                "method": "post",
                "requestPath": "/internal",
                "startedAt": "2026-09-06T00:00:00Z",
                "durationMs": 12,
                "upstreamStatusCode": 429,
                "responseHeaders": {"Retry-After": ["1"]},
                "responseBody": "slow down",
                "errorChain": [{"type": "RateLimit", "message": "too many"}],
            }
        ]
    )
    assert attempts[0]["number"] == 1
    assert attempts[0]["method"] == "POST"
    assert attempts[0]["upstreamStatusCode"] == 429
    assert attempts[0]["errorChain"][0]["type"] == "RateLimit"


def test_apply_gateway_to_payload_fills_missing_fields_only():
    payload = {"cachedInputTokens": 0, "clientIp": "1.1.1.1"}
    apply_gateway_to_payload(
        payload,
        {"cachedInputTokens": 8, "clientIp": "8.8.8.8", "attemptCount": 1},
    )
    assert payload["clientIp"] == "1.1.1.1"
    assert payload["cachedInputTokens"] == 8
    assert payload["attemptCount"] == 1


def test_normalize_record_stores_gateway_outside_raw():
    service = RequestAuditService(
        settings=Settings(_env_file=None),
        client=MagicMock(),
        repository=MagicMock(),
    )
    created_at = utc_now()
    record = service._normalize_record(
        {
            "requestId": "req-1",
            "provider": "grok_build",
            "statusCode": 200,
            "streaming": True,
            "outputTokens": 40,
            "cachedInputTokens": 12,
            "clientIp": "198.51.100.4",
            "usageSource": "estimated",
            "requestMethod": "POST",
            "requestPath": "/v1/chat/completions",
            "requestHeaders": {"User-Agent": ["grok-iq"]},
            "attemptCount": 1,
            "durationMs": 200,
            "createdAt": created_at.isoformat(),
        },
        "99",
        created_at.date().isoformat(),
        created_at,
        {},
    )
    assert record["gateway"]["clientIp"] == "198.51.100.4"
    assert record["gateway"]["cachedInputTokens"] == 12
    assert record["request_headers"]["User-Agent"] == ["grok-iq"]
    assert "requestHeaders" not in record["raw"]
    assert "clientIp" not in record["raw"]


async def test_list_page_exposes_gateway_fields_without_headers(tmp_path: Path):
    repository, service = _build(tmp_path)
    now = utc_now()
    repository.upsert_records(
        [
            _record(
                now,
                upstream_id="1",
                gateway={
                    "clientIp": "203.0.113.9",
                    "cachedInputTokens": 22,
                    "costInUsdTicks": 1000,
                    "attemptCount": 1,
                    "usageSource": "upstream",
                },
                request_headers={"Authorization": ["secret"]},
            )
        ]
    )
    rows = repository.records_for_range(now - timedelta(hours=1), now + timedelta(hours=1))
    assert rows[0]["gateway"]["clientIp"] == "203.0.113.9"
    assert "request_headers" not in rows[0]
    page = await service.list_page(page=1, page_size=50, window_preset="7d")
    item = page["items"][0]
    assert item["clientIp"] == "203.0.113.9"
    assert item["cachedInputTokens"] == 22
    assert item["attemptCount"] == 1
    assert "requestHeaders" not in item
    assert "attempts" not in item


def test_refresh_gateway_snapshots_fills_empty_rows_only(tmp_path: Path):
    repository, _service = _build(tmp_path)
    now = utc_now()
    repository.upsert_records(
        [
            _record(now, upstream_id="1", gateway={}),
            _record(
                now,
                upstream_id="2",
                gateway={"clientIp": "already", "attemptCount": 3},
            ),
        ]
    )
    updated = repository.refresh_gateway_snapshots(
        [
            {
                "id": "1",
                "gateway": {"clientIp": "new-ip", "cachedInputTokens": 5},
                "request_headers": {"X-Trace": ["abc"]},
            },
            {
                "id": "2",
                "gateway": {"clientIp": "should-not-overwrite"},
                "request_headers": {"X-Trace": ["nope"]},
            },
        ]
    )
    assert updated == 2
    row1 = repository.get_record("1")
    row2 = repository.get_record("2")
    assert row1["gateway"]["clientIp"] == "new-ip"
    assert row1["request_headers"]["X-Trace"] == ["abc"]
    assert row2["gateway"]["clientIp"] == "already"
    assert row2["request_headers"]["X-Trace"] == ["nope"]


def test_gateway_refresh_items_only_keep_grok_build():
    items = _gateway_refresh_items(
        [
            {
                "id": "1",
                "provider": "grok_build",
                "clientIp": "10.0.0.1",
                "usageSource": "none",
            },
            {
                "id": "2",
                "provider": "grok_web",
                "clientIp": "10.0.0.2",
                "usageSource": "none",
            },
        ]
    )
    assert [item["id"] for item in items] == ["1"]


async def test_get_detail_hydrates_attempts_from_grok2api(tmp_path: Path):
    repository, service = _build(tmp_path)
    now = utc_now()
    repository.upsert_records([_record(now, upstream_id="88", gateway={})])
    service.client.get_request_audit = AsyncMock(
        return_value={
            "audit": {
                "id": "88",
                "clientIp": "203.0.113.10",
                "usageSource": "upstream",
                "cachedInputTokens": 9,
                "requestMethod": "POST",
                "requestPath": "/v1/messages",
                "requestHeaders": {"X-Request-Id": ["abc"]},
                "streamSample": {
                    "protocol": "chat",
                    "hasVisibleOutput": True,
                    "outputChars": 4,
                    "outputHead": "hello",
                },
            },
            "attempts": [
                {
                    "id": "1",
                    "number": 1,
                    "source": "gateway_transport",
                    "stage": "stream",
                    "transportError": "timeout",
                    "durationMs": 30,
                }
            ],
        }
    )
    detail = await service.get_detail("88")
    assert detail["clientIp"] == "203.0.113.10"
    assert detail["cachedInputTokens"] == 9
    assert detail["requestHeaders"]["X-Request-Id"] == ["abc"]
    assert detail["attempts"][0]["transportError"] == "timeout"
    assert detail["streamSample"]["outputHead"] == "hello"
    assert detail["gatewayHydrated"] is True
    stored = repository.get_record("88")
    assert stored["gateway"]["clientIp"] == "203.0.113.10"
    assert stored["request_headers"]["X-Request-Id"] == ["abc"]


async def test_get_detail_keeps_local_row_when_grok2api_fails(tmp_path: Path):
    repository, service = _build(tmp_path)
    now = utc_now()
    repository.upsert_records(
        [
            _record(
                now,
                upstream_id="77",
                gateway={"clientIp": "local-ip", "attemptCount": 2},
            )
        ]
    )
    service.client.get_request_audit = AsyncMock(side_effect=RuntimeError("down"))
    detail = await service.get_detail("77")
    assert detail["clientIp"] == "local-ip"
    assert detail["attemptCount"] == 2
    assert detail.get("attempts") in (None, [])
    assert detail["gatewayHydrated"] is False
    assert "down" in detail["gatewayError"]
