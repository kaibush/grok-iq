from __future__ import annotations

from datetime import timedelta
from pathlib import Path

import pytest

from app.core.clock import utc_now
from app.persistence.account_repository import AccountRepository
from app.persistence.database import Database
from app.web.routes.probes import overlay_run_missing_upstream
from tests.test_account_service import IsolationClient, _isolation_service


def test_mark_upstream_deleted_creates_stamp_and_keeps_existing(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    accounts = AccountRepository(database)

    accounts.mark_upstream_deleted([7, 0, 7, -1])
    first = accounts.get_assessment(7)
    assert first is not None
    assert first["upstream_deleted_at"]
    first_stamp = first["upstream_deleted_at"]

    accounts.mark_upstream_deleted([7])
    second = accounts.get_assessment(7)
    assert second is not None
    assert second["upstream_deleted_at"] == first_stamp

    accounts.clear_upstream_deleted([7])
    cleared = accounts.get_assessment(7)
    assert cleared is not None
    assert cleared["upstream_deleted_at"] is None


@pytest.mark.asyncio
async def test_delete_upstream_accounts_stamps_deleted_ids_only(tmp_path: Path):
    client = IsolationClient(
        [
            {"id": "1", "name": "Alpha", "enabled": True},
            {"id": "3", "name": "Charlie", "enabled": True},
        ]
    )
    client.failing_delete_ids = {3}
    _database, accounts, _probes, _client, service = _isolation_service(
        tmp_path,
        client=client,
    )

    result = await service.delete_upstream_accounts(account_ids=[1, 3])

    assert result["deleted"] == 1
    assert result["failedAccountIds"] == [3]
    stamped = accounts.get_assessment(1)
    assert stamped is not None
    assert stamped["upstream_deleted_at"]
    assert accounts.get_assessment(3) is None


def test_overlay_run_missing_upstream_uses_local_stamp():
    stamped_at = utc_now() - timedelta(minutes=3)
    runs = overlay_run_missing_upstream(
        [
            {"id": "run-1", "account_id": 11},
            {"id": "run-2", "account_id": 12},
        ],
        {
            11: {"upstream_deleted_at": stamped_at},
            12: {"upstream_deleted_at": None},
        },
    )
    assert runs[0]["missingUpstream"] is True
    assert runs[1]["missingUpstream"] is False


@pytest.mark.asyncio
async def test_live_account_clears_upstream_deleted_stamp(tmp_path: Path):
    _database, accounts, _probes, _client, service = _isolation_service(tmp_path)
    accounts.mark_upstream_deleted([1])
    assert accounts.get_assessment(1)["upstream_deleted_at"]

    detail = await service.detail(1)
    assert detail["account"]["id"] in {1, "1"}
    stored = accounts.get_assessment(1)
    assert stored is not None
    assert stored["upstream_deleted_at"] is None
