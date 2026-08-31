from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.core.clock import APP_TIMEZONE_NAME, utc_now
from app.integrations.grok2api.client import Grok2APIClient
from app.services.client_key_quota_service import ClientKeyQuotaService

MAX_AUDIT_KEYS = 50
MAX_AUDIT_PAGES = 40
AUDIT_PAGE_SIZE = 200
AUDIT_FETCH_TIMEOUT_SECONDS = 60
AUDIT_FETCH_CONCURRENCY = 8
PUBLIC_USAGE_TTL_SECONDS = 30.0
PUBLIC_DASHBOARD_PERIODS = ("24h", "7d", "30d", "90d")
AUDIT_PERIODS = {
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
    "30d": timedelta(days=30),
    "90d": timedelta(days=90),
}


class ClientKeyUsageService:
    def __init__(
        self,
        client: Grok2APIClient,
        quota_service: ClientKeyQuotaService | None = None,
    ) -> None:
        self.client = client
        self.quota_service = quota_service or ClientKeyQuotaService(client)
        self._public_usage_cache: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}
        self._public_usage_lock = asyncio.Lock()

    async def lookup_public_usage(
        self,
        api_key: str,
        *,
        client_ip: str,
        period: str = "24h",
        start: str = "",
        end: str = "",
    ) -> dict[str, Any]:
        item = await self.quota_service.lookup_item(api_key, client_ip=client_ip)
        if item is None:
            return {"found": False}
        key_id = str(item.get("id") or "")
        if not key_id:
            return {"found": False}
        summary = await self.audit_summary(
            key_ids=[key_id],
            period=period,
            start=start,
            end=end,
        )
        return {
            "found": True,
            "period": summary["period"],
            "sourcePeriod": summary["sourcePeriod"],
            "range": summary["range"],
            "truncated": summary["truncated"],
            "usage": summary["total"],
        }

    async def public_usage_overview(
        self,
        *,
        period: str = "24h",
        timezone: str = APP_TIMEZONE_NAME,
        refresh: bool = False,
    ) -> dict[str, Any]:
        resolved_period = _resolve_dashboard_period(period)
        resolved_timezone = _resolve_dashboard_timezone(timezone)
        cache_key = (resolved_period, resolved_timezone)
        if not refresh:
            cached = self._fresh_public_usage(cache_key)
            if cached is not None:
                return cached
        async with self._public_usage_lock:
            if not refresh:
                cached = self._fresh_public_usage(cache_key)
                if cached is not None:
                    return cached
            try:
                raw = await self.client.get_dashboard(
                    period=resolved_period,
                    timezone=resolved_timezone,
                    refresh=refresh,
                )
                payload = _public_dashboard(raw, reachable=True, period=resolved_period)
            except Exception:
                payload = _empty_public_dashboard(period=resolved_period, reachable=False)
            self._public_usage_cache[cache_key] = (time.monotonic(), payload)
            return payload

    def _fresh_public_usage(self, cache_key: tuple[str, str]) -> dict[str, Any] | None:
        cached = self._public_usage_cache.get(cache_key)
        if cached is not None and time.monotonic() - cached[0] < PUBLIC_USAGE_TTL_SECONDS:
            return cached[1]
        return None

    async def audit_summary(
        self,
        *,
        key_ids: list[str],
        period: str = "24h",
        start: str = "",
        end: str = "",
    ) -> dict[str, Any]:
        ids = _unique_ids(_split_key_ids(key_ids))
        if not ids:
            raise ValueError("请选择要统计的密钥")
        if len(ids) > MAX_AUDIT_KEYS:
            raise ValueError(f"单次最多统计 {MAX_AUDIT_KEYS} 个密钥")
        window = resolve_audit_window(period, start, end)
        semaphore = asyncio.Semaphore(AUDIT_FETCH_CONCURRENCY)

        async def load_key(ident: str) -> tuple[str, dict[str, Any]]:
            async with semaphore:
                return ident, await self._audit_usage_for_key(ident, window)

        loaded = await asyncio.gather(*(load_key(ident) for ident in ids))
        by_id = {ident: row for ident, row in loaded}
        total = _empty_audit_usage()
        rows: list[dict[str, Any]] = []
        truncated = bool(window["clamped"])
        for ident in ids:
            row = by_id[ident]
            truncated = truncated or bool(row.get("truncated"))
            _merge_audit_usage(total, row["usage"])
            rows.append(
                {
                    "id": ident,
                    "name": row.get("name") or ident,
                    **_finalize_audit_usage(row["usage"]),
                }
            )
        return {
            "period": window["period"],
            "sourcePeriod": window["sourcePeriod"],
            "range": {
                "start": _iso_z(window["start"]),
                "end": _iso_z(window["end"]),
            },
            "total": _finalize_audit_usage(total),
            "keys": rows,
            "truncated": truncated,
        }

    async def _audit_usage_for_key(
        self,
        key_id: str,
        window: dict[str, Any],
    ) -> dict[str, Any]:
        return await self._audit_usage_for_window(window, key_id=key_id)

    async def _audit_usage_for_window(
        self,
        window: dict[str, Any],
        *,
        key_id: str = "",
    ) -> dict[str, Any]:
        usage = _empty_audit_usage()
        name = ""
        truncated = False
        cursor = ""
        start: datetime = window["start"]
        end: datetime = window["end"]
        source_period = str(window["sourcePeriod"])
        for _ in range(MAX_AUDIT_PAGES):
            payload = await self.client.list_request_audits(
                cursor=cursor,
                page_size=AUDIT_PAGE_SIZE,
                period=source_period,
                key=key_id,
                sort_by="createdAt",
                sort_order="desc",
                timeout=AUDIT_FETCH_TIMEOUT_SECONDS,
            )
            data = payload if isinstance(payload, dict) else {}
            items = _list_items(data)
            older = False
            for item in items:
                ident = str(item.get("clientKeyId") or item.get("client_key_id") or "")
                if key_id and ident != key_id:
                    continue
                created = _parse_audit_time(str(item.get("createdAt") or item.get("created_at") or ""))
                if created is None:
                    continue
                if created >= end:
                    continue
                if created < start:
                    older = True
                    continue
                if not name:
                    name = str(item.get("clientKeyName") or item.get("client_key_name") or "")
                _add_audit_item(usage, item)
            if older or not data.get("hasMore"):
                break
            cursor = str(data.get("nextCursor") or data.get("next_cursor") or "")
            if not cursor:
                break
        else:
            truncated = True
        return {"name": name, "usage": usage, "truncated": truncated}


