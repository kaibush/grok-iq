from __future__ import annotations

import logging
from typing import Any

from app.core.config import Settings
from app.services.client_key_service import (
    MAX_BILLING_LIMIT_TICKS,
    USD_TICKS,
    ClientKeyService,
)

logger = logging.getLogger(__name__)


class ClientKeyTopupService:
    def __init__(self, *, settings: Settings, client_keys: ClientKeyService) -> None:
        self.settings = settings
        self.client_keys = client_keys

    async def run(self) -> dict[str, Any]:
        threshold = float(self.settings.paid_key_auto_topup_threshold_percent)
        amount_usd = float(self.settings.paid_key_auto_topup_amount_usd)
        if not self.settings.paid_key_auto_topup_enabled:
            return _result(
                ok=True,
                skipped=True,
                scanned=0,
                eligible=0,
                topped_up=0,
                skipped_count=0,
                failed=0,
                threshold=threshold,
                amount_usd=amount_usd,
                items=[],
                error="付费密钥自动加额已关闭",
            )

        sync_error = ""
        try:
            await self.client_keys.sync_from_upstream()
        except Exception as exc:
            logger.exception("paid key auto top-up sync failed")
            sync_error = str(exc)

        rows = self.client_keys.repository.list_paid_present()
        scanned = 0
        eligible = 0
        topped_up = 0
        skipped_count = 0
        failed = 0
        items: list[dict[str, Any]] = []
        add_ticks = int(round(amount_usd * USD_TICKS))

        for row in rows:
            scanned += 1
            view = self.client_keys.public_key(row)
            key_id = str(view.get("id") or "")
            name = str(view.get("name") or "")
            percent = float(view.get("remainingPercent") or 0)
            if view.get("expired") or view.get("unlimited") or percent >= threshold:
                skipped_count += 1
                continue
            limit_ticks = int(row.get("billing_limit_usd_ticks") or 0)
            new_limit = min(MAX_BILLING_LIMIT_TICKS, limit_ticks + add_ticks)
            if new_limit <= limit_ticks:
                skipped_count += 1
                continue
            eligible += 1
            added_usd = (new_limit - limit_ticks) / USD_TICKS
            try:
                result = await self.client_keys.client.update_client_key(
                    key_id,
                    {"billingLimitUsdTicks": new_limit},
                )
                snapshot = self.client_keys._snapshot(result)
                if snapshot is None:
                    raise ValueError("更新额度后响应无效")
                self.client_keys.repository.apply_snapshot(snapshot)
            except Exception as exc:
                logger.exception("paid key auto top-up failed for %s", key_id)
                failed += 1
                items.append(
                    {
                        "id": key_id,
                        "name": name,
                        "remainingPercent": percent,
                        "addedUsd": 0,
                        "error": str(exc),
                    }
                )
                continue
            topped_up += 1
            items.append(
                {
                    "id": key_id,
                    "name": name,
                    "remainingPercent": percent,
                    "addedUsd": added_usd,
                }
            )

        return _result(
            ok=True,
            skipped=False,
            scanned=scanned,
            eligible=eligible,
            topped_up=topped_up,
            skipped_count=skipped_count,
            failed=failed,
            threshold=threshold,
            amount_usd=amount_usd,
            items=items,
            sync_error=sync_error,
        )


def _result(
    *,
    ok: bool,
    skipped: bool,
    scanned: int,
    eligible: int,
    topped_up: int,
    skipped_count: int,
    failed: int,
    threshold: float,
    amount_usd: float,
    items: list[dict[str, Any]],
    error: str = "",
    sync_error: str = "",
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "ok": ok,
        "skipped": True if skipped else skipped_count,
        "scanned": scanned,
        "eligible": eligible,
        "toppedUp": topped_up,
        "failed": failed,
        "thresholdPercent": threshold,
        "amountUsd": amount_usd,
        "items": items,
    }
    if error:
        payload["error"] = error
    if sync_error:
        payload["syncError"] = sync_error
    return payload
