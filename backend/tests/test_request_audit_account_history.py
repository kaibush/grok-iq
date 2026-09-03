from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from unittest.mock import MagicMock

from app.core.clock import utc_now
from app.core.config import Settings
from app.persistence.database import Database
from app.persistence.request_audit_repository import RequestAuditRepository
from app.services.request_audit_service import RequestAuditService


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


def _record(now, *, upstream_id: str, **values):
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
        "status_code": 200,
        "error_code": "",
        "streaming": False,
        "input_tokens": 0,
        "media_input_images": 0,
        "output_tokens": 100,
        "reasoning_tokens": 20,
        "reasoning_tokens_reported": True,
        "reasoning_effort": "",
        "total_tokens": 100,
        "first_token_ms": 200,
        "duration_ms": 1200,
        "tps": 80,
        "risk_level": "normal",
        "risk_reasons": [],
        "stream_sample": {},
        "raw": {},
        "created_at": now,
        "fetched_at": now,
    }
    payload.update(values)
    return payload


def _history(service: RequestAuditService, start, end, **kwargs):
    return service.account_history(
        window_preset="custom",
        start_at=start,
        end_at=end,
        **kwargs,
    )


def test_account_history_classifies_always_never_and_occasional(tmp_path: Path):
    repository, service = _build(tmp_path)
    now = utc_now()
    start = now - timedelta(hours=2)
    end = now + timedelta(minutes=1)
    rows = []
    for index in range(5):
        rows.append(
            _record(
                start + timedelta(minutes=10 + index),
                upstream_id=f"a{index}",
                account_id=1,
                account_name="stable",
                tps=80,
            )
        )
    for index in range(5):
        rows.append(
            _record(
                start + timedelta(minutes=20 + index),
                upstream_id=f"b{index}",
                account_id=2,
                account_name="broken",
                tps=600,
            )
        )
    rows.extend(
        [
            _record(
                start + timedelta(minutes=30),
                upstream_id="c-high-1",
                account_id=3,
                account_name="blip",
                tps=600,
            ),
            _record(
                start + timedelta(minutes=31),
                upstream_id="c-high-2",
                account_id=3,
                account_name="blip",
                tps=600,
            ),
            _record(
                start + timedelta(minutes=42),
                upstream_id="c-ok-1",
                account_id=3,
                account_name="blip",
                tps=80,
            ),
            _record(
                start + timedelta(minutes=43),
                upstream_id="c-ok-2",
                account_id=3,
                account_name="blip",
                tps=80,
            ),
            _record(
                start + timedelta(minutes=44),
                upstream_id="c-ok-3",
                account_id=3,
                account_name="blip",
                tps=80,
            ),
        ]
    )
    repository.upsert_records(rows)
    payload = _history(service, start, end)
    by_name = {item["accountName"]: item for item in payload["accounts"]}
    assert by_name["stable"]["pattern"] == "always_normal"
    assert by_name["stable"]["alwaysNormal"] is True
    assert by_name["broken"]["pattern"] == "never_normal"
    assert by_name["broken"]["neverNormal"] is True
    assert by_name["broken"]["stillAbnormal"] is True
    assert by_name["blip"]["pattern"] == "occasional"
    assert by_name["blip"]["recovered"] is True
    assert by_name["blip"]["stillAbnormal"] is False
    assert by_name["blip"]["lastRecoveryMinutes"] is not None
    assert payload["summary"]["alwaysNormal"] >= 1
    assert payload["summary"]["neverNormal"] >= 1
    assert payload["summary"]["occasional"] >= 1


def test_account_history_keeps_http_failures_out_of_risk(tmp_path: Path):
    repository, service = _build(tmp_path)
    now = utc_now()
    start = now - timedelta(hours=1)
    end = now + timedelta(minutes=1)
    repository.upsert_records(
        [
            _record(
                start + timedelta(minutes=10 + index),
                upstream_id=str(index),
                status_code=503,
                error_code="upstream_server_error_unavailable",
                tps=None,
            )
            for index in range(4)
        ]
    )
    payload = _history(service, start, end)
    account = payload["accounts"][0]
    assert account["pattern"] == "always_normal"
    assert account["failing"] is True
    assert account["failedRequests"] == 4
    assert account["watchRequests"] == 0
    assert account["highRiskRequests"] == 0
    assert payload["summary"]["failing"] == 1