def resolve_audit_window(
    period: str,
    start: str = "",
    end: str = "",
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    current = (now or utc_now()).astimezone(UTC)
    label = str(period or "24h").strip() or "24h"
    if label == "custom":
        start_at = _parse_audit_time(start)
        end_at = _parse_audit_time(end)
        if start_at is None or end_at is None:
            raise ValueError("自定义时间窗口需要开始和结束时间")
        if end_at <= start_at:
            raise ValueError("结束时间必须晚于开始时间")
    elif label in AUDIT_PERIODS:
        end_at = current
        start_at = current - AUDIT_PERIODS[label]
    else:
        raise ValueError("时间窗口仅支持 24h、7d、30d、90d 或 custom")
    if end_at > current:
        end_at = current
    age = current - start_at
    if age <= AUDIT_PERIODS["24h"]:
        source_period = "24h"
    elif age <= AUDIT_PERIODS["7d"]:
        source_period = "7d"
    elif age <= AUDIT_PERIODS["30d"]:
        source_period = "30d"
    else:
        source_period = "90d"
    floor = current - AUDIT_PERIODS["90d"]
    clamped = start_at < floor
    if clamped:
        start_at = floor
    return {
        "period": label,
        "sourcePeriod": source_period,
        "start": start_at,
        "end": end_at,
        "clamped": clamped,
    }


def _split_key_ids(values: list[str] | None) -> list[str]:
    ids: list[str] = []
    for raw in values or []:
        for part in str(raw or "").split(","):
            ident = part.strip()
            if ident:
                ids.append(ident)
    return ids


def _unique_ids(values: list[str] | None) -> list[str]:
    ids: list[str] = []
    seen: set[str] = set()
    for raw in values or []:
        ident = str(raw or "").strip()
        if not ident or ident in seen:
            continue
        seen.add(ident)
        ids.append(ident)
    return ids


def _parse_audit_time(value: str) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _iso_z(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _empty_audit_usage() -> dict[str, Any]:
    return {
        "requests": 0,
        "successfulRequests": 0,
        "failedRequests": 0,
        "inputTokens": 0,
        "cachedInputTokens": 0,
        "outputTokens": 0,
        "reasoningTokens": 0,
        "totalTokens": 0,
        "durationMs": 0,
        "estimatedCostInUsdTicks": 0,
        "averageDurationMs": 0.0,
        "successRate": 0.0,
    }


def _add_audit_item(usage: dict[str, Any], item: dict[str, Any]) -> None:
    usage["requests"] += 1
    status = _as_int(item.get("statusCode", item.get("status_code")))
    error = str(item.get("errorCode") or item.get("error_code") or "").strip()
    if 200 <= status < 300 and not error:
        usage["successfulRequests"] += 1
    else:
        usage["failedRequests"] += 1
    usage["inputTokens"] += _as_int(item.get("inputTokens", item.get("input_tokens")))
    usage["cachedInputTokens"] += _as_int(item.get("cachedInputTokens", item.get("cached_input_tokens")))
    usage["outputTokens"] += _as_int(item.get("outputTokens", item.get("output_tokens")))
    usage["reasoningTokens"] += _as_int(item.get("reasoningTokens", item.get("reasoning_tokens")))
    usage["totalTokens"] += _as_int(item.get("totalTokens", item.get("total_tokens")))
    cost = item.get("estimatedCostInUsdTicks", item.get("estimated_cost_in_usd_ticks"))
    if not cost:
        cost = item.get("costInUsdTicks", item.get("cost_in_usd_ticks"))
    usage["estimatedCostInUsdTicks"] += _as_int(cost)
    usage["durationMs"] += _as_int(item.get("durationMs", item.get("duration_ms")))


def _merge_audit_usage(target: dict[str, Any], extra: dict[str, Any]) -> None:
    for field in (
        "requests",
        "successfulRequests",
        "failedRequests",
        "inputTokens",
        "cachedInputTokens",
        "outputTokens",
        "reasoningTokens",
        "totalTokens",
        "durationMs",
        "estimatedCostInUsdTicks",
    ):
        target[field] += extra.get(field) or 0


def _finalize_audit_usage(usage: dict[str, Any]) -> dict[str, Any]:
    result = dict(usage)
    requests = result.get("requests") or 0
    input_tokens = result.get("inputTokens") or 0
    if requests:
        result["successRate"] = result["successfulRequests"] / requests * 100
        result["averageDurationMs"] = result["durationMs"] / requests
    else:
        result["successRate"] = 0.0
        result["averageDurationMs"] = 0.0
    result["cacheHitRate"] = result["cachedInputTokens"] / input_tokens * 100 if input_tokens else 0.0
    return result


def _empty_public_dashboard(*, period: str, reachable: bool) -> dict[str, Any]:
    return _public_dashboard({}, reachable=reachable, period=period)


def _public_dashboard(raw: Any, *, reachable: bool, period: str) -> dict[str, Any]:
    payload = raw if isinstance(raw, dict) else {}
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    range_raw = payload.get("range") if isinstance(payload.get("range"), dict) else {}
    resolved_period = str(payload.get("period") or period).strip()
    if resolved_period not in PUBLIC_DASHBOARD_PERIODS:
        resolved_period = period
    return {
        "reachable": reachable,
        "period": resolved_period,
        "generatedAt": _as_timestamp(payload.get("generatedAt")),
        "range": {
            "start": _as_timestamp(range_raw.get("start")),
            "end": _as_timestamp(range_raw.get("end")),
        },
        "usage": _public_dashboard_usage(usage),
        "series": _public_dashboard_series_list(payload.get("series")),
        "activity": _public_dashboard_activity_list(payload.get("activity")),
        "topModels": _public_dashboard_model_list(payload.get("topModels")),
        "providers": _public_dashboard_provider_list(payload.get("providers")),
    }


def _public_dashboard_usage(usage: dict[str, Any]) -> dict[str, Any]:
    requests = _as_int(usage.get("requests"))
    successful = _as_int(usage.get("successfulRequests"))
    input_tokens = _as_int(usage.get("inputTokens"))
    cached = _as_int(usage.get("cachedInputTokens"))
    success_rate = _as_float(usage.get("successRate"))
    if not success_rate and requests:
        success_rate = successful / requests * 100
    return {
        "requests": requests,
        "successfulRequests": successful,
        "failedRequests": _as_int(usage.get("failedRequests")),
        "inputTokens": input_tokens,
        "cachedInputTokens": cached,
        "outputTokens": _as_int(usage.get("outputTokens")),
        "reasoningTokens": _as_int(usage.get("reasoningTokens")),
        "tokens": _as_int(usage.get("tokens", usage.get("totalTokens"))),
        "billedCostUsdTicks": _as_int(
            usage.get("billedCostUsdTicks", usage.get("estimatedCostInUsdTicks"))
        ),
        "successRate": success_rate,
        "cacheHitRate": cached / input_tokens * 100 if input_tokens else 0.0,
        "averageFirstTokenMs": _as_float(usage.get("averageFirstTokenMs")),
        "outputTokensPerSecond": _as_float(usage.get("outputTokensPerSecond")),
        "firstTokenSamples": _as_int(usage.get("firstTokenSamples")),
        "throughputSamples": _as_int(usage.get("throughputSamples")),
    }


def _public_dashboard_series_list(raw: Any) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for item in _list_items(raw):
        start = _as_timestamp(item.get("start"))
        if not start:
            continue
        items.append(
            {
                "start": start,
                "end": _as_timestamp(item.get("end")) or start,
                "requests": _as_int(item.get("requests")),
                "inputTokens": _as_int(item.get("inputTokens")),
                "cachedInputTokens": _as_int(item.get("cachedInputTokens")),
                "outputTokens": _as_int(item.get("outputTokens")),
                "reasoningTokens": _as_int(item.get("reasoningTokens")),
                "tokens": _as_int(item.get("tokens", item.get("totalTokens"))),
                "billedCostUsdTicks": _as_int(item.get("billedCostUsdTicks")),
            }
        )
    return items


def _public_dashboard_activity_list(raw: Any) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for item in _list_items(raw):
        start = _as_timestamp(item.get("start"))
        if not start:
            continue
        items.append({"start": start, "requests": _as_int(item.get("requests"))})
    return items


def _public_dashboard_model_list(raw: Any) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for item in _list_items(raw):
        model = str(item.get("model") or "").strip()
        if not model:
            continue
        items.append(
            {
                "model": model,
                "requests": _as_int(item.get("requests")),
                "inputTokens": _as_int(item.get("inputTokens")),
                "cachedInputTokens": _as_int(item.get("cachedInputTokens")),
                "outputTokens": _as_int(item.get("outputTokens")),
                "reasoningTokens": _as_int(item.get("reasoningTokens")),
                "tokens": _as_int(item.get("tokens", item.get("totalTokens"))),
                "billedCostUsdTicks": _as_int(item.get("billedCostUsdTicks")),
            }
        )
    return items


def _public_dashboard_provider_list(raw: Any) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for item in _list_items(raw):
        provider = str(item.get("provider") or "").strip()
        if not provider:
            continue
        items.append(
            {
                "provider": provider,
                "requests": _as_int(item.get("requests")),
                "successfulRequests": _as_int(item.get("successfulRequests")),
                "tokens": _as_int(item.get("tokens", item.get("totalTokens"))),
            }
        )
    return items


def _resolve_dashboard_period(value: str) -> str:
    period = (value or "").strip()
    return period if period in PUBLIC_DASHBOARD_PERIODS else "24h"


def _resolve_dashboard_timezone(value: str) -> str:
    candidate = (value or "").strip() or APP_TIMEZONE_NAME
    try:
        ZoneInfo(candidate)
    except (ZoneInfoNotFoundError, ValueError):
        return APP_TIMEZONE_NAME
    return candidate


def _as_timestamp(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return _iso_z(value)
    text = str(value).strip()
    return text or None


def _list_items(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        raw_items = payload.get("items") or payload.get("keys") or []
        if not isinstance(raw_items, list):
            return []
        return [item for item in raw_items if isinstance(item, dict)]
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    return []


def _as_int(value: Any, fallback: int = 0) -> int:
    if value is None or value == "":
        return fallback
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _as_float(value: Any, fallback: float = 0.0) -> float:
    if value is None or value == "":
        return fallback
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback
