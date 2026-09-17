from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import case, func, or_, select, update

from app.core.clock import utc_now

from .database import Database
from .models import ClientKeyRecord, model_dict

PLAN_TYPES = ("none", "day", "week", "month")
MAX_RECHARGE_CENTS = 100_000_000_00


class ClientKeyRepository:
    """ORM persistence for grok2api Client Key snapshots and paid marks."""

    def __init__(self, database: Database):
        self.database = database

    def get(self, key_id: str) -> dict[str, Any] | None:
        normalized = _key_id(key_id)
        if not normalized:
            return None
        with self.database.session() as session:
            record = session.get(ClientKeyRecord, normalized)
            return model_dict(record) if record else None

    def list_keys(
        self,
        *,
        query: str = "",
        paid: str = "",
        plan_type: str = "",
        enabled: str = "",
        upstream: str = "",
        offset: int = 0,
        limit: int = 50,
    ) -> tuple[list[dict[str, Any]], int]:
        filters = _list_filters(
            query=query,
            paid=paid,
            plan_type=plan_type,
            enabled=enabled,
            upstream=upstream,
        )
        with self.database.session() as session:
            total = session.scalar(
                select(func.count()).select_from(ClientKeyRecord).where(*filters)
            )
            values = session.scalars(
                select(ClientKeyRecord)
                .where(*filters)
                .order_by(
                    ClientKeyRecord.paid.desc(),
                    case((ClientKeyRecord.plan_type == "none", 1), else_=0),
                    ClientKeyRecord.plan_type.asc(),
                    ClientKeyRecord.recharge_cents.desc(),
                    ClientKeyRecord.updated_at.desc(),
                    ClientKeyRecord.key_id.asc(),
                )
                .offset(max(0, offset))
                .limit(max(1, limit))
            ).all()
            return [model_dict(value) for value in values], int(total or 0)

    def summarize(
        self,
        *,
        query: str = "",
        paid: str = "",
        plan_type: str = "",
        enabled: str = "",
        upstream: str = "",
    ) -> dict[str, Any]:
        filters = _list_filters(
            query=query,
            paid=paid,
            plan_type=plan_type,
            enabled=enabled,
            upstream=upstream,
        )
        with self.database.session() as session:
            row = session.execute(
                select(
                    func.count().label("total"),
                    func.coalesce(
                        func.sum(case((ClientKeyRecord.paid.is_(True), 1), else_=0)),
                        0,
                    ).label("paid"),
                    func.coalesce(
                        func.sum(case((ClientKeyRecord.paid.is_(False), 1), else_=0)),
                        0,
                    ).label("unpaid"),
                    func.coalesce(
                        func.sum(
                            case((ClientKeyRecord.plan_type == "day", 1), else_=0)
                        ),
                        0,
                    ).label("day"),
                    func.coalesce(
                        func.sum(
                            case((ClientKeyRecord.plan_type == "week", 1), else_=0)
                        ),
                        0,
                    ).label("week"),
                    func.coalesce(
                        func.sum(
                            case((ClientKeyRecord.plan_type == "month", 1), else_=0)
                        ),
                        0,
                    ).label("month"),
                    func.coalesce(
                        func.sum(
                            case((ClientKeyRecord.upstream_missing.is_(True), 1), else_=0)
                        ),
                        0,
                    ).label("missing"),
                    func.coalesce(func.sum(ClientKeyRecord.recharge_cents), 0).label(
                        "recharge"
                    ),
                    func.max(ClientKeyRecord.last_synced_at).label("last_synced_at"),
                ).where(*filters)
            ).one()
            return {
                "total": int(row.total or 0),
                "paid": int(row.paid or 0),
                "unpaid": int(row.unpaid or 0),
                "day": int(row.day or 0),
                "week": int(row.week or 0),
                "month": int(row.month or 0),
                "missing": int(row.missing or 0),
                "recharge_cents": int(row.recharge or 0),
                "last_synced_at": row.last_synced_at,
            }

    def upsert_snapshots(
        self,
        snapshots: list[dict[str, Any]],
        *,
        now: datetime | None = None,
    ) -> dict[str, int]:
        stamp = now or utc_now()
        seen_ids: set[str] = set()
        created = 0
        updated = 0
        with self.database.transaction() as session:
            for snapshot in snapshots:
                key_id = _key_id(snapshot.get("key_id"))
                if not key_id or key_id in seen_ids:
                    continue
                seen_ids.add(key_id)
                record = session.get(ClientKeyRecord, key_id)
                if record is None:
                    record = ClientKeyRecord(
                        key_id=key_id,
                        created_at=stamp,
                        paid=False,
                        plan_type="none",
                        recharge_cents=0,
                        note="",
                    )
                    session.add(record)
                    created += 1
                else:
                    updated += 1
                record.name = str(snapshot.get("name") or "")[:160]
                record.scheme = str(snapshot.get("scheme") or "sk")[:16]
                record.prefix = str(snapshot.get("prefix") or "")[:64]
                record.enabled = bool(snapshot.get("enabled", True))
                record.expires_at = snapshot.get("expires_at")
                record.rpm_limit = int(snapshot.get("rpm_limit") or 0)
                record.max_concurrent = int(snapshot.get("max_concurrent") or 0)
                record.billing_limit_usd_ticks = int(
                    snapshot.get("billing_limit_usd_ticks") or 0
                )
                record.billed_usage_usd_ticks = int(
                    snapshot.get("billed_usage_usd_ticks") or 0
                )
                record.last_used_at = snapshot.get("last_used_at")
                record.upstream_created_at = snapshot.get("upstream_created_at")
                record.last_synced_at = stamp
                record.upstream_missing = False
                record.updated_at = stamp
            if seen_ids:
                session.execute(
                    update(ClientKeyRecord)
                    .where(
                        ClientKeyRecord.upstream_missing.is_(False),
                        ClientKeyRecord.key_id.notin_(seen_ids),
                    )
                    .values(upstream_missing=True, updated_at=stamp)
                )
            else:
                session.execute(
                    update(ClientKeyRecord)
                    .where(ClientKeyRecord.upstream_missing.is_(False))
                    .values(upstream_missing=True, updated_at=stamp)
                )
            missing = int(
                session.scalar(
                    select(func.count())
                    .select_from(ClientKeyRecord)
                    .where(ClientKeyRecord.upstream_missing.is_(True))
                )
                or 0
            )
        return {
            "fetched": len(seen_ids),
            "created": created,
            "updated": updated,
            "missing": missing,
        }

    def update_local(
        self,
        key_id: str,
        *,
        paid: bool | None = None,
        plan_type: str | None = None,
        recharge_cents: int | None = None,
        note: str | None = None,
    ) -> dict[str, Any] | None:
        normalized = _key_id(key_id)
        if not normalized:
            return None
        with self.database.transaction() as session:
            record = session.get(ClientKeyRecord, normalized)
            if record is None:
                return None
            if paid is not None:
                record.paid = bool(paid)
                if not record.paid:
                    record.plan_type = "none"
            if plan_type is not None:
                record.plan_type = _plan_type(plan_type, paid=record.paid)
            elif paid is True and record.plan_type == "none":
                raise ValueError("付费用户需要选择天卡、周卡或月卡")
            if recharge_cents is not None:
                record.recharge_cents = _recharge_cents(recharge_cents)
            if note is not None:
                record.note = str(note or "")[:500]
            record.updated_at = utc_now()
            session.flush()
            return model_dict(record)

    def apply_snapshot(
        self,
        snapshot: dict[str, Any],
        *,
        now: datetime | None = None,
    ) -> dict[str, Any] | None:
        key_id = _key_id(snapshot.get("key_id"))
        if not key_id:
            return None
        stamp = now or utc_now()
        with self.database.transaction() as session:
            record = session.get(ClientKeyRecord, key_id)
            if record is None:
                record = ClientKeyRecord(
                    key_id=key_id,
                    created_at=stamp,
                    paid=False,
                    plan_type="none",
                    recharge_cents=0,
                    note="",
                )
                session.add(record)
            _apply_snapshot_fields(record, snapshot, stamp=stamp)
            session.flush()
            return model_dict(record)

    def list_ids(
        self,
        *,
        query: str = "",
        paid: str = "",
        plan_type: str = "",
        enabled: str = "",
        upstream: str = "",
        limit: int = 500,
    ) -> tuple[list[str], int]:
        filters = _list_filters(
            query=query,
            paid=paid,
            plan_type=plan_type,
            enabled=enabled,
            upstream=upstream,
        )
        capped = max(1, min(int(limit or 500), 500))
        with self.database.session() as session:
            total = session.scalar(
                select(func.count()).select_from(ClientKeyRecord).where(*filters)
            )
            values = session.scalars(
                select(ClientKeyRecord.key_id)
                .where(*filters)
                .order_by(
                    ClientKeyRecord.paid.desc(),
                    case((ClientKeyRecord.plan_type == "none", 1), else_=0),
                    ClientKeyRecord.plan_type.asc(),
                    ClientKeyRecord.recharge_cents.desc(),
                    ClientKeyRecord.updated_at.desc(),
                    ClientKeyRecord.key_id.asc(),
                )
                .limit(capped)
            ).all()
            return [str(value) for value in values], int(total or 0)

    def list_paid_present(self, *, limit: int = 10_000) -> list[dict[str, Any]]:
        rows, _total = self.list_keys(
            paid="paid",
            upstream="present",
            offset=0,
            limit=max(1, min(int(limit or 10_000), 10_000)),
        )
        return rows

    def set_enabled_many(self, key_ids: list[str], enabled: bool) -> int:
        ids = [_key_id(value) for value in key_ids]
        ids = [value for value in ids if value]
        if not ids:
            return 0
        stamp = utc_now()
        with self.database.transaction() as session:
            result = session.execute(
                update(ClientKeyRecord)
                .where(ClientKeyRecord.key_id.in_(ids))
                .values(enabled=bool(enabled), updated_at=stamp)
            )
            return int(result.rowcount or 0)

    def delete(self, key_id: str) -> bool:
        normalized = _key_id(key_id)
        if not normalized:
            return False
        with self.database.transaction() as session:
            record = session.get(ClientKeyRecord, normalized)
            if record is None:
                return False
            session.delete(record)
            return True

    def delete_many(self, key_ids: list[str]) -> int:
        ids = [_key_id(value) for value in key_ids]
        ids = [value for value in ids if value]
        if not ids:
            return 0
        deleted = 0
        with self.database.transaction() as session:
            records = session.scalars(
                select(ClientKeyRecord).where(ClientKeyRecord.key_id.in_(ids))
            ).all()
            for record in records:
                session.delete(record)
                deleted += 1
        return deleted


