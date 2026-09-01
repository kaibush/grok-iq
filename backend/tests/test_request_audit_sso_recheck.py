from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

from app.core.clock import utc_now
from app.core.config import Settings
from app.persistence.account_repository import AccountRepository
from app.persistence.database import Database
from app.persistence.request_audit_repository import RequestAuditRepository
from app.services.request_audit_service import RequestAuditService


def build_service(**overrides: object) -> tuple[
    RequestAuditService,
    MagicMock,
    AsyncMock,
]:
    settings = Settings(_env_file=None)
    for key, value in overrides.items():
        setattr(settings, key, value)
    repository = MagicMock()
    repository.update_verification.side_effect = (
        lambda audit_id, values: {"audit_upstream_id": audit_id, **values}
    )
    account_service = AsyncMock()
    service = RequestAuditService(
        settings=settings,
        client=MagicMock(),
        repository=repository,
        account_service=account_service,
    )
    return service, repository, account_service


def quarantine_record() -> dict[str, object]:
    return {
        "account_id": 11,
        "upstream_id": "audit-1",
        "tps": 12.5,
        "reasoning_tokens": 0,
        "_action_mode": "quarantine",
        "_risk_rule_id": "reasoning_zero",
        "_risk_rule_count": 2,
        "_risk_reasons": ["成功请求思考输出为 0"],
        "created_at": utc_now(),
    }


def tps_record() -> dict[str, object]:
    return {
        "account_id": 11,
        "upstream_id": "audit-2",
        "tps": 800,
        "_action_mode": "tps_only",
        "_risk_rule_id": "fast_risk",
        "_risk_rule_count": 2,
        "_tps_anomaly_count": 2,
        "_tps_min_count": 2,
        "_tps_max": 800,
        "_tps_egress_node_ids": [3],
        "_risk_reasons": ["TPS 过高"],
        "created_at": utc_now(),
    }


async def test_pre_disable_quarantines_without_sso_recheck():
    service, _repository, account_service = build_service()
    service.repository.create_verification.return_value = {
        "status": "pending",
        "action_status": "pending",
    }
    account_service.apply_auto_quarantine.return_value = {"actionStatus": "disabled"}

    result = await service._process_pre_disable_candidate(quarantine_record())

    account_service.apply_auto_quarantine.assert_awaited()
    note = account_service.apply_auto_quarantine.await_args.kwargs["note"]
    assert "自动停用" in note
    assert "SSO" not in note
    assert result["status"] == "sso_skipped"
    assert result["action_status"] == "disabled"
    assert result["sso_verdict"] == "skipped"


async def test_pre_disable_retries_missing_sso_records():
    service, _repository, account_service = build_service()
    service.repository.create_verification.return_value = {
        "status": "missing_sso",
        "action_status": "not_required",
        "sso_verdict": "",
        "bot_flag": {},
        "proxy_used": False,
        "check_error": "账号未保存 SSO",
    }
    account_service.apply_auto_quarantine.return_value = {"actionStatus": "disabled"}

    result = await service._process_pre_disable_candidate(quarantine_record())

    account_service.apply_auto_quarantine.assert_awaited()
    assert result["status"] == "sso_skipped"
    assert result["action_status"] == "disabled"


async def test_pre_disable_retries_false_clean_records():
    service, _repository, account_service = build_service()
    service.repository.create_verification.return_value = {
        "status": "clean",
        "action_status": "not_required",
        "sso_verdict": "clean",
        "bot_flag": {"found": False, "flagged": False},
        "valid_session": True,
        "email_match": True,
    }
    account_service.apply_auto_quarantine.return_value = {"actionStatus": "disabled"}

    result = await service._process_pre_disable_candidate(quarantine_record())

    account_service.apply_auto_quarantine.assert_awaited()
    assert result["status"] == "sso_skipped"
    assert result["action_status"] == "disabled"


async def test_pre_disable_skips_already_disabled_records():
    service, _repository, account_service = build_service()
    existing = {
        "status": "sso_skipped",
        "action_status": "disabled",
        "sso_verdict": "skipped",
    }
    service.repository.create_verification.return_value = existing

    result = await service._process_pre_disable_candidate(quarantine_record())

    account_service.apply_auto_quarantine.assert_not_called()
    assert result is existing


