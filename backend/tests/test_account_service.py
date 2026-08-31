from __future__ import annotations

import asyncio
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

from app.analyzer import Thresholds
from app.core.clock import app_isoformat, utc_now
from app.core.config import Settings
from app.integrations.grok2api.client import (
    AccountBatchDeleteResult,
    AccountBatchUpdateResult,
    AccountUpdateFailure,
)
from app.persistence.account_repository import AccountRepository
from app.persistence.database import Database
from app.persistence.models import AccountAssessment
from app.persistence.probe_repository import ProbeRepository
from app.persistence.register_event_repository import RegisterEventRepository
from app.services.account_service import QUARANTINE_RECOVERY_PRIORITY, AccountService
from app.services.probe_manager import ProbeManager


class AccountListClient:
    async def list_accounts(self, **_: Any) -> dict[str, Any]:
        return {
            "items": [
                {
                    "id": "1",
                    "name": "Alpha",
                    "email": "alpha@example.test",
                    "enabled": True,
                    "authStatus": "active",
                    "egressNodeId": "12",
                    "egressAssignmentMode": "manual",
                },
                {
                    "id": "2",
                    "name": "Bravo",
                    "email": "bravo@example.test",
                    "enabled": True,
                    "authStatus": "active",
                    "egressNodeId": None,
                },
            ],
            "total": 2,
            "page": 1,
            "pageSize": 50,
        }

    async def list_all_accounts(self, **_: Any) -> list[dict[str, Any]]:
        return [
            {
                "id": "1",
                "name": "Alpha",
                "email": "alpha@example.test",
                "enabled": True,
                "authStatus": "active",
            },
            {
                "id": "2",
                "name": "Bravo",
                "email": "bravo@example.test",
                "enabled": False,
                "authStatus": "active",
            },
            {
                "id": "3",
                "name": "Blocked",
                "email": "blocked@example.test",
                "enabled": True,
                "authStatus": "error",
            },
        ]


class RecoveryClient:
    def __init__(self) -> None:
        self.accounts = [
            {
                "id": "1",
                "name": "Recovered",
                "email": "recovered@example.test",
                "enabled": False,
                "authStatus": "active",
                "priority": 100,
            },
            {
                "id": "2",
                "name": "Regular",
                "email": "regular@example.test",
                "enabled": True,
                "authStatus": "active",
                "priority": 100,
            },
        ]
        self.recovery_calls: list[tuple[int, int]] = []

    async def list_all_accounts(self, **_: Any) -> list[dict[str, Any]]:
        return self.accounts

    async def recover_account_at_priority(self, account_id: int, *, priority: int) -> None:
        self.recovery_calls.append((account_id, priority))
        account = next(item for item in self.accounts if int(item["id"]) == account_id)
        account["enabled"] = True
        account["priority"] = priority


class EgressClient:
    def __init__(self) -> None:
        self.nodes = [
            {
                "id": "1",
                "name": "unhealthy",
                "enabled": True,
                "proxyConfigured": True,
                "probeStatus": "unhealthy",
                "assignedAccountCount": 0,
                "accountCapacity": 0,
            },
            {
                "id": "2",
                "name": "full",
                "enabled": True,
                "proxyConfigured": True,
                "probeStatus": "healthy",
                "assignedAccountCount": 10,
                "accountCapacity": 10,
            },
            {
                "id": "3",
                "name": "busier",
                "enabled": True,
                "proxyConfigured": True,
                "probeStatus": "healthy",
                "assignedAccountCount": 5,
                "accountCapacity": 0,
            },
            {
                "id": "4",
                "name": "least-loaded",
                "enabled": True,
                "proxyConfigured": True,
                "probeStatus": "healthy",
                "assignedAccountCount": 2,
                "accountCapacity": 0,
            },
        ]
        self.bindings: list[tuple[list[int], int | None, str]] = []

    async def list_egress_nodes(self, **_: Any) -> dict[str, Any]:
        return {"items": self.nodes}

    async def set_accounts_egress(
        self,
        account_ids: list[int],
        node_id: int | None,
        *,
        mode: str,
    ) -> AccountBatchUpdateResult:
        self.bindings.append((account_ids, node_id, mode))
        return AccountBatchUpdateResult(updated=len(account_ids))

    async def get_account(self, account_id: int) -> dict[str, Any]:
        node_id = self.bindings[-1][1] if self.bindings else None
        return {
            "id": str(account_id),
            "enabled": True,
            "authStatus": "active",
            "egressNodeId": str(node_id) if node_id is not None else None,
            "egressAssignmentMode": self.bindings[-1][2] if node_id is not None else "",
        }


class LockedProbeSettings:
    def account_settings_locked_ids(self, account_ids: set[int]) -> set[int]:
        return account_ids & {2}


