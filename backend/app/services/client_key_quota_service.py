from __future__ import annotations

import hmac
from typing import Any

from app.core.clock import parse_optional_datetime, utc_now
from app.core.rate_limit import RateLimitExceeded, SlidingWindowRateLimiter
from app.integrations.grok2api.client import Grok2APIClient, IntegrationError

USD_TICKS = 10_000_000_000
PAGE_SIZE = 20
MAX_PAGES = 50
MAX_SECRET_FETCHES = 8
SHORT_LIMIT = 12
SHORT_WINDOW_SECONDS = 60.0
LONG_LIMIT = 40
LONG_WINDOW_SECONDS = 15 * 60.0


class ClientKeyQuotaService:
    def __init__(
        self,
        client: Grok2APIClient,
        *,
        limiter: SlidingWindowRateLimiter | None = None,
    ) -> None:
        self.client = client
        self.limiter = limiter or SlidingWindowRateLimiter()

    async def lookup(self, api_key: str, *, client_ip: str) -> dict[str, Any]:
        item = await self.lookup_item(api_key, client_ip=client_ip)
        if item is None:
            return {"found": False}
        return _quota_payload(item)

    async def lookup_item(self, api_key: str, *, client_ip: str) -> dict[str, Any] | None:
        self._consume_rate_limit(client_ip)
        prefix = _parse_prefix(api_key)
        if prefix is None:
            return None
        return await self._find_item(prefix, api_key)

    def _consume_rate_limit(self, client_ip: str) -> None:
        allowed_short, retry_short = self.limiter.allow(
            f"client-key-quota:{client_ip}:1m",
            limit=SHORT_LIMIT,
            window_seconds=SHORT_WINDOW_SECONDS,
        )
        allowed_long, retry_long = self.limiter.allow(
            f"client-key-quota:{client_ip}:15m",
            limit=LONG_LIMIT,
            window_seconds=LONG_WINDOW_SECONDS,
        )
        if not allowed_short or not allowed_long:
            raise RateLimitExceeded(retry_after=max(retry_short, retry_long, 1))

    async def _find_item(self, prefix: str, api_key: str) -> dict[str, Any] | None:
        secret_fetches = 0
        page = 1
        while page <= MAX_PAGES:
            payload = await self.client.list_client_keys(
                search=prefix,
                page=page,
                pageSize=PAGE_SIZE,
            )
            batch = list(payload.get("items") or [])
            if not batch:
                break
            for item in batch:
                if not isinstance(item, dict):
                    continue
                if str(item.get("prefix") or "") != prefix:
                    continue
                key_id = str(item.get("id") or "")
                if not key_id:
                    continue
                if secret_fetches >= MAX_SECRET_FETCHES:
                    return None
                secret_fetches += 1
                try:
                    secret = await self.client.get_client_key_secret(key_id)
                except IntegrationError:
                    continue
                if _secrets_match(secret, api_key):
                    return item
            page_size = int(payload.get("pageSize") or PAGE_SIZE)
            total = int(payload.get("total") or 0)
            if page_size <= 0 or page * page_size >= total:
                break
            page += 1
        return None


def _parse_prefix(raw: str) -> str | None:
    parts = raw.split("_", 2)
    if len(parts) != 3:
        return None
    scheme, prefix, rest = parts
    if scheme != "g2a" or not prefix or not rest:
        return None
    return prefix


def _secrets_match(left: str, right: str) -> bool:
    left_bytes = left.encode("utf-8")
    right_bytes = right.encode("utf-8")
    if len(left_bytes) != len(right_bytes):
        return False
    return hmac.compare_digest(left_bytes, right_bytes)


def _quota_payload(item: dict[str, Any]) -> dict[str, Any]:
    billing_limit_ticks = _as_int(item.get("billingLimitUsdTicks"))
    billed_usage_usd = _as_int(item.get("billedUsageUsdTicks")) / USD_TICKS
    unlimited = billing_limit_ticks <= 0
    if unlimited:
        billing_limit_usd = 0.0
        remaining_usd = 0.0
        usage_percent = 0.0
    else:
        billing_limit_usd = billing_limit_ticks / USD_TICKS
        remaining_usd = max(0.0, billing_limit_usd - billed_usage_usd)
        usage_percent = min(100.0, max(0.0, billed_usage_usd / billing_limit_usd * 100.0))
    expires_at = _optional_text(item.get("expiresAt"))
    return {
        "found": True,
        "name": str(item.get("name") or ""),
        "prefix": str(item.get("prefix") or ""),
        "enabled": bool(item.get("enabled")),
        "expired": _is_expired(expires_at),
        "expiresAt": expires_at,
        "lastUsedAt": _optional_text(item.get("lastUsedAt")),
        "unlimited": unlimited,
        "billingLimitUsd": billing_limit_usd,
        "billedUsageUsd": billed_usage_usd,
        "remainingUsd": remaining_usd,
        "usagePercent": usage_percent,
    }


def _is_expired(expires_at: str | None) -> bool:
    parsed = parse_optional_datetime(expires_at)
    if parsed is None:
        return False
    return parsed <= utc_now()


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _as_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0