async def test_pre_disable_cools_tps_only_without_sso():
    service, _repository, account_service = build_service()
    service.repository.create_verification.return_value = {
        "status": "pending",
        "action_status": "pending",
    }
    account_service.apply_tps_cooldown.return_value = {
        "actionStatus": "cooled",
        "cooldownUntil": utc_now(),
        "disabledByCooldown": True,
    }

    result = await service._process_pre_disable_candidate(tps_record())

    account_service.apply_tps_only_deprioritization.assert_not_called()
    account_service.apply_auto_quarantine.assert_not_called()
    account_service.apply_tps_cooldown.assert_awaited()
    note = account_service.apply_tps_cooldown.await_args.kwargs["note"]
    detail = account_service.apply_tps_cooldown.await_args.kwargs["detail"]
    assert "冷却" in note
    assert "SSO" not in note
    assert detail["riskRuleId"] == "fast_risk"
    assert detail["tpsStreak"] == 2
    assert result["status"] == "sso_skipped"
    assert result["action_status"] == "cooled"
    assert result["egress_recommendation"]["kind"] == "tps_cooldown"


async def test_pre_disable_isolates_tps_only_after_cooldown():
    service, _repository, account_service = build_service()
    service.repository.create_verification.return_value = {
        "status": "pending",
        "action_status": "pending",
    }
    account_service.apply_auto_quarantine.return_value = {"actionStatus": "disabled"}
    record = tps_record()
    record["_tps_disposition"] = "disable"

    result = await service._process_pre_disable_candidate(record)

    account_service.apply_tps_cooldown.assert_not_called()
    account_service.apply_auto_quarantine.assert_awaited()
    note = account_service.apply_auto_quarantine.await_args.kwargs["note"]
    assert "冷却后" in note
    assert account_service.apply_auto_quarantine.await_args.kwargs["permanent"] is True
    assert result["action_status"] == "disabled"


async def test_pre_disable_retries_deprioritized_tps_only_for_isolation():
    service, _repository, account_service = build_service()
    service.repository.create_verification.return_value = {
        "status": "sso_skipped",
        "action_status": "deprioritized",
        "sso_verdict": "skipped",
    }
    account_service.apply_auto_quarantine.return_value = {"actionStatus": "disabled"}

    result = await service._process_pre_disable_candidate(tps_record())

    account_service.apply_tps_only_deprioritization.assert_not_called()
    account_service.apply_auto_quarantine.assert_awaited()
    assert result["action_status"] == "disabled"


async def test_pre_disable_retries_sso_skipped_action_failed():
    service, _repository, account_service = build_service()
    service.repository.create_verification.return_value = {
        "status": "sso_skipped",
        "action_status": "action_failed",
        "sso_verdict": "skipped",
        "action_error": "upstream timeout",
    }
    account_service.apply_auto_quarantine.return_value = {"actionStatus": "disabled"}

    result = await service._process_pre_disable_candidate(quarantine_record())

    account_service.apply_auto_quarantine.assert_awaited()
    assert result["status"] == "sso_skipped"
    assert result["action_status"] == "disabled"


async def test_pre_disable_retries_already_quarantined_after_probe_restore():
    service, _repository, account_service = build_service()
    accounts = MagicMock()
    accounts.get_assessment.return_value = {"monitor_status": "healthy"}
    service.accounts = accounts
    service.repository.create_verification.return_value = {
        "status": "sso_skipped",
        "action_status": "already_quarantined",
        "sso_verdict": "skipped",
    }
    account_service.apply_auto_quarantine.return_value = {"actionStatus": "disabled"}

    result = await service._process_pre_disable_candidate(quarantine_record())

    account_service.apply_auto_quarantine.assert_awaited()
    assert account_service.apply_auto_quarantine.await_args.kwargs["permanent"] is True
    assert result["action_status"] == "disabled"


async def test_pre_disable_skips_already_quarantined_while_still_isolated():
    service, _repository, account_service = build_service()
    accounts = MagicMock()
    accounts.get_assessment.return_value = {"monitor_status": "quarantined"}
    service.accounts = accounts
    existing = {
        "status": "sso_skipped",
        "action_status": "already_quarantined",
        "sso_verdict": "skipped",
    }
    service.repository.create_verification.return_value = existing

    result = await service._process_pre_disable_candidate(quarantine_record())

    account_service.apply_auto_quarantine.assert_not_called()
    assert result is existing


async def test_pre_disable_records_probe_isolation_without_alerting():
    service, repository, account_service = build_service()
    accounts = MagicMock()
    accounts.get_assessment.return_value = {"monitor_status": "quarantined"}
    service.accounts = accounts
    service.repository.create_verification.return_value = {
        "status": "pending",
        "action_status": "pending",
    }

    result = await service._process_pre_disable_candidate(quarantine_record())

    account_service.apply_auto_quarantine.assert_not_called()
    repository.update_verification.assert_called_once()
    updated = repository.update_verification.call_args.args[1]
    assert updated["status"] == "sso_skipped"
    assert updated["action_status"] == "already_quarantined"
    assert result["action_status"] == "already_quarantined"


