from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import delete, inspect

from app.analyzer import Thresholds
from app.core.clock import to_app_timezone, utc_now
from app.core.config import Settings
from app.integrations.grok2api.client import ChatProbeResult, IntegrationError, model_account_bind_window_message
from app.persistence.account_repository import (
    ALL_EGRESS_RISK_MIGRATION_KEY,
    FIXED_EGRESS_RISK_MIGRATION_KEY,
    AccountRepository,
)
from app.persistence.database import Database
from app.persistence.models import AppSetting, MetadataRow, ProbeDurationEstimate, ProbeRun
from app.persistence.probe_repository import (
    PROBE_DURATION_ESTIMATE_BACKFILL_KEY,
    SAFE_CURRENT_EGRESS_MIGRATION_KEY,
    ProbeRepository,
    QueueFullError,
    RunStateError,
)
from app.services.account_service import AccountService
from app.services.probe_manager import ProbeManager
from app.services.probe_run_executor import ProbeRunExecutor
from app.services.probe_runtime import WorkerRuntime
from tests.test_account_service import EgressClient


@pytest.fixture
def repository(tmp_path: Path) -> ProbeRepository:
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    value = ProbeRepository(database)
    value.seed_defaults()
    return value


def create_run(
    repository: ProbeRepository,
    account_id: int = 10,
    *,
    account_name: str | None = None,
    account_email: str = "",
    account_created_at=None,
) -> str:
    return repository.create_run(
        account_id=account_id,
        account_name=account_name or f"account-{account_id}",
        account_email=account_email,
        account_created_at=account_created_at,
        profile_id="quality-marker",
        rounds=1,
        proxy_targets=[{"kind": "direct", "id": None, "name": "直连"}],
        trigger="manual",
        priority=100,
        queue_limit=20,
    )


def test_register_runs_use_per_profile_rounds(repository: ProbeRepository):
    result = repository.create_register_runs(
        source_event_id="registration-10",
        account={
            "id": 10,
            "name": "new-account",
            "email": "new@example.test",
        },
        profile_ids=["quality-marker", "reasoning-check"],
        rounds={"quality-marker": 1, "reasoning-check": 4},
        proxy_targets=[{"kind": "current", "id": None}],
        execution_mode="chat",
        priority=150,
        queue_limit=20,
    )

    assert result["created"] == 2
    runs = repository.list_runs(page=1, page_size=20)["items"]
    assert {run["profile_id"]: run["rounds"] for run in runs} == {
        "quality-marker": 1,
        "reasoning-check": 4,
    }
    assert {run["profile_id"]: run["total_steps"] for run in runs} == {
        "quality-marker": 1,
        "reasoning-check": 4,
    }


def test_register_runs_are_claimed_in_profile_order(repository: ProbeRepository):
    result = repository.create_register_runs(
        source_event_id="registration-order",
        account={
            "id": 10,
            "name": "new-account",
            "email": "new@example.test",
        },
        profile_ids=["reasoning-check", "quality-marker"],
        rounds={"reasoning-check": 1, "quality-marker": 1},
        proxy_targets=[{"kind": "current", "id": None}],
        execution_mode="chat",
        priority=150,
        queue_limit=20,
    )

    assert result["created"] == 2
    assert result["profileIds"] == ["reasoning-check", "quality-marker"]
    runs_by_id = {
        run["id"]: run
        for run in repository.list_runs(page=1, page_size=20)["items"]
    }
    assert [runs_by_id[run_id]["profile_id"] for run_id in result["runIds"]] == [
        "reasoning-check",
        "quality-marker",
    ]

    first = repository.claim_next("worker-1")
    assert first is not None
    assert first.run["profile_id"] == "reasoning-check"
    assert repository.claim_next("worker-2") is None

    repository.finish_run(first.run["id"])
    second = repository.claim_next("worker-2")
    assert second is not None
    assert second.run["profile_id"] == "quality-marker"


def test_worker_queue_stats_include_oldest_wait(repository: ProbeRepository):
    run_id = create_run(repository)
    with repository.database.transaction() as session:
        run = session.get(ProbeRun, run_id)
        assert run is not None
        run.queued_at = utc_now() - timedelta(seconds=75)

    stats = repository.worker_queue_stats()

    assert stats["oldestQueueWaitSeconds"] >= 74


async def wait_for_terminal_run(
    repository: ProbeRepository,
    run_id: str,
) -> dict[str, Any]:
    detail: dict[str, Any] | None = None
    for _ in range(150):
        detail = repository.run_detail(run_id)
        if detail and detail["run"]["status"] in {
            "completed",
            "completed_with_errors",
            "failed",
            "cancelled",
        }:
            return detail
        await asyncio.sleep(0.02)
    raise AssertionError(f"run {run_id} did not become terminal: {detail}")


