from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import defer

from app.core.clock import to_app_timezone, utc_now

from .database import Database
from .models import (
    AccountAssessment,
    MetadataRow,
    RequestAuditAccountVerification,
    RequestAuditRecord,
    RequestAuditScanState,
    model_dict,
)

RETRYABLE_VERIFICATION_STATUSES = frozenset(
    {"pending", "flagged", "clean", "sso_skipped", "session_confirmed"}
)
RETRYABLE_VERIFICATION_ACTIONS = frozenset(
    {
        "pending",
        "action_failed",
        "task_protected",
        "auto_quarantine_disabled",
        "deprioritize_failed",
        "deprioritize_disabled",
        "deprioritized",
        "already_deprioritized",
        "already_quarantined",
    }
)


class RequestAuditRepository:
    """Persistence boundary for the retained local request-audit projection."""

    def __init__(self, database: Database):
        self.database = database

    def get_state(self, scope: str = "grok_build_today") -> dict[str, Any] | None:
        with self.database.session() as session:
            value = session.get(RequestAuditScanState, scope)
            return model_dict(value) if value else None

    def save_state(self, scope: str, values: dict[str, Any]) -> dict[str, Any]:
        with self.database.transaction() as session:
            value = session.get(RequestAuditScanState, scope)
            if value is None:
                value = RequestAuditScanState(scope=scope)
                session.add(value)
            for key, item in values.items():
                if hasattr(value, key):
                    setattr(value, key, item)
            value.updated_at = utc_now()
            session.flush()
            return model_dict(value)

    def existing_ids(self, upstream_ids: Iterable[str]) -> set[str]:
        values = {str(item) for item in upstream_ids if str(item)}
        if not values:
            return set()
        with self.database.session() as session:
            rows = session.scalars(
                select(RequestAuditRecord.upstream_id).where(
                    RequestAuditRecord.upstream_id.in_(values)
                )
            ).all()
        return set(rows)

    def upsert_records(self, records: Iterable[dict[str, Any]]) -> int:
        # De-duplicate a page before opening the transaction. Audit rows are
        # immutable after grok2api publishes them, so conflicts can be ignored.
        unique: dict[str, dict[str, Any]] = {}
        for record in records:
            key = str(record.get("upstream_id") or "").strip()
            if key:
                unique[key] = record
        if not unique:
            return 0

        columns = {
            "upstream_id",
            "request_id",
            "day_key",
            "provider",
            "operation",
            "model_public_id",
            "model_upstream_model",
            "account_id",
            "account_name",
            "client_key_id",
            "client_key_name",
            "egress_node_id",
            "egress_node_name",
            "egress_ip",
            "egress_mode",
            "egress_scope",
            "status_code",
            "error_code",
            "streaming",
            "input_tokens",
            "media_input_images",
            "output_tokens",
            "reasoning_tokens",
            "reasoning_tokens_reported",
            "total_tokens",
            "first_token_ms",
            "duration_ms",
            "tps",
            "risk_level",
            "risk_reasons",
            "raw",
            "created_at",
            "fetched_at",
        }
        payloads = [
            {key: item for key, item in record.items() if key in columns}
            for record in unique.values()
        ]
        with self.database.transaction() as session:
            result = session.execute(
                sqlite_insert(RequestAuditRecord.__table__)
                .on_conflict_do_nothing(index_elements=["upstream_id"]),
                payloads,
            )
            return max(0, int(result.rowcount or 0))

    def refresh_media_input_counts(self, items: Iterable[dict[str, Any]]) -> int:
        values: dict[str, int] = {}
        for item in items:
            upstream_id = str(item.get("id") or item.get("requestId") or "").strip()
            try:
                count = max(0, int(item.get("mediaInputImages") or 0))
            except (TypeError, ValueError, OverflowError):
                count = 0
            if upstream_id and count > 0:
                values[upstream_id] = count
        if not values:
            return 0
        updated = 0
        with self.database.transaction() as session:
            for upstream_id, count in values.items():
                result = session.execute(
                    update(RequestAuditRecord)
                    .where(
                        RequestAuditRecord.upstream_id == upstream_id,
                        RequestAuditRecord.media_input_images != count,
                    )
                    .values(media_input_images=count)
                )
                updated += int(result.rowcount or 0)
        return updated

    def refresh_client_keys(self, items: Iterable[dict[str, Any]]) -> int:
        values: dict[str, tuple[str, str]] = {}
        for item in items:
            upstream_id = str(item.get("id") or item.get("requestId") or "").strip()
            key_id = str(item.get("clientKeyId") or "").strip()
            if key_id == "0":
                key_id = ""
            key_name = str(item.get("clientKeyName") or "").strip()[:160]
            if upstream_id and (key_id or key_name):
                values[upstream_id] = (key_id[:64], key_name)
        if not values:
            return 0
        updated = 0
        with self.database.transaction() as session:
            for upstream_id, (key_id, key_name) in values.items():
                result = session.execute(
                    update(RequestAuditRecord)
                    .where(
                        RequestAuditRecord.upstream_id == upstream_id,
                        or_(
                            RequestAuditRecord.client_key_id != key_id,
                            RequestAuditRecord.client_key_name != key_name,
                        ),
                    )
                    .values(client_key_id=key_id, client_key_name=key_name)
                )
                updated += int(result.rowcount or 0)
        return updated

    def metadata_value(self, key: str) -> str:
        with self.database.session() as session:
            value = session.get(MetadataRow, str(key))
            return str(value.value or "") if value else ""

    def set_metadata_value(self, key: str, value: str) -> None:
        with self.database.transaction() as session:
            row = session.get(MetadataRow, str(key))
            if row is None:
                session.add(MetadataRow(key=str(key), value=str(value)))
            else:
                row.value = str(value)

    def create_verification(self, values: dict[str, Any]) -> dict[str, Any]:
        """Create durable pending evidence without duplicating an audit trigger."""

        audit_upstream_id = str(values.get("audit_upstream_id") or "").strip()
        if not audit_upstream_id:
            raise ValueError("请求审计复检缺少审计 ID")
        columns = {
            "account_id",
            "audit_upstream_id",
            "audit_created_at",
            "audit_tps",
            "status",
            "sso_verdict",
            "bot_flag",
            "proxy_used",
            "valid_session",
            "email_match",
            "status_code",
            "response_ms",
            "check_error",
            "action_status",
            "action_error",
            "egress_recommendation",
            "previous_priority",
            "applied_priority",
            "checked_at",
            "created_at",
            "updated_at",
        }
        now = utc_now()
        payload = {key: item for key, item in values.items() if key in columns}
        payload.update(
            {
                "audit_upstream_id": audit_upstream_id,
                "created_at": payload.get("created_at") or now,
                "updated_at": now,
            }
        )
        with self.database.transaction() as session:
            session.execute(
                sqlite_insert(RequestAuditAccountVerification.__table__)
                .values(**payload)
                .on_conflict_do_nothing(index_elements=["audit_upstream_id"])
            )
            value = session.scalar(
                select(RequestAuditAccountVerification).where(
                    RequestAuditAccountVerification.audit_upstream_id
                    == audit_upstream_id
                )
            )
            if value is None:
                raise RuntimeError("请求审计复检记录创建失败")
            return model_dict(value)

    def update_verification(
        self,
        audit_upstream_id: str,
        values: dict[str, Any],
    ) -> dict[str, Any] | None:
        allowed = {
            "status",
            "sso_verdict",
            "bot_flag",
            "proxy_used",
            "valid_session",
            "email_match",
            "status_code",
            "response_ms",
            "check_error",
            "action_status",
            "action_error",
            "egress_recommendation",
            "previous_priority",
            "applied_priority",
            "checked_at",
        }
        with self.database.transaction() as session:
            value = session.scalar(
                select(RequestAuditAccountVerification).where(
                    RequestAuditAccountVerification.audit_upstream_id
                    == str(audit_upstream_id)
                )
            )
            if value is None:
                return None
            for key, item in values.items():
                if key in allowed:
                    setattr(value, key, item)
            value.updated_at = utc_now()
            session.flush()
            return model_dict(value)

    def clear_egress_recommendations_for_account(self, account_id: int) -> int:
        """Remove stale change-egress hints after a later decisive SSO verdict."""

        with self.database.transaction() as session:
            result = session.execute(
                update(RequestAuditAccountVerification)
                .where(RequestAuditAccountVerification.account_id == int(account_id))
                .values(egress_recommendation={}, updated_at=utc_now())
            )
            return int(result.rowcount or 0)

    def set_action_for_account_statuses(
        self,
        account_id: int,
        *,
        statuses: set[str],
        action_status: str,
        action_error: str = "",
    ) -> int:
        """Apply one action result to historical verdict rows for global UI state."""

        if not statuses:
            return 0
        with self.database.transaction() as session:
            result = session.execute(
                update(RequestAuditAccountVerification)
                .where(
                    RequestAuditAccountVerification.account_id == int(account_id),
                    RequestAuditAccountVerification.status.in_(statuses),
                )
                .values(
                    action_status=str(action_status),
                    action_error=str(action_error)[:1000],
                    updated_at=utc_now(),
                )
            )
            return int(result.rowcount or 0)

    def verifications_for_audits(
        self,
        audit_upstream_ids: Iterable[str],
    ) -> dict[str, dict[str, Any]]:
        values = {
            str(item).strip() for item in audit_upstream_ids if str(item).strip()
        }
        if not values:
            return {}
        with self.database.session() as session:
            rows = session.scalars(
                select(RequestAuditAccountVerification).where(
                    RequestAuditAccountVerification.audit_upstream_id.in_(values)
                )
            ).all()
            return {
                str(row.audit_upstream_id): model_dict(row) for row in rows
            }

    def latest_verifications_for_accounts(
        self,
        account_ids: Iterable[int],
    ) -> dict[int, dict[str, Any]]:
        normalized = {int(item) for item in account_ids if int(item) > 0}
        if not normalized:
            return {}
        with self.database.session() as session:
            rows = session.scalars(
                select(RequestAuditAccountVerification)
                .where(RequestAuditAccountVerification.account_id.in_(normalized))
                .order_by(
                    RequestAuditAccountVerification.account_id.asc(),
                    func.coalesce(
                        RequestAuditAccountVerification.checked_at,
                        RequestAuditAccountVerification.updated_at,
                    ).desc(),
                    RequestAuditAccountVerification.updated_at.desc(),
                    RequestAuditAccountVerification.audit_created_at.desc(),
                    RequestAuditAccountVerification.id.desc(),
                )
            ).all()
        result: dict[int, dict[str, Any]] = {}
        for row in rows:
            result.setdefault(int(row.account_id), model_dict(row))
        return result

    def latest_tps_cooldowns_for_accounts(
        self,
        account_ids: Iterable[int],
    ) -> dict[int, dict[str, Any]]:
        """Return the newest TPS cooldown record per account.

        Active rows stay ``cooled`` until expiry rewrites them to
        ``cooldown_expired``. Either status is enough for the next consecutive
        burst to decide between another cooldown and isolation.
        """

        normalized = {int(item) for item in account_ids if int(item) > 0}
        if not normalized:
            return {}
        with self.database.session() as session:
            rows = session.scalars(
                select(RequestAuditAccountVerification)
                .where(
                    RequestAuditAccountVerification.account_id.in_(normalized),
                    RequestAuditAccountVerification.action_status.in_(
                        ("cooled", "cooldown_expired")
                    ),
                )
                .order_by(
                    RequestAuditAccountVerification.account_id.asc(),
                    func.coalesce(
                        RequestAuditAccountVerification.checked_at,
                        RequestAuditAccountVerification.updated_at,
                    ).desc(),
                    RequestAuditAccountVerification.id.desc(),
                )
            ).all()
        result: dict[int, dict[str, Any]] = {}
        for row in rows:
            account_id = int(row.account_id)
            if account_id in result:
                continue
            payload = model_dict(row)
            recommendation = payload.get("egress_recommendation")
            if (
                not isinstance(recommendation, dict)
                or recommendation.get("kind") != "tps_cooldown"
            ):
                continue
            result[account_id] = payload
        return result

    def cooling_verifications(self) -> list[dict[str, Any]]:
        """Return TPS cooldown rows that still need expiry / re-enable."""

        with self.database.session() as session:
            rows = session.scalars(
                select(RequestAuditAccountVerification).where(
                    RequestAuditAccountVerification.action_status == "cooled"
                )
            ).all()
        values: list[dict[str, Any]] = []
        for row in rows:
            payload = model_dict(row)
            recommendation = payload.get("egress_recommendation")
            if (
                isinstance(recommendation, dict)
                and recommendation.get("kind") == "tps_cooldown"
            ):
                values.append(payload)
        return values

    def retryable_verification_account_ids(self) -> set[int]:
        """Return accounts whose confirmed verdict still needs an action retry.

        Probe isolation can temporarily mark an account as already quarantined.
        Those rows stay retryable after recovery so request-audit can still
        apply a permanent disable. Accounts that are still quarantined are
        excluded here to avoid repeating the same alert on every scan.
        """

        with self.database.session() as session:
            rows = session.scalars(
                select(RequestAuditAccountVerification.account_id)
                .outerjoin(
                    AccountAssessment,
                    AccountAssessment.account_id
                    == RequestAuditAccountVerification.account_id,
                )
                .where(
                    RequestAuditAccountVerification.status.in_(
                        RETRYABLE_VERIFICATION_STATUSES
                    ),
                    RequestAuditAccountVerification.action_status.in_(
                        RETRYABLE_VERIFICATION_ACTIONS
                    ),
                    or_(
                        AccountAssessment.monitor_status.is_(None),
                        AccountAssessment.monitor_status != "quarantined",
                    ),
                )
                .distinct()
            ).all()
        return {int(value) for value in rows if int(value) > 0}

    def delete_older_than(self, cutoff: datetime) -> int:
        with self.database.transaction() as session:
            result = session.execute(
                delete(RequestAuditRecord).where(RequestAuditRecord.created_at < cutoff)
            )
            return int(result.rowcount or 0)

    def refresh_egress_node_details(
        self,
        *,
        day_key: str = "",
        start: datetime | None = None,
        end: datetime | None = None,
        nodes: dict[int, dict[str, Any]],
    ) -> int:
        """Refresh stable node labels and remove legacy IP snapshot backfills.

        grok2api request audits identify the egress node, but they do not retain
        the concrete dynamic IP used by an individual request. Older GrokIQ
        builds copied a node's latest probe IP onto every historical row. Clear
        that derived value so it can no longer be mistaken for request evidence.
        """

        updated = 0
        with self.database.transaction() as session:
            query = select(RequestAuditRecord)
            if start is not None:
                query = query.where(RequestAuditRecord.created_at >= start)
            if end is not None:
                query = query.where(RequestAuditRecord.created_at < end)
            if start is None and end is None and day_key:
                query = query.where(RequestAuditRecord.day_key == day_key)
            values = session.scalars(query).all()
            for value in values:
                changed = False
                if value.egress_ip:
                    value.egress_ip = ""
                    changed = True
                if value.egress_node_id is not None:
                    node = nodes.get(value.egress_node_id, {})
                    current_name = str(node.get("name") or "")
                    if current_name and value.egress_node_name != current_name:
                        value.egress_node_name = current_name
                        changed = True
                if changed:
                    updated += 1
        return updated

    def list_records(
        self,
        *,
        day_key: str = "",
        start: datetime | None = None,
        end: datetime | None = None,
        page: int = 1,
        page_size: int = 50,
        account: str = "",
        egress_node_id: int | None = None,
    ) -> dict[str, Any]:
        page = max(1, page)
        page_size = max(1, min(page_size, 200))
        with self.database.session() as session:
            query = select(RequestAuditRecord)
            count_query = select(func.count()).select_from(RequestAuditRecord)
            if start is not None:
                query = query.where(RequestAuditRecord.created_at >= start)
                count_query = count_query.where(RequestAuditRecord.created_at >= start)
            if end is not None:
                query = query.where(RequestAuditRecord.created_at < end)
                count_query = count_query.where(RequestAuditRecord.created_at < end)
            if start is None and end is None and day_key:
                query = query.where(RequestAuditRecord.day_key == day_key)
                count_query = count_query.where(RequestAuditRecord.day_key == day_key)
            if egress_node_id is not None:
                query = query.where(
                    RequestAuditRecord.egress_node_id == egress_node_id
                )
                count_query = count_query.where(
                    RequestAuditRecord.egress_node_id == egress_node_id
                )
            if account:
                needle = f"%{account.strip()}%"
                account_clause = (
                    RequestAuditRecord.account_name.ilike(needle)
                    | RequestAuditRecord.request_id.ilike(needle)
                )
                try:
                    account_id = int(account.strip())
                except (TypeError, ValueError):
                    account_id = 0
                if account_id > 0:
                    account_clause = account_clause | (RequestAuditRecord.account_id == account_id)
                query = query.where(account_clause)
                count_query = count_query.where(account_clause)
            total = int(session.scalar(count_query) or 0)
            values = session.scalars(
                query.order_by(
                    RequestAuditRecord.created_at.desc(),
                    RequestAuditRecord.upstream_id.desc(),
                )
                .offset((page - 1) * page_size)
                .limit(page_size)
            ).all()
            return {
                "items": [model_dict(value) for value in values],
                "total": total,
                "page": page,
                "page_size": page_size,
            }

    def records_for_day(self, day_key: str) -> list[dict[str, Any]]:
        with self.database.session() as session:
            values = session.scalars(
                _audit_record_query().where(RequestAuditRecord.day_key == day_key)
                .order_by(RequestAuditRecord.created_at.asc(), RequestAuditRecord.upstream_id.asc())
            ).all()
            return [_audit_record_dict(value) for value in values]

    def records_for_range(
        self,
        start: datetime,
        end: datetime,
        *,
        account_ids: Iterable[int] | None = None,
    ) -> list[dict[str, Any]]:
        stmt = _audit_record_query().where(
            RequestAuditRecord.created_at >= start,
            RequestAuditRecord.created_at < end,
        )
        id_values = _positive_account_ids(account_ids)
        if id_values:
            stmt = stmt.where(RequestAuditRecord.account_id.in_(id_values))
        with self.database.session() as session:
            values = session.scalars(
                stmt.order_by(
                    RequestAuditRecord.created_at.asc(),
                    RequestAuditRecord.upstream_id.asc(),
                )
            ).all()
            return [_audit_record_dict(value) for value in values]

    def page_records_for_range(
        self,
        start: datetime,
        end: datetime,
        *,
        limit: int,
        offset: int,
        account: str = "",
        account_id: int | None = None,
        client_key: str = "",
        egress_node_id: int | None = None,
    ) -> list[dict[str, Any]]:
        stmt = _filtered_audit_record_query(
            start,
            end,
            account=account,
            account_id=account_id,
            client_key=client_key,
            egress_node_id=egress_node_id,
        ).order_by(
            RequestAuditRecord.created_at.desc(),
            RequestAuditRecord.upstream_id.desc(),
        )
        with self.database.session() as session:
            values = session.scalars(stmt.offset(max(0, offset)).limit(max(1, limit))).all()
            return [_audit_record_dict(value) for value in values]

    def count_records_for_range(
        self,
        start: datetime,
        end: datetime,
        *,
        account: str = "",
        account_id: int | None = None,
        client_key: str = "",
        egress_node_id: int | None = None,
    ) -> int:
        stmt = select(func.count()).select_from(RequestAuditRecord).where(
            *_ledger_filter_clauses(
                start,
                end,
                account=account,
                account_id=account_id,
                client_key=client_key,
                egress_node_id=egress_node_id,
            )
        )
        with self.database.session() as session:
            return int(session.scalar(stmt) or 0)

    def client_key_pairs_for_range(
        self,
        start: datetime,
        end: datetime,
    ) -> list[dict[str, Any]]:
        stmt = (
            select(
                RequestAuditRecord.client_key_id,
                RequestAuditRecord.client_key_name,
            )
            .where(
                RequestAuditRecord.created_at >= start,
                RequestAuditRecord.created_at < end,
            )
            .distinct()
        )
        with self.database.session() as session:
            return [
                {
                    "client_key_id": str(row[0] or ""),
                    "client_key_name": str(row[1] or ""),
                }
                for row in session.execute(stmt).all()
            ]

    def count_for_day(self, day_key: str) -> int:
        with self.database.session() as session:
            return int(
                session.scalar(
                    select(func.count()).select_from(RequestAuditRecord).where(
                        RequestAuditRecord.day_key == day_key
                    )
                )
                or 0
            )

    def count_for_range(self, start: datetime, end: datetime) -> int:
        with self.database.session() as session:
            return int(
                session.scalar(
                    select(func.count()).select_from(RequestAuditRecord).where(
                        RequestAuditRecord.created_at >= start,
                        RequestAuditRecord.created_at < end,
                    )
                )
                or 0
            )

    def available_range(self) -> dict[str, Any]:
        with self.database.session() as session:
            row = session.execute(
                select(
                    func.min(RequestAuditRecord.created_at),
                    func.max(RequestAuditRecord.created_at),
                    func.count(),
                )
            ).one()
            return {
                "start": row[0],
                "end": row[1],
                "records": int(row[2] or 0),
            }

    @staticmethod
    def state_defaults(scope: str = "grok_build_today") -> dict[str, Any]:
        return {
            "scope": scope,
            "day_key": "",
            "newest_upstream_id": "",
            "newest_created_at": None,
            "initial_cursor": "",
            "initial_complete": False,
            "last_scan_at": None,
            "last_success_at": None,
            "last_error": "",
            "last_pages": 0,
            "last_new_records": 0,
            "last_seen_records": 0,
        }

    def ensure_state(self, scope: str = "grok_build_today") -> dict[str, Any]:
        return self.get_state(scope) or self.state_defaults(scope)

    def reset_day(self, scope: str, day_key: str) -> dict[str, Any]:
        return self.save_state(
            scope,
            {
                "day_key": day_key,
                "newest_upstream_id": "",
                "newest_created_at": None,
                "initial_cursor": "",
                "initial_complete": False,
                "last_scan_at": None,
                "last_success_at": None,
                "last_error": "",
                "last_pages": 0,
                "last_new_records": 0,
                "last_seen_records": 0,
            },
        )

    @staticmethod
    def retention_cutoff(days: int = 3) -> datetime:
        return utc_now() - timedelta(days=max(1, days))

