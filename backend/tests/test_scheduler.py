from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest

from app.analyzer import Thresholds
from app.core.config import Settings
from app.persistence.account_repository import AccountRepository
from app.persistence.database import Database
from app.persistence.probe_repository import ProbeRepository
from app.services.probe_manager import ProbeManager
from app.services.scheduler import SchedulerService


def build_repository(tmp_path: Path) -> ProbeRepository:
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = ProbeRepository(database)
    repository.seed_defaults()
    return repository


def create_plan(repository: ProbeRepository, *, account_scope: str) -> str:
    return repository.create_plan(
        {
            "name": "scheduled inspection",
            "description": "",
            "profile_id": "quality-marker",
            "profile_ids": ["quality-marker"],
            "account_scope": account_scope,
            "account_ids": [10] if account_scope == "fixed" else [],
            "proxy_targets": [{"kind": "current", "id": None}],
            "execution_mode": "chat",
            "rounds": 1,
            "cron_expression": "15 */6 * * *",
            "timezone": "UTC",
            "enabled": True,
            "overlap_policy": "fill",
            "priority": 200,
        }
    )


@pytest.mark.asyncio
async def test_quarantine_recovery_runs_when_user_plans_are_disabled(tmp_path: Path):
    repository = build_repository(tmp_path)
    create_plan(repository, account_scope="fixed")
    settings = Settings(
        database_path=tmp_path / "grokiq.db",
        scheduler_enabled=False,
    )
    scheduler = SchedulerService(
        settings=settings,
        repository=repository,
        probes=AsyncMock(),  # type: ignore[arg-type]
        recovery_callback=AsyncMock(return_value={"restored": 0, "guarded": 0}),
    )

    await scheduler.start()
    try:
        job_ids = {job.id for job in scheduler.scheduler.get_jobs()}
        assert scheduler.scheduler.running is True
        assert job_ids == {"system:quarantine-recovery"}
        assert scheduler.status()["plansEnabled"] is False
        assert scheduler.status()["systemRecoveryEnabled"] is True
    finally:
        await scheduler.stop()


@pytest.mark.asyncio
async def test_quarantine_recovery_can_be_disabled_independently(tmp_path: Path):
    repository = build_repository(tmp_path)
    plan_id = create_plan(repository, account_scope="fixed")
    settings = Settings(
        database_path=tmp_path / "grokiq.db",
        scheduler_enabled=True,
        quarantine_recovery_enabled=False,
    )
    scheduler = SchedulerService(
        settings=settings,
        repository=repository,
        probes=AsyncMock(),  # type: ignore[arg-type]
        recovery_callback=AsyncMock(return_value={"restored": 0, "guarded": 0}),
    )

    await scheduler.start()
    try:
        job_ids = {job.id for job in scheduler.scheduler.get_jobs()}
        assert job_ids == {f"plan:{plan_id}"}
        assert scheduler.status()["plansEnabled"] is True
        assert scheduler.status()["systemRecoveryEnabled"] is False
        assert scheduler.status()["systemJobs"] == []
    finally:
        await scheduler.stop()


@pytest.mark.asyncio
async def test_quality_retry_isolation_runs_when_user_plans_are_disabled(
    tmp_path: Path,
):
    repository = build_repository(tmp_path)
    create_plan(repository, account_scope="fixed")
    settings = Settings(
        database_path=tmp_path / "grokiq.db",
        scheduler_enabled=False,
        quality_retry_isolation_enabled=True,
    )
    scheduler = SchedulerService(
        settings=settings,
        repository=repository,
        probes=AsyncMock(),  # type: ignore[arg-type]
        recovery_callback=AsyncMock(return_value={"restored": 0, "guarded": 0}),
        quality_retry_callback=AsyncMock(
            return_value={"ok": True, "isolated": 0}
        ),
    )

    await scheduler.start()
    try:
        job_ids = {job.id for job in scheduler.scheduler.get_jobs()}
        assert "system:quality-retry-isolation" in job_ids
        assert "system:quarantine-recovery" in job_ids
        assert all(not job_id.startswith("plan:") for job_id in job_ids)
        assert scheduler.status()["plansEnabled"] is False
        assert scheduler.status()["qualityRetryIsolationEnabled"] is True
    finally:
        await scheduler.stop()


class DynamicAccountClient:
    async def list_all_accounts(self) -> list[dict[str, Any]]:
        return [
            {
                "id": "10",
                "name": "enabled-bound",
                "email": "enabled@example.test",
                "enabled": True,
                "authStatus": "active",
                "egressNodeId": "7",
            },
            {
                "id": "11",
                "name": "disabled",
                "email": "disabled@example.test",
                "enabled": False,
                "authStatus": "active",
                "egressNodeId": "7",
            },
            {
                "id": "12",
                "name": "enabled-unbound",
                "email": "unbound@example.test",
                "enabled": True,
                "authStatus": "active",
                "egressNodeId": None,
            },
        ]


@pytest.mark.asyncio
async def test_all_enabled_scope_resolves_live_accounts_at_trigger_time(tmp_path: Path):
    repository = build_repository(tmp_path)
    plan_id = create_plan(repository, account_scope="all_enabled")
    manager = ProbeManager(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            scheduled_probe_register_cooldown_minutes=0,
        ),
        repository=repository,
        accounts=AccountRepository(repository.database),
        client=DynamicAccountClient(),  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )

    result = await manager.enqueue_plan(repository.get_plan(plan_id) or {})

    assert result["accountScope"] == "all_enabled"
    assert result["resolvedAccountCount"] == 2
    assert result["created"] == 1
    assert result["invalidAccounts"] == [
        {"id": 12, "reason": "账号 12 未绑定固定出口；请先在 grok2api 绑定账号出口"}
    ]
    runs = repository.list_runs(page=1, page_size=20)["items"]
    assert [run["account_id"] for run in runs] == [10]


def test_recent_register_probe_is_excluded_from_scheduled_plan(tmp_path: Path):
    repository = build_repository(tmp_path)
    plan_id = create_plan(repository, account_scope="fixed")
    account = {
        "id": 10,
        "name": "new-account",
        "email": "new@example.test",
    }
    register = repository.create_register_runs(
        source_event_id="registration-10",
        account=account,
        profile_ids=["quality-marker"],
        rounds=1,
        proxy_targets=[{"kind": "current", "id": None}],
        execution_mode="chat",
        priority=150,
        queue_limit=20,
    )
    claimed = repository.claim_next("register-worker")
    assert claimed is not None
    repository.finish_run(register["runIds"][0])

    result = repository.create_plan_runs_batch(
        plan_id=plan_id,
        accounts=[account],
        profile_ids=["quality-marker"],
        execution_mode="chat",
        rounds=1,
        proxy_targets=[{"kind": "current", "id": None}],
        priority=200,
        queue_limit=20,
        register_cooldown_minutes=360,
    )

    assert result["runIds"] == []
    assert result["registerCooldownAccountIds"] == [10]