@pytest.mark.asyncio
async def test_account_list_marks_stored_sso_availability(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    register_events = RegisterEventRepository(database)
    register_events.receive(
        {
            "event_id": "registration:alpha:grok2api-imported",
            "email": "alpha@example.test",
            "sso": "RAW-ALPHA",
            "grok2api_account_id": 1,
        }
    )
    service = AccountService(
        settings=Settings(database_path=tmp_path / "grokiq.db"),
        client=AccountListClient(),  # type: ignore[arg-type]
        accounts=AccountRepository(database),
        probes=ProbeRepository(database),
        register_events=register_events,
    )

    result = await service.list_accounts(page=1, page_size=50)

    assert result["items"][0]["ssoAvailable"] is True
    assert result["items"][1]["ssoAvailable"] is False
    database.dispose()


class PublicSummaryClient:
    def __init__(self, payload: dict[str, Any] | Exception):
        self.payload = payload
        self.calls = 0

    async def admin_request(self, method: str, path: str, **_: Any) -> dict[str, Any]:
        self.calls += 1
        assert method == "GET"
        assert path == "/api/admin/v1/accounts/summary"
        if isinstance(self.payload, Exception):
            raise self.payload
        return self.payload


class BlockingPublicSummaryClient(PublicSummaryClient):
    def __init__(self, payload: dict[str, Any]):
        super().__init__(payload)
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def admin_request(
        self, method: str, path: str, **kwargs: Any
    ) -> dict[str, Any]:
        self.started.set()
        await self.release.wait()
        return await super().admin_request(method, path, **kwargs)


@pytest.mark.asyncio
async def test_public_upstream_summary_returns_counts_only(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    client = PublicSummaryClient(
        {
            "total": 12,
            "available": 7,
            "recovering": 3,
            "attention": 2,
            "risk": 1,
            "providers": {
                "grok_build": {"total": 8, "available": 5},
                "grok_web": {"total": 3, "available": 2},
                "grok_console": {"total": 1, "available": 0},
            },
            "recovery": {"cooldown": 1, "waitingReset": 1, "probing": 1},
            "issues": {"disabled": 1, "reauthRequired": 1},
            "token": "must-not-leak",
            "accounts": [{"id": 99, "email": "secret@example.test"}],
        }
    )
    service = AccountService(
        settings=Settings(database_path=tmp_path / "grokiq.db"),
        client=client,  # type: ignore[arg-type]
        accounts=AccountRepository(database),
        probes=ProbeRepository(database),
    )

    public = await service.public_upstream_account_summary()
    admin = await service.public_upstream_account_summary(include_inventory=True)

    assert public["reachable"] is True
    assert "total" not in public
    assert "available" not in public
    assert "recovering" not in public
    assert "attention" not in public
    assert "recovery" not in public
    assert "issues" not in public
    assert "risk" not in public
    assert public["providers"]["grok_build"] == {"total": 8, "available": 5}
    assert "token" not in public
    assert "accounts" not in public

    assert admin["reachable"] is True
    assert admin["total"] == 12
    assert admin["available"] == 7
    assert admin["recovering"] == 3
    assert admin["attention"] == 2
    assert admin["risk"] == 1
    assert admin["recovery"] == {"cooldown": 1, "waitingReset": 1, "probing": 1}
    assert admin["issues"] == {"disabled": 1, "reauthRequired": 1}
    database.dispose()


@pytest.mark.asyncio
async def test_public_upstream_summary_coalesces_concurrent_requests(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    client = BlockingPublicSummaryClient({"total": 2, "available": 1})
    service = AccountService(
        settings=Settings(database_path=tmp_path / "grokiq.db"),
        client=client,  # type: ignore[arg-type]
        accounts=AccountRepository(database),
        probes=ProbeRepository(database),
    )

    first = asyncio.create_task(service.public_upstream_account_summary())
    await client.started.wait()
    second = asyncio.create_task(service.public_upstream_account_summary())
    await asyncio.sleep(0)
    client.release.set()

    first_result, second_result = await asyncio.gather(first, second)

    assert client.calls == 1
    assert first_result == second_result
    database.dispose()


@pytest.mark.asyncio
async def test_public_upstream_summary_hides_upstream_errors(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    client = PublicSummaryClient(RuntimeError("admin jwt expired for user root"))
    service = AccountService(
        settings=Settings(database_path=tmp_path / "grokiq.db"),
        client=client,  # type: ignore[arg-type]
        accounts=AccountRepository(database),
        probes=ProbeRepository(database),
    )

    result = await service.public_upstream_account_summary()
    admin = await service.public_upstream_account_summary(include_inventory=True)

    assert result["reachable"] is False
    assert "total" not in result
    assert admin["total"] == 0
    assert "jwt" not in str(result).lower()
    assert "admin" not in str(result).lower()
    database.dispose()


@pytest.mark.asyncio
async def test_select_account_ids_applies_filters_and_excludes_auth_failures(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    accounts = AccountRepository(database)
    probes = ProbeRepository(database)
    accounts.set_manual_status(account_id=1, status="suspect", note="")
    accounts.set_manual_status(account_id=3, status="suspect", note="")
    service = AccountService(
        settings=Settings(database_path=tmp_path / "grokiq.db"),
        client=AccountListClient(),  # type: ignore[arg-type]
        accounts=accounts,
        probes=probes,
    )

    all_matching = await service.select_account_ids(search="example.test")
    assert all_matching == {
        "accountIds": [1, 2],
        "disabledAccountIds": [2],
        "matched": 3,
        "selectable": 2,
        "excluded": 1,
    }

    suspect = await service.select_account_ids(monitor_status="suspect")
    assert suspect["accountIds"] == [1]
    assert suspect["matched"] == 2
    assert suspect["excluded"] == 1


@pytest.mark.asyncio
async def test_account_options_include_egress_binding(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    service = AccountService(
        settings=Settings(database_path=tmp_path / "grokiq.db"),
        client=AccountListClient(),  # type: ignore[arg-type]
        accounts=AccountRepository(database),
        probes=ProbeRepository(database),
    )

    result = await service.list_account_options(page=1, page_size=50)

    assert result["items"][0]["egressNodeId"] == "12"
    assert result["items"][0]["egressAssignmentMode"] == "manual"
    assert result["items"][1]["egressNodeId"] is None


@pytest.mark.asyncio
async def test_webhook_account_auto_binding_uses_least_loaded_healthy_node(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    client = EgressClient()
    service = AccountService(
        settings=Settings(database_path=tmp_path / "grokiq.db"),
        client=client,  # type: ignore[arg-type]
        accounts=AccountRepository(database),
        probes=ProbeRepository(database),
    )

    result = await service.ensure_account_egress({"id": "41", "egressNodeId": None})

    assert client.bindings == [([41], 4, "manual")]
    assert result["egressNodeId"] == "4"
    assert result["egressAssignmentMode"] == "manual"

    same = await service.ensure_account_egress(result)
    assert same is result
    assert client.bindings == [([41], 4, "manual")]


@pytest.mark.asyncio
async def test_webhook_account_rebind_skips_used_healthy_nodes(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    client = EgressClient()
    service = AccountService(
        settings=Settings(database_path=tmp_path / "grokiq.db"),
        client=client,  # type: ignore[arg-type]
        accounts=AccountRepository(database),
        probes=ProbeRepository(database),
    )

    rebound = await service.rebind_account_egress(
        {"id": "41", "egressNodeId": "4"}
    )

    assert rebound is not None
    assert rebound["egressNodeId"] == "3"
    assert client.bindings == [([41], 3, "manual")]


@pytest.mark.asyncio
async def test_batch_egress_binding_skips_probe_locked_accounts(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    client = EgressClient()
    service = AccountService(
        settings=Settings(database_path=tmp_path / "grokiq.db"),
        client=client,  # type: ignore[arg-type]
        accounts=AccountRepository(database),
        probes=LockedProbeSettings(),  # type: ignore[arg-type]
    )

    result = await service.set_accounts_egress(
        account_ids=[1, 2, 3, 2],
        egress_node_id=9,
    )

    assert client.bindings == [([1, 3], 9, "manual")]
    assert result == {
        "requested": 3,
        "eligible": 2,
        "updated": 2,
        "egressNodeId": 9,
        "assignmentMode": "manual",
        "skippedAccountIds": [2],
        "failedAccountIds": [],
        "failures": [],
    }


@pytest.mark.asyncio
async def test_quarantine_recovery_uses_lowest_priority_and_exposes_guard_filter(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    accounts = AccountRepository(database)
    probes = ProbeRepository(database)
    client = RecoveryClient()
    accounts.set_manual_status(
        account_id=1,
        status="quarantined",
        note="auto quarantine",
        quarantine_until=utc_now() - timedelta(minutes=1),
        previous_upstream_enabled=True,
        disabled_by_monitor=True,
    )
    service = AccountService(
        settings=Settings(database_path=tmp_path / "grokiq.db"),
        client=client,  # type: ignore[arg-type]
        accounts=accounts,
        probes=probes,
    )

    result = await service.recover_due_quarantines()

    assert result == {
        "restored": 1,
        "guarded": 1,
        "priority": QUARANTINE_RECOVERY_PRIORITY,
        "failed": [],
    }
    assert client.recovery_calls == [(1, QUARANTINE_RECOVERY_PRIORITY)]
    stored = accounts.get_assessment(1)
    assert stored is not None
    assert stored["monitor_status"] == "healthy"
    assert stored["disabled_by_monitor"] is False
    assert stored["previous_upstream_enabled"] is None
    assert stored["recovery_guarded"] is True

    page = await service.list_accounts(
        page=1,
        page_size=50,
        recovery_guarded="true",
    )
    assert [item["id"] for item in page["items"]] == ["1"]
    assert page["items"][0]["priority"] == QUARANTINE_RECOVERY_PRIORITY
    selection = await service.select_account_ids(recovery_guarded="true")
    assert selection["accountIds"] == [1]



class IsolationClient:
    def __init__(self, accounts: list[dict[str, Any]] | None = None) -> None:
        self.accounts = {
            int(item["id"]): dict(item) for item in (accounts or [])
        }
        self.enabled_calls: list[tuple[int, bool]] = []
        self.priority_calls: list[tuple[int, int]] = []
        self.delete_calls: list[int] = []
        self.failing_delete_ids: set[int] = set()

    async def get_account(self, account_id: int) -> dict[str, Any]:
        return dict(self.accounts[account_id])

    async def get_accounts_by_ids(self, account_ids: set[int]) -> list[dict[str, Any]]:
        return [
            dict(self.accounts[account_id])
            for account_id in sorted(account_ids)
            if account_id in self.accounts
        ]

    async def set_account_enabled(self, account_id: int, enabled: bool) -> dict[str, Any]:
        self.enabled_calls.append((account_id, enabled))
        account = self.accounts[account_id]
        account["enabled"] = enabled
        return dict(account)

    async def set_account_priority(self, account_id: int, priority: int) -> dict[str, Any]:
        self.priority_calls.append((account_id, priority))
        account = self.accounts[account_id]
        account["priority"] = priority
        return dict(account)

    async def recover_account_at_priority(
        self,
        account_id: int,
        *,
        priority: int,
    ) -> dict[str, Any]:
        await self.set_account_priority(account_id, priority)
        return await self.set_account_enabled(account_id, True)

    async def delete_account(self, account_id: int) -> None:
        self.delete_calls.append(account_id)
        if account_id in self.failing_delete_ids:
            raise RuntimeError(f"delete failed for {account_id}")
        self.accounts.pop(account_id, None)

    async def delete_accounts(
        self,
        account_ids: list[int],
    ) -> AccountBatchDeleteResult:
        unique_ids = list(
            dict.fromkeys(account_id for account_id in account_ids if account_id > 0)
        )
        failures: list[AccountUpdateFailure] = []
        for account_id in unique_ids:
            try:
                await self.delete_account(account_id)
            except Exception as exc:
                failures.append(
                    AccountUpdateFailure(account_id=account_id, error=str(exc))
                )
        return AccountBatchDeleteResult(
            deleted=len(unique_ids) - len(failures),
            failures=tuple(failures),
        )


def _isolation_service(
    tmp_path: Path,
    *,
    client: IsolationClient | None = None,
    auto_isolation_enabled: bool = False,
    auto_isolation_min_status: str = "high_risk",
    auto_quarantine: bool = False,
    probes: ProbeRepository | LockedProbeSettings | None = None,
) -> tuple[
    Database,
    AccountRepository,
    ProbeRepository | LockedProbeSettings,
    IsolationClient,
    AccountService,
]:
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    accounts = AccountRepository(database)
    probe_repo = probes if probes is not None else ProbeRepository(database)
    isolation_client = client or IsolationClient(
        [
            {
                "id": "1",
                "name": "Alpha",
                "email": "alpha@example.test",
                "enabled": True,
                "authStatus": "active",
            },
            {
                "id": "2",
                "name": "Bravo",
                "email": "bravo@example.test",
                "enabled": True,
                "authStatus": "active",
            },
        ]
    )
    service = AccountService(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            auto_isolation_enabled=auto_isolation_enabled,
            auto_isolation_min_status=auto_isolation_min_status,  # type: ignore[arg-type]
            auto_quarantine=auto_quarantine,
            auto_quarantine_recovery_enabled=True,
            quarantine_minutes=30,
        ),
        client=isolation_client,  # type: ignore[arg-type]
        accounts=accounts,
        probes=probe_repo,  # type: ignore[arg-type]
    )
    return database, accounts, probe_repo, isolation_client, service


def _add_probe_sample(probes: ProbeRepository, account_id: int) -> str:
    probes.seed_defaults()
    run_id = probes.create_run(
        account_id=account_id,
        account_name="Alpha",
        account_email="alpha@example.test",
        profile_id="quality-marker",
        rounds=1,
        proxy_targets=[{"kind": "current", "id": None}],
        trigger="manual",
        priority=100,
        queue_limit=20,
    )
    probes.add_sample(
        run_id,
        {
            "round_number": 1,
            "target_key": "current",
            "target_kind": "current",
            "egress_node_id": None,
            "egress_name": "",
            "status": "done",
            "status_code": 200,
            "output_tokens": 10,
            "reasoning_tokens": 0,
            "visible_tokens": 10,
            "chunk_count": 1,
            "first_token_ms": 100,
            "duration_ms": 200,
            "generation_ms": 100,
            "first_token_share": 0.5,
            "tps": 50,
            "expected_matched": True,
            "classification": "normal",
            "severity": 0,
            "error": "",
        },
    )
    probes.finish_run(run_id)
    return run_id


@pytest.mark.asyncio
async def test_isolate_disables_upstream_and_enters_permanent_zone(tmp_path: Path):
    _database, accounts, _probes, client, service = _isolation_service(tmp_path)

    result = await service.action(
        account_id=1,
        action="isolate",
        note="manual isolate",
        propagate=True,
        quarantine_minutes=None,
    )

    assert result["status"] == "quarantined"
    assert result["propagated"] is True
    assert result["quarantineUntil"] is None
    assert client.enabled_calls == [(1, False)]
    stored = accounts.get_assessment(1)
    assert stored is not None
    assert stored["monitor_status"] == "quarantined"
    assert stored["quarantine_until"] is None
    assert stored["previous_upstream_enabled"] is True
    assert stored["disabled_by_monitor"] is True
    assert stored["recovery_guarded"] is False
    alerts = accounts.list_alerts()
    assert alerts[0]["kind"] == "manual_isolate"
    assert stored["disposition"]["source"] == "manual"
    assert stored["disposition"]["sourceLabel"] == "手动操作"
    assert stored["disposition"]["action"] == "isolate"
    assert stored["disposition"]["reason"] == "manual isolate"


@pytest.mark.asyncio
async def test_isolate_records_request_audit_disposition(tmp_path: Path):
    _database, accounts, _probes, _client, service = _isolation_service(tmp_path)

    result = await service.isolate_account(
        1,
        note="请求审计高风险已达处置阈值后自动停用",
        source="request_audit",
        detail={"riskReasons": ["高速 TPS 3 次"]},
    )

    stored = result["assessment"]
    assert stored["disposition"]["source"] == "request_audit"
    assert stored["disposition"]["sourceLabel"] == "请求审计"
    assert stored["disposition"]["action"] == "isolate"
    assert stored["disposition"]["reason"] == "请求审计高风险已达处置阈值后自动停用"
    assert stored["disposition"]["evidence"] == ["高速 TPS 3 次"]


@pytest.mark.asyncio
async def test_isolation_disposition_survives_recalculate(tmp_path: Path):
    _database, accounts, _probes, _client, service = _isolation_service(tmp_path)
    await service.isolate_account(
        1,
        note="请求审计高风险已达处置阈值后自动停用",
        source="request_audit",
        detail={"riskReasons": ["高速 TPS 3 次"]},
    )

    accounts.recalculate(1, Thresholds(), 168)
    stored = accounts.get_assessment(1)
    assert stored is not None
    assert stored["risk_reasons"] == []
    assert stored["disposition"]["source"] == "request_audit"
    assert stored["disposition"]["reason"] == "请求审计高风险已达处置阈值后自动停用"
    assert stored["disposition"]["evidence"] == ["高速 TPS 3 次"]


@pytest.mark.asyncio
async def test_legacy_isolation_note_hydrates_disposition(tmp_path: Path):
    database, accounts, _probes, _client, _service = _isolation_service(tmp_path)
    accounts.set_manual_status(
        account_id=1,
        status="quarantined",
        note="请求审计高风险已达处置阈值后自动停用",
        quarantine_until=None,
        previous_upstream_enabled=True,
        disabled_by_monitor=True,
        recovery_guarded=False,
    )
    from app.persistence.models import AccountAssessment

    with database.transaction() as session:
        assessment = session.get(AccountAssessment, 1)
        assert assessment is not None
        assessment.disposition = {}

    stored = accounts.get_assessment(1)
    assert stored is not None
    assert stored["disposition"]["source"] == "request_audit"
    assert stored["disposition"]["sourceLabel"] == "请求审计"
    assert stored["disposition"]["reason"] == "请求审计高风险已达处置阈值后自动停用"


@pytest.mark.asyncio
async def test_restore_clears_isolation_disposition(tmp_path: Path):
    _database, accounts, _probes, _client, service = _isolation_service(tmp_path)
    await service.isolate_account(
        1,
        note="请求审计高风险已达处置阈值后自动停用",
        source="request_audit",
    )
    await service.action(
        account_id=1,
        action="restore",
        note="",
        propagate=True,
        quarantine_minutes=None,
    )
    stored = accounts.get_assessment(1)
    assert stored is not None
    assert stored["monitor_status"] == "healthy"
    assert stored["disposition"] == {}


@pytest.mark.asyncio
async def test_isolation_zone_lists_only_permanent_isolations(tmp_path: Path):
    _database, accounts, _probes, client, service = _isolation_service(tmp_path)
    accounts.set_manual_status(
        account_id=1,
        status="quarantined",
        note="permanent",
        quarantine_until=None,
        previous_upstream_enabled=True,
        disabled_by_monitor=True,
        recovery_guarded=False,
    )
    accounts.set_manual_status(
        account_id=2,
        status="quarantined",
        note="timed",
        quarantine_until=utc_now() + timedelta(minutes=30),
        previous_upstream_enabled=True,
        disabled_by_monitor=True,
        recovery_guarded=False,
    )
    accounts.set_manual_status(
        account_id=99,
        status="quarantined",
        note="missing upstream",
        quarantine_until=None,
        previous_upstream_enabled=False,
        disabled_by_monitor=False,
        recovery_guarded=False,
    )

    page = await service.list_isolation_zone(page=1, page_size=50)
    ids = {int(item["id"]) for item in page["items"]}
    assert ids == {1, 99}
    assert page["total"] == 2
    missing = next(item for item in page["items"] if int(item["id"]) == 99)
    assert missing["name"] == "账号 #99"
    assert missing["enabled"] is False
    assert missing["missingUpstream"] is True
    assert missing["ssoAvailable"] is False
    present = next(item for item in page["items"] if int(item["id"]) == 1)
    assert present["name"] == "Alpha"
    assert "missingUpstream" not in present

    searched = await service.list_isolation_zone(page=1, page_size=50, search="99")
    assert searched["total"] == 1
    assert int(searched["items"][0]["id"]) == 99


@pytest.mark.asyncio
async def test_isolation_zone_operator_note_roundtrip(tmp_path: Path):
    database, accounts, _probes, _client, service = _isolation_service(tmp_path)
    accounts.set_manual_status(
        account_id=1,
        status="quarantined",
        note="permanent",
        quarantine_until=None,
        previous_upstream_enabled=True,
        disabled_by_monitor=True,
        recovery_guarded=False,
    )

    first = await service.add_operator_note(1, "  出口异常，先隔离观察  ")
    assert first["operatorNote"] == "出口异常，先隔离观察"
    assert len(first["notes"]) == 1
    first_id = first["notes"][0]["id"]
    assert first["notes"][0]["content"] == "出口异常，先隔离观察"
    assert first["notes"][0]["created_at"]

    second = await service.add_operator_note(1, "人工确认降智")
    assert [item["content"] for item in second["notes"]] == [
        "人工确认降智",
        "出口异常，先隔离观察",
    ]
    stored = accounts.get_assessment(1)
    assert stored is not None
    assert stored["operator_note"] == "人工确认降智"
    assert stored["manual_note"] == "permanent"

    page = await service.list_isolation_zone(page=1, page_size=50)
    item = next(value for value in page["items"] if int(value["id"]) == 1)
    assert [note["content"] for note in item["assessment"]["operator_notes"]] == [
        "人工确认降智",
        "出口异常，先隔离观察",
    ]

    edited = await service.update_operator_note(1, first_id, "出口异常，继续观察")
    assert [item["content"] for item in edited["notes"]] == [
        "人工确认降智",
        "出口异常，继续观察",
    ]
    edited_note = next(item for item in edited["notes"] if item["id"] == first_id)
    assert edited_note["updated_at"]

    deleted = await service.delete_operator_note(1, first_id)
    assert [item["content"] for item in deleted["notes"]] == ["人工确认降智"]
    assert deleted["operatorNote"] == "人工确认降智"

    accounts.set_manual_status(
        account_id=1,
        status="quarantined",
        note="re-isolated",
        quarantine_until=None,
        previous_upstream_enabled=True,
        disabled_by_monitor=True,
        recovery_guarded=False,
    )
    stored = accounts.get_assessment(1)
    assert stored is not None
    assert stored["manual_note"] == "re-isolated"
    assert stored["operator_note"] == "人工确认降智"

    with pytest.raises(ValueError, match="不能为空"):
        await service.add_operator_note(1, "   ")
    with pytest.raises(ValueError, match="2000"):
        await service.add_operator_note(1, "x" * 2001)
    with pytest.raises(ValueError, match="隔离区"):
        await service.add_operator_note(2, "not isolated")

    accounts.set_manual_status(
        account_id=99,
        status="quarantined",
        note="missing",
        quarantine_until=None,
        previous_upstream_enabled=False,
        disabled_by_monitor=False,
        recovery_guarded=False,
    )
    from app.persistence.models import AccountAssessment

    with database.transaction() as session:
        assessment = session.get(AccountAssessment, 99)
        assert assessment is not None
        assessment.operator_note = "旧备注"

    page = await service.list_isolation_zone(page=1, page_size=50)
    legacy = next(value for value in page["items"] if int(value["id"]) == 99)
    assert legacy["assessment"]["operator_notes"][0]["content"] == "旧备注"


@pytest.mark.asyncio
async def test_isolation_zone_note_does_not_reorder(tmp_path: Path):
    _database, accounts, _probes, _client, service = _isolation_service(tmp_path)
    accounts.set_manual_status(
        account_id=1,
        status="quarantined",
        note="first",
        quarantine_until=None,
        previous_upstream_enabled=True,
        disabled_by_monitor=True,
        recovery_guarded=False,
    )
    accounts.set_manual_status(
        account_id=99,
        status="quarantined",
        note="second",
        quarantine_until=None,
        previous_upstream_enabled=False,
        disabled_by_monitor=False,
        recovery_guarded=False,
    )

    before = [
        int(item["id"])
        for item in (await service.list_isolation_zone(page=1, page_size=50))["items"]
    ]
    assert before == [99, 1]

    await service.add_operator_note(1, "不会因为备注改排序")
    after = [
        int(item["id"])
        for item in (await service.list_isolation_zone(page=1, page_size=50))["items"]
    ]
    assert after == before


@pytest.mark.asyncio
async def test_isolation_zone_orders_by_isolated_at_newest_first(tmp_path: Path):
    database, accounts, _probes, _client, service = _isolation_service(tmp_path)
    accounts.set_manual_status(
        account_id=99,
        status="quarantined",
        note="older",
        quarantine_until=None,
        previous_upstream_enabled=False,
        disabled_by_monitor=False,
        recovery_guarded=False,
    )
    with database.transaction() as session:
        assessment = session.get(AccountAssessment, 99)
        assert assessment is not None
        payload = dict(assessment.disposition or {})
        payload["at"] = app_isoformat(utc_now() - timedelta(hours=2))
        assessment.disposition = payload
    accounts.set_manual_status(
        account_id=1,
        status="quarantined",
        note="newer",
        quarantine_until=None,
        previous_upstream_enabled=True,
        disabled_by_monitor=True,
        recovery_guarded=False,
    )

    page = await service.list_isolation_zone(page=1, page_size=50)
    assert [int(item["id"]) for item in page["items"]] == [1, 99]


@pytest.mark.asyncio
async def test_get_upstream_account_returns_live_payload(tmp_path: Path):
    _database, _accounts, _probes, client, service = _isolation_service(tmp_path)
    client.accounts[1]["priority"] = 12
    client.accounts[1]["maxConcurrent"] = 3

    found = await service.get_upstream_account(1)
    assert found["accountId"] == 1
    assert found["missingUpstream"] is False
    assert found["account"]["name"] == "Alpha"
    assert found["account"]["priority"] == 12
    assert found["account"]["maxConcurrent"] == 3
    assert "assessment" not in found["account"]

    missing = await service.get_upstream_account(99)
    assert missing == {
        "accountId": 99,
        "missingUpstream": True,
        "account": None,
    }


@pytest.mark.asyncio
async def test_isolation_zone_filters_match_account_probe_filters(tmp_path: Path):
    _database, accounts, _probes, client, service = _isolation_service(tmp_path)
    client.accounts[1]["enabled"] = False
    client.accounts[1]["egressNodeId"] = 7
    client.accounts[1]["authStatus"] = "active"
    accounts.set_manual_status(
        account_id=1,
        status="quarantined",
        note="permanent",
        quarantine_until=None,
        previous_upstream_enabled=True,
        disabled_by_monitor=True,
        recovery_guarded=False,
    )
    accounts.set_manual_status(
        account_id=99,
        status="quarantined",
        note="missing upstream",
        quarantine_until=None,
        previous_upstream_enabled=False,
        disabled_by_monitor=False,
        recovery_guarded=False,
    )

    disabled = await service.list_isolation_zone(
        page=1, page_size=50, upstream_status="disabled"
    )
    assert {int(item["id"]) for item in disabled["items"]} == {1, 99}

    missing = await service.list_isolation_zone(
        page=1, page_size=50, upstream_status="missing"
    )
    assert [int(item["id"]) for item in missing["items"]] == [99]

    active = await service.list_isolation_zone(
        page=1, page_size=50, upstream_status="active"
    )
    assert active["items"] == []

    bound = await service.list_isolation_zone(
        page=1, page_size=50, egress_node_id="7"
    )
    assert [int(item["id"]) for item in bound["items"]] == [1]

    unbound = await service.list_isolation_zone(
        page=1, page_size=50, egress_node_id="unbound"
    )
    assert [int(item["id"]) for item in unbound["items"]] == [99]

    sso_missing = await service.list_isolation_zone(
        page=1, page_size=50, sso_risk="missing"
    )
    assert {int(item["id"]) for item in sso_missing["items"]} == {1, 99}


@pytest.mark.asyncio
async def test_isolation_zone_filters_by_disposition_source(tmp_path: Path):
    _database, _accounts, _probes, _client, service = _isolation_service(tmp_path)
    await service.isolate_account(1, note="探针隔离", source="probe")
    await service.isolate_account(
        2,
        note="grok2api 请求拦截二次命中降智后停用",
        source="quality_retry",
    )

    grok2api = await service.list_isolation_zone(
        page=1, page_size=50, source="grok2api"
    )
    grokiq = await service.list_isolation_zone(
        page=1, page_size=50, source="grokiq"
    )
    probe = await service.list_isolation_zone(
        page=1, page_size=50, source="probe"
    )
    quality = await service.list_isolation_zone(
        page=1, page_size=50, source="quality_retry"
    )

    assert {int(item["id"]) for item in grok2api["items"]} == {2}
    assert {int(item["id"]) for item in grokiq["items"]} == {1}
    assert {int(item["id"]) for item in probe["items"]} == {1}
    assert {int(item["id"]) for item in quality["items"]} == {2}
    item = quality["items"][0]
    assert item["assessment"]["disposition"]["origin"] == "grok2api"
    assert item["assessment"]["disposition"]["originLabel"] == "grok2api"


@pytest.mark.asyncio
async def test_restore_reenables_when_previous_upstream_enabled(tmp_path: Path):
    _database, accounts, _probes, client, service = _isolation_service(tmp_path)

    await service.action(
        account_id=1,
        action="isolate",
        note="manual isolate",
        propagate=True,
        quarantine_minutes=None,
    )
    result = await service.action(
        account_id=1,
        action="restore",
        note="manual restore",
        propagate=True,
        quarantine_minutes=None,
    )

    assert result["status"] == "healthy"
    assert result["propagated"] is True
    assert client.enabled_calls == [(1, False), (1, True)]
    stored = accounts.get_assessment(1)
    assert stored is not None
    assert stored["monitor_status"] == "healthy"
    assert stored["disabled_by_monitor"] is False


@pytest.mark.asyncio
async def test_restore_sets_upstream_priority(tmp_path: Path):
    _database, accounts, _probes, client, service = _isolation_service(tmp_path)

    await service.action(
        account_id=1,
        action="isolate",
        note="manual isolate",
        propagate=True,
        quarantine_minutes=None,
    )
    result = await service.action(
        account_id=1,
        action="restore",
        note="manual restore",
        propagate=True,
        quarantine_minutes=None,
        priority=0,
    )

    assert result["status"] == "healthy"
    assert result["propagated"] is True
    assert client.enabled_calls == [(1, False), (1, True)]
    assert client.priority_calls == [(1, 0)]
    assert client.accounts[1]["priority"] == 0


@pytest.mark.asyncio
async def test_local_purge_deletes_assessment_samples_alerts_not_upstream(tmp_path: Path):
    _database, accounts, probes, client, service = _isolation_service(tmp_path)
    assert isinstance(probes, ProbeRepository)
    await service.action(
        account_id=1,
        action="isolate",
        note="manual isolate",
        propagate=True,
        quarantine_minutes=None,
    )
    run_id = _add_probe_sample(probes, 1)
    accounts.create_alert(
        account_id=1,
        kind="extra",
        severity="info",
        title="extra",
        detail={},
    )

    result = await service.delete_local_quarantine_records(account_ids=[1, 1, 2])

    assert result["requested"] == 2
    assert result["eligible"] == 2
    assert result["deleted"] == 2
    assert result["skippedAccountIds"] == []
    assert result["failedAccountIds"] == []
    assert accounts.get_assessment(1) is None
    assert accounts.list_alerts() == []
    assert probes.account_samples(1, page=1, page_size=25)["total"] == 0
    assert probes.get_run(run_id) is not None
    assert client.delete_calls == []


@pytest.mark.asyncio
async def test_local_purge_skips_locked_accounts(tmp_path: Path):
    _database, accounts, _probes, client, service = _isolation_service(
        tmp_path,
        probes=LockedProbeSettings(),
    )
    accounts.set_manual_status(
        account_id=2,
        status="quarantined",
        note="locked",
        quarantine_until=None,
        previous_upstream_enabled=True,
        disabled_by_monitor=True,
        recovery_guarded=False,
    )

    result = await service.delete_local_quarantine_records(account_ids=[2])

    assert result["requested"] == 1
    assert result["eligible"] == 0
    assert result["deleted"] == 0
    assert result["skippedAccountIds"] == [2]
    assert accounts.get_assessment(2) is not None
    assert client.delete_calls == []


@pytest.mark.asyncio
async def test_quarantine_upstream_delete_only_removes_isolated_accounts(tmp_path: Path):
    _database, accounts, _probes, client, service = _isolation_service(tmp_path)
    await service.action(
        account_id=1,
        action="isolate",
        note="manual isolate",
        propagate=True,
        quarantine_minutes=None,
    )

    result = await service.delete_quarantine_upstream_accounts(account_ids=[1, 1, 2])

    assert result["requested"] == 2
    assert result["eligible"] == 1
    assert result["deleted"] == 1
    assert result["skippedAccountIds"] == []
    assert result["failedAccountIds"] == []
    assert result["skippedNotQuarantinedAccountIds"] == [2]
    assert client.delete_calls == [1]
    assert 1 not in client.accounts
    assert 2 in client.accounts
    assert accounts.get_assessment(1) is not None


@pytest.mark.asyncio
async def test_quarantine_upstream_delete_skips_locked_accounts(tmp_path: Path):
    _database, accounts, _probes, client, service = _isolation_service(
        tmp_path,
        probes=LockedProbeSettings(),
    )
    accounts.set_manual_status(
        account_id=2,
        status="quarantined",
        note="locked",
        quarantine_until=None,
        previous_upstream_enabled=True,
        disabled_by_monitor=True,
        recovery_guarded=False,
    )

    result = await service.delete_quarantine_upstream_accounts(account_ids=[2])

    assert result["requested"] == 1
    assert result["eligible"] == 0
    assert result["deleted"] == 0
    assert result["skippedAccountIds"] == [2]
    assert result["failedAccountIds"] == []
    assert result["skippedNotQuarantinedAccountIds"] == []
    assert client.delete_calls == []
    assert accounts.get_assessment(2) is not None


@pytest.mark.asyncio
async def test_quarantine_upstream_delete_requires_account_ids(tmp_path: Path):
    _database, _accounts, _probes, _client, service = _isolation_service(tmp_path)

    with pytest.raises(ValueError, match="至少选择一个账号"):
        await service.delete_quarantine_upstream_accounts(account_ids=[])
    with pytest.raises(ValueError, match="至少选择一个账号"):
        await service.delete_quarantine_upstream_accounts(account_ids=[0, -1])


@pytest.mark.asyncio
async def test_quarantine_upstream_delete_records_upstream_failures(tmp_path: Path):
    _database, accounts, _probes, client, service = _isolation_service(tmp_path)
    client.failing_delete_ids.add(1)
    await service.action(
        account_id=1,
        action="isolate",
        note="manual isolate",
        propagate=True,
        quarantine_minutes=None,
    )

    result = await service.delete_quarantine_upstream_accounts(account_ids=[1])

    assert result["requested"] == 1
    assert result["eligible"] == 1
    assert result["deleted"] == 0
    assert result["failedAccountIds"] == [1]
    assert result["failures"] == [{"id": 1, "error": "delete failed for 1"}]
    assert result["skippedNotQuarantinedAccountIds"] == []
    assert client.delete_calls == [1]
    assert 1 in client.accounts
    assert accounts.get_assessment(1) is not None


@pytest.mark.asyncio
async def test_batch_isolate_skips_already_isolated_and_locked(tmp_path: Path):
    _database, accounts, _probes, client, service = _isolation_service(
        tmp_path,
        probes=LockedProbeSettings(),
    )
    accounts.set_manual_status(
        account_id=1,
        status="quarantined",
        note="already isolated",
        quarantine_until=None,
        previous_upstream_enabled=True,
        disabled_by_monitor=True,
        recovery_guarded=False,
    )

    result = await service.action_many(
        account_ids=[1, 2, 2],
        action="isolate",
        note="batch isolate",
        propagate=True,
        quarantine_minutes=None,
    )

    assert result["requested"] == 2
    assert result["eligible"] == 0
    assert result["updated"] == 0
    assert result["skippedAccountIds"] == [2]
    assert result["alreadyIsolatedAccountIds"] == [1]
    assert client.enabled_calls == []


@pytest.mark.asyncio
async def test_auto_isolation_switch_off_does_not_isolate(tmp_path: Path):
    _database, accounts, probes, client, service = _isolation_service(tmp_path)
    assert isinstance(probes, ProbeRepository)
    manager = ProbeManager(
        settings=service.settings,
        repository=probes,
        accounts=accounts,
        client=client,  # type: ignore[arg-type]
        thresholds=Thresholds(),
        account_service=service,
    )

    result = await manager._apply_auto_quarantine(  # noqa: SLF001
        1,
        {"monitor_status": "suspect", "risk_score": 60},
    )
    disabled = await service.isolate_account(
        1,
        note="auto",
        source="probe",
        automatic=True,
    )

    assert result.get("monitor_status") != "quarantined"
    assert disabled["actionStatus"] == "auto_isolation_disabled"
    assert client.enabled_calls == []
    assert accounts.get_assessment(1) is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "min_status", "expected"),
    [
        ("watch", "high_risk", False),
        ("suspect", "high_risk", False),
        ("high_risk", "high_risk", True),
        ("watch", "suspect", False),
        ("suspect", "suspect", True),
        ("high_risk", "suspect", True),
        ("watch", "watch", True),
        ("healthy", "watch", False),
    ],
)
async def test_auto_isolation_switch_on_isolates_by_min_status(
    tmp_path: Path,
    status: str,
    min_status: str,
    expected: bool,
):
    _database, accounts, probes, client, service = _isolation_service(
        tmp_path,
        auto_isolation_enabled=True,
        auto_isolation_min_status=min_status,
        auto_quarantine=True,
    )
    assert isinstance(probes, ProbeRepository)
    manager = ProbeManager(
        settings=service.settings,
        repository=probes,
        accounts=accounts,
        client=client,  # type: ignore[arg-type]
        thresholds=Thresholds(),
        account_service=service,
    )

    result = await manager._apply_auto_quarantine(  # noqa: SLF001
        1,
        {"monitor_status": status, "risk_score": 88},
    )

    if expected:
        assert result["monitor_status"] == "quarantined"
        assert result["quarantine_until"] is None
        assert result["recovery_guarded"] is False
        assert client.enabled_calls == [(1, False)]
        stored = accounts.get_assessment(1)
        assert stored is not None
        assert stored["quarantine_until"] is None
        assert stored["previous_upstream_enabled"] is True
    else:
        assert result.get("monitor_status") != "quarantined"
        assert client.enabled_calls == []
        assert accounts.get_assessment(1) is None


def test_isolation_stats_uses_register_events_and_current_zone(tmp_path: Path):
    database, accounts, _probes, _client, service = _isolation_service(tmp_path)
    register_events = RegisterEventRepository(database)
    service.register_events = register_events
    accounts.set_manual_status(
        account_id=1,
        status="quarantined",
        note="风险周期达到自动隔离区阈值",
        quarantine_until=None,
        previous_upstream_enabled=True,
        disabled_by_monitor=True,
        recovery_guarded=False,
        source="probe",
    )
    accounts.set_manual_status(
        account_id=2,
        status="quarantined",
        note="请求审计发现异常后自动停用",
        quarantine_until=None,
        previous_upstream_enabled=True,
        disabled_by_monitor=True,
        recovery_guarded=False,
        source="request_audit",
    )
    from app.core.clock import app_isoformat
    from app.persistence.models import AccountAssessment

    stale = utc_now() - timedelta(days=2)
    with database.transaction() as session:
        assessment = session.get(AccountAssessment, 2)
        assert assessment is not None
        payload = dict(assessment.disposition or {})
        payload["at"] = app_isoformat(stale)
        assessment.disposition = payload

    register_events.receive(
        {
            "event_id": "reg-1",
            "email": "alpha@example.test",
            "grok2api_account_id": 1,
        }
    )
    register_events.complete("reg-1", 1, ["run-1"])
    register_events.receive(
        {
            "event_id": "reg-2",
            "email": "bravo@example.test",
            "grok2api_account_id": 2,
        }
    )
    register_events.complete("reg-2", 2, ["run-2"])
    register_events.receive({"event_id": "reg-3", "email": "charlie@example.test"})
    register_events.fail("reg-3", "import failed")

    stats = service.isolation_stats()
    assert stats["zone"]["total"] == 2
    assert stats["zone"]["isolatedInRange"] == 1
    assert stats["registered"]["total"] == 3
    assert stats["registered"]["completed"] == 2
    assert stats["registered"]["failed"] == 1
    assert stats["registered"]["isolated"] == 2
    assert stats["registered"]["isolatedInRange"] == 1
