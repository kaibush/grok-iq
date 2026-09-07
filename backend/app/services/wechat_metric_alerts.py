from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from app.core.clock import utc_now
from app.core.config import Settings
from app.persistence.wechat_alert_repository import WeChatAlertRepository
from app.services.wechat_notification import WeChatAccountNotificationService

if TYPE_CHECKING:
    from app.services.request_audit_service import RequestAuditService

KEY_QUALITY_RULE = "key_quality"
UPSTREAM_HEALTH_RULE = "upstream_health"
MAX_ALERTS_PER_ROUND = 10
RECOVER_DELTA = 5.0
WINDOW_LABELS = {
    "15m": "最近 15 分钟",
    "30m": "最近 30 分钟",
    "1h": "最近 1 小时",
}
logger = logging.getLogger(__name__)


def recover_threshold(threshold: float) -> float:
    return min(100.0, float(threshold) + RECOVER_DELTA)


def quality_normal_rate(requests: int, watch: int, high: int) -> float:
    total = max(0, int(requests))
    if total <= 0:
        return 0.0
    abnormal = max(0, int(watch)) + max(0, int(high))
    normal = max(0, total - abnormal)
    return round(normal * 100.0 / total, 1)


def cooldown_elapsed(
    last_fired_at: datetime | None,
    *,
    now: datetime,
    cooldown: timedelta,
) -> bool:
    if last_fired_at is None:
        return True
    return now - last_fired_at >= cooldown


