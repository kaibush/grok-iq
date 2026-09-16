from __future__ import annotations

from datetime import timedelta
from pathlib import Path

import pytest

from app.core.clock import app_isoformat, utc_now
from app.core.config import Settings
from app.persistence.account_repository import AccountRepository
from app.persistence.database import Database
from app.persistence.models import ProbeRun
from app.persistence.probe_repository import ProbeRepository
from app.persistence.request_audit_repository import RequestAuditRepository
from app.services.account_service import AccountService
from tests.test_cooldown_zone import CooldownClient, _live_missing_thinking_record


def _service(tmp_path: Path) -> tuple[CooldownClient, AccountService, ProbeRepository, Database]:
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    accounts = AccountRepository(database)
    probes = ProbeRepository(database)
    probes.seed_defaults()
    request_audits = RequestAuditRepository(database)
    client = CooldownClient(
        [
            {
                "id": "1",
                "name": "Alpha",
                "email": "alpha@example.test",
                "enabled": False,
            },
            {
                "id": "2",
                "name": "Bravo",
                "email": "bravo@example.test",
                "enabled": True,
            },
            {
                "id": "3",
                "name": "Charlie",
                "email": "charlie@example.test",
                "enabled": False,
            },
        ]
    )
    service = AccountService(
        settings=Settings(database_path=tmp_path / "grokiq.db"),
        client=client,  # type: ignore[arg-type]
        accounts=accounts,
        probes=probes,
        request_audits=request_audits,
    )
    return client, service, probes, database


def _create_run(probes: ProbeRepository, account_id: int) -> str:
    return probes.create_run(
        account_id=account_id,
        account_name=f"account-{account_id}",
        account_email=f"account-{account_id}@example.test",
        profile_id="quality-marker",
        rounds=1,
        proxy_targets=[{"kind": "direct", "id": None, "name": "直连"}],
        trigger="manual",
        priority=100,
        queue_limit=20,
    )


def _staging_payload(
    account_id: int,
    *,
    name: str,
    grok_state: str = "timed_disabled",
    reason: str = "缺少有效思考内容",
    missing_upstream: bool = False,
) -> dict:
    now = utc_now()
    return {
        "accountId": account_id,
        "name": name,
        "email": f"{name.lower()}@example.test",
        "grokState": grok_state,
        "reason": reason,
        "cooledAt": (now - timedelta(minutes=10)).isoformat(),
        "cooldownUntil": (now + timedelta(minutes=20)).isoformat(),
        "cooldownCount": 3,
        "missingUpstream": missing_upstream,
    }


@pytest.mark.asyncio
async def test_add_list_and_remove_cooldown_probe_staging(tmp_path: Path):
    _client, service, _probes, _database = _service(tmp_path)

    added = await service.add_cooldown_probe_staging(
        [
            _staging_payload(1, name="Alpha"),
            _staging_payload(3, name="Charlie", grok_state="permanent_disabled"),
        ]
    )
    assert added["added"] == 2
    assert added["alreadyStagedAccountIds"] == []
    assert added["skippedAccountIds"] == []

    page = await service.list_cooldown_probe_staging(page=1, page_size=50)
    assert page["total"] == 2
    assert page["unprobedCount"] == 2
    assert page["probedCount"] == 0
    by_id = {item["id"]: item for item in page["items"]}
    assert by_id[1]["grokState"] == "timed_disabled"
    assert by_id[1]["cooldownCount"] == 3
    assert by_id[1]["probedAfterStaged"] is False
    assert by_id[1]["stagedAt"]
    assert by_id[3]["grokState"] == "permanent_disabled"

    removed = service.remove_cooldown_probe_staging([1, 3])
    assert removed["removed"] == 2
    empty = await service.list_cooldown_probe_staging(page=1, page_size=50)
    assert empty["total"] == 0


@pytest.mark.asyncio
async def test_readd_keeps_original_staged_at(tmp_path: Path):
    _client, service, _probes, database = _service(tmp_path)
    first = await service.add_cooldown_probe_staging([_staging_payload(1, name="Alpha")])
    assert first["added"] == 1

    kept_staged_at = utc_now() - timedelta(hours=2)
    with database.transaction() as session:
        from app.persistence.models import CooldownProbeStaging

        row = session.get(CooldownProbeStaging, 1)
        assert row is not None
        row.staged_at = kept_staged_at
        row.name = "Old Alpha"

    second = await service.add_cooldown_probe_staging(
        [_staging_payload(1, name="Alpha Relabeled", grok_state="permanent_disabled")]
    )
    assert second["added"] == 0
    assert second["alreadyStagedAccountIds"] == [1]
    listed = (await service.list_cooldown_probe_staging(page=1, page_size=50))["items"][0]
    assert listed["name"] == "Alpha"
    assert listed["stagedAt"] == app_isoformat(kept_staged_at)
    assert listed["grokState"] == "permanent_disabled"