def test_monitor_schema_does_not_copy_upstream_account_or_egress_tables(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    tables = set(inspect(database.engine).get_table_names())
    assessment_columns = {
        value["name"] for value in inspect(database.engine).get_columns("account_assessments")
    }
    assert "account_assessments" in tables
    assert "recovery_guarded" in assessment_columns
    assert "probe_runs" in tables
    probe_run_columns = {
        value["name"] for value in inspect(database.engine).get_columns("probe_runs")
    }
    assert "account_created_at" in probe_run_columns
    assert "probe_duration_estimates" in tables
    assert "sso_reports" in tables
    register_event_columns = {
        value["name"]
        for value in inspect(database.engine).get_columns("register_webhook_events")
    }
    assert {"sso", "sso_received_at"} <= register_event_columns
    register_event_indexes = {
        value["name"]
        for value in inspect(database.engine).get_indexes("register_webhook_events")
    }
    assert {
        "ix_register_webhook_resolved_sso_received",
        "ix_register_webhook_upstream_sso_received",
    } <= register_event_indexes
    assert "register_callback_deliveries" in tables
    callback_columns = {
        value["name"]
        for value in inspect(database.engine).get_columns("register_callback_deliveries")
    }
    assert {"event_id", "status", "payload", "next_attempt_at"} <= callback_columns
    sso_report_columns = {
        value["name"] for value in inspect(database.engine).get_columns("sso_reports")
    }
    assert {"concurrency", "request_timeout_seconds"} <= sso_report_columns
    assert "monitored_accounts" not in tables
    assert "account_snapshots" not in tables
    assert "egress_mirrors" not in tables
    assert "egress_snapshots" not in tables


def test_account_risk_uses_all_period_egress_samples(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = ProbeRepository(database)
    repository.seed_defaults()

    def add_anomaly(target: dict[str, Any], round_number: int) -> None:
        run_id = repository.create_run(
            account_id=10,
            account_name="account-10",
            account_email="",
            profile_id="quality-marker",
            rounds=3,
            proxy_targets=[target],
            trigger="manual",
            priority=100,
            queue_limit=20,
        )
        repository.add_sample(
            run_id,
            {
                "round_number": round_number,
                "target_key": (
                    "current"
                    if target["kind"] == "current"
                    else f"egress:{target['id']}"
                ),
                "target_kind": target["kind"],
                "egress_node_id": target.get("id") or 7,
                "egress_name": "test",
                "status": "done",
                "status_code": 200,
                "output_tokens": 100,
                "reasoning_tokens": 0,
                "visible_tokens": 100,
                "chunk_count": 2,
                "first_token_ms": 1000,
                "duration_ms": 1100,
                "generation_ms": 100,
                "first_token_share": 0.9,
                "tps": 1000,
                "expected_matched": True,
                "classification": "buffered_hard",
                "severity": 2,
                "error": "",
            },
        )
        repository.finish_run(run_id)

    for round_number in range(1, 4):
        add_anomaly(
            {"kind": "egress", "id": round_number, "name": f"诊断出口 {round_number}"},
            round_number,
        )

    accounts = AccountRepository(database)
    diagnostic_only = accounts.recalculate(10, Thresholds(), 168)
    assert diagnostic_only["monitor_status"] == "high_risk"
    assert diagnostic_only["risk_score"] >= 75
    assert diagnostic_only["sample_count"] == 3
    assert diagnostic_only["anomaly_count"] == 3
    assert diagnostic_only["distinct_egress_count"] == 3

    for round_number in range(1, 4):
        add_anomaly(
            {"kind": "current", "id": None, "name": "账号当前出口"},
            round_number,
        )

    fixed_egress = accounts.recalculate(10, Thresholds(), 168)
    assert fixed_egress["monitor_status"] == "high_risk"
    assert fixed_egress["risk_score"] >= 75
    assert fixed_egress["sample_count"] == 6
    assert fixed_egress["anomaly_count"] == 6
    assert fixed_egress["distinct_egress_count"] == 4


def test_fixed_egress_formula_migration_recalculates_existing_assessments_once(
    tmp_path: Path,
):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    accounts = AccountRepository(database)
    accounts.set_manual_status(account_id=10, status="high_risk", note="legacy")
    with database.transaction() as session:
        session.add(AppSetting(key="cross_egress_min", value=2))

    assert accounts.migrate_fixed_egress_risk_formula(Thresholds(), 168) == 1
    migrated = accounts.get_assessment(10)
    assert migrated is not None
    assert migrated["monitor_status"] == "healthy"
    assert migrated["risk_score"] == 0

    assert accounts.migrate_fixed_egress_risk_formula(Thresholds(), 168) == 0
    with database.session() as session:
        assert session.get(MetadataRow, FIXED_EGRESS_RISK_MIGRATION_KEY) is not None
        assert session.get(AppSetting, "cross_egress_min") is None


def test_all_egress_formula_migration_recalculates_existing_samples_once(
    tmp_path: Path,
):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    probes = ProbeRepository(database)
    probes.seed_defaults()
    run_id = probes.create_run(
        account_id=10,
        account_name="account-10",
        account_email="",
        profile_id="quality-marker",
        rounds=1,
        proxy_targets=[{"kind": "egress", "id": 7, "name": "诊断出口"}],
        trigger="manual",
        priority=100,
        queue_limit=20,
    )
    probes.add_sample(
        run_id,
        {
            "round_number": 1,
            "target_key": "egress:7",
            "target_kind": "egress",
            "egress_node_id": 7,
            "egress_name": "诊断出口",
            "status": "done",
            "status_code": 200,
            "output_tokens": 100,
            "reasoning_tokens": 0,
            "visible_tokens": 100,
            "chunk_count": 2,
            "first_token_ms": 1000,
            "duration_ms": 1100,
            "generation_ms": 100,
            "first_token_share": 0.9,
            "tps": 1000,
            "expected_matched": True,
            "classification": "buffered_hard",
            "severity": 2,
            "error": "",
        },
    )
    probes.finish_run(run_id)
    accounts = AccountRepository(database)

    assert accounts.migrate_all_egress_risk_formula(Thresholds(), 168) == 1
    migrated = accounts.get_assessment(10)
    assert migrated is not None
    assert migrated["sample_count"] == 1
    assert migrated["anomaly_count"] == 1

    assert accounts.migrate_all_egress_risk_formula(Thresholds(), 168) == 0
    with database.session() as session:
        assert session.get(MetadataRow, ALL_EGRESS_RISK_MIGRATION_KEY) is not None


def test_recalculate_all_uses_new_formula_for_existing_samples(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    probes = ProbeRepository(database)
    probes.seed_defaults()
    run_id = probes.create_run(
        account_id=10,
        account_name="account-10",
        account_email="",
        profile_id="quality-marker",
        rounds=1,
        proxy_targets=[
            {"kind": "current", "id": None, "name": "账号当前出口"}
        ],
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
            "egress_node_id": 7,
            "egress_name": "test",
            "status": "done",
            "status_code": 200,
            "output_tokens": 1000,
            "reasoning_tokens": 0,
            "visible_tokens": 1000,
            "chunk_count": 2,
            "first_token_ms": 1000,
            "duration_ms": 2000,
            "generation_ms": 1000,
            "first_token_share": 0.5,
            "tps": 1000,
            "expected_matched": True,
            "classification": "fast_risk",
            "severity": 4,
            "error": "",
        },
    )
    probes.finish_run(run_id)
    accounts = AccountRepository(database)

    assert accounts.recalculate_all(
        Thresholds(risk_watch_floor=5, risk_fast_weight=1, risk_fast_cap=1),
        168,
    ) == 1
    first = accounts.get_assessment(10)
    assert first is not None
    assert first["risk_score"] == 40

    assert accounts.recalculate_all(
        Thresholds(
            risk_anomaly_rate_weight=0,
            risk_hard_weight=0,
            risk_fast_weight=0,
            risk_marker_miss_weight=0,
            risk_streak_weight=0,
            risk_watch_floor=5,
        ),
        168,
    ) == 1
    second = accounts.get_assessment(10)
    assert second is not None
    assert second["risk_score"] == 5


def test_probe_recalculation_preserves_registration_risk(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    accounts = AccountRepository(database)
    accounts.mark_registration_risk(
        account_id=10,
        bfs="high",
        registration_id="registration-10",
    )

    result = accounts.recalculate(10, Thresholds(), 168)

    assert result["monitor_status"] == "high_risk"
    assert result["risk_score"] >= 85
    assert any("grok-register" in reason for reason in result["risk_reasons"])

    capped = accounts.recalculate(
        10,
        Thresholds(risk_score_cap=70, risk_high_floor=70),
        168,
    )
    assert capped["monitor_status"] == "high_risk"
    assert capped["risk_score"] == 70


def test_same_account_runs_are_claimed_serially(repository: ProbeRepository):
    first = create_run(repository)
    second = create_run(repository)

    claimed = repository.claim_next("worker-1")
    assert claimed and claimed.run["id"] == first
    assert repository.claim_next("worker-2") is None

    repository.finish_run(first)
    claimed = repository.claim_next("worker-2")
    assert claimed and claimed.run["id"] == second


def test_queued_run_can_be_cancelled_then_deleted(repository: ProbeRepository):
    run_id = create_run(repository)
    assert repository.request_cancel(run_id) == "cancelled"
    assert repository.delete_run(run_id) == 10
    assert repository.run_detail(run_id) is None


def test_terminal_runs_can_be_deleted_in_bulk(repository: ProbeRepository):
    first = create_run(repository, account_id=11)
    second = create_run(repository, account_id=12)
    repository.request_cancel(first)
    repository.request_cancel(second)

    deleted, account_ids, skipped = repository.delete_runs([first, second])

    assert deleted == 2
    assert account_ids == {11, 12}
    assert skipped == []
    assert repository.run_detail(first) is None
    assert repository.run_detail(second) is None


def test_manual_batch_creates_many_runs_and_skips_active_accounts(repository: ProbeRepository):
    accounts = [
        {"id": 11, "name": "alpha", "email": "alpha@example.test"},
        {"id": 12, "name": "bravo", "email": "bravo@example.test"},
    ]
    created = repository.create_manual_runs_batch(
        accounts=accounts,
        profile_id="quality-marker",
        rounds=3,
        proxy_targets=[{"kind": "direct", "id": None, "name": "上游调度"}],
        execution_mode="chat",
        priority=100,
        queue_limit=20,
    )
    assert created["createdAccountIds"] == [11, 12]
    assert len(created["runIds"]) == 2

    repeated = repository.create_manual_runs_batch(
        accounts=accounts,
        profile_id="quality-marker",
        rounds=3,
        proxy_targets=[{"kind": "direct", "id": None, "name": "上游调度"}],
        execution_mode="chat",
        priority=100,
        queue_limit=20,
    )
    assert repeated["createdAccountIds"] == []
    assert repeated["activeAccountIds"] == [11, 12]
    assert repository.list_runs(page=1, page_size=20)["total"] == 2


def test_list_runs_reports_active_count(repository: ProbeRepository):
    active = create_run(repository, account_id=21)
    terminal_run = create_run(repository, account_id=22)
    repository.request_cancel(terminal_run)

    result = repository.list_runs(page=1, page_size=20)

    assert result["total"] == 2
    assert result["activeCount"] == 1
    repository.request_cancel(active)


def test_preview_samples_for_runs_omit_empty_text_and_response_body(
    repository: ProbeRepository,
):
    first = create_run(repository, account_id=41)
    second = create_run(repository, account_id=42)
    sample_values = {
        "target_key": "direct",
        "target_kind": "direct",
        "status": "done",
        "classification": "normal",
    }
    repository.add_sample(
        first,
        {
            **sample_values,
            "round_number": 1,
            "egress_name": "直连",
            "response_text": "第一轮正文",
        },
    )
    repository.add_sample(
        first,
        {
            **sample_values,
            "round_number": 2,
            "target_key": "direct-2",
            "egress_name": "节点A",
            "response_text": "第二轮正文",
        },
    )
    repository.add_sample(
        second,
        {
            **sample_values,
            "round_number": 1,
            "response_text": "   ",
        },
    )
    items = repository.preview_samples_for_runs([second, first, first])
    assert [item["run_id"] for item in items] == [first, first]
    assert [item["round_number"] for item in items] == [1, 2]
    assert items[0]["egress_name"] == "直连"
    assert "response_text" not in items[0]
    assert "reasoning_text" not in items[0]
    detail = repository.run_detail(first)
    assert detail is not None
    assert detail["samples"][0]["response_text"] == "第一轮正文"


def test_duration_estimate_backfills_once_then_updates_incrementally(
    repository: ProbeRepository,
):
    historical_run_id = create_run(repository, account_id=31)
    assert repository.claim_next("worker-history") is not None
    repository.add_sample(
        historical_run_id,
        {
            "round_number": 1,
            "target_key": "direct",
            "target_kind": "direct",
            "status": "done",
            "duration_ms": 1_500,
            "classification": "normal",
        },
    )
    repository.finish_run(historical_run_id)

    with repository.database.transaction() as session:
        session.execute(delete(ProbeDurationEstimate))
        session.execute(delete(MetadataRow).where(MetadataRow.key == PROBE_DURATION_ESTIMATE_BACKFILL_KEY))
    repository.seed_defaults()

    pending_run_id = repository.create_run(
        account_id=32,
        account_name="account-32",
        account_email="",
        profile_id="quality-marker",
        rounds=2,
        proxy_targets=[
            {"kind": "direct", "id": None, "name": "直连"},
            {"kind": "egress", "id": 7, "name": "出口 7"},
        ],
        trigger="manual",
        priority=100,
        queue_limit=20,
    )
    pending = repository.run_detail(pending_run_id)
    assert pending is not None
    estimate = pending["run"]["duration_estimate"]
    assert estimate["average_sample_ms"] == 1_500
    assert estimate["estimated_total_ms"] == 6_000
    assert estimate["estimated_remaining_ms"] == 6_000
    assert estimate["sample_count"] == 1
    assert estimate["updated_at"] is not None

    claimed = repository.claim_next("worker-current")
    assert claimed is not None and claimed.run["id"] == pending_run_id
    repository.add_sample(
        pending_run_id,
        {
            "round_number": 1,
            "target_key": "direct",
            "target_kind": "direct",
            "status": "done",
            "duration_ms": 2_500,
            "classification": "normal",
        },
    )
    running = repository.run_detail(pending_run_id)
    assert running is not None
    estimate = running["run"]["duration_estimate"]
    assert estimate["average_sample_ms"] == 2_000
    assert estimate["estimated_total_ms"] == 8_000
    assert estimate["estimated_remaining_ms"] == 6_000
    assert estimate["sample_count"] == 2


def test_manual_batch_capacity_failure_does_not_partially_create(repository: ProbeRepository):
    create_run(repository, account_id=99)
    with pytest.raises(QueueFullError, match="本次未创建任务"):
        repository.create_manual_runs_batch(
            accounts=[
                {"id": 21, "name": "charlie", "email": ""},
                {"id": 22, "name": "delta", "email": ""},
            ],
            profile_id="quality-marker",
            rounds=1,
            proxy_targets=[{"kind": "direct", "id": None, "name": "上游调度"}],
            execution_mode="chat",
            priority=100,
            queue_limit=2,
        )
    assert repository.list_runs(page=1, page_size=20)["total"] == 1


def test_legacy_direct_only_plans_and_queued_runs_migrate_to_current_egress(
    repository: ProbeRepository,
):
    plan_id = repository.create_plan(
        {
            "name": "legacy-normal-check",
            "description": "",
            "profile_id": "quality-marker",
            "profile_ids": ["quality-marker"],
            "account_ids": [10],
            "proxy_targets": [{"kind": "direct", "id": None}],
            "execution_mode": "chat",
            "rounds": 1,
            "cron_expression": "15 */6 * * *",
            "timezone": "UTC",
            "enabled": True,
            "overlap_policy": "skip",
            "priority": 200,
        }
    )
    queued_run_id = create_run(repository, account_id=10)
    historical_run_id = create_run(repository, account_id=11)
    repository.request_cancel(historical_run_id)
    with repository.database.transaction() as session:
        session.execute(delete(MetadataRow).where(MetadataRow.key == SAFE_CURRENT_EGRESS_MIGRATION_KEY))

    repository.seed_defaults()

    assert repository.get_plan(plan_id)["proxy_targets"] == [
        {"kind": "current", "id": None, "name": "账号当前出口"}
    ]
    assert repository.get_run(queued_run_id)["proxy_targets"] == [
        {"kind": "current", "id": None, "name": "账号当前出口"}
    ]
    assert repository.get_run(historical_run_id)["proxy_targets"][0]["kind"] == "direct"


def test_runs_can_be_searched_by_account_name_email_or_id(repository: ProbeRepository):
    create_run(
        repository,
        account_id=301,
        account_name="Alpha Account",
        account_email="alpha@example.test",
    )
    create_run(
        repository,
        account_id=302,
        account_name="Bravo Account",
        account_email="bravo@example.test",
    )

    assert repository.list_runs(page=1, page_size=20, search="bravo")["total"] == 1
    assert repository.list_runs(page=1, page_size=20, search="EXAMPLE.TEST")["total"] == 2
    result = repository.list_runs(page=1, page_size=20, search="301")
    assert result["total"] == 1
    assert result["items"][0]["account_id"] == 301


def test_runs_can_be_filtered_by_indexed_creation_range(repository: ProbeRepository):
    old_run_id = create_run(repository, account_id=311)
    recent_run_id = create_run(repository, account_id=312)
    now = utc_now().replace(microsecond=0)
    with repository.database.transaction() as session:
        session.get(ProbeRun, old_run_id).created_at = now - timedelta(days=2)  # type: ignore[union-attr]
        session.get(ProbeRun, recent_run_id).created_at = now  # type: ignore[union-attr]

    result = repository.list_runs(
        page=1,
        page_size=20,
        created_from=now - timedelta(hours=1),
        created_to=now + timedelta(hours=1),
    )
    selection = repository.select_run_ids(
        created_from=now - timedelta(hours=1),
        created_to=now + timedelta(hours=1),
    )

    assert result["total"] == 1
    assert result["items"][0]["id"] == recent_run_id
    assert [item["id"] for item in selection["items"]] == [recent_run_id]


def test_runs_store_and_backfill_account_created_at(repository: ProbeRepository):
    created_at = utc_now().replace(microsecond=0)
    expected = to_app_timezone(created_at)
    run_id = create_run(repository, account_id=401, account_created_at=created_at)
    missing_id = create_run(repository, account_id=402)

    stored = repository.get_run(run_id)
    assert stored["account_created_at"] == expected
    assert repository.get_run(missing_id)["account_created_at"] is None

    repository.persist_account_created_at({401: created_at, 402: created_at})
    assert repository.get_run(missing_id)["account_created_at"] == expected
    assert repository.list_runs(page=1, page_size=20, search="401")["items"][0][
        "account_created_at"
    ] == expected


@pytest.mark.asyncio
async def test_register_probe_switches_egress_after_degradation(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = ProbeRepository(database)
    repository.seed_defaults()
    account_client = EgressClient()
    account_service = AccountService(
        settings=Settings(database_path=tmp_path / "grokiq.db"),
        client=account_client,  # type: ignore[arg-type]
        accounts=AccountRepository(database),
        probes=repository,
    )
    probe_client = FakeGrokClient()
    probe_client.account_egress_node_id = 4
    manager = ProbeManager(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            scheduler_enabled=False,
            register_probe_switch_on_degradation=True,
        ),
        repository=repository,
        accounts=AccountRepository(database),
        client=probe_client,  # type: ignore[arg-type]
        thresholds=Thresholds(),
        account_service=account_service,
    )
    run_id = repository.create_run(
        account_id=41,
        account_name="register-account",
        account_email="register@example.test",
        profile_id="quality-marker",
        rounds=1,
        proxy_targets=[{"kind": "current", "id": None}],
        trigger="register",
        priority=100,
        queue_limit=20,
        source_event_id="event-switch",
    )
    with repository.database.transaction() as session:
        run = session.get(ProbeRun, run_id)
        assert run is not None
        run.original_egress_node_id = 4
        run.status = "completed"
        run.summary = {"anomaly_count": 1}
        run.completed_at = utc_now()
    account_client.bindings.append(([41], 4, "manual"))

    follow_up_id = await manager.maybe_switch_register_probe_egress(
        repository.get_run(run_id) or {},
        {"status": "completed", "summary": {"anomaly_count": 1}},
    )

    assert follow_up_id
    follow_up = repository.get_run(follow_up_id)
    assert follow_up is not None
    assert follow_up["trigger"] == "register"
    assert follow_up["parent_run_id"] == run_id
    assert follow_up["source_event_id"] == "event-switch"
    assert account_client.bindings[-1][1] != 4


@pytest.mark.asyncio
async def test_register_probe_switch_can_be_disabled(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = ProbeRepository(database)
    repository.seed_defaults()
    manager = ProbeManager(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            scheduler_enabled=False,
            register_probe_switch_on_degradation=False,
        ),
        repository=repository,
        accounts=AccountRepository(database),
        client=FakeGrokClient(),  # type: ignore[arg-type]
        thresholds=Thresholds(),
        account_service=AccountService(
            settings=Settings(database_path=tmp_path / "grokiq.db"),
            client=EgressClient(),  # type: ignore[arg-type]
            accounts=AccountRepository(database),
            probes=repository,
        ),
    )

    follow_up_id = await manager.maybe_switch_register_probe_egress(
        {
            "id": "run-disabled",
            "account_id": 41,
            "trigger": "register",
            "source_event_id": "event-disabled",
            "profile_id": "quality-marker",
            "execution_mode": "chat",
            "rounds": 1,
            "proxy_targets": [{"kind": "current", "id": None}],
        },
        {"status": "completed", "summary": {"anomaly_count": 2}},
    )

    assert follow_up_id is None


@pytest.mark.asyncio
async def test_register_follow_up_defers_auto_quarantine():
    calls: list[str] = []

    class Accounts:
        @staticmethod
        def get_assessment(_: int) -> dict[str, Any]:
            return {"monitor_status": "healthy"}

        @staticmethod
        def recalculate(*_: Any) -> dict[str, Any]:
            return {"monitor_status": "high_risk", "risk_score": 75}

    async def switch_egress(*_: Any) -> str:
        calls.append("switch")
        return "follow-up-run"

    async def quarantine(*_: Any) -> dict[str, Any]:
        calls.append("quarantine")
        return {"monitor_status": "quarantined", "risk_score": 75}

    manager = SimpleNamespace(
        accounts=Accounts(),
        thresholds=Thresholds(),
        settings=Settings(),
        notifications=None,
        maybe_switch_register_probe_egress=switch_egress,
        _apply_auto_quarantine=quarantine,
    )
    now = utc_now()
    runtime = WorkerRuntime(
        index=1,
        worker_id="worker-1",
        status="running",
        started_at=now,
        state_changed_at=now,
        last_heartbeat_at=now,
    )

    await ProbeRunExecutor(
        manager,  # type: ignore[arg-type]
        logging.getLogger(__name__),
    )._post_process(
        {
            "id": "register-run",
            "account_id": 41,
            "account_name": "register-account",
            "account_email": "register@example.test",
            "trigger": "register",
        },
        runtime,
        {
            "status": "completed",
            "summary": {"anomaly_count": 3},
        },
    )

    assert calls == ["switch"]


@pytest.mark.asyncio
async def test_register_follow_up_exhaustion_applies_auto_quarantine():
    calls: list[str] = []

    class Accounts:
        @staticmethod
        def get_assessment(_: int) -> dict[str, Any]:
            return {"monitor_status": "healthy"}

        @staticmethod
        def recalculate(*_: Any) -> dict[str, Any]:
            return {"monitor_status": "high_risk", "risk_score": 75}

    async def switch_egress(*_: Any) -> None:
        calls.append("switch")

    async def quarantine(*_: Any) -> dict[str, Any]:
        calls.append("quarantine")
        return {"monitor_status": "quarantined", "risk_score": 75}

    manager = SimpleNamespace(
        accounts=Accounts(),
        thresholds=Thresholds(),
        settings=Settings(),
        notifications=None,
        maybe_switch_register_probe_egress=switch_egress,
        _apply_auto_quarantine=quarantine,
    )
    now = utc_now()
    runtime = WorkerRuntime(
        index=1,
        worker_id="worker-1",
        status="running",
        started_at=now,
        state_changed_at=now,
        last_heartbeat_at=now,
    )

    await ProbeRunExecutor(
        manager,  # type: ignore[arg-type]
        logging.getLogger(__name__),
    )._post_process(
        {
            "id": "register-run",
            "account_id": 41,
            "account_name": "register-account",
            "account_email": "register@example.test",
            "trigger": "register",
        },
        runtime,
        {
            "status": "completed",
            "summary": {"anomaly_count": 3},
        },
    )

    assert calls == ["switch", "quarantine"]


class FakeGrokClient:
    def __init__(self):
        self.bindings: list[dict[str, Any]] = []
        self.routing_updates: list[dict[str, Any]] = []
        self.restored = False
        self.deleted_route = False
        self.deleted_key = False
        self.account_enabled = True
        self.account_priority = 7
        self.account_max_concurrent = 4
        self.probe_error: Exception | None = None
        self.probe_errors: list[Exception] = []
        self.probe_calls = 0
        self.restore_routing_failures = 0
        self.chat_egress_override = 0
        self.account_egress_node_id: int | None = None
        self.account_egress_mode = ""
        self.bind_mismatch = False
        self.create_probe_route_calls: list[dict[str, Any]] = []
        self.quality_guard_calls: list[dict[str, Any]] = []
        self.quality_probe_calls: list[dict[str, Any]] = []
        self.quality_probe_account_id: int | None = None

    async def get_account(self, account_id: int) -> dict[str, Any]:
        return {
            "id": str(account_id),
            "name": "probe-account",
            "email": "probe@example.test",
            "enabled": self.account_enabled,
            "authStatus": "active",
            "priority": self.account_priority,
            "maxConcurrent": self.account_max_concurrent,
            "egressNodeId": self.account_egress_node_id,
            "egressAssignmentMode": self.account_egress_mode,
        }

    async def list_all_accounts(self, account_ids: set[int] | None = None) -> list[dict[str, Any]]:
        return [await self.get_account(account_id) for account_id in sorted(account_ids or {10})]

    async def list_egress_nodes(self, **_: Any) -> dict[str, Any]:
        return {
            "items": [
                {
                    "id": "7",
                    "name": "proxy-7",
                    "enabled": True,
                    "proxyConfigured": True,
                }
            ],
            "total": 1,
            "pageSize": 500,
        }

    async def create_probe_route(self, **kwargs: Any) -> tuple[str, str]:
        self.create_probe_route_calls.append(kwargs)
        if self.bind_mismatch and kwargs.get("bind_account", True):
            raise IntegrationError(
                "grok2api 返回 HTTP 400: 模型参数无效: "
                "账号 4725 不存在或与模型来源不匹配",
                status_code=400,
                error_code="modelCreateFailed",
            )
        return "route-1", "grokiq-probe-test"

    async def create_probe_client_key(self, _: str, **__: Any) -> tuple[str, str]:
        return "key-1", "secret"

    async def set_account_egress(self, _: int, target: dict[str, Any]) -> None:
        self.bindings.append(target)

    async def set_account_routing_settings(
        self,
        _: int,
        *,
        enabled: bool,
        priority: int,
        max_concurrent: int,
    ) -> None:
        if not enabled and self.restore_routing_failures > 0:
            self.restore_routing_failures -= 1
            raise RuntimeError("simulated account restore failure")
        self.account_enabled = enabled
        self.account_priority = priority
        self.account_max_concurrent = max_concurrent
        self.routing_updates.append(
            {
                "enabled": enabled,
                "priority": priority,
                "maxConcurrent": max_concurrent,
            }
        )

    async def chat_probe(self, **kwargs: Any) -> ChatProbeResult:
        self.probe_calls += 1
        if self.probe_errors:
            raise self.probe_errors.pop(0)
        if self.probe_error is not None:
            raise self.probe_error
        target_id = (
            int(self.bindings[-1].get("id") or 0) or None if self.bindings else self.account_egress_node_id
        )
        egress_id = self.chat_egress_override or target_id
        return ChatProbeResult(
            request_id="request-1",
            audit_id=1,
            verified_account_id=10,
            verified_egress_node_id=egress_id,
            status_code=200,
            response_text="探针校验通过",
            reasoning_text="",
            response_sha256="digest",
            output_tokens=100,
            reasoning_tokens=10,
            reasoning_tokens_reported=True,
            visible_tokens=90,
            chunk_count=3,
            first_token_ms=500,
            duration_ms=1500,
            generation_ms=1000,
            first_token_share=1 / 3,
            tps=100,
            expected_matched=True,
            usage={"completion_tokens": 100},
        )

    async def quality_guard_probe(self, **kwargs: Any) -> ChatProbeResult:
        self.quality_guard_calls.append(kwargs)
        self.probe_calls += 1
        if self.probe_errors:
            raise self.probe_errors.pop(0)
        if self.probe_error is not None:
            raise self.probe_error
        egress_id = kwargs["egress_node_id"]
        return ChatProbeResult(
            request_id="guard-request-1",
            audit_id=3,
            verified_account_id=10,
            verified_egress_node_id=egress_id,
            status_code=200,
            response_text="",
            reasoning_text="",
            response_sha256="guard-digest",
            output_tokens=80,
            reasoning_tokens=12,
            reasoning_tokens_reported=True,
            visible_tokens=68,
            chunk_count=2,
            first_token_ms=300,
            duration_ms=1200,
            generation_ms=900,
            first_token_share=0.25,
            tps=66.6,
            expected_matched=True,
            usage={
                "completion_tokens": 80,
                "quality_test": True,
                "quality_guard": True,
                "account_bind_skipped": True,
            },
        )

    async def quality_probe(self, **kwargs: Any) -> ChatProbeResult:
        self.quality_probe_calls.append(kwargs)
        self.probe_calls += 1
        if self.probe_errors:
            raise self.probe_errors.pop(0)
        if self.probe_error is not None:
            raise self.probe_error
        egress_id = kwargs["egress_node_id"]
        usage = {"completion_tokens": 120, "quality_test": True}
        if kwargs.get("pin_account"):
            usage["account_bind_skipped"] = True
        verified_account_id = self.quality_probe_account_id or 10
        if kwargs.get("pin_account") and verified_account_id != kwargs["account_id"]:
            error = IntegrationError(
                model_account_bind_window_message(
                    kwargs["account_id"],
                    verified_account_id=verified_account_id,
                ),
                request_id="quality-request-1",
                error_code="modelBindWindow",
            )
            error.verified_account_id = verified_account_id
            error.verified_egress_node_id = egress_id
            raise error
        return ChatProbeResult(
            request_id="quality-request-1",
            audit_id=2,
            verified_account_id=verified_account_id,
            verified_egress_node_id=egress_id,
            status_code=200,
            response_text="",
            reasoning_text="",
            response_sha256="quality-digest",
            output_tokens=120,
            reasoning_tokens=20,
            reasoning_tokens_reported=True,
            visible_tokens=100,
            chunk_count=4,
            first_token_ms=400,
            duration_ms=1400,
            generation_ms=1000,
            first_token_share=2 / 7,
            tps=120,
            expected_matched=True,
            usage=usage,
        )

    async def restore_account_egress(self, *_: Any) -> None:
        self.restored = True

    async def delete_probe_client_key(self, key_id: str) -> None:
        if key_id:
            self.deleted_key = True

    async def delete_probe_route(self, route_id: str) -> None:
        if route_id:
            self.deleted_route = True

    async def cleanup_stale_resources(self) -> dict[str, int]:
        return {"routes": 0, "clientKeys": 0}

    async def set_account_enabled(self, *_: Any) -> None:
        return None


class DisabledFakeGrokClient(FakeGrokClient):
    def __init__(self):
        super().__init__()
        self.account_enabled = False


@pytest.mark.asyncio
@pytest.mark.parametrize("recovery_enabled", [True, False])
async def test_auto_quarantine_records_selected_recovery_policy(
    tmp_path: Path,
    recovery_enabled: bool,
):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    accounts = AccountRepository(database)
    manager = ProbeManager(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            auto_quarantine=True,
            auto_quarantine_recovery_enabled=recovery_enabled,
            quarantine_minutes=30,
        ),
        repository=ProbeRepository(database),
        accounts=accounts,
        client=FakeGrokClient(),  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )

    result = await manager._apply_auto_quarantine(42, {  # noqa: SLF001
        "monitor_status": "high_risk",
        "risk_score": 88,
    })

    assert result["monitor_status"] == "quarantined"
    assert result["disabled_by_monitor"] is True
    if recovery_enabled:
        assert result["quarantine_until"] is not None
    else:
        assert result["quarantine_until"] is None
        assert accounts.due_quarantines() == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "min_status", "expected"),
    [
        ("suspect", "high_risk", False),
        ("high_risk", "high_risk", True),
        ("suspect", "suspect", True),
        ("watch", "suspect", False),
        ("watch", "watch", True),
    ],
)
async def test_auto_isolation_respects_configured_min_status(
    tmp_path: Path,
    status: str,
    min_status: str,
    expected: bool,
):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    accounts = AccountRepository(database)
    manager = ProbeManager(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            auto_isolation_enabled=True,
            auto_isolation_min_status=min_status,  # type: ignore[arg-type]
            auto_quarantine=True,
            auto_quarantine_recovery_enabled=True,
            quarantine_minutes=30,
        ),
        repository=ProbeRepository(database),
        accounts=accounts,
        client=FakeGrokClient(),  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )

    result = await manager._apply_auto_quarantine(42, {  # noqa: SLF001
        "monitor_status": status,
        "risk_score": 88,
    })

    if expected:
        assert result["monitor_status"] == "quarantined"
        assert result["quarantine_until"] is None
        assert result["disabled_by_monitor"] is True
        assert accounts.due_quarantines() == []
    else:
        assert result.get("monitor_status") != "quarantined"
        assert accounts.get_assessment(42) is None