class WeChatMetricAlertService:
    """Evaluate rolling request metrics and send WeChat alerts on state changes."""

    def __init__(
        self,
        *,
        settings: Settings,
        notifications: WeChatAccountNotificationService,
        request_audits: RequestAuditService,
        repository: WeChatAlertRepository,
    ) -> None:
        self.settings = settings
        self.notifications = notifications
        self.request_audits = request_audits
        self.repository = repository
        self._lock = asyncio.Lock()

    async def evaluate_after_scan(self, scan_result: dict[str, Any] | None = None) -> dict[str, Any]:
        async with self._lock:
            return await self._evaluate_after_scan_locked(scan_result)

    async def _evaluate_after_scan_locked(
        self,
        scan_result: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload = scan_result or {}
        if not self.settings.wechat_notification_enabled:
            return {"skipped": "disabled", "sent": 0}
        if payload.get("skipped") or not payload.get("ok", True):
            return {"skipped": "scan", "sent": 0}
        if not (
            self.settings.wechat_key_quality_enabled
            or self.settings.wechat_upstream_health_15m_enabled
            or self.settings.wechat_upstream_health_30m_enabled
        ):
            return {"skipped": "rules_disabled", "sent": 0}
        health = self.request_audits.recent_request_health()
        if health.get("stale"):
            logger.info("wechat metric alerts skipped reason=stale")
            return {"skipped": "stale", "sent": 0}
        now = utc_now()
        candidates: list[dict[str, Any]] = []
        recovered = 0
        recovered += self._collect_key_quality(candidates, now=now)
        recovered += self._collect_upstream_health(
            candidates,
            health=health,
            now=now,
        )
        sent = 0
        errors = 0
        capped = 0
        for index, candidate in enumerate(candidates):
            if sent >= MAX_ALERTS_PER_ROUND:
                capped += len(candidates) - index
                break
            try:
                result = await self.notifications.send_template(
                    template_id=str(candidate["templateId"]),
                    template_data=candidate["templateData"],
                )
            except Exception:
                errors += 1
                logger.exception(
                    "wechat metric alert failed rule=%s subject=%s",
                    candidate["ruleId"],
                    candidate["subjectId"],
                )
                continue
            if not result.get("sent"):
                logger.info(
                    "wechat metric alert skipped rule=%s subject=%s reason=%s",
                    candidate["ruleId"],
                    candidate["subjectId"],
                    result.get("skipped") or "not_sent",
                )
                continue
            self.repository.upsert(
                rule_id=str(candidate["ruleId"]),
                subject_id=str(candidate["subjectId"]),
                status="open",
                last_value=float(candidate["value"]),
                last_fired_at=now,
                extra=candidate.get("extra") or {},
            )
            sent += 1
            logger.info(
                "wechat metric alert sent rule=%s subject=%s value=%s",
                candidate["ruleId"],
                candidate["subjectId"],
                candidate["value"],
            )
        return {
            "skipped": "",
            "sent": sent,
            "recovered": recovered,
            "capped": capped,
            "errors": errors,
            "candidates": len(candidates),
        }

    def _collect_key_quality(
        self,
        candidates: list[dict[str, Any]],
        *,
        now: datetime,
    ) -> int:
        if not self.settings.wechat_key_quality_enabled:
            return 0
        template_id = self.settings.wechat_key_quality_template_id.strip()
        if not template_id:
            logger.info("wechat key quality alerts skipped reason=missing_template")
            return 0
        selected = [
            item
            for item in self.settings.wechat_key_quality_keys
            if isinstance(item, dict) and str(item.get("id") or "").strip()
        ]
        if not selected:
            return 0
        stats = {
            str(item.get("id") or ""): item
            for item in self.request_audits.client_key_options_for_window("1h")
        }
        recovered = 0
        cooldown = timedelta(minutes=self.settings.wechat_key_quality_cooldown_minutes)
        default_threshold = float(self.settings.wechat_key_quality_threshold)
        min_requests = int(self.settings.wechat_key_quality_min_requests)
        for item in selected:
            key_id = str(item.get("id") or "").strip()
            if not key_id or key_id == "unlabeled":
                continue
            threshold = float(item.get("threshold") or default_threshold)
            current = stats.get(key_id) or {}
            requests = int(current.get("requestCount") or 0)
            watch = int(current.get("watchRequests") or 0)
            high = int(current.get("highRiskRequests") or 0)
            rate = quality_normal_rate(requests, watch, high)
            extra = {
                "keyName": str(item.get("name") or current.get("name") or ""),
                "window": "1h",
                "requests": requests,
                "watchRequests": watch,
                "highRiskRequests": high,
            }
            action = self._decide(
                rule_id=KEY_QUALITY_RULE,
                subject_id=key_id,
                value=rate,
                threshold=threshold,
                requests=requests,
                min_requests=min_requests,
                cooldown=cooldown,
                now=now,
                extra=extra,
            )
            if action == "recover":
                recovered += 1
                continue
            if action != "fire":
                continue
            candidates.append(
                {
                    "ruleId": KEY_QUALITY_RULE,
                    "subjectId": key_id,
                    "value": rate,
                    "templateId": template_id,
                    "extra": extra,
                    "templateData": WeChatAccountNotificationService.build_key_quality_template_data(
                        key_id=key_id,
                        key_name=str(extra["keyName"] or key_id),
                        window=WINDOW_LABELS["1h"],
                        rate=rate,
                        threshold=threshold,
                        requests=requests,
                        watch_requests=watch,
                        high_risk_requests=high,
                        occurred_at=now,
                    ),
                }
            )
        return recovered

    def _collect_upstream_health(
        self,
        candidates: list[dict[str, Any]],
        *,
        health: dict[str, Any],
        now: datetime,
    ) -> int:
        windows = health.get("windows") if isinstance(health.get("windows"), dict) else {}
        recovered = 0
        cooldown = timedelta(
            minutes=self.settings.wechat_upstream_health_cooldown_minutes
        )
        template_id = self.settings.wechat_upstream_health_template_id.strip()
        specs = (
            (
                "15m",
                self.settings.wechat_upstream_health_15m_enabled,
                float(self.settings.wechat_upstream_health_15m_threshold),
                int(self.settings.wechat_upstream_health_15m_min_requests),
            ),
            (
                "30m",
                self.settings.wechat_upstream_health_30m_enabled,
                float(self.settings.wechat_upstream_health_30m_threshold),
                int(self.settings.wechat_upstream_health_30m_min_requests),
            ),
        )
        for window_key, enabled, threshold, min_requests in specs:
            if not enabled:
                continue
            if not template_id:
                logger.info(
                    "wechat upstream health alerts skipped window=%s reason=missing_template",
                    window_key,
                )
                continue
            stats = windows.get(window_key) if isinstance(windows.get(window_key), dict) else {}
            requests = int(stats.get("requests") or 0)
            failed = int(stats.get("failedRequests") or 0)
            rate = float(stats.get("successRate") or 0.0)
            extra = {
                "window": window_key,
                "requests": requests,
                "failedRequests": failed,
            }
            action = self._decide(
                rule_id=UPSTREAM_HEALTH_RULE,
                subject_id=window_key,
                value=rate,
                threshold=threshold,
                requests=requests,
                min_requests=min_requests,
                cooldown=cooldown,
                now=now,
                extra=extra,
            )
            if action == "recover":
                recovered += 1
                continue
            if action != "fire":
                continue
            candidates.append(
                {
                    "ruleId": UPSTREAM_HEALTH_RULE,
                    "subjectId": window_key,
                    "value": rate,
                    "templateId": template_id,
                    "extra": extra,
                    "templateData": WeChatAccountNotificationService.build_upstream_health_template_data(
                        window=WINDOW_LABELS.get(window_key, window_key),
                        rate=rate,
                        threshold=threshold,
                        requests=requests,
                        failed_requests=failed,
                        occurred_at=now,
                    ),
                }
            )
        return recovered

    def _decide(
        self,
        *,
        rule_id: str,
        subject_id: str,
        value: float,
        threshold: float,
        requests: int,
        min_requests: int,
        cooldown: timedelta,
        now: datetime,
        extra: dict[str, Any],
    ) -> str:
        if requests < min_requests:
            return "insufficient"
        state = self.repository.get(rule_id, subject_id) or {}
        status = str(state.get("status") or "closed")
        recover_at = recover_threshold(threshold)
        if value < threshold:
            if status != "open" or cooldown_elapsed(
                state.get("last_fired_at"),
                now=now,
                cooldown=cooldown,
            ):
                return "fire"
            return "cooldown"
        if status == "open" and value >= recover_at:
            self.repository.upsert(
                rule_id=rule_id,
                subject_id=subject_id,
                status="closed",
                last_value=value,
                last_recovered_at=now,
                extra=extra,
            )
            return "recover"
        return "hold"