def _apply_snapshot_fields(
    record: ClientKeyRecord, snapshot: dict[str, Any], *, stamp: datetime
) -> None:
    record.name = str(snapshot.get("name") or "")[:160]
    record.scheme = str(snapshot.get("scheme") or "sk")[:16]
    record.prefix = str(snapshot.get("prefix") or "")[:64]
    record.enabled = bool(snapshot.get("enabled", True))
    record.expires_at = snapshot.get("expires_at")
    record.rpm_limit = int(snapshot.get("rpm_limit") or 0)
    record.max_concurrent = int(snapshot.get("max_concurrent") or 0)
    record.billing_limit_usd_ticks = int(
        snapshot.get("billing_limit_usd_ticks") or 0
    )
    record.billed_usage_usd_ticks = int(
        snapshot.get("billed_usage_usd_ticks") or 0
    )
    record.last_used_at = snapshot.get("last_used_at")
    if snapshot.get("upstream_created_at") is not None:
        record.upstream_created_at = snapshot.get("upstream_created_at")
    record.last_synced_at = stamp
    record.upstream_missing = False
    record.updated_at = stamp


def _list_filters(
    *,
    query: str,
    paid: str,
    plan_type: str,
    enabled: str,
    upstream: str,
) -> list[Any]:
    filters: list[Any] = []
    needle = "".join(ch for ch in (query or "").strip() if ch not in "%_")[:80]
    if needle:
        filters.append(
            or_(
                ClientKeyRecord.key_id.contains(needle),
                ClientKeyRecord.name.contains(needle),
                ClientKeyRecord.prefix.contains(needle),
                ClientKeyRecord.note.contains(needle),
            )
        )
    paid_filter = str(paid or "").strip().lower()
    if paid_filter in {"true", "1", "paid"}:
        filters.append(ClientKeyRecord.paid.is_(True))
    elif paid_filter in {"false", "0", "unpaid"}:
        filters.append(ClientKeyRecord.paid.is_(False))
    plan_filter = str(plan_type or "").strip().lower()
    if plan_filter in PLAN_TYPES:
        filters.append(ClientKeyRecord.plan_type == plan_filter)
    enabled_filter = str(enabled or "").strip().lower()
    if enabled_filter in {"true", "1", "enabled"}:
        filters.append(ClientKeyRecord.enabled.is_(True))
    elif enabled_filter in {"false", "0", "disabled"}:
        filters.append(ClientKeyRecord.enabled.is_(False))
    upstream_filter = str(upstream or "").strip().lower()
    if upstream_filter in {"missing", "gone"}:
        filters.append(ClientKeyRecord.upstream_missing.is_(True))
    elif upstream_filter in {"present", "synced"}:
        filters.append(ClientKeyRecord.upstream_missing.is_(False))
    return filters


def _key_id(value: Any) -> str:
    return str(value or "").strip()[:64]


def _plan_type(value: Any, *, paid: bool) -> str:
    plan = str(value or "").strip().lower()
    if plan not in PLAN_TYPES:
        raise ValueError("卡种仅支持天卡、周卡或月卡")
    if paid and plan == "none":
        raise ValueError("付费用户需要选择天卡、周卡或月卡")
    if not paid:
        return "none"
    return plan


def _recharge_cents(value: Any) -> int:
    try:
        cents = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("累计充值需为非负数") from exc
    if cents < 0 or cents > MAX_RECHARGE_CENTS:
        raise ValueError("累计充值需在 0 到 100000000 元之间")
    return cents
