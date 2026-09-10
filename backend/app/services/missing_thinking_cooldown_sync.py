from __future__ import annotations

import logging
from typing import Any

from app.core.clock import parse_optional_datetime, utc_now
from app.core.config import Settings
from app.integrations.grok2api.client import Grok2APIClient, IntegrationError
from app.persistence.account_repository import AccountRepository
from app.services.cooldown_stats import (
    MISSING_THINKING_ERROR,
    account_id_of,
    account_last_error,
    is_missing_thinking_cooling,
    snapshot_missing_thinking_account,
)

logger = logging.getLogger(__name__)


class MissingThinkingCooldownSyncService:
    def __init__(
        self,
        *,
        settings: Settings,
        client: Grok2APIClient,
        accounts: AccountRepository,
    ) -> None:
        self.settings = settings
        self.client = client
        self.accounts = accounts

    async def scan(self) -> dict[str, Any]:
        if not self.settings.missing_thinking_cooldown_sync_enabled:
            return _scan_result(
                ok=True,
                skipped=True,
                reason="disabled",
                error="grok2api 降智冷却同步已关闭",
            )
        try:
            accounts = await self.client.list_all_accounts(
                status="missingThinking",
                provider="grok_build",
                degradeWindow="1h",
                sortBy="updatedAt",
                sortOrder="desc",
            )
        except IntegrationError as exc:
            logger.exception("missing-thinking cooldown sync failed")
            return _scan_result(
                ok=False,
                skipped=False,
                reason="upstream_error",
                error=str(exc),
            )
        now = utc_now()
        matched = [
            item
            for item in accounts
            if isinstance(item, dict) and is_missing_thinking_cooling(item, now=now)
        ]
        cooling_ids: set[int] = set()
        upserted = 0
        failures: list[dict[str, Any]] = []
        for item in matched:
            account_id = account_id_of(item)
            if account_id <= 0:
                failures.append({"id": item.get("id"), "error": "账号 ID 无效"})
                continue
            until = parse_optional_datetime(
                item.get("cooldownUntil") or item.get("cooldown_until")
            )
            updated = parse_optional_datetime(
                item.get("updatedAt") or item.get("updated_at")
            )
            degrade_last = parse_optional_datetime(
                item.get("degradeLast") or item.get("degrade_last")
            )
            try:
                self.accounts.upsert_missing_thinking_cooldown(
                    account_id=account_id,
                    cooled_at=degrade_last or updated or now,
                    cooldown_until=until,
                    last_error=account_last_error(item) or MISSING_THINKING_ERROR,
                    degrade_hits=_as_int(item.get("degradeHits") or item.get("degrade_hits")),
                    failure_count=_as_int(
                        item.get("failureCount") or item.get("failure_count")
                    ),
                    snapshot=snapshot_missing_thinking_account(item),
                )
            except Exception as exc:
                failures.append({"id": account_id, "error": str(exc)})
                continue
            cooling_ids.add(account_id)
            upserted += 1
        expired = self.accounts.expire_missing_thinking_cooldowns(cooling_ids, now=now)
        return _scan_result(
            ok=True,
            skipped=False,
            scanned=len(accounts),
            matched=len(matched),
            cooling=len(cooling_ids),
            upserted=upserted,
            expired=expired,
            failures=failures,
        )


def _as_int(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError, OverflowError):
        return 0


def _scan_result(
    *,
    ok: bool,
    skipped: bool,
    reason: str = "",
    error: str = "",
    scanned: int = 0,
    matched: int = 0,
    cooling: int = 0,
    upserted: int = 0,
    expired: int = 0,
    failures: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    items = failures or []
    return {
        "ok": ok,
        "skipped": skipped,
        "reason": reason,
        "error": error,
        "scanned": scanned,
        "matched": matched,
        "cooling": cooling,
        "upserted": upserted,
        "expired": expired,
        "failed": len(items),
        "failures": items,
    }
