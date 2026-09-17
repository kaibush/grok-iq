from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

from app.core.clock import app_isoformat, parse_optional_datetime, utc_now
from app.core.config import Settings
from app.integrations.grok2api.client import Grok2APIClient
from app.persistence.client_key_repository import PLAN_TYPES, ClientKeyRepository

USD_TICKS = 10_000_000_000
YUAN_CENTS = Decimal("100")
MAX_RECHARGE_YUAN = Decimal("100000000")
PROBE_NAME_MARKER = "-"
INTERNAL_KEY_NAME_PREFIX = "[system]"
INTERNAL_KEY_PREFIXES = frozenset(
    {"quality-guard-internal", "thinking-standby-internal"}
)


class ClientKeyService:
    """Sync grok2api Client Keys and keep local paid-user annotations."""

    def __init__(
        self,
        settings: Settings,
        client: Grok2APIClient,
        repository: ClientKeyRepository,
    ) -> None:
        self.settings = settings
        self.client = client
        self.repository = repository

    async def sync_from_upstream(self) -> dict[str, Any]:
        fetched = await self.client.list_all_client_keys(pageSize=200)
        snapshots: list[dict[str, Any]] = []
        skipped_probe_keys = 0
        skipped_system_keys = 0
        for item in fetched:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "")
            prefix = str(item.get("prefix") or "")
            if self._is_system_key(name, prefix):
                skipped_system_keys += 1
                continue
            snapshot = self._snapshot(item)
            if snapshot is None:
                if self._is_probe_key(name):
                    skipped_probe_keys += 1
                continue
            snapshots.append(snapshot)
        result = self.repository.upsert_snapshots(snapshots, now=utc_now())
        return {
            "fetched": result["fetched"],
            "created": result["created"],
            "updated": result["updated"],
            "missing": result["missing"],
            "skippedProbeKeys": skipped_probe_keys,
            "skippedSystemKeys": skipped_system_keys,
            "syncedAt": app_isoformat(utc_now()),
        }

    def list_keys(
        self,
        *,
        query: str = "",
        paid: str = "",
        plan_type: str = "",
        enabled: str = "",
        upstream: str = "",
        page: int = 1,
        page_size: int = 50,
    ) -> dict[str, Any]:
        resolved_page, resolved_size, offset = _page_window(page, page_size)
        rows, total = self.repository.list_keys(
            query=query,
            paid=paid,
            plan_type=plan_type,
            enabled=enabled,
            upstream=upstream,
            offset=offset,
            limit=resolved_size,
        )
        summary = self.repository.summarize(
            query=query,
            paid=paid,
            plan_type=plan_type,
            enabled=enabled,
            upstream=upstream,
        )
        return {
            "page": resolved_page,
            "pageSize": resolved_size,
            "total": total,
            "items": [self.public_key(row) for row in rows],
            "summary": self._public_summary(summary),
        }

    def update_key(
        self,
        key_id: str,
        *,
        paid: bool | None = None,
        plan_type: str | None = None,
        recharge_yuan: Decimal | float | int | str | None = None,
        note: str | None = None,
    ) -> dict[str, Any]:
        record = self.repository.get(key_id)
        if record is None:
            raise ValueError("密钥不存在，请先从 grok2api 同步")
        next_paid = bool(record.get("paid")) if paid is None else bool(paid)
        if paid is False:
            next_plan: str | None = "none"
        elif plan_type is not None:
            next_plan = plan_type
        elif paid is True and str(record.get("plan_type") or "none") == "none":
            raise ValueError("付费用户需要选择天卡、周卡或月卡")
        else:
            next_plan = None
        if next_paid and next_plan == "none":
            raise ValueError("付费用户需要选择天卡、周卡或月卡")
        updated = self.repository.update_local(
            key_id,
            paid=None if paid is None else next_paid,
            plan_type=next_plan,
            recharge_cents=(
                None if recharge_yuan is None else yuan_to_cents(recharge_yuan)
            ),
            note=note,
        )
        if updated is None:
            raise ValueError("密钥不存在，请先从 grok2api 同步")
        return self.public_key(updated)

    def public_key(self, record: dict[str, Any]) -> dict[str, Any]:
        billing_limit_ticks = int(record.get("billing_limit_usd_ticks") or 0)
        billed_usage_ticks = int(record.get("billed_usage_usd_ticks") or 0)
        unlimited = billing_limit_ticks <= 0
        billing_limit_usd = 0.0 if unlimited else billing_limit_ticks / USD_TICKS
        billed_usage_usd = billed_usage_ticks / USD_TICKS
        remaining_usd = (
            0.0 if unlimited else max(0.0, billing_limit_usd - billed_usage_usd)
        )
        return {
            "id": str(record.get("key_id") or ""),
            "name": str(record.get("name") or ""),
            "scheme": str(record.get("scheme") or "sk"),
            "prefix": str(record.get("prefix") or ""),
            "maskedKey": _mask_key(
                str(record.get("scheme") or "sk"),
                str(record.get("prefix") or ""),
            ),
            "enabled": bool(record.get("enabled", True)),
            "expired": _is_expired(record.get("expires_at")),
            "expiresAt": app_isoformat(_as_datetime(record.get("expires_at"))),
            "rpmLimit": int(record.get("rpm_limit") or 0),
            "maxConcurrent": int(record.get("max_concurrent") or 0),
            "unlimited": unlimited,
            "billingLimitUsd": billing_limit_usd,
            "billedUsageUsd": billed_usage_usd,
            "remainingUsd": remaining_usd,
            "lastUsedAt": app_isoformat(_as_datetime(record.get("last_used_at"))),
            "upstreamCreatedAt": app_isoformat(
                _as_datetime(record.get("upstream_created_at"))
            ),
            "lastSyncedAt": app_isoformat(_as_datetime(record.get("last_synced_at"))),
            "upstreamMissing": bool(record.get("upstream_missing")),
            "paid": bool(record.get("paid")),
            "planType": _public_plan(record.get("plan_type")),
            "rechargeYuan": cents_to_yuan(record.get("recharge_cents")),
            "note": str(record.get("note") or ""),
            "createdAt": app_isoformat(_as_datetime(record.get("created_at"))),
            "updatedAt": app_isoformat(_as_datetime(record.get("updated_at"))),
        }

    def _snapshot(self, item: dict[str, Any]) -> dict[str, Any] | None:
        key_id = str(item.get("id") or "").strip()
        name = str(item.get("name") or "").strip()
        prefix = str(item.get("prefix") or "")[:64]
        if not key_id or self._is_probe_key(name) or self._is_system_key(name, prefix):
            return None
        scheme = str(item.get("scheme") or "sk").strip().lower()
        if scheme not in {"sk", "g2a"}:
            scheme = "sk"
        return {
            "key_id": key_id[:64],
            "name": name[:160],
            "scheme": scheme,
            "prefix": prefix,
            "enabled": bool(item.get("enabled", True)),
            "expires_at": parse_optional_datetime(item.get("expiresAt")),
            "rpm_limit": _as_int(item.get("rpmLimit")),
            "max_concurrent": _as_int(item.get("maxConcurrent")),
            "billing_limit_usd_ticks": _as_int(item.get("billingLimitUsdTicks")),
            "billed_usage_usd_ticks": _as_int(item.get("billedUsageUsdTicks")),
            "last_used_at": parse_optional_datetime(item.get("lastUsedAt")),
            "upstream_created_at": parse_optional_datetime(item.get("createdAt")),
        }

    def _is_probe_key(self, name: str) -> bool:
        prefix = str(self.settings.probe_route_prefix or "").strip()
        if not prefix:
            return False
        return name.startswith(f"{prefix}{PROBE_NAME_MARKER}")

    @staticmethod
    def _is_system_key(name: str, prefix: str = "") -> bool:
        if str(name or "").strip().startswith(INTERNAL_KEY_NAME_PREFIX):
            return True
        return str(prefix or "").strip() in INTERNAL_KEY_PREFIXES

    @staticmethod
    def _public_summary(summary: dict[str, Any]) -> dict[str, Any]:
        return {
            "total": int(summary.get("total") or 0),
            "paid": int(summary.get("paid") or 0),
            "unpaid": int(summary.get("unpaid") or 0),
            "day": int(summary.get("day") or 0),
            "week": int(summary.get("week") or 0),
            "month": int(summary.get("month") or 0),
            "missing": int(summary.get("missing") or 0),
            "rechargeYuan": cents_to_yuan(summary.get("recharge_cents")),
            "lastSyncedAt": app_isoformat(_as_datetime(summary.get("last_synced_at"))),
        }


