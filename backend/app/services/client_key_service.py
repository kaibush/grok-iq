from __future__ import annotations

from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, NoReturn

from app.core.clock import app_isoformat, parse_optional_datetime, utc_now
from app.core.config import Settings
from app.core.probe_resources import is_probe_resource
from app.integrations.grok2api.client import Grok2APIClient, IntegrationError
from app.persistence.client_key_repository import PLAN_TYPES, ClientKeyRepository

USD_TICKS = 10_000_000_000
MAX_BILLING_USD = 900_000
MAX_BILLING_LIMIT_TICKS = 9_000_000_000_000_000
YUAN_CENTS = Decimal("100")
MAX_RECHARGE_YUAN = Decimal("100000000")
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

    def list_ids(
        self,
        *,
        query: str = "",
        paid: str = "",
        plan_type: str = "",
        enabled: str = "",
        upstream: str = "",
    ) -> dict[str, Any]:
        ids, total = self.repository.list_ids(
            query=query,
            paid=paid,
            plan_type=plan_type,
            enabled=enabled,
            upstream=upstream,
            limit=500,
        )
        return {
            "ids": ids,
            "total": total,
            "truncated": total > len(ids),
        }

    async def update_key(
        self,
        key_id: str,
        *,
        paid: bool | None = None,
        plan_type: str | None = None,
        recharge_yuan: Decimal | float | int | str | None = None,
        note: str | None = None,
        name: str | None = None,
        enabled: bool | None = None,
        expires_at: str | None = None,
        set_expires_at: bool = False,
        rpm_limit: int | None = None,
        max_concurrent: int | None = None,
        billing_limit_usd: float | int | str | None = None,
    ) -> dict[str, Any]:
        record = self.repository.get(key_id)
        if record is None:
            raise ValueError("密钥不存在，请先从 grok2api 同步")
        has_local = (
            paid is not None
            or plan_type is not None
            or recharge_yuan is not None
            or note is not None
        )
        if has_local:
            _validate_local_paid_update(
                record,
                paid=paid,
                plan_type=plan_type,
            )
        upstream_payload = _upstream_update_payload(
            name=name,
            enabled=enabled,
            expires_at=expires_at,
            set_expires_at=set_expires_at,
            rpm_limit=rpm_limit,
            max_concurrent=max_concurrent,
            billing_limit_usd=billing_limit_usd,
        )
        if upstream_payload:
            try:
                result = await self.client.update_client_key(key_id, upstream_payload)
            except IntegrationError as exc:
                _reraise_client_key_error(exc)
            snapshot = self._snapshot(result)
            if snapshot is None:
                raise ValueError("更新密钥后响应无效")
            applied = self.repository.apply_snapshot(snapshot)
            if applied is None:
                raise ValueError("更新密钥后响应无效")
        if has_local:
            return self._update_local_fields(
                key_id,
                paid=paid,
                plan_type=plan_type,
                recharge_yuan=recharge_yuan,
                note=note,
            )
        updated = self.repository.get(key_id)
        if updated is None:
            raise ValueError("密钥不存在，请先从 grok2api 同步")
        return self.public_key(updated)

    def _update_local_fields(
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
        next_paid, next_plan = _validate_local_paid_update(
            record,
            paid=paid,
            plan_type=plan_type,
        )
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

    async def set_enabled_many(self, ids: list[str], enabled: bool) -> dict[str, Any]:
        key_ids = _normalize_ids(ids)
        if not key_ids:
            raise ValueError("请指定要更新的密钥")
        try:
            result = await self.client.set_client_keys_enabled(key_ids, bool(enabled))
        except IntegrationError as exc:
            _reraise_client_key_error(exc)
        local_updated = self.repository.set_enabled_many(key_ids, bool(enabled))
        updated = _as_int((result or {}).get("updated"), default=local_updated)
        return {"updated": updated}

    async def delete_key(self, key_id: str) -> dict[str, Any]:
        try:
            await self.client.delete_client_key(key_id)
        except IntegrationError as exc:
            if int(exc.status_code or 0) != 404:
                _reraise_client_key_error(exc)
        self.repository.delete(key_id)
        return {"deleted": True}

    async def delete_keys(self, ids: list[str]) -> dict[str, Any]:
        key_ids = _normalize_ids(ids)
        if not key_ids:
            raise ValueError("请指定要删除的密钥")
        try:
            await self.client.delete_client_keys(key_ids)
        except IntegrationError as exc:
            if int(exc.status_code or 0) != 404:
                _reraise_client_key_error(exc)
        deleted = self.repository.delete_many(key_ids)
        return {"deleted": deleted}

    async def get_secret(self, key_id: str) -> dict[str, Any]:
        if self.repository.get(key_id) is None:
            raise ValueError("密钥不存在，请先从 grok2api 同步")
        try:
            secret = await self.client.get_client_key_secret(key_id)
        except IntegrationError as exc:
            _reraise_client_key_error(exc)
        return {"secret": secret}

    async def usage_summary(
        self,
        ids: list[str],
        period: str,
        start: str = "",
        end: str = "",
    ) -> dict[str, Any]:
        key_ids = _normalize_ids(ids)
        if not key_ids:
            raise ValueError("请指定要查看用量的密钥")
        try:
            return await self.client.client_key_usage_summary(
                ids=key_ids,
                period=period,
                start=start,
                end=end,
            )
        except IntegrationError as exc:
            _reraise_client_key_error(exc)

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
            "remainingPercent": remaining_percent(
                billing_limit_ticks, billed_usage_ticks
            ),
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
        return is_probe_resource(name, self.settings.probe_route_prefix)

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


def _validate_local_paid_update(
    record: dict[str, Any],
    *,
    paid: bool | None,
    plan_type: str | None,
) -> tuple[bool, str | None]:
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
    return next_paid, next_plan


def remaining_percent(limit_ticks: int, billed_ticks: int) -> float:
    if int(limit_ticks or 0) <= 0:
        return 0.0
    remaining = max(0, int(limit_ticks) - max(0, int(billed_ticks or 0)))
    percent = remaining / int(limit_ticks) * 100.0
    return max(0.0, min(100.0, percent))


def usd_to_billing_ticks(value: Decimal | float | int | str) -> int:
    try:
        amount = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("额度上限需为有效金额") from exc
    if amount != amount or amount in {float("inf"), float("-inf")}:
        raise ValueError("额度上限需为有效金额")
    if amount < 0 or amount > MAX_BILLING_USD:
        raise ValueError("额度上限需在 0 到 900000 美元之间")
    if amount == 0:
        return 0
    ticks = int(round(amount * USD_TICKS))
    return max(0, min(MAX_BILLING_LIMIT_TICKS, ticks))


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


def _upstream_update_payload(
    *,
    name: str | None,
    enabled: bool | None,
    expires_at: str | None,
    set_expires_at: bool,
    rpm_limit: int | None,
    max_concurrent: int | None,
    billing_limit_usd: float | int | str | None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    if name is not None:
        cleaned = str(name).strip()
        if not cleaned:
            raise ValueError("密钥名称不能为空")
        payload["name"] = cleaned[:160]
    if enabled is not None:
        payload["enabled"] = bool(enabled)
    if set_expires_at:
        text = "" if expires_at is None else str(expires_at).strip()
        if text:
            parsed = parse_optional_datetime(text)
            if parsed is None:
                raise ValueError("过期时间需为 RFC3339 时间")
            payload["expiresAt"] = text
        else:
            payload["expiresAt"] = ""
    if rpm_limit is not None:
        limit = int(rpm_limit)
        if limit < 0 or limit > 100000:
            raise ValueError("RPM 上限需在 0 到 100000 之间")
        payload["rpmLimit"] = limit
    if max_concurrent is not None:
        concurrent = int(max_concurrent)
        if concurrent < 0 or concurrent > 1024:
            raise ValueError("并发上限需在 0 到 1024 之间")
        payload["maxConcurrent"] = concurrent
    if billing_limit_usd is not None:
        payload["billingLimitUsdTicks"] = usd_to_billing_ticks(billing_limit_usd)
    return payload


def _reraise_client_key_error(exc: IntegrationError) -> NoReturn:
    if 400 <= int(exc.status_code or 0) < 500:
        raise ValueError(str(exc)) from exc
    raise exc


def _normalize_ids(values: list[str] | None) -> list[str]:
    ids: list[str] = []
    seen: set[str] = set()
    for value in values or []:
        key_id = str(value or "").strip()
        if not key_id or key_id in seen:
            continue
        seen.add(key_id)
        ids.append(key_id)
    return ids


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


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return int(default or 0)


def _page_window(page: int, page_size: int) -> tuple[int, int, int]:
    resolved_page = max(1, int(page or 1))
    resolved_size = min(100, max(1, int(page_size or 50)))
    return resolved_page, resolved_size, (resolved_page - 1) * resolved_size
