from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from unittest.mock import MagicMock

from app.core.clock import utc_now
from app.core.config import Settings
from app.persistence.account_repository import AccountRepository
from app.persistence.database import Database
from app.persistence.request_audit_repository import RequestAuditRepository
from app.services.request_audit_service import RequestAuditService

from tests.test_request_audit_sso_recheck import _seed_verification


def build_service() -> RequestAuditService:
    return RequestAuditService(
        settings=Settings(_env_file=None),
        client=MagicMock(),
        repository=MagicMock(),
    )


def _row(*, upstream_id: str, tps: float, account_id: int = 5976) -> dict[str, object]:
    return {
        "upstream_id": upstream_id,
        "account_id": account_id,
        "account_name": "chiyaowang601753@outlook.com",
        "status_code": 200,
        "error_code": "",
        "output_tokens": 200,
        "reasoning_tokens": 20,
        "reasoning_tokens_reported": True,
        "first_token_ms": 100,
        "duration_ms": 1100,
        "tps": tps,
        "model_upstream_model": "Build/grok-4.6",
        "model_public_id": "grok-4.6",
        "operation": "responses",
        "media_input_images": 0,
        "created_at": utc_now(),
    }


def test_window_verifications_ignore_disable_from_other_audits():
    service = build_service()
    service.repository.verifications_for_audits.return_value = {
        "51740": {
            "account_id": 5976,
            "audit_upstream_id": "51740",
            "action_status": "disabled",
        }
    }
    records = [_row(upstream_id="64428", tps=155.7)]
    assert service._window_account_verifications(records) == {}


def test_window_verifications_keep_current_window_disable():
    service = build_service()
    current = {
        "account_id": 5976,
        "audit_upstream_id": "64428",
        "action_status": "disabled",
        "checked_at": utc_now(),
    }
    service.repository.verifications_for_audits.return_value = {"64428": current}
    records = [_row(upstream_id="64428", tps=155.7)]
    assert service._window_account_verifications(records)[5976]["action_status"] == "disabled"


def test_stale_disable_shows_restored_when_account_is_healthy():
    service = build_service()
    payload = service._account_payload(
        [_row(upstream_id="51740", tps=86.1)],
        assessment={"monitor_status": "healthy"},
        upstream_account={"enabled": True, "authStatus": "active"},
        verification={
            "audit_upstream_id": "51740",
            "status": "sso_skipped",
            "action_status": "disabled",
            "checked_at": utc_now() - timedelta(days=2),
        },
    )
    assert payload["riskLevel"] in {"watch", "normal", "high"}
    assert payload["preDisableCheck"]["actionStatus"] == "restored"


def test_disable_still_shows_when_account_is_quarantined():
    service = build_service()
    payload = service._account_payload(
        [_row(upstream_id="51740", tps=86.1)],
        assessment={"monitor_status": "quarantined"},
        upstream_account={"enabled": False, "authStatus": "active"},
        verification={
            "audit_upstream_id": "51740",
            "status": "sso_skipped",
            "action_status": "disabled",
            "checked_at": utc_now() - timedelta(days=2),
        },
    )
    assert payload["preDisableCheck"]["actionStatus"] == "disabled"


def test_manual_restore_clears_request_audit_disable(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = RequestAuditRepository(database)
    accounts = AccountRepository(database)
    _seed_verification(
        repository,
        upstream_id="51740",
        account_id=5976,
        status="sso_skipped",
        action_status="disabled",
    )
    _seed_verification(
        repository,
        upstream_id="retry",
        account_id=5977,
        status="sso_skipped",
        action_status="already_quarantined",
    )
    accounts.set_manual_status(account_id=5977, status="healthy", note="probe recovered")

    assert 5977 in repository.retryable_verification_account_ids()
    updated = repository.mark_actions_restored(5976)
    retry_cleared = repository.mark_actions_restored(5977)

    latest = repository.latest_verifications_for_accounts([5976, 5977])
    assert updated == 1
    assert retry_cleared == 1
    assert latest[5976]["action_status"] == "restored"
    assert latest[5977]["action_status"] == "restored"
    assert repository.retryable_verification_account_ids() == set()
    database.dispose()