def yuan_to_cents(value: Decimal | float | int | str) -> int:
    try:
        amount = Decimal(str(value).strip())
    except (InvalidOperation, AttributeError, TypeError, ValueError) as exc:
        raise ValueError("累计充值需为有效金额") from exc
    if not amount.is_finite():
        raise ValueError("累计充值需为有效金额")
    amount = amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if amount < 0 or amount > MAX_RECHARGE_YUAN:
        raise ValueError("累计充值需在 0 到 100000000 元之间")
    cents = int((amount * YUAN_CENTS).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    return cents


def cents_to_yuan(value: Any) -> float:
    try:
        cents = int(value or 0)
    except (TypeError, ValueError):
        cents = 0
    return float((Decimal(cents) / YUAN_CENTS).quantize(Decimal("0.01")))


def _mask_key(scheme: str, prefix: str) -> str:
    if scheme == "g2a":
        return f"g2a_{prefix}_********" if prefix else "g2a_********"
    return f"sk-{prefix}********" if prefix else "sk-********"


def _public_plan(value: Any) -> str:
    plan = str(value or "none").strip().lower()
    return plan if plan in PLAN_TYPES else "none"


def _is_expired(value: Any) -> bool:
    parsed = value if isinstance(value, datetime) else parse_optional_datetime(value)
    if parsed is None:
        return False
    return parsed <= utc_now()


def _as_datetime(value: Any) -> datetime | None:
    return value if isinstance(value, datetime) else parse_optional_datetime(value)


def _as_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _page_window(page: int, page_size: int) -> tuple[int, int, int]:
    resolved_page = max(1, int(page or 1))
    resolved_size = min(100, max(1, int(page_size or 50)))
    return resolved_page, resolved_size, (resolved_page - 1) * resolved_size
