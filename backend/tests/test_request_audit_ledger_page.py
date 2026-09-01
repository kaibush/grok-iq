from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

from app.core.clock import utc_now
from app.core.config import Settings
from app.persistence.database import Database
from app.persistence.request_audit_repository import RequestAuditRepository
from app.services.request_audit_service import RequestAuditService


class _SpyRepository(RequestAuditRepository):
    def __init__(self, database: Database):
        super().__init__(database)
        self.range_account_ids: list[object] = []
        self.page_calls = 0

    def records_for_range(self, start, end, *, account_ids=None):  # type: ignore[no-untyped-def]
        self.range_account_ids.append(account_ids)
        return super().records_for_range(start, end, account_ids=account_ids)

    def page_records_for_range(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        self.page_calls += 1
        return super().page_records_for_range(*args, **kwargs)


def _build(tmp_path: Path) -> tuple[_SpyRepository, RequestAuditService]:
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = _SpyRepository(database)
    client = MagicMock()
    client.get_accounts_by_ids = AsyncMock(return_value=[])
    service = RequestAuditService(
        settings=Settings(_env_file=None),
        client=client,
        repository=repository,
    )
    return repository, service


def _record(now, **values):
    index = str(values.get("upstream_id") or "1")
    payload = {
        "upstream_id": index,
        "request_id": f"req-{index}",
        "day_key": now.date().isoformat(),
        "provider": "grok_build",
        "operation": "chat",
        "model_public_id": "grok-4.6",
        "model_upstream_model": "Build/grok-4.6",
        "account_id": 7,
        "account_name": "alice",
        "client_key_id": "9",
        "client_key_name": "production",
        "egress_node_id": 3,
        "egress_node_name": "node-3",
        "egress_ip": "",
        "egress_mode": "",
        "egress_scope": "",
        "status_code": 200,
        "streaming": False,
        "input_tokens": 0,
        "media_input_images": 0,
        "output_tokens": 155,
        "reasoning_tokens": 0,
        "reasoning_tokens_reported": True,
        "total_tokens": 155,
        "first_token_ms": 100,
        "duration_ms": 1100,
        "tps": 40,
        "risk_level": "normal",
        "risk_reasons": [],
        "raw": {"huge": "x" * 4000},
        "created_at": now,
        "fetched_at": now,
    }
    payload.update(values)
    return payload


def test_records_for_range_skip_raw_blob(tmp_path: Path):
    repository, _service = _build(tmp_path)
    now = utc_now()
    repository.upsert_records([_record(now, upstream_id="1")])

    rows = repository.records_for_range(now - timedelta(hours=1), now + timedelta(hours=1))
    assert len(rows) == 1
    assert "raw" not in rows[0]
    assert rows[0]["upstream_id"] == "1"
    assert rows[0]["account_name"] == "alice"


async def test_list_page_sql_path_paginates_without_full_window_scan(tmp_path: Path):
    repository, service = _build(tmp_path)
    now = utc_now()
    repository.upsert_records(
        [
            _record(
                now,
                upstream_id=str(index),
                account_id=7 if index <= 12 else 8,
                account_name="alice" if index <= 12 else "bob",
                created_at=now - timedelta(seconds=25 - index),
            )
            for index in range(1, 26)
        ]
    )

    page = await service.list_page(page=1, page_size=10, window_preset="7d")
    assert page["total"] == 25
    assert [item["id"] for item in page["items"]] == [str(index) for index in range(25, 15, -1)]
    assert repository.page_calls == 1
    assert repository.range_account_ids
    assert all(account_ids is not None for account_ids in repository.range_account_ids)
    assert set(repository.range_account_ids[0]) <= {7, 8}


async def test_list_page_keeps_reasoning_streak_from_rows_outside_page(tmp_path: Path):
    repository, service = _build(tmp_path)
    now = utc_now()
    repository.upsert_records(
        [
            _record(
                now,
                upstream_id=str(index),
                created_at=now - timedelta(seconds=12 - index),
            )
            for index in range(1, 13)
        ]
    )

    page = await service.list_page(page=1, page_size=10, window_preset="7d")
    assert page["total"] == 12
    assert [item["id"] for item in page["items"]] == [str(index) for index in range(12, 2, -1)]
    newest = page["items"][0]
    oldest_on_page = page["items"][-1]
    assert newest["id"] == "12"
    assert newest["reasoningZeroStreak"] == 12
    assert oldest_on_page["id"] == "3"
    assert oldest_on_page["reasoningZeroStreak"] == 3


async def test_list_page_sql_filters_match_python_filters(tmp_path: Path):
    repository, service = _build(tmp_path)
    now = utc_now()
    repository.upsert_records(
        [
            _record(
                now,
                upstream_id="1",
                request_id="req-12",
                account_id=12,
                account_name="alice",
                client_key_id="9",
                client_key_name="production",
                created_at=now,
            ),
            _record(
                now,
                upstream_id="2",
                request_id="req-120",
                account_id=120,
                account_name="alice-120",
                client_key_id="11",
                client_key_name="staging",
                created_at=now - timedelta(seconds=1),
            ),
            _record(
                now,
                upstream_id="3",
                request_id="req-special",
                account_id=5,
                account_name="100%_prod",
                client_key_id="",
                client_key_name="",
                created_at=now - timedelta(seconds=2),
            ),
            _record(
                now,
                upstream_id="4",
                request_id="req-wildcard",
                account_id=6,
                account_name="100X_prod",
                client_key_id="13",
                client_key_name="other",
                created_at=now - timedelta(seconds=3),
            ),
        ]
    )
    window = service.resolve_window(window_preset="7d")
    start, end = window["start"], window["end"]
    all_rows = repository.records_for_range(start, end)
    cases = [
        {"account": "12"},
        {"account": "alice"},
        {"account": "100%_prod"},
        {"client_key": "production"},
        {"client_key": "unlabeled"},
        {"account_id": 12},
        {"egress_node_id": 3},
    ]
    for kwargs in cases:
        python_rows = RequestAuditService._apply_ledger_row_filters(all_rows, **kwargs)
        python_rows.sort(
            key=lambda item: (item["created_at"], str(item.get("upstream_id") or "")),
            reverse=True,
        )
        sql_rows = repository.page_records_for_range(
            start,
            end,
            limit=50,
            offset=0,
            **kwargs,
        )
        sql_count = repository.count_records_for_range(start, end, **kwargs)
        assert [row["upstream_id"] for row in sql_rows] == [
            row["upstream_id"] for row in python_rows
        ], kwargs
        assert sql_count == len(python_rows), kwargs

    page = await service.list_page(page=1, page_size=50, account="12", window_preset="7d")
    assert {item["accountId"] for item in page["items"]} == {12, 120}
    unlabeled = await service.list_page(
        page=1,
        page_size=50,
        client_key="unlabeled",
        window_preset="7d",
    )
    assert unlabeled["total"] == 1
    assert unlabeled["items"][0]["id"] == "3"
    assert unlabeled["clientKeys"][-1] == {"id": "unlabeled", "name": "未记录 Key"}


async def test_list_page_risk_filter_still_scans_window(tmp_path: Path):
    repository, service = _build(tmp_path)
    now = utc_now()
    repository.upsert_records(
        [
            _record(
                now,
                upstream_id=str(index),
                created_at=now - timedelta(seconds=4 - index),
            )
            for index in range(1, 5)
        ]
    )

    page = await service.list_page(page=1, page_size=50, risk="high", window_preset="7d")
    assert repository.page_calls == 0
    assert None in repository.range_account_ids
    assert page["total"] >= 1
    assert all(item["riskLevel"] == "high" for item in page["items"])
    assert page["items"][0]["reasoningZeroStreak"] == 4