@pytest.mark.asyncio
async def test_add_skips_missing_upstream_and_unknown_accounts(tmp_path: Path):
    _client, service, _probes, _database = _service(tmp_path)
    result = await service.add_cooldown_probe_staging(
        [
            _staging_payload(1, name="Alpha", missing_upstream=True),
            _staging_payload(99, name="Ghost"),
            {"accountId": 0, "name": "Invalid"},
        ]
    )
    assert result["added"] == 0
    assert result["skippedAccountIds"] == [1, 99]
    listed = await service.list_cooldown_probe_staging(page=1, page_size=50)
    assert listed["total"] == 0


@pytest.mark.asyncio
async def test_live_overlay_marks_enabled_and_deleted_accounts(tmp_path: Path):
    client, service, _probes, _database = _service(tmp_path)
    await service.add_cooldown_probe_staging(
        [
            _staging_payload(1, name="Alpha"),
            _staging_payload(3, name="Charlie", grok_state="timed_disabled"),
        ]
    )
    client.accounts[1]["enabled"] = True
    del client.accounts[3]

    page = await service.list_cooldown_probe_staging(page=1, page_size=50)
    by_id = {item["id"]: item for item in page["items"]}
    assert by_id[1]["grokState"] == "enabled"
    assert by_id[1]["enabled"] is True
    assert by_id[1]["status"] == "expired"
    assert by_id[3]["grokState"] == "deleted"
    assert by_id[3]["missingUpstream"] is True
    assert by_id[3]["name"] == "Charlie"


@pytest.mark.asyncio
async def test_probe_after_staged_is_counted_and_old_run_is_not(tmp_path: Path):
    _client, service, probes, database = _service(tmp_path)
    old_run_id = _create_run(probes, 1)
    with database.transaction() as session:
        run = session.get(ProbeRun, old_run_id)
        assert run is not None
        run.created_at = utc_now() - timedelta(hours=2)

    await service.add_cooldown_probe_staging([_staging_payload(1, name="Alpha")])
    unprobed = await service.list_cooldown_probe_staging(page=1, page_size=50)
    assert unprobed["items"][0]["probedAfterStaged"] is False
    assert unprobed["items"][0]["latestProbeRun"]["id"] == old_run_id
    assert unprobed["unprobedCount"] == 1

    new_run_id = _create_run(probes, 1)
    probed = await service.list_cooldown_probe_staging(
        page=1,
        page_size=50,
        probe_status="probed",
    )
    assert probed["total"] == 1
    assert probed["items"][0]["probedAfterStaged"] is True
    assert probed["items"][0]["latestProbeRun"]["id"] == new_run_id
    assert probed["probedCount"] == 1
    still_unprobed = await service.list_cooldown_probe_staging(
        page=1,
        page_size=50,
        probe_status="unprobed",
    )
    assert still_unprobed["total"] == 0


@pytest.mark.asyncio
async def test_search_and_invalid_probe_status(tmp_path: Path):
    _client, service, _probes, _database = _service(tmp_path)
    await service.add_cooldown_probe_staging(
        [
            _staging_payload(1, name="Alpha"),
            _staging_payload(3, name="Charlie"),
        ]
    )
    searched = await service.list_cooldown_probe_staging(page=1, page_size=50, search="char")
    assert [item["id"] for item in searched["items"]] == [3]
    with pytest.raises(ValueError, match="all、unprobed 或 probed"):
        await service.list_cooldown_probe_staging(page=1, page_size=50, probe_status="done")


@pytest.mark.asyncio
async def test_grok_cooldown_list_marks_staged_accounts(tmp_path: Path):
    client, service, _probes, _database = _service(tmp_path)
    client.missing_thinking = [
        _live_missing_thinking_record(account_id=1, name="Alpha"),
        _live_missing_thinking_record(
            account_id=3,
            name="Charlie",
            state="permanent_disabled",
        ),
    ]
    await service.add_cooldown_probe_staging([_staging_payload(1, name="Alpha")])
    page = await service.list_cooldown_zone(
        page=1,
        page_size=50,
        status="all",
        source="grok2api",
    )
    by_id = {item["id"]: item for item in page["items"]}
    assert by_id[1]["staged"] is True
    assert by_id[3]["staged"] is False