async def test_pre_disable_skips_auto_quarantine_disabled_while_isolation_off():
    service, _repository, account_service = build_service(
        request_audit_isolation_enabled=False
    )
    existing = {
        "status": "sso_skipped",
        "action_status": "auto_quarantine_disabled",
        "sso_verdict": "skipped",
    }
    service.repository.create_verification.return_value = existing

    result = await service._process_pre_disable_candidate(quarantine_record())

    account_service.apply_auto_quarantine.assert_not_called()
    assert result is existing


async def test_pre_disable_retries_auto_quarantine_disabled_after_isolation_enabled():
    service, _repository, account_service = build_service(
        request_audit_isolation_enabled=True
    )
    service.repository.create_verification.return_value = {
        "status": "sso_skipped",
        "action_status": "auto_quarantine_disabled",
        "sso_verdict": "skipped",
    }
    account_service.apply_auto_quarantine.return_value = {"actionStatus": "disabled"}

    result = await service._process_pre_disable_candidate(quarantine_record())

    account_service.apply_auto_quarantine.assert_awaited()
    assert result["action_status"] == "disabled"


def _seed_verification(
    repository: RequestAuditRepository,
    *,
    upstream_id: str,
    account_id: int,
    status: str,
    action_status: str,
) -> None:
    now = utc_now()
    repository.upsert_records(
        [
            {
                "upstream_id": upstream_id,
                "request_id": upstream_id,
                "day_key": now.date().isoformat(),
                "provider": "grok_build",
                "operation": "chat",
                "model_public_id": "grok-4.6",
                "model_upstream_model": "Build/grok-4.6",
                "account_id": account_id,
                "account_name": f"account-{account_id}",
                "client_key_id": "",
                "client_key_name": "",
                "egress_node_name": "",
                "egress_ip": "",
                "egress_mode": "",
                "egress_scope": "",
                "status_code": 200,
                "streaming": False,
                "input_tokens": 0,
                "media_input_images": 0,
                "output_tokens": 0,
                "reasoning_tokens": 0,
                "reasoning_tokens_reported": False,
                "total_tokens": 0,
                "duration_ms": 1000,
                "tps": 10,
                "risk_level": "high",
                "risk_reasons": ["test"],
                "raw": {},
                "created_at": now,
                "fetched_at": now,
            }
        ]
    )
    repository.create_verification(
        {
            "account_id": account_id,
            "audit_upstream_id": upstream_id,
            "audit_created_at": now,
            "audit_tps": 10.0,
            "status": status,
            "sso_verdict": "skipped",
            "bot_flag": {},
            "proxy_used": False,
            "status_code": 0,
            "response_ms": 0,
            "check_error": "",
            "action_status": action_status,
            "action_error": "",
            "egress_recommendation": {},
        }
    )


def test_retryable_verification_account_ids_follow_sso_skipped_and_restore(
    tmp_path: Path,
):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = RequestAuditRepository(database)
    accounts = AccountRepository(database)

    _seed_verification(
        repository,
        upstream_id="failed",
        account_id=11,
        status="sso_skipped",
        action_status="action_failed",
    )
    _seed_verification(
        repository,
        upstream_id="protected",
        account_id=12,
        status="sso_skipped",
        action_status="task_protected",
    )
    _seed_verification(
        repository,
        upstream_id="isolation-off",
        account_id=13,
        status="sso_skipped",
        action_status="auto_quarantine_disabled",
    )
    _seed_verification(
        repository,
        upstream_id="restored",
        account_id=14,
        status="sso_skipped",
        action_status="already_quarantined",
    )
    _seed_verification(
        repository,
        upstream_id="still-isolated",
        account_id=15,
        status="sso_skipped",
        action_status="already_quarantined",
    )
    _seed_verification(
        repository,
        upstream_id="done",
        account_id=16,
        status="sso_skipped",
        action_status="disabled",
    )
    _seed_verification(
        repository,
        upstream_id="legacy-flagged",
        account_id=17,
        status="flagged",
        action_status="action_failed",
    )
    _seed_verification(
        repository,
        upstream_id="legacy-clean",
        account_id=18,
        status="clean",
        action_status="deprioritize_failed",
    )
    _seed_verification(
        repository,
        upstream_id="tps-deprioritized",
        account_id=19,
        status="sso_skipped",
        action_status="deprioritized",
    )
    _seed_verification(
        repository,
        upstream_id="tps-already-deprioritized",
        account_id=20,
        status="sso_skipped",
        action_status="already_deprioritized",
    )
    accounts.set_manual_status(
        account_id=14,
        status="healthy",
        note="probe recovered",
    )
    accounts.set_manual_status(
        account_id=15,
        status="quarantined",
        note="probe isolation still active",
    )

    retryable = repository.retryable_verification_account_ids()

    assert retryable == {11, 12, 13, 14, 17, 18, 19, 20}
    database.dispose()
