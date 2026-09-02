from __future__ import annotations

from datetime import timedelta
from unittest.mock import AsyncMock, MagicMock

from app.core.clock import utc_now
from app.core.config import Settings
from app.services.request_audit_service import RequestAuditService


def _record(**values):
    now = utc_now()
    return {
        "upstream_id": "1",
        "request_id": "req-1",
        "account_id": 7,
        "account_name": "alice",
        "client_key_id": "9",
        "client_key_name": "production",
        "egress_node_id": 3,
        "status_code": 200,
        "output_tokens": 20,
        "reasoning_tokens": 0,
        "reasoning_tokens_reported": False,
        "first_token_ms": 10,
        "duration_ms": 110,
        "tps": 20,
        "model_upstream_model": "Build/grok-4.6",
        "model_public_id": "grok-4.6",
        "operation": "chat",
        "media_input_images": 0,
        "created_at": now,
        **values,
    }


def test_normalize_record_keeps_client_key_identity():
    service = RequestAuditService(
        settings=Settings(_env_file=None),
        client=MagicMock(),
        repository=MagicMock(),
    )
    created_at = utc_now()
    record = service._normalize_record(
        {
            "requestId": "req-1",
            "clientKeyId": "42",
            "clientKeyName": "production",
            "accountId": 7,
            "accountName": "alice",
            "statusCode": 200,
            "streaming": True,
            "outputTokens": 20,
            "durationMs": 110,
            "firstTokenMs": 10,
            "createdAt": created_at.isoformat(),
            "errorCode": "upstream_stream_interrupted",
        },
        "99",
        created_at.date().isoformat(),
        created_at,
        {},
    )
    assert record["client_key_id"] == "42"
    assert record["client_key_name"] == "production"
    assert record["error_code"] == "upstream_stream_interrupted"
    assert record["raw"]["clientKeyName"] == "production"
    assert record["raw"]["errorCode"] == "upstream_stream_interrupted"


async def test_list_page_filters_client_key_name():
    now = utc_now()
    repo = MagicMock()
    repo.records_for_range.return_value = [
        _record(
            upstream_id="1",
            request_id="req-prod",
            client_key_id="9",
            client_key_name="production",
            created_at=now,
        ),
        _record(
            upstream_id="2",
            request_id="req-stage",
            account_id=8,
            account_name="bob",
            client_key_id="11",
            client_key_name="staging",
            created_at=now - timedelta(seconds=1),
        ),
    ]
    repo.verifications_for_audits.return_value = {}
    client = MagicMock()
    client.get_accounts_by_ids = AsyncMock(return_value=[])
    service = RequestAuditService(
        settings=Settings(_env_file=None),
        client=client,
        repository=repo,
    )

    page = await service.list_page(page=1, page_size=50, client_key="production")
    assert page["total"] == 1
    assert page["items"][0]["clientKeyName"] == "production"
    assert page["items"][0]["clientKeyId"] == "9"
    assert [
        (item["id"], item["name"], item["requestCount"]) for item in page["clientKeys"]
    ] == [
        ("9", "production", 1),
        ("11", "staging", 1),
    ]

    by_id = await service.list_page(page=1, page_size=50, client_key="11")
    assert by_id["total"] == 1
    assert by_id["items"][0]["clientKeyName"] == "staging"
    assert by_id["clientKeys"] == page["clientKeys"]

    by_search = await service.list_page(page=1, page_size=50, account="production")
    assert by_search["total"] == 1
    assert by_search["items"][0]["requestId"] == "req-prod"


async def test_list_page_filters_exact_account_id():
    now = utc_now()
    repo = MagicMock()
    repo.records_for_range.return_value = [
        _record(
            upstream_id="1",
            request_id="req-12",
            account_id=12,
            account_name="alice",
            created_at=now,
        ),
        _record(
            upstream_id="2",
            request_id="req-120",
            account_id=120,
            account_name="alice-120",
            created_at=now - timedelta(seconds=1),
        ),
    ]
    repo.verifications_for_audits.return_value = {}
    client = MagicMock()
    client.get_accounts_by_ids = AsyncMock(return_value=[])
    service = RequestAuditService(
        settings=Settings(_env_file=None),
        client=client,
        repository=repo,
    )

    page = await service.list_page(page=1, page_size=50, account_id=12)
    assert page["total"] == 1
    assert page["items"][0]["accountId"] == 12
    assert page["items"][0]["requestId"] == "req-12"

    by_search = await service.list_page(page=1, page_size=50, account="12")
    assert {item["accountId"] for item in by_search["items"]} == {12, 120}


def test_client_key_options_aggregates_window_activity():
    now = utc_now()
    earlier = now - timedelta(minutes=8)
    values = RequestAuditService._client_key_options(
        [
            {
                "client_key_id": "9",
                "client_key_name": "production",
                "created_at": earlier,
            },
            {
                "client_key_id": "9",
                "client_key_name": "production",
                "created_at": now,
            },
            {
                "client_key_id": "11",
                "client_key_name": "staging",
                "created_at": earlier,
            },
            {
                "client_key_id": "",
                "client_key_name": "",
                "created_at": now,
            },
        ]
    )
    by_id = {item["id"]: item for item in values}
    assert by_id["9"]["requestCount"] == 2
    assert by_id["11"]["requestCount"] == 1
    assert by_id["unlabeled"]["name"] == "未记录 Key"
    assert by_id["unlabeled"]["requestCount"] == 1
    assert values[0]["id"] == "9"
