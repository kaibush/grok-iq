from __future__ import annotations

import asyncio
import logging
import math
import re
from collections.abc import Iterable
from typing import Any

from app.core.config import Settings
from app.integrations.grok2api.client import Grok2APIClient, IntegrationError

logger = logging.getLogger(__name__)

TPS_FUSE_SYNC_FIELDS = frozenset(
    {
        "request_audit_enabled",
        "request_audit_risk_enabled",
        "strong_degradation_tps",
        "request_audit_tps_only_min_count",
        "request_audit_tps_cooldown_minutes",
        "min_generation_ms",
        "minimum_output_tokens",
        "media_input_observe_enabled",
    }
)
FLOAT_TOLERANCE = 1e-6
_DURATION_NUMBER = re.compile(r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)")
_DURATION_UNITS: tuple[tuple[str, float], ...] = (
    ("ns", 1e-9),
    ("us", 1e-6),
    ("µs", 1e-6),
    ("μs", 1e-6),
    ("ms", 1e-3),
    ("s", 1.0),
    ("m", 60.0),
    ("h", 3600.0),
)
_DURATION_SECONDS = dict(_DURATION_UNITS)

IDLE_RESULT = {"ok": True, "status": "idle", "error": ""}


def desired_tps_fuse(settings: Settings) -> dict[str, Any]:
    """Map grok-iq runtime settings onto grok2api ``config.tpsFuse``."""

    return {
        "enabled": bool(
            settings.request_audit_enabled and settings.request_audit_risk_enabled
        ),
        "hardTPS": float(settings.strong_degradation_tps),
        "minCount": int(settings.request_audit_tps_only_min_count),
        "cooldown": f"{int(settings.request_audit_tps_cooldown_minutes)}m",
        "minGenerationMs": int(settings.min_generation_ms),
        "minOutputTokens": int(settings.minimum_output_tokens),
        "skipMediaInput": bool(settings.media_input_observe_enabled),
    }


def should_sync_runtime_changes(changed: Iterable[str]) -> bool:
    keys = {str(key) for key in changed}
    return bool(keys & TPS_FUSE_SYNC_FIELDS) or any(
        key.startswith("grok2api_") for key in keys
    )


def duration_minutes(value: Any) -> float | None:
    """Parse a grok2api duration or minute count into minutes."""

    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        if math.isnan(value) or math.isinf(value):
            return None
        return float(value)
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = float(text)
    except ValueError:
        parsed = None
    else:
        if not math.isnan(parsed) and not math.isinf(parsed):
            return parsed
    lowered = text.lower()
    total_seconds = 0.0
    index = 0
    length = len(lowered)
    while index < length:
        match = _DURATION_NUMBER.match(lowered, index)
        if match is None:
            return None
        number = float(match.group(0))
        index = match.end()
        unit = next(
            (name for name, _ in _DURATION_UNITS if lowered.startswith(name, index)),
            None,
        )
        if unit is None:
            return None
        total_seconds += number * _DURATION_SECONDS[unit]
        index += len(unit)
    if index != length:
        return None
    return total_seconds / 60.0


def numbers_equal(left: Any, right: Any) -> bool:
    try:
        left_value = float(left)
        right_value = float(right)
    except (TypeError, ValueError):
        return False
    if (
        math.isnan(left_value)
        or math.isnan(right_value)
        or math.isinf(left_value)
        or math.isinf(right_value)
    ):
        return False
    return abs(left_value - right_value) <= FLOAT_TOLERANCE


def tps_fuse_matches(desired: dict[str, Any], actual: Any) -> bool:
    if not isinstance(desired, dict) or not isinstance(actual, dict):
        return False
    # grok2api may omit false booleans when older DTO tags used omitempty.
    if bool(actual.get("enabled")) != bool(desired["enabled"]):
        return False
    if bool(actual.get("skipMediaInput")) != bool(desired["skipMediaInput"]):
        return False
    if not numbers_equal(actual.get("hardTPS"), desired["hardTPS"]):
        return False
    if not numbers_equal(actual.get("minCount"), desired["minCount"]):
        return False
    if not numbers_equal(actual.get("minGenerationMs"), desired["minGenerationMs"]):
        return False
    if not numbers_equal(actual.get("minOutputTokens"), desired["minOutputTokens"]):
        return False
    actual_cooldown = duration_minutes(actual.get("cooldown"))
    desired_cooldown = duration_minutes(desired["cooldown"])
    if actual_cooldown is None or desired_cooldown is None:
        return False
    return abs(actual_cooldown - desired_cooldown) <= FLOAT_TOLERANCE