def test_worker_activity_stats_use_rolling_process_window(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = ProbeRepository(database)
    manager = ProbeManager(
        settings=Settings(database_path=tmp_path / "grokiq.db"),
        repository=repository,
        accounts=AccountRepository(database),
        client=FakeGrokClient(),  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )
    now = utc_now()
    manager._recent_completions.extend(  # noqa: SLF001
        [
            (now - timedelta(seconds=70), False, 20),
            (now - timedelta(seconds=20), False, 10),
            (now - timedelta(seconds=5), True, 6),
        ]
    )

    stats = manager._activity_stats(now, 75)  # noqa: SLF001

    assert stats == {
        "windowSeconds": 60,
        "completed": 2,
        "failed": 1,
        "failureRate": 0.5,
        "averageDurationSeconds": 8,
        "oldestQueueWaitSeconds": 75,
    }


@pytest.mark.asyncio
async def test_manual_batch_reports_skipped_account_details(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = ProbeRepository(database)
    repository.seed_defaults()
    client = FakeGrokClient()
    client.account_egress_node_id = 7
    manager = ProbeManager(
        settings=Settings(database_path=tmp_path / "grokiq.db", scheduler_enabled=False),
        repository=repository,
        accounts=AccountRepository(database),
        client=client,  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )
    created = await manager.enqueue_manual_batch(
        account_ids=[10],
        profile_id="quality-marker",
        rounds=1,
        proxy_targets=[{"kind": "current", "id": None}],
    )
    repeated = await manager.enqueue_manual_batch(
        account_ids=[10],
        profile_id="quality-marker",
        rounds=1,
        proxy_targets=[{"kind": "current", "id": None}],
    )

    assert created["created"] == 1
    assert repeated["created"] == 0
    assert repeated["skippedAccounts"] == [
        {
            "id": 10,
            "name": "probe-account",
            "email": "probe@example.test",
            "code": "active_run",
            "reason": "账号 10 已有排队或执行中的探针任务，请等待其结束",
        }
    ]


@pytest.mark.asyncio
async def test_disabled_account_uses_diagnostic_activation_and_restores_snapshot(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = ProbeRepository(database)
    client = DisabledFakeGrokClient()
    manager = ProbeManager(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            scheduler_enabled=False,
            probe_worker_concurrency=1,
            probe_step_delay_seconds=0,
        ),
        repository=repository,
        accounts=AccountRepository(database),
        client=client,  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )
    await manager.start()
    try:
        run_id = await manager.enqueue_manual(
            account_id=10,
            profile_id="quality-marker",
            rounds=1,
            proxy_targets=[{"kind": "direct", "id": None}],
        )
        detail = await wait_for_terminal_run(repository, run_id)
        run = detail["run"]
        assert run["status"] == "completed"
        assert run["original_account_enabled"] is False
        assert run["original_account_priority"] == 7
        assert run["original_account_max_concurrent"] == 4
        assert run["diagnostic_priority"] == -1_000_000
        assert run["diagnostic_activation_active"] is False
        assert run["account_restore_status"] == "automatic_restored"
        assert run["account_restore_source"] == "automatic"
        assert client.routing_updates[0] == {
            "enabled": True,
            "priority": -1_000_000,
            "maxConcurrent": 1,
        }
        assert client.routing_updates[-1] == {
            "enabled": False,
            "priority": 7,
            "maxConcurrent": 4,
        }
    finally:
        await manager.stop()


@pytest.mark.asyncio
async def test_probe_error_still_restores_disabled_account_automatically(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = ProbeRepository(database)
    client = DisabledFakeGrokClient()
    client.probe_error = RuntimeError("simulated upstream probe failure")
    manager = ProbeManager(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            scheduler_enabled=False,
            probe_worker_concurrency=1,
            probe_step_delay_seconds=0,
        ),
        repository=repository,
        accounts=AccountRepository(database),
        client=client,  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )
    await manager.start()
    try:
        run_id = await manager.enqueue_manual(
            account_id=10,
            profile_id="quality-marker",
            rounds=1,
            proxy_targets=[{"kind": "direct", "id": None}],
        )
        detail = await wait_for_terminal_run(repository, run_id)
        run = detail["run"]
        assert run["status"] == "completed_with_errors"
        assert detail["samples"][0]["status"] == "error"
        assert run["account_restore_status"] == "automatic_restored"
        assert run["account_restore_source"] == "automatic"
        assert client.account_enabled is False
        assert client.account_priority == 7
        assert client.account_max_concurrent == 4
    finally:
        await manager.stop()


@pytest.mark.asyncio
async def test_transient_scheduler_error_is_retried_as_one_successful_sample(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = ProbeRepository(database)
    client = FakeGrokClient()
    client.probe_errors = [
        IntegrationError(
            "temporarily unavailable",
            status_code=503,
            error_code="client_key_account_scope_unavailable",
            request_id="failed-request",
        )
    ]
    manager = ProbeManager(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            scheduler_enabled=False,
            probe_worker_concurrency=1,
            probe_step_delay_seconds=0,
            probe_transient_retry_attempts=1,
            probe_transient_retry_base_seconds=0.1,
            probe_transient_retry_max_seconds=0.1,
        ),
        repository=repository,
        accounts=AccountRepository(database),
        client=client,  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )
    await manager.start()
    try:
        run_id = await manager.enqueue_manual(
            account_id=10,
            profile_id="quality-marker",
            rounds=1,
            proxy_targets=[{"kind": "direct", "id": None}],
        )
        detail = await wait_for_terminal_run(repository, run_id)
        sample = detail["samples"][0]
        assert detail["run"]["status"] == "completed"
        assert client.probe_calls == 2
        assert sample["status"] == "done"
        assert sample["usage"]["probeAttempts"] == 2
    finally:
        await manager.stop()


@pytest.mark.asyncio
async def test_transient_retry_delay_honors_retry_after_beyond_local_max(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    client = FakeGrokClient()
    manager = ProbeManager(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            scheduler_enabled=False,
            probe_transient_retry_base_seconds=5,
            probe_transient_retry_max_seconds=30,
        ),
        repository=ProbeRepository(database),
        accounts=AccountRepository(database),
        client=client,  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )

    delay = await manager._transient_retry_delay(
        account_id=10,
        error=IntegrationError(
            "model cooling",
            status_code=429,
            error_code="upstream_model_cooling",
            retry_after_seconds=265,
        ),
        attempt=0,
    )

    assert delay == 265


@pytest.mark.asyncio
async def test_final_cooling_error_delays_the_next_round_by_retry_after(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    client = FakeGrokClient()
    manager = ProbeManager(
        settings=Settings(database_path=tmp_path / "grokiq.db", scheduler_enabled=False),
        repository=ProbeRepository(database),
        accounts=AccountRepository(database),
        client=client,  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )
    waits: list[tuple[str, float]] = []

    async def record_wait(run_id: str, seconds: float) -> None:
        waits.append((run_id, seconds))

    manager._sleep_probe_delay = record_wait  # type: ignore[method-assign]
    await manager._wait_for_account_cooldown(
        "run-cooling",
        10,
        IntegrationError(
            "model still cooling",
            status_code=429,
            error_code="upstream_model_cooling",
            retry_after_seconds=144,
        ),
    )

    assert waits == [("run-cooling", 144)]


@pytest.mark.asyncio
async def test_final_transient_error_preserves_http_and_retry_metadata(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = ProbeRepository(database)
    client = FakeGrokClient()
    client.probe_error = IntegrationError(
        "scope temporarily unavailable",
        status_code=503,
        error_code="client_key_account_scope_unavailable",
        retry_after_seconds=5,
        request_id="failed-request",
    )
    manager = ProbeManager(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            scheduler_enabled=False,
            probe_worker_concurrency=1,
            probe_step_delay_seconds=0,
            probe_transient_retry_attempts=0,
        ),
        repository=repository,
        accounts=AccountRepository(database),
        client=client,  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )
    await manager.start()
    try:
        run_id = await manager.enqueue_manual(
            account_id=10,
            profile_id="quality-marker",
            rounds=1,
            proxy_targets=[{"kind": "direct", "id": None}],
        )
        detail = await wait_for_terminal_run(repository, run_id)
        sample = detail["samples"][0]
        assert detail["run"]["status"] == "completed_with_errors"
        assert sample["status_code"] == 503
        assert sample["error_code"] == "client_key_account_scope_unavailable"
        assert sample["request_id"] == "failed-request"
        assert sample["retry_count"] == 0
        assert sample["retry_after_seconds"] == 5
        assert sample["usage"]["probeError"]["transient"] is True
    finally:
        await manager.stop()


@pytest.mark.asyncio
async def test_restore_failure_is_marked_then_manual_sync_clears_it(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = ProbeRepository(database)
    client = DisabledFakeGrokClient()
    # The per-sample rollback and the final cleanup both fail.
    client.restore_routing_failures = 2
    manager = ProbeManager(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            scheduler_enabled=False,
            probe_worker_concurrency=1,
            probe_step_delay_seconds=0,
        ),
        repository=repository,
        accounts=AccountRepository(database),
        client=client,  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )
    await manager.start()
    try:
        run_id = await manager.enqueue_manual(
            account_id=10,
            profile_id="quality-marker",
            rounds=1,
            proxy_targets=[{"kind": "direct", "id": None}],
        )
        detail = await wait_for_terminal_run(repository, run_id)
        failed = detail["run"]
        assert failed["status"] == "failed"
        assert failed["account_restore_status"] == "restore_failed"
        assert failed["diagnostic_activation_active"] is True
        assert failed["account_restore_attempts"] == 1
        assert "simulated account restore failure" in failed["account_restore_error"]

        restored = await manager.restore_run_account_settings(run_id)
        assert restored["account_restore_status"] == "manual_restored"
        assert restored["account_restore_source"] == "manual"
        assert restored["diagnostic_activation_active"] is False
        assert restored["account_restore_attempts"] == 2
        assert client.account_enabled is False
        assert client.account_priority == 7
        assert client.account_max_concurrent == 4
    finally:
        await manager.stop()


@pytest.mark.asyncio
async def test_startup_recovery_marks_cancelled_run_as_startup_restored(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = ProbeRepository(database)
    repository.seed_defaults()
    run_id = create_run(repository)
    assert repository.claim_next("crashed-worker") is not None
    repository.ensure_account_settings_snapshot(
        run_id=run_id,
        enabled=False,
        priority=7,
        max_concurrent=4,
        egress_node_id=None,
        egress_assignment_mode="",
        diagnostic_priority=-1_000_000,
        diagnostic_max_concurrent=1,
    )
    repository.set_upstream_context(
        run_id=run_id,
        original_node_id=None,
        original_mode="",
        route_id="route-1",
        public_model="grokiq-probe-test",
        client_key_id="key-1",
    )
    repository.set_diagnostic_activation(run_id, True)
    assert repository.request_cancel(run_id) == "cancel_requested"

    client = DisabledFakeGrokClient()
    client.account_enabled = True
    client.account_priority = -1_000_000
    client.account_max_concurrent = 1
    manager = ProbeManager(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            scheduler_enabled=False,
            probe_worker_concurrency=1,
            probe_step_delay_seconds=0,
        ),
        repository=repository,
        accounts=AccountRepository(database),
        client=client,  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )
    await manager.start()
    try:
        detail = repository.run_detail(run_id)
        assert detail is not None
        run = detail["run"]
        assert run["status"] == "cancelled"
        assert run["account_restore_status"] == "startup_restored"
        assert run["account_restore_source"] == "startup"
        assert run["diagnostic_activation_active"] is False
        assert client.account_enabled is False
        assert client.deleted_route and client.deleted_key
    finally:
        await manager.stop()


def test_failed_restore_blocks_followup_claim_delete_and_retry(repository: ProbeRepository):
    failed_run_id = create_run(repository)
    assert repository.claim_next("worker-1") is not None
    repository.ensure_account_settings_snapshot(
        run_id=failed_run_id,
        enabled=False,
        priority=7,
        max_concurrent=4,
        egress_node_id=None,
        egress_assignment_mode="",
        diagnostic_priority=-1_000_000,
        diagnostic_max_concurrent=1,
    )
    repository.begin_account_restore(failed_run_id, "automatic")
    repository.finish_account_restore(failed_run_id, "automatic", "restore failed")
    repository.finish_run(failed_run_id, status="failed", error="restore failed")
    queued_run_id = create_run(repository)

    assert repository.claim_next("worker-2") is None
    with pytest.raises(RunStateError, match="同步原设置"):
        repository.delete_run(failed_run_id)
    with pytest.raises(RunStateError, match="同步原设置"):
        repository.retry_values(failed_run_id)

    repository.begin_account_restore(failed_run_id, "manual")
    repository.finish_account_restore(failed_run_id, "manual")
    claimed = repository.claim_next("worker-2")
    assert claimed is not None
    assert claimed.run["id"] == queued_run_id


@pytest.mark.asyncio
async def test_worker_persists_result_and_restores_upstream(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    probe_repository = ProbeRepository(database)
    account_repository = AccountRepository(database)
    client = FakeGrokClient()
    manager = ProbeManager(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            scheduler_enabled=False,
            probe_worker_concurrency=1,
            probe_step_delay_seconds=0,
        ),
        repository=probe_repository,
        accounts=account_repository,
        client=client,  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )
    await manager.start()
    try:
        run_id = await manager.enqueue_manual(
            account_id=10,
            profile_id="quality-marker",
            rounds=1,
            proxy_targets=[{"kind": "egress", "id": 7}],
        )
        detail = await wait_for_terminal_run(probe_repository, run_id)
        assert detail["run"]["status"] == "completed"
        assert detail["samples"][0]["response_text"] == "探针校验通过"
        assert client.restored and client.deleted_route and client.deleted_key
    finally:
        await manager.stop()


@pytest.mark.asyncio
async def test_chat_probe_keeps_metrics_when_actual_egress_differs(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    probe_repository = ProbeRepository(database)
    client = FakeGrokClient()
    client.chat_egress_override = 3
    manager = ProbeManager(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            scheduler_enabled=False,
            probe_worker_concurrency=1,
            probe_step_delay_seconds=0,
        ),
        repository=probe_repository,
        accounts=AccountRepository(database),
        client=client,  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )
    await manager.start()
    try:
        run_id = await manager.enqueue_manual(
            account_id=10,
            profile_id="quality-marker",
            rounds=1,
            proxy_targets=[{"kind": "egress", "id": 7}],
        )
        detail = await wait_for_terminal_run(probe_repository, run_id)
        sample = detail["samples"][0]
        assert detail["run"]["status"] == "completed"
        assert sample["status"] == "done"
        assert sample["egress_node_id"] == 7
        assert sample["verified_egress_node_id"] == 3
        assert sample["tps"] == 100
        assert sample["request_id"] == "request-1"
        assert sample["audit_id"] == 1
        assert sample["response_text"] == "探针校验通过"
        assert not sample["error"]
    finally:
        await manager.stop()


@pytest.mark.asyncio
async def test_current_egress_probe_preserves_binding_and_routing_settings(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    probe_repository = ProbeRepository(database)
    client = FakeGrokClient()
    client.account_egress_node_id = 7
    client.account_egress_mode = "manual"
    manager = ProbeManager(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            scheduler_enabled=False,
            probe_worker_concurrency=1,
            probe_step_delay_seconds=0,
            probe_current_egress_interval_seconds=0,
        ),
        repository=probe_repository,
        accounts=AccountRepository(database),
        client=client,  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )
    await manager.start()
    try:
        run_id = await manager.enqueue_manual(
            account_id=10,
            profile_id="quality-marker",
            rounds=1,
            proxy_targets=[{"kind": "current", "id": None}],
        )
        detail = await wait_for_terminal_run(probe_repository, run_id)
        run = detail["run"]
        sample = detail["samples"][0]
        assert run["status"] == "completed"
        assert run["original_egress_node_id"] == 7
        assert run["original_egress_assignment_mode"] == "manual"
        assert run["account_restore_status"] == "not_recorded"
        assert client.bindings == []
        assert client.routing_updates == []
        assert client.restored is False
        assert sample["target_kind"] == "current"
        assert sample["egress_node_id"] == 7
        assert sample["verified_egress_node_id"] == 7
        assert sample["status"] == "done"
    finally:
        await manager.stop()


@pytest.mark.asyncio
async def test_current_egress_probe_rejects_unbound_or_disabled_account(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    client = FakeGrokClient()
    manager = ProbeManager(
        settings=Settings(database_path=tmp_path / "grokiq.db", scheduler_enabled=False),
        repository=ProbeRepository(database),
        accounts=AccountRepository(database),
        client=client,  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )
    with pytest.raises(ValueError, match="未绑定固定出口"):
        await manager.enqueue_manual(
            account_id=10,
            profile_id="quality-marker",
            rounds=1,
            proxy_targets=[{"kind": "current", "id": None}],
        )

    client.account_egress_node_id = 7
    client.account_enabled = False
    with pytest.raises(ValueError, match="正常定检不会临时激活"):
        await manager.enqueue_manual(
            account_id=10,
            profile_id="quality-marker",
            rounds=1,
            proxy_targets=[{"kind": "current", "id": None}],
        )


@pytest.mark.asyncio
async def test_current_egress_probe_keeps_metrics_when_audited_node_differs(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    probe_repository = ProbeRepository(database)
    client = FakeGrokClient()
    client.account_egress_node_id = 7
    client.account_egress_mode = "manual"
    client.chat_egress_override = 3
    manager = ProbeManager(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            scheduler_enabled=False,
            probe_worker_concurrency=1,
            probe_step_delay_seconds=0,
            probe_current_egress_interval_seconds=0,
        ),
        repository=probe_repository,
        accounts=AccountRepository(database),
        client=client,  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )
    await manager.start()
    try:
        run_id = await manager.enqueue_manual(
            account_id=10,
            profile_id="quality-marker",
            rounds=1,
            proxy_targets=[{"kind": "current", "id": None}],
        )
        detail = await wait_for_terminal_run(probe_repository, run_id)
        sample = detail["samples"][0]
        assert detail["run"]["status"] == "completed"
        assert sample["status"] == "done"
        assert sample["egress_node_id"] == 7
        assert sample["verified_egress_node_id"] == 3
        assert sample["request_id"] == "request-1"
        assert sample["audit_id"] == 1
        assert sample["output_tokens"] == 100
        assert sample["tps"] == 100
        assert sample["response_text"] == "探针校验通过"
        assert not sample["error"]
        assert client.bindings == []
        assert client.restored is False
        assessment = AccountRepository(database).get_assessment(10)
        assert assessment is not None
        assert assessment["sample_count"] == 1
        assert assessment["latest_tps"] == 100
        assert assessment["latest_classification"] != "error"
    finally:
        await manager.stop()


@pytest.mark.asyncio
async def test_current_egress_cannot_be_mixed_with_diagnostic_targets(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    manager = ProbeManager(
        settings=Settings(database_path=tmp_path / "grokiq.db", scheduler_enabled=False),
        repository=ProbeRepository(database),
        accounts=AccountRepository(database),
        client=FakeGrokClient(),  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )
    with pytest.raises(ValueError, match="不能与诊断出口混用"):
        await manager.validate_targets(
            [
                {"kind": "current", "id": None},
                {"kind": "egress", "id": 7},
            ]
        )


@pytest.mark.asyncio
async def test_quality_test_pins_account_and_node_without_changing_binding(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    probe_repository = ProbeRepository(database)
    account_repository = AccountRepository(database)
    client = FakeGrokClient()
    manager = ProbeManager(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            scheduler_enabled=False,
            probe_worker_concurrency=1,
            probe_step_delay_seconds=0,
        ),
        repository=probe_repository,
        accounts=account_repository,
        client=client,  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )
    await manager.start()
    try:
        run_id = await manager.enqueue_manual(
            account_id=10,
            profile_id="quality-marker",
            execution_mode="quality_test",
            rounds=1,
            proxy_targets=[{"kind": "egress", "id": 7}],
        )
        detail = await wait_for_terminal_run(probe_repository, run_id)
        assert detail["run"]["status"] == "completed"
        assert detail["run"]["execution_mode"] == "quality_test"
        assert detail["samples"][0]["response_text"] == ""
        assert detail["samples"][0]["verified_egress_node_id"] == 7
        assert client.bindings == []
        assert client.restored is False
        assert client.deleted_route and client.deleted_key
    finally:
        await manager.stop()


@pytest.mark.asyncio
async def test_bind_window_fallback_pins_via_quality_test(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    probe_repository = ProbeRepository(database)
    client = FakeGrokClient()
    client.account_enabled = False
    client.account_egress_node_id = 110
    client.bind_mismatch = True
    manager = ProbeManager(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            scheduler_enabled=False,
            probe_worker_concurrency=1,
            probe_step_delay_seconds=0,
        ),
        repository=probe_repository,
        accounts=AccountRepository(database),
        client=client,  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )
    await manager.start()
    try:
        run_id = await manager.enqueue_manual(
            account_id=10,
            profile_id="quality-marker",
            rounds=1,
            proxy_targets=[{"kind": "direct", "id": None}],
        )
        detail = await wait_for_terminal_run(probe_repository, run_id)
        sample = detail["samples"][0]
        assert detail["run"]["status"] == "completed"
        assert len(client.create_probe_route_calls) == 2
        assert client.create_probe_route_calls[0]["account_id"] == 10
        assert client.create_probe_route_calls[0]["bind_account"] is True
        assert client.create_probe_route_calls[0]["allow_temporarily_unavailable"] is True
        assert client.create_probe_route_calls[1]["bind_account"] is False
        assert client.quality_guard_calls == []
        assert len(client.quality_probe_calls) == 1
        probe_call = client.quality_probe_calls[0]
        assert probe_call["client_key_id"] == "key-1"
        assert probe_call["public_model"] == "grokiq-probe-test"
        assert probe_call["account_id"] == 10
        assert probe_call["egress_node_id"] == 110
        assert probe_call["pin_account"] is True
        assert probe_call["max_output_tokens"] == 0
        assert client.bindings == []
        assert client.deleted_route is True
        assert client.deleted_key is True
        assert sample["request_id"] == "quality-request-1"
        assert sample["verified_account_id"] == 10
        assert sample["verified_egress_node_id"] == 110
        assert sample["usage"]["quality_test"] is True
        assert sample["usage"]["account_bind_skipped"] is True
        assert sample["usage"].get("quality_guard") is not True
    finally:
        await manager.stop()


@pytest.mark.asyncio
async def test_bind_window_fallback_requires_egress_node(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    probe_repository = ProbeRepository(database)
    client = FakeGrokClient()
    client.bind_mismatch = True
    manager = ProbeManager(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            scheduler_enabled=False,
            probe_worker_concurrency=1,
            probe_step_delay_seconds=0,
        ),
        repository=probe_repository,
        accounts=AccountRepository(database),
        client=client,  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )
    await manager.start()
    try:
        run_id = await manager.enqueue_manual(
            account_id=10,
            profile_id="quality-marker",
            rounds=1,
            proxy_targets=[{"kind": "direct", "id": None}],
        )
        detail = await wait_for_terminal_run(probe_repository, run_id)
        assert detail["run"]["status"] == "failed"
        error = str(detail["run"]["error"] or "")
        assert "模型绑定窗口" in error
        assert "最新约 1000 个账号" in error
        assert "没有可用出口节点" in error
        assert client.quality_guard_calls == []
        assert client.quality_probe_calls == []
        assert client.deleted_route is False
    finally:
        await manager.stop()


@pytest.mark.asyncio
async def test_bind_window_fallback_explains_unpatched_grok2api(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    probe_repository = ProbeRepository(database)
    client = FakeGrokClient()
    client.account_egress_node_id = 110
    client.bind_mismatch = True
    client.quality_probe_account_id = 99
    manager = ProbeManager(
        settings=Settings(
            database_path=tmp_path / "grokiq.db",
            scheduler_enabled=False,
            probe_worker_concurrency=1,
            probe_step_delay_seconds=0,
        ),
        repository=probe_repository,
        accounts=AccountRepository(database),
        client=client,  # type: ignore[arg-type]
        thresholds=Thresholds(),
    )
    await manager.start()
    try:
        run_id = await manager.enqueue_manual(
            account_id=10,
            profile_id="quality-marker",
            rounds=1,
            proxy_targets=[{"kind": "direct", "id": None}],
        )
        detail = await wait_for_terminal_run(probe_repository, run_id)
        sample = detail["samples"][0]
        assert detail["run"]["status"] in {"failed", "completed_with_errors"}
        error = str(sample["error"] or detail["run"]["error"] or "")
        assert "模型绑定窗口" in error
        assert "最新约 1000 个账号" in error
        assert "实际命中了账号 99" in error
        assert sample["verified_account_id"] == 99
    finally:
        await manager.stop()
