from __future__ import annotations

from datetime import timedelta
from unittest.mock import AsyncMock, MagicMock

from app.core.clock import utc_now
from app.core.config import Settings
from app.services.request_audit_service import RequestAuditService


def build_service(**overrides: object) -> RequestAuditService:
    settings = Settings(_env_file=None)
    for key, value in overrides.items():
        setattr(settings, key, value)
    return RequestAuditService(
        settings=settings,
        client=MagicMock(),
        repository=MagicMock(),
        account_service=AsyncMock(),
    )


def _row(
    *,
    upstream_id: str,
    tps: float | None,
    offset_seconds: int,
    status_code: int = 200,
    error_code: str = "",
    account_id: int = 7,
) -> dict[str, object]:
    now = utc_now()
    return {
        "upstream_id": upstream_id,
        "account_id": account_id,
        "status_code": status_code,
        "error_code": error_code,
        "output_tokens": 600,
        "reasoning_tokens": 40,
        "reasoning_tokens_reported": True,
        "first_token_ms": 100,
        "duration_ms": 1100,
        "tps": tps,
        "model_upstream_model": "Build/grok-4.6",
        "model_public_id": "grok-4.6",
        "operation": "chat",
        "media_input_images": 0,
        "created_at": now + timedelta(seconds=offset_seconds),
    }


def test_high_normal_high_does_not_create_tps_candidate():
    service = build_service()
    records = [
        _row(upstream_id="1", tps=800, offset_seconds=1),
        _row(upstream_id="2", tps=40, offset_seconds=2),
        _row(upstream_id="3", tps=900, offset_seconds=3),
    ]
    evaluations = service._audit_risk_evaluations(records)
    candidates = service._pre_disable_candidates(records, evaluations=evaluations)
    assert candidates == []


def test_watch_tps_resets_consecutive_high_streak():
    service = build_service()
    records = [
        _row(upstream_id="1", tps=800, offset_seconds=1),
        _row(upstream_id="2", tps=200, offset_seconds=2),
        _row(upstream_id="3", tps=900, offset_seconds=3),
    ]
    evaluations = service._audit_risk_evaluations(records)
    candidates = service._pre_disable_candidates(records, evaluations=evaluations)
    assert candidates == []


def test_two_consecutive_highs_create_cooldown_candidate():
    service = build_service()
    records = [
        _row(upstream_id="1", tps=40, offset_seconds=1),
        _row(upstream_id="2", tps=800, offset_seconds=2),
        _row(upstream_id="3", tps=900, offset_seconds=3),
    ]
    evaluations = service._audit_risk_evaluations(records)
    candidates = service._pre_disable_candidates(records, evaluations=evaluations)
    assert [item.get("_action_mode") for item in candidates] == ["tps_only"]
    assert candidates[0]["_tps_disposition"] == "cool"
    assert candidates[0]["_tps_anomaly_count"] == 2
    assert candidates[0]["upstream_id"] == "3"


def test_error_rows_do_not_reset_high_tps_streak():
    service = build_service()
    records = [
        _row(upstream_id="1", tps=800, offset_seconds=1),
        _row(
            upstream_id="2",
            tps=None,
            offset_seconds=2,
            status_code=503,
            error_code="upstream_server_error_unavailable",
        ),
        _row(upstream_id="3", tps=900, offset_seconds=3),
    ]
    evaluations = service._audit_risk_evaluations(records)
    candidates = service._pre_disable_candidates(records, evaluations=evaluations)
    assert candidates[0]["_tps_anomaly_count"] == 2
    assert candidates[0]["_tps_disposition"] == "cool"


def test_active_tps_cooldown_skips_new_candidate():
    service = build_service()
    until = utc_now() + timedelta(minutes=20)
    service.repository.latest_tps_cooldowns_for_accounts.return_value = {
        7: {
            "account_id": 7,
            "action_status": "cooled",
            "checked_at": utc_now() - timedelta(minutes=5),
            "egress_recommendation": {
                "kind": "tps_cooldown",
                "cooldownUntil": until.isoformat(),
                "cooledAt": (utc_now() - timedelta(minutes=5)).isoformat(),
            },
        }
    }
    records = [
        _row(upstream_id="1", tps=800, offset_seconds=1),
        _row(upstream_id="2", tps=900, offset_seconds=2),
    ]
    evaluations = service._audit_risk_evaluations(records)
    candidates = service._pre_disable_candidates(records, evaluations=evaluations)
    assert candidates == []