def tps_fuse_drifted(desired: dict[str, Any], actual: Any) -> bool:
    return not tps_fuse_matches(desired, actual)


def snapshot_config(snapshot: Any) -> dict[str, Any]:
    """Return a shallow copy of grok2api's current settings config."""

    if not isinstance(snapshot, dict):
        return {}
    config = snapshot.get("config")
    if not isinstance(config, dict):
        return {}
    return dict(config)


def snapshot_tps_fuse(snapshot: Any) -> Any:
    config = snapshot_config(snapshot)
    return config.get("tpsFuse")


def snapshot_revision(snapshot: Any) -> str:
    if not isinstance(snapshot, dict) or snapshot.get("revision") is None:
        return ""
    return str(snapshot.get("revision"))


def _is_settings_conflict(error: BaseException) -> bool:
    if not isinstance(error, IntegrationError):
        return False
    return error.status_code == 409 or error.error_code == "settingsConflict"


def _result(*, ok: bool, status: str, error: str = "") -> dict[str, Any]:
    return {"ok": ok, "status": status, "error": error}


class TpsFuseSyncService:
    """Push grok-iq TPS cooldown rules into grok2api ``config.tpsFuse``."""

    def __init__(self, client: Grok2APIClient, settings: Settings) -> None:
        self.client = client
        self.settings = settings
        self._last = dict(IDLE_RESULT)
        self._lock = asyncio.Lock()
        self._startup_task: asyncio.Task[dict[str, Any]] | None = None

    def public_view(self) -> dict[str, Any]:
        return dict(self._last)

    def schedule_startup_sync(self) -> None:
        """Best-effort push when request-audit auto scan starts."""

        if not (
            self.settings.request_audit_enabled
            and self.settings.request_audit_auto_scan_enabled
            and self.settings.grok2api_admin_username
            and self.settings.grok2api_admin_password
        ):
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if self._startup_task is not None and not self._startup_task.done():
            return
        self._startup_task = loop.create_task(
            self.sync(trigger="startup"),
            name="tps-fuse-sync-startup",
        )

    async def sync(self, *, trigger: str = "settings") -> dict[str, Any]:
        async with self._lock:
            result = await self._sync_unlocked(trigger=trigger)
            self._last = result
            return dict(result)

    async def _sync_unlocked(self, *, trigger: str) -> dict[str, Any]:
        if not (
            self.settings.grok2api_admin_username
            and self.settings.grok2api_admin_password
        ):
            return _result(
                ok=True,
                status="skipped",
                error="尚未配置 grok2api 管理员凭据",
            )
        desired = desired_tps_fuse(self.settings)
        try:
            return await self._push_desired(desired, trigger=trigger)
        except Exception as exc:
            logger.warning("grok2api tpsFuse sync failed: %s", exc)
            return _result(ok=False, status="failed", error=str(exc))

    async def _push_desired(
        self,
        desired: dict[str, Any],
        *,
        trigger: str,
    ) -> dict[str, Any]:
        snapshot = await self.client.get_admin_settings()
        return await self._reconcile_snapshot(
            snapshot,
            desired,
            trigger=trigger,
            retry_on_conflict=True,
        )

    async def _reconcile_snapshot(
        self,
        snapshot: dict[str, Any],
        desired: dict[str, Any],
        *,
        trigger: str,
        retry_on_conflict: bool,
    ) -> dict[str, Any]:
        actual = snapshot_tps_fuse(snapshot)
        drifted = tps_fuse_drifted(desired, actual)
        if not drifted:
            return _result(ok=True, status="synced")
        if actual is None and trigger not in {"settings", "startup"}:
            return _result(
                ok=True,
                status="unsupported",
                error="grok2api 尚未返回 tpsFuse，等待镜像更新后再同步",
            )
        if trigger != "settings":
            logger.warning(
                "grok2api tpsFuse drifted from grok-iq rules; pushing desired=%s actual=%s",
                desired,
                actual,
            )
        revision = snapshot_revision(snapshot)
        if not revision:
            return _result(
                ok=False,
                status="failed",
                error="grok2api 设置缺少 revision",
            )
        config = snapshot_config(snapshot)
        config["tpsFuse"] = desired
        try:
            await self.client.update_admin_settings(revision, config)
        except IntegrationError as exc:
            if retry_on_conflict and _is_settings_conflict(exc):
                latest = await self.client.get_admin_settings()
                return await self._reconcile_snapshot(
                    latest,
                    desired,
                    trigger=trigger,
                    retry_on_conflict=False,
                )
            raise
        status = "drift_pushed" if trigger != "settings" else "synced"
        return _result(ok=True, status=status)
