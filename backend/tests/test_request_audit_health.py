from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from unittest.mock import MagicMock

from app.core.clock import utc_now
from app.core.config import Settings
from app.persistence.database import Database
from app.persistence.request_audit_repository import RequestAuditRepository
from app.services.request_audit_service import (
    REQUEST_AUDIT_SCOPE,
    RequestAuditService,
)


def _build(tmp_path: Path) -> tuple[RequestAuditRepository, RequestAuditService]:
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = RequestAuditRepository(database)
    service = RequestAuditService(
        settings=Settings(_env_file=None),
        client=MagicMock(),
        repository=repository,
    )
    return repository, service


def _record(now, *, upstream_id: str, status_code: int, error_code: str = "", **values):
    payload = {
        "upstream_id": upstream_id,
        "request_id": f"req-{upstream_id}",
        "day_key": now.date().isoformat(),
        "provider": "grok_build",
        "operation": "responses",
        "model_public_id": "grok-4.6",
        "model_upstream_model": "Build/grok-4.6",
        "account_id": 7,
        "account_name": "alice",
        "client_key_id": "",
        "client_key_name": "",
        "egress_node_id": 0,
        "egress_node_name": "",
        "egress_ip": "",
        "egress_mode": "",
        "egress_scope": "",
        "status_code": status_code,
        "error_code": error_code,
        "streaming": False,
        "input_tokens": 0,
        "media_input_images": 0,
        "output_tokens": 100,
        "reasoning_tokens": 0,
        "reasoning_tokens_reported": True,
        "reasoning_effort": "",
        "total_tokens": 100,
        "first_token_ms": 200,
        "duration_ms": 1200,
        "tps": None,
        "risk_level": "normal",
        "risk_reasons": [],
        "stream_sample": {},
        "raw": {},
        "created_at": now,
        "fetched_at": now,
    }
    payload.update(values)
    return payload


def test_recent_request_health_aggregates_windows_models_and_errors(tmp_path: Path):
    repository, service = _build(tmp_path)
    now = utc_now()
    repository.upsert_records(
        [
            _record(
                now - timedelta(minutes=1),
                upstream_id="1",
                status_code=503,
                error_code="upstream_server_error_unavailable",
            ),
            _record(now - timedelta(minutes=2), upstream_id="2", status_code=200),
            _record(
                now - timedelta(minutes=5),
                upstream_id="3",
                status_code=503,
                error_code="upstream_server_error_unavailable",
            ),
            _record(now - timedelta(minutes=8), upstream_id="4", status_code=200),
            _record(now - timedelta(minutes=10), upstream_id="5", status_code=200),
            _record(
                now - timedelta(minutes=20),
                upstream_id="6",
                status_code=429,
                error_code="upstream_rate_limited_resource_exhausted",
            ),
            _record(
                now - timedelta(minutes=40),
                upstream_id="7",
                status_code=200,
                model_public_id="grok-3.8",
                model_upstream_model="Build/grok-3.8",
            ),
        ]
    )

    payload = service.recent_request_health()

    assert payload["provider"] == "grok_build"
    assert payload["enabled"] is True
    assert payload["stale"] is False
    assert payload["asOf"] is not None
    assert payload["windows"]["15m"] == {
        "requests": 5,
        "successfulRequests": 3,
        "failedRequests": 2,
        "successRate": 60.0,
    }
    assert payload["windows"]["30m"]["requests"] == 6
    assert payload["windows"]["30m"]["successRate"] == 50.0
    assert payload["windows"]["1h"]["requests"] == 7
    assert payload["windows"]["1h"]["successfulRequests"] == 4
    assert payload["windows"]["1h"]["failedRequests"] == 3
    assert payload["windows"]["1h"]["successRate"] == 57.1

    by_model = {item["model"]: item for item in payload["models"]}
    assert by_model["grok-4.6"]["requests"] == 6
    assert by_model["grok-4.6"]["failedRequests"] == 3
    assert (
        by_model["grok-4.6"]["mainError"]["errorCode"]
        == "upstream_server_error_unavailable"
    )
    assert by_model["grok-4.6"]["mainError"]["requests"] == 2
    assert by_model["grok-3.8"]["requests"] == 1
    assert by_model["grok-3.8"]["successRate"] == 100.0

    assert payload["errors"][0] == {
        "statusCode": 503,
        "errorCode": "upstream_server_error_unavailable",
        "requests": 2,
    }
    assert payload["errors"][1]["statusCode"] == 429

    assert 11 <= len(payload["series"]) <= 12
    assert any(point["requests"] > 0 for point in payload["series"])
    assert all(
        0.0 <= point["successRate"] <= 100.0 for point in payload["series"]
    )


def test_recent_request_health_marks_stale_without_fresh_scan(tmp_path: Path):
    repository, service = _build(tmp_path)
    now = utc_now()
    repository.save_state(
        REQUEST_AUDIT_SCOPE,
        {
            "day_key": now.date().isoformat(),
            "initial_complete": True,
            "last_scan_at": now - timedelta(hours=2),
            "last_success_at": now - timedelta(hours=2),
        },
    )

    payload = service.recent_request_health()

    assert payload["stale"] is True
    assert payload["windows"]["1h"]["requests"] == 0
    assert payload["models"] == []
    assert payload["errors"] == []


def test_recent_request_health_keeps_fresh_when_rows_recent_but_state_absent(
    tmp_path: Path,
):
    repository, service = _build(tmp_path)
    now = utc_now()
    repository.upsert_records(
        [
            _record(
                now - timedelta(seconds=30),
                upstream_id="1",
                status_code=200,
            )
        ]
    )

    payload = service.recent_request_health()

    assert payload["stale"] is False


def test_recent_request_health_omits_internal_quality_intercepts(tmp_path: Path):
    repository, service = _build(tmp_path)
    now = utc_now()
    repository.upsert_records(
        [
            _record(now - timedelta(minutes=2), upstream_id="1", status_code=200),
            _record(
                now - timedelta(minutes=3),
                upstream_id="2",
                status_code=200,
                error_code="quality_degraded",
            ),
            _record(
                now - timedelta(minutes=4),
                upstream_id="3",
                status_code=503,
                error_code="quality_degraded",
            ),
            _record(
                now - timedelta(minutes=6),
                upstream_id="4",
                status_code=503,
                error_code="upstream_server_error_unavailable",
            ),
        ]
    )

    payload = service.recent_request_health()

    assert payload["windows"]["15m"] == {
        "requests": 2,
        "successfulRequests": 1,
        "failedRequests": 1,
        "successRate": 50.0,
    }
    assert payload["errors"] == [
        {
            "statusCode": 503,
            "errorCode": "upstream_server_error_unavailable",
            "requests": 1,
        }
    ]
    assert payload["models"][0]["requests"] == 2
    assert payload["models"][0]["failedRequests"] == 1
    assert payload["models"][0]["mainError"]["errorCode"] == (
        "upstream_server_error_unavailable"
    )