def test_expired_cooldown_without_healthy_tps_disables():
    service = build_service()
    now = utc_now()
    cooled_at = now - timedelta(minutes=40)
    until = now - timedelta(minutes=10)
    service.repository.latest_tps_cooldowns_for_accounts.return_value = {
        7: {
            "account_id": 7,
            "action_status": "cooldown_expired",
            "checked_at": cooled_at,
            "egress_recommendation": {
                "kind": "tps_cooldown",
                "cooldownUntil": until.isoformat(),
                "cooledAt": cooled_at.isoformat(),
            },
        }
    }
    records = [
        _row(upstream_id="old-1", tps=800, offset_seconds=-50 * 60),
        _row(upstream_id="old-2", tps=900, offset_seconds=-49 * 60),
        {
            **_row(upstream_id="new-1", tps=850, offset_seconds=0),
            "created_at": until + timedelta(minutes=1),
        },
        {
            **_row(upstream_id="new-2", tps=920, offset_seconds=0),
            "created_at": until + timedelta(minutes=2),
        },
    ]
    evaluations = service._audit_risk_evaluations(records)
    candidates = service._pre_disable_candidates(records, evaluations=evaluations)
    assert candidates[0]["_tps_disposition"] == "disable"
    assert candidates[0]["_tps_anomaly_count"] == 2
    assert candidates[0]["upstream_id"] == "new-2"


def test_expired_cooldown_with_healthy_tps_cools_again():
    service = build_service()
    now = utc_now()
    cooled_at = now - timedelta(minutes=40)
    until = now - timedelta(minutes=10)
    service.repository.latest_tps_cooldowns_for_accounts.return_value = {
        7: {
            "account_id": 7,
            "action_status": "cooldown_expired",
            "checked_at": cooled_at,
            "egress_recommendation": {
                "kind": "tps_cooldown",
                "cooldownUntil": until.isoformat(),
                "cooledAt": cooled_at.isoformat(),
            },
        }
    }
    records = [
        {
            **_row(upstream_id="healthy", tps=45, offset_seconds=0),
            "created_at": until + timedelta(minutes=1),
        },
        {
            **_row(upstream_id="new-1", tps=850, offset_seconds=0),
            "created_at": until + timedelta(minutes=2),
        },
        {
            **_row(upstream_id="new-2", tps=920, offset_seconds=0),
            "created_at": until + timedelta(minutes=3),
        },
    ]
    evaluations = service._audit_risk_evaluations(records)
    candidates = service._pre_disable_candidates(records, evaluations=evaluations)
    assert candidates[0]["_tps_disposition"] == "cool"
    assert candidates[0]["upstream_id"] == "new-2"


async def test_expire_tps_cooldown_reenables_account():
    service = build_service()
    service.repository.cooling_verifications.return_value = [
        {
            "account_id": 7,
            "audit_upstream_id": "audit-cool",
            "action_status": "cooled",
            "egress_recommendation": {
                "kind": "tps_cooldown",
                "cooldownUntil": (utc_now() - timedelta(minutes=1)).isoformat(),
                "disabledByCooldown": True,
            },
        }
    ]
    service.account_service.release_tps_cooldown.return_value = {
        "actionStatus": "cooldown_expired",
        "reenabled": True,
    }

    stats = await service._expire_tps_cooldowns()

    assert stats == {"expired": 1, "reenabled": 1, "skipped": 0, "failed": 0}
    service.account_service.release_tps_cooldown.assert_awaited()
    service.repository.update_verification.assert_called()
    payload = service.repository.update_verification.call_args.args[1]
    assert payload["action_status"] == "cooldown_expired"


async def test_expire_tps_cooldown_skips_future_until():
    service = build_service()
    service.repository.cooling_verifications.return_value = [
        {
            "account_id": 7,
            "audit_upstream_id": "audit-cool",
            "action_status": "cooled",
            "egress_recommendation": {
                "kind": "tps_cooldown",
                "cooldownUntil": (utc_now() + timedelta(minutes=10)).isoformat(),
                "disabledByCooldown": True,
            },
        }
    ]

    stats = await service._expire_tps_cooldowns()

    assert stats["expired"] == 0
    service.account_service.release_tps_cooldown.assert_not_called()
