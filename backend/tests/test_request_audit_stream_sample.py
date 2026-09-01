from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

from app.core.clock import utc_now
from app.core.config import Settings
from app.persistence.database import Database
from app.persistence.request_audit_repository import RequestAuditRepository
from app.services.request_audit_service import (
    RequestAuditService,
    _normalize_stream_sample,
)


def _build(tmp_path: Path) -> tuple[RequestAuditRepository, RequestAuditService]:
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = RequestAuditRepository(database)
    client = MagicMock()
    client.get_accounts_by_ids = AsyncMock(return_value=[])
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
        "input_tokens": 0,
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
        "raw": {"id": index},
        "created_at": now,
        "fetched_at": now,
    }
    payload.update(values)
    return payload


def test_normalize_stream_sample_keeps_bounded_evidence():
    sample = _normalize_stream_sample(
        {
            "protocol": "chat",
            "thinkingChars": 120,
            "thinkingChunks": 3,
            "hasThinking": True,
            "hasVisibleOutput": True,
            "thinkingThenOutput": True,
            "firstThinkingMs": 20,
            "lastThinkingMs": 80,
            "thinkingHead": "先看约束",
            "outputHead": "结论",
            "truncated": True,
            "ignored": "drop-me",
        }
    )
    assert sample["protocol"] == "chat"
    assert sample["thinkingChars"] == 120
    assert sample["hasThinking"] is True
    assert sample["thinkingHead"] == "先看约束"
    assert sample["truncated"] is True
    assert "ignored" not in sample


def test_normalize_stream_sample_omits_empty_payloads():
    assert _normalize_stream_sample(None) == {}
    assert _normalize_stream_sample({}) == {}
    assert _normalize_stream_sample({"protocol": "chat", "truncated": True}) == {}


def test_normalize_record_stores_stream_sample_outside_raw():
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
            "reasoningTokens": 18,
            "durationMs": 200,
            "createdAt": created_at.isoformat(),
            "streamSample": {
                "protocol": "chat",
                "hasThinking": True,
                "thinkingChars": 40,
                "thinkingHead": "思考开头",
            },
        },
        "99",
        created_at.date().isoformat(),
        created_at,
        {},
    )
    assert record["stream_sample"]["hasThinking"] is True
    assert record["stream_sample"]["thinkingHead"] == "思考开头"
    assert "streamSample" not in record["raw"]


async def test_list_page_attaches_stream_sample_without_loading_it_in_range(
    tmp_path: Path,
):
    repository, service = _build(tmp_path)
    now = utc_now()
    sample = {
        "protocol": "chat",
        "hasThinking": True,
        "hasVisibleOutput": True,
        "thinkingChars": 80,
        "outputChars": 20,
        "thinkingHead": "先核对推理",
        "outputHead": "可见输出",
    }
    repository.upsert_records(
        [
            _record(now, upstream_id="1", stream_sample=sample, created_at=now),
            _record(
                now,
                upstream_id="2",
                stream_sample={},
                created_at=now - timedelta(seconds=1),
            ),
        ]
    )

    rows = repository.records_for_range(now - timedelta(hours=1), now + timedelta(hours=1))
    assert {row["upstream_id"] for row in rows} == {"1", "2"}
    assert all("stream_sample" not in row and "raw" not in row for row in rows)

    page = await service.list_page(page=1, page_size=50, window_preset="7d")
    by_id = {item["id"]: item for item in page["items"]}
    assert by_id["1"]["streamSample"]["thinkingHead"] == "先核对推理"
    assert "streamSample" not in by_id["2"]


def test_refresh_stream_samples_fills_empty_rows_only(tmp_path: Path):
    repository, _service = _build(tmp_path)
    now = utc_now()
    existing = {
        "protocol": "chat",
        "hasThinking": True,
        "thinkingChars": 12,
        "thinkingHead": "已有样本",
    }
    repository.upsert_records(
        [
            _record(now, upstream_id="1", stream_sample={}),
            _record(now, upstream_id="2", stream_sample=existing),
        ]
    )

    updated = repository.refresh_stream_samples(
        [
            {
                "id": "1",
                "provider": "grok_build",
                "streamSample": {
                    "protocol": "chat",
                    "hasVisibleOutput": True,
                    "outputChars": 16,
                    "outputHead": "回填输出",
                },
            },
            {
                "id": "2",
                "provider": "grok_build",
                "streamSample": {
                    "protocol": "chat",
                    "hasThinking": True,
                    "thinkingChars": 99,
                    "thinkingHead": "不应覆盖",
                },
            },
        ]
    )
    assert updated == 1
    samples = repository.stream_samples_for_audits(["1", "2"])
    assert samples["1"]["outputHead"] == "回填输出"
    assert samples["2"]["thinkingHead"] == "已有样本"