def _audit_record_query():
    return select(RequestAuditRecord).options(defer(RequestAuditRecord.raw))


def _audit_record_dict(value: RequestAuditRecord) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for column in value.__table__.columns:
        if column.name == "raw":
            continue
        item = getattr(value, column.name)
        result[column.name] = (
            to_app_timezone(item) if isinstance(item, datetime) else item
        )
    return result


def _positive_account_ids(account_ids: Iterable[int] | None) -> list[int]:
    values: list[int] = []
    seen: set[int] = set()
    for item in account_ids or ():
        try:
            account_id = int(item)
        except (TypeError, ValueError, OverflowError):
            continue
        if account_id > 0 and account_id not in seen:
            seen.add(account_id)
            values.append(account_id)
    return values


def _contains_pattern(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _ledger_filter_clauses(
    start: datetime,
    end: datetime,
    *,
    account: str = "",
    account_id: int | None = None,
    client_key: str = "",
    egress_node_id: int | None = None,
):
    clauses = [
        RequestAuditRecord.created_at >= start,
        RequestAuditRecord.created_at < end,
    ]
    if account_id is not None:
        clauses.append(RequestAuditRecord.account_id == account_id)
    account_needle = account.strip().casefold()
    if account_needle:
        pattern = _contains_pattern(account_needle)
        account_match = [
            func.lower(RequestAuditRecord.account_name).like(pattern, escape="\\"),
            func.lower(RequestAuditRecord.request_id).like(pattern, escape="\\"),
            func.lower(RequestAuditRecord.client_key_name).like(pattern, escape="\\"),
            func.lower(RequestAuditRecord.client_key_id).like(pattern, escape="\\"),
        ]
        try:
            account_id_filter = int(account_needle)
        except ValueError:
            account_id_filter = 0
        if account_id_filter > 0:
            account_match.append(RequestAuditRecord.account_id == account_id_filter)
        clauses.append(or_(*account_match))
    client_key_needle = client_key.strip()
    if client_key_needle == "unlabeled":
        clauses.append(RequestAuditRecord.client_key_id == "")
        clauses.append(RequestAuditRecord.client_key_name == "")
    elif client_key_needle:
        clauses.append(
            or_(
                RequestAuditRecord.client_key_id == client_key_needle,
                RequestAuditRecord.client_key_name == client_key_needle,
            )
        )
    if egress_node_id is not None:
        clauses.append(RequestAuditRecord.egress_node_id == egress_node_id)
    return tuple(clauses)


def _filtered_audit_record_query(
    start: datetime,
    end: datetime,
    *,
    account: str = "",
    account_id: int | None = None,
    client_key: str = "",
    egress_node_id: int | None = None,
):
    return _audit_record_query().where(
        *_ledger_filter_clauses(
            start,
            end,
            account=account,
            account_id=account_id,
            client_key=client_key,
            egress_node_id=egress_node_id,
        )
    )