def test_account_history_splits_idle_episodes_and_measures_recovery(tmp_path: Path):
    repository, service = _build(tmp_path)
    now = utc_now()
    start = now - timedelta(hours=3)
    end = now + timedelta(minutes=1)
    repository.upsert_records(
        [
            _record(start + timedelta(minutes=10), upstream_id="1", tps=600),
            _record(start + timedelta(minutes=22), upstream_id="2", tps=80),
            _record(start + timedelta(minutes=80), upstream_id="3", tps=600),
            _record(start + timedelta(minutes=81), upstream_id="4", tps=600),
        ]
    )
    payload = _history(service, start, end)
    account = payload["accounts"][0]
    assert account["abnormalEpisodes"] == 2
    first, second = account["episodes"]
    assert first["recovered"] is True
    assert first["recoveryMinutes"] >= 10
    assert second["recovered"] is False
    assert account["stillAbnormal"] is True
    assert account["pattern"] == "still_abnormal"


def test_account_history_risk_filter_keeps_full_timeline(tmp_path: Path):
    repository, service = _build(tmp_path)
    now = utc_now()
    start = now - timedelta(hours=1)
    end = now + timedelta(minutes=1)
    repository.upsert_records(
        [
            _record(start + timedelta(minutes=5), upstream_id="1", tps=80),
            _record(start + timedelta(minutes=6), upstream_id="2", tps=80),
            _record(start + timedelta(minutes=7), upstream_id="3", tps=80),
            _record(start + timedelta(minutes=8), upstream_id="4", tps=600),
        ]
    )
    high = _history(service, start, end, risk="high")
    assert len(high["accounts"]) == 1
    assert high["accounts"][0]["requests"] == 4
    assert high["accounts"][0]["normalRequests"] == 3
    normal = _history(service, start, end, risk="normal")
    assert normal["accounts"] == []
    risky = _history(service, start, end, risk="risky")
    assert len(risky["accounts"]) == 1


def test_account_history_bucket_minutes_follow_window(tmp_path: Path):
    repository, service = _build(tmp_path)
    now = utc_now()
    hour = _history(service, now - timedelta(hours=1), now)
    day = _history(service, now - timedelta(hours=24), now)
    week = _history(service, now - timedelta(days=7), now)
    month = _history(service, now - timedelta(days=30), now)
    assert hour["bucketMinutes"] == 5
    assert day["bucketMinutes"] == 15
    assert week["bucketMinutes"] == 60
    assert month["bucketMinutes"] == 240
    assert hour["accounts"] == []
    assert hour["summary"]["accounts"] == 0


def test_account_history_sparse_and_unlabeled_and_client_key(tmp_path: Path):
    repository, service = _build(tmp_path)
    now = utc_now()
    start = now - timedelta(hours=1)
    end = now + timedelta(minutes=1)
    repository.upsert_records(
        [
            _record(
                start + timedelta(minutes=5),
                upstream_id="u1",
                account_id=None,
                account_name="ghost",
                client_key_id="k1",
                client_key_name="alpha",
                tps=80,
            ),
            _record(
                start + timedelta(minutes=6),
                upstream_id="u2",
                account_id=9,
                account_name="keyed",
                client_key_id="k2",
                client_key_name="beta",
                tps=80,
            ),
            _record(
                start + timedelta(minutes=7),
                upstream_id="u3",
                account_id=9,
                account_name="keyed",
                client_key_id="k2",
                client_key_name="beta",
                tps=80,
            ),
        ]
    )
    payload = _history(service, start, end)
    ghost = next(item for item in payload["accounts"] if item["accountName"] == "ghost")
    assert ghost["accountId"] is None
    assert ghost["pattern"] == "sparse"
    keyed = _history(service, start, end, client_key="k2")
    assert [item["accountName"] for item in keyed["accounts"]] == ["keyed"]
    pinned = _history(service, start, end, account_id=9)
    assert [item["accountId"] for item in pinned["accounts"]] == [9]


def test_account_history_sorts_still_abnormal_first(tmp_path: Path):
    repository, service = _build(tmp_path)
    now = utc_now()
    start = now - timedelta(hours=1)
    end = now + timedelta(minutes=1)
    repository.upsert_records(
        [
            _record(start + timedelta(minutes=10), upstream_id="ok1", account_id=1, account_name="ok", tps=80),
            _record(start + timedelta(minutes=11), upstream_id="ok2", account_id=1, account_name="ok", tps=80),
            _record(start + timedelta(minutes=12), upstream_id="ok3", account_id=1, account_name="ok", tps=80),
            _record(start + timedelta(minutes=13), upstream_id="bad1", account_id=2, account_name="bad", tps=600),
            _record(start + timedelta(minutes=14), upstream_id="bad2", account_id=2, account_name="bad", tps=600),
            _record(start + timedelta(minutes=15), upstream_id="bad3", account_id=2, account_name="bad", tps=600),
        ]
    )
    payload = _history(service, start, end)
    assert payload["accounts"][0]["accountName"] == "bad"
    assert payload["accounts"][0]["stillAbnormal"] is True
