from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
from collections import defaultdict
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, time, timedelta
from typing import TYPE_CHECKING, Any

from app.analyzer import (
    MEDIA_INPUT_REASONING_ZERO_REASON,
    Classification,
    Thresholds,
    classify_audit_sample,
    get_risk_rule,
    media_input_blocks_reasoning_action,
    risk_rule_definitions,
    risk_rule_enabled,
    rule_candidate_min_count,
    thresholds_from_settings,
)
from app.core.clock import APP_TIMEZONE, app_now, ensure_utc, to_app_timezone, utc_now
from app.core.config import Settings
from app.core.disposition import public_disposition
from app.integrations.grok2api.client import Grok2APIClient
from app.persistence.account_repository import AccountRepository
from app.persistence.probe_repository import ProbeRepository
from app.persistence.request_audit_repository import RequestAuditRepository
from app.reasoning_policy import canonical_reasoning_model

if TYPE_CHECKING:
    from app.services.account_service import AccountService

REQUEST_AUDIT_SCOPE = "grok_build_today"
REQUEST_AUDIT_PAGE_SIZE = 500
# Keep one scheduler/manual execution bounded to 100k upstream rows. The
# durable cursor resumes larger first-day imports or traffic bursts later.
REQUEST_AUDIT_MAX_PAGES = 200
# Kept for API compatibility; adaptive scheduling is the default and exposes
# its actual busy/normal/idle intervals in status payloads.
REQUEST_AUDIT_SCAN_CRON = "*/5 * * * *"
REQUEST_AUDIT_WINDOW_PRESETS = frozenset({"today", "1h", "3h", "6h", "24h", "7d", "30d"})
REQUEST_AUDIT_ACTIVITY_MINUTES = 5
REQUEST_AUDIT_ACCOUNT_CACHE_SECONDS = 120
REQUEST_AUDIT_MEDIA_BACKFILL_KEY = "request_audit_media_input_projection_v1"
REQUEST_AUDIT_MEDIA_BACKFILL_MAX_PAGES = 10
REQUEST_AUDIT_CLIENT_KEY_BACKFILL_KEY = "request_audit_client_key_projection_v1"
REQUEST_AUDIT_CLIENT_KEY_BACKFILL_MAX_PAGES = 10

logger = logging.getLogger(__name__)


@dataclass(slots=True, frozen=True)
class AuditRiskEvaluation:
    classification: Classification
    reasoning_mode: str = ""
    reasoning_min_count: int = 0
    reasoning_streak: int = 0
    reasoning_detected: bool = False


def _finite_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _needs_full_ledger_scan(risk: str) -> bool:
    value = str(risk or "").strip()
    return bool(value) and value != "all"


def _positive_int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if number > 0 else None


def _nonnegative_int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if number >= 0 else None


def _int_or_zero(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0


def _client_key_id(value: Any) -> str:
    text = str(value or "").strip()
    if not text or text == "0":
        return ""
    return text[:64]


def _client_key_name(value: Any) -> str:
    return str(value or "").strip()[:160]


def _parse_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return ensure_utc(value)
    if value is None or str(value).strip() == "":
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError, OverflowError):
        return None
    return ensure_utc(parsed)


def _day_bounds(day_key: str) -> tuple[datetime, datetime]:
    value = date.fromisoformat(day_key)
    start = datetime.combine(value, time.min, tzinfo=APP_TIMEZONE).astimezone(UTC)
    end = (
        datetime.combine(value, time.min, tzinfo=APP_TIMEZONE) + timedelta(days=1)
    ).astimezone(UTC)
    return start, end


def current_day_key() -> str:
    return app_now().date().isoformat()


def _record_day_key(value: datetime) -> str:
    converted = to_app_timezone(value)
    return (converted or value).date().isoformat()


def calculate_audit_tps(item: dict[str, Any]) -> float | None:
    """Match grok2api's outputTokensPerSecond calculation.

    The upstream value is authoritative when present.  The fallback mirrors
    the source implementation: output tokens divided by generation time
    (duration minus first-token latency), in seconds.
    """

    if not bool(item.get("streaming")):
        return None
    status = _int_or_zero(item.get("statusCode"))
    if status < 200 or status >= 300 or str(item.get("errorCode") or ""):
        return None
    output_tokens = _positive_int(item.get("outputTokens"))
    first_token_ms = _nonnegative_int(item.get("firstTokenMs"))
    duration_ms = _nonnegative_int(item.get("durationMs"))
    if not output_tokens or first_token_ms is None or duration_ms is None:
        return None
    generation_ms = duration_ms - first_token_ms
    if generation_ms <= 0:
        return None
    direct = _finite_float(item.get("outputTokensPerSecond"))
    if direct is not None:
        return max(0.0, direct)
    return output_tokens * 1000.0 / generation_ms


def classify_audit_tps(
    tps: float | None,
    soft_threshold: float,
    hard_threshold: float,
) -> tuple[str, list[str]]:
    if tps is None or tps <= 0:
        return "normal", []
    if tps >= hard_threshold:
        return "high", [f"TPS ≥ {hard_threshold:g}"]
    if tps >= soft_threshold:
        return "watch", [f"TPS ≥ {soft_threshold:g}"]
    return "normal", []


def _iso(value: Any) -> str | None:
    if isinstance(value, datetime):
        converted = to_app_timezone(value)
        return converted.isoformat() if converted else None
    if value is None:
        return None
    return str(value)


def _p95(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = (len(ordered) - 1) * 0.95
    lower = math.floor(rank)
    upper = math.ceil(rank)
    if lower == upper:
        return ordered[lower]
    weight = rank - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


class RequestAuditService:
    """Projects grok_build audit windows and scores throughput by account/node."""

    def __init__(
        self,
        *,
        settings: Settings,
        client: Grok2APIClient,
        repository: RequestAuditRepository,
        accounts: AccountRepository | None = None,
        probes: ProbeRepository | None = None,
        account_service: AccountService | None = None,
    ):
        self.settings = settings
        self.client = client
        self.repository = repository
        self.accounts = accounts
        self.probes = probes
        self.account_service = account_service
        self._scan_lock = asyncio.Lock()
        self._egress_cache_lock = asyncio.Lock()
        self._account_cache_lock = asyncio.Lock()
        self._egress_cache: dict[int, dict[str, Any]] = {}
        self._egress_cache_at = 0.0
        self._account_cache: dict[int, dict[str, Any]] = {}
        self._account_cache_known_ids: set[int] = set()
        self._account_cache_at = 0.0
        self._account_cache_checked_at: datetime | None = None
        self._rule_thresholds_cache_key: tuple[Any, ...] | None = None
        self._rule_thresholds_cache: Thresholds | None = None

    @property
    def thresholds(self) -> dict[str, float]:
        return {
            "watch": float(self.settings.degradation_tps),
            "high": float(self.settings.strong_degradation_tps),
        }

    @property
    def rule_thresholds(self) -> Thresholds:
        return self._rule_thresholds()

    def _rule_thresholds(self) -> Thresholds:
        overrides_key = tuple(
            tuple(sorted((str(key), repr(value)) for key, value in item.items()))
            for item in self.settings.risk_rule_overrides
            if isinstance(item, dict)
        )
        cache_key = (
            self.settings.degradation_tps,
            self.settings.strong_degradation_tps,
            self.settings.minimum_output_tokens,
            self.settings.buffer_first_token_share,
            self.settings.min_generation_ms,
            self.settings.reasoning_zero_risk_enabled,
            tuple(
                tuple(sorted((str(key), repr(value)) for key, value in item.items()))
                for item in self.settings.reasoning_model_policies
                if isinstance(item, dict)
            ),
            self.settings.media_input_observe_enabled,
            self.settings.request_audit_risk_enabled,
            self.settings.probe_tps_override_enabled,
            self.settings.probe_tps_override_mode,
            self.settings.probe_tps_override_min_first_token_ms,
            self.settings.probe_tps_override_max_generation_ms,
            overrides_key,
        )
        if (
            self._rule_thresholds_cache is not None
            and cache_key == self._rule_thresholds_cache_key
        ):
            return self._rule_thresholds_cache
        value = thresholds_from_settings(self.settings)
        self._rule_thresholds_cache_key = cache_key
        self._rule_thresholds_cache = value
        return value

    async def scan_scheduled(self) -> dict[str, Any]:
        return await self.scan(trigger="scheduled", window_preset="today")

    async def _backfill_media_input_projection(self) -> dict[str, Any]:
        raw_state = self.repository.metadata_value(REQUEST_AUDIT_MEDIA_BACKFILL_KEY)
        if raw_state == "completed":
            return {"complete": True, "pages": 0, "updated": 0, "error": ""}
        try:
            state = json.loads(raw_state) if raw_state else {}
        except (TypeError, ValueError):
            state = {}
        cursor = str(state.get("cursor") or "") if isinstance(state, dict) else ""
        pages = 0
        updated = 0
        try:
            while pages < REQUEST_AUDIT_MEDIA_BACKFILL_MAX_PAGES:
                payload = await self.client.list_request_audits(
                    cursor=cursor,
                    page_size=REQUEST_AUDIT_PAGE_SIZE,
                    period="90d",
                )
                items = payload.get("items", [])
                if not isinstance(items, list) or not items:
                    self.repository.set_metadata_value(
                        REQUEST_AUDIT_MEDIA_BACKFILL_KEY, "completed"
                    )
                    return {
                        "complete": True,
                        "pages": pages,
                        "updated": updated,
                        "error": "",
                    }
                pages += 1
                updated += self.repository.refresh_media_input_counts(
                    item
                    for item in items
                    if isinstance(item, dict)
                    and str(item.get("provider") or "") == "grok_build"
                )
                next_cursor = str(payload.get("nextCursor") or "")
                has_more = bool(payload.get("hasMore")) and bool(next_cursor)
                if not has_more:
                    self.repository.set_metadata_value(
                        REQUEST_AUDIT_MEDIA_BACKFILL_KEY, "completed"
                    )
                    return {
                        "complete": True,
                        "pages": pages,
                        "updated": updated,
                        "error": "",
                    }
                if next_cursor == cursor:
                    raise RuntimeError("Media Input 回填游标未推进")
                cursor = next_cursor
                self.repository.set_metadata_value(
                    REQUEST_AUDIT_MEDIA_BACKFILL_KEY,
                    json.dumps({"cursor": cursor}),
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if getattr(exc, "error_code", "") == "invalidCursor":
                self.repository.set_metadata_value(
                    REQUEST_AUDIT_MEDIA_BACKFILL_KEY, ""
                )
            return {
                "complete": False,
                "pages": pages,
                "updated": updated,
                "error": str(exc),
            }
        return {"complete": False, "pages": pages, "updated": updated, "error": ""}

    async def _backfill_client_key_projection(self) -> dict[str, Any]:
        raw_state = self.repository.metadata_value(REQUEST_AUDIT_CLIENT_KEY_BACKFILL_KEY)
        if raw_state == "completed":
            return {"complete": True, "pages": 0, "updated": 0, "error": ""}
        try:
            state = json.loads(raw_state) if raw_state else {}
        except (TypeError, ValueError):
            state = {}
        cursor = str(state.get("cursor") or "") if isinstance(state, dict) else ""
        pages = 0
        updated = 0
        try:
            while pages < REQUEST_AUDIT_CLIENT_KEY_BACKFILL_MAX_PAGES:
                payload = await self.client.list_request_audits(
                    cursor=cursor,
                    page_size=REQUEST_AUDIT_PAGE_SIZE,
                    period="90d",
                )
                items = payload.get("items", [])
                if not isinstance(items, list) or not items:
                    self.repository.set_metadata_value(
                        REQUEST_AUDIT_CLIENT_KEY_BACKFILL_KEY, "completed"
                    )
                    return {
                        "complete": True,
                        "pages": pages,
                        "updated": updated,
                        "error": "",
                    }
                pages += 1
                updated += self.repository.refresh_client_keys(
                    item
                    for item in items
                    if isinstance(item, dict)
                    and str(item.get("provider") or "") == "grok_build"
                )
                next_cursor = str(payload.get("nextCursor") or "")
                has_more = bool(payload.get("hasMore")) and bool(next_cursor)
                if not has_more:
                    self.repository.set_metadata_value(
                        REQUEST_AUDIT_CLIENT_KEY_BACKFILL_KEY, "completed"
                    )
                    return {
                        "complete": True,
                        "pages": pages,
                        "updated": updated,
                        "error": "",
                    }
                if next_cursor == cursor:
                    raise RuntimeError("客户端 Key 回填游标未推进")
                cursor = next_cursor
                self.repository.set_metadata_value(
                    REQUEST_AUDIT_CLIENT_KEY_BACKFILL_KEY,
                    json.dumps({"cursor": cursor}),
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if getattr(exc, "error_code", "") == "invalidCursor":
                self.repository.set_metadata_value(
                    REQUEST_AUDIT_CLIENT_KEY_BACKFILL_KEY, ""
                )
            return {
                "complete": False,
                "pages": pages,
                "updated": updated,
                "error": str(exc),
            }
        return {"complete": False, "pages": pages, "updated": updated, "error": ""}

    def resolve_window(
        self,
        *,
        window_preset: str = "today",
        start_at: Any = None,
        end_at: Any = None,
    ) -> dict[str, Any]:
        preset = str(window_preset or "today").strip().lower()
        if preset not in REQUEST_AUDIT_WINDOW_PRESETS | {"custom"}:
            raise ValueError("请求审计时间窗口无效")
        now = utc_now()
        explicit = start_at is not None or end_at is not None
        if explicit:
            start = _parse_datetime(start_at)
            end = _parse_datetime(end_at)
            if start is None or end is None:
                raise ValueError("自定义时间窗口需要完整的开始和结束时间")
            preset = "custom"
        elif preset == "today":
            start, end = _day_bounds(current_day_key())
        elif preset == "1h":
            start, end = now - timedelta(hours=1), now
        elif preset == "3h":
            start, end = now - timedelta(hours=3), now
        elif preset == "6h":
            start, end = now - timedelta(hours=6), now
        elif preset == "24h":
            start, end = now - timedelta(hours=24), now
        elif preset == "7d":
            start, end = now - timedelta(days=7), now
        elif preset == "30d":
            start, end = now - timedelta(days=30), now
        else:
            raise ValueError("自定义时间窗口需要完整的开始和结束时间")

        if start >= end:
            raise ValueError("请求审计开始时间必须早于结束时间")
        if end - start > timedelta(days=90, minutes=1):
            raise ValueError("单次请求审计时间窗口不能超过 90 天")
        if start < now - timedelta(days=90, minutes=1):
            raise ValueError("请求审计仅支持最近 90 天")

        today_start, today_end = _day_bounds(current_day_key())
        is_today = start == today_start and end == today_end
        labels = {
            "today": "当天",
            "1h": "最近 1 小时",
            "3h": "最近 3 小时",
            "6h": "最近 6 小时",
            "24h": "最近 24 小时",
            "7d": "最近 7 天",
            "30d": "最近 30 天",
            "custom": "自定义窗口",
        }
        return {
            "preset": "today" if is_today else preset,
            "label": labels["today" if is_today else preset],
            "start": start,
            "end": end,
            "is_today": is_today,
        }

    async def scan(
        self,
        *,
        trigger: str = "manual",
        window_preset: str = "today",
        start_at: Any = None,
        end_at: Any = None,
    ) -> dict[str, Any]:
        window = self.resolve_window(
            window_preset=window_preset,
            start_at=start_at,
            end_at=end_at,
        )
        async with self._scan_lock:
            return await self._scan_locked(trigger=trigger, window=window)

    @staticmethod
    def _window_scope(window: dict[str, Any]) -> tuple[str, str]:
        if window["is_today"]:
            return REQUEST_AUDIT_SCOPE, current_day_key()
        preset = str(window["preset"])
        if preset in REQUEST_AUDIT_WINDOW_PRESETS:
            return f"grok_build_{preset}", preset
        raw = f"{window['start'].isoformat()}|{window['end'].isoformat()}"
        digest = hashlib.sha256(raw.encode()).hexdigest()
        return f"grok_build_window:{digest[:24]}", digest[:16]

    @staticmethod
    def _upstream_period(start: datetime) -> str:
        age = max(timedelta(0), utc_now() - start)
        if age <= timedelta(hours=24, minutes=1):
            return "24h"
        if age <= timedelta(days=7, minutes=1):
            return "7d"
        if age <= timedelta(days=30, minutes=1):
            return "30d"
        return "90d"

    def _skipped_scan(
        self,
        *,
        trigger: str,
        window: dict[str, Any],
        error: str,
        ok: bool = True,
    ) -> dict[str, Any]:
        return {
            "ok": ok,
            "skipped": True,
            "trigger": trigger,
            "day": current_day_key(),
            "window": self._window_payload(window),
            "error": error,
            "activity": {
                "level": "idle",
                "label": "闲时",
                "requests": 0,
                "requestsPerMinute": 0,
                "maxTps": 0,
                "sampleMinutes": REQUEST_AUDIT_ACTIVITY_MINUTES,
                "reasons": [error],
                "recommendedIntervalSeconds": (
                    self.settings.request_audit_idle_scan_interval_seconds
                ),
            },
            "recommendedIntervalSeconds": (
                self.settings.request_audit_idle_scan_interval_seconds
            ),
        }

    async def _scan_locked(
        self,
        *,
        trigger: str,
        window: dict[str, Any],
    ) -> dict[str, Any]:
        if not self.settings.request_audit_enabled:
            return self._skipped_scan(
                trigger=trigger,
                window=window,
                error="请求审计监控已停用",
            )
        if trigger == "scheduled" and not self.settings.request_audit_auto_scan_enabled:
            return self._skipped_scan(
                trigger=trigger,
                window=window,
                error="请求审计自动扫描已停用",
            )

        scope, identity = self._window_scope(window)
        state = self.repository.ensure_state(scope)
        if state.get("day_key") != identity:
            state = self.repository.reset_day(scope, identity)

        started_at = utc_now()
        previous_success_at = ensure_utc(state.get("last_success_at"))
        if (
            not self.settings.grok2api_admin_username
            or not self.settings.grok2api_admin_password
        ):
            result = self._skipped_scan(
                trigger=trigger,
                window=window,
                error="grok2api 管理凭据尚未配置",
                ok=False,
            )
            self.repository.save_state(
                scope,
                {"last_scan_at": started_at, "last_error": result["error"]},
            )
            return result

        start = window["start"]
        end = window["end"]
        initial_complete = bool(state.get("initial_complete"))
        previous_boundary_id = (
            str(state.get("newest_upstream_id") or "") if initial_complete else ""
        )
        saved_initial_cursor = (
            str(state.get("initial_cursor") or "") if not initial_complete else ""
        )
        scan_head_id = (
            str(state.get("newest_upstream_id") or "") if not initial_complete else ""
        )
        scan_head_created_at = (
            ensure_utc(state.get("newest_created_at")) if not initial_complete else None
        )
        cursor = saved_initial_cursor
        mode = (
            "incremental"
            if initial_complete
            else "initial_resume"
            if saved_initial_cursor
            else "initial"
        )
        pages = 0
        inserted = 0
        seen_records = 0
        skipped_non_build = 0
        skipped_outside_day = 0
        reached_day_start = False
        reached_overlap = False
        has_more = False
        egress_error = ""
        egress_updated = 0
        try:
            media_backfill = await self._backfill_media_input_projection()
            client_key_backfill = await self._backfill_client_key_projection()
            try:
                egress_map = await self._egress_map()
            except Exception as exc:  # node labels are supplemental
                egress_map = self._egress_cache
                egress_error = str(exc)
            try:
                egress_updated = self.repository.refresh_egress_node_details(
                    start=start,
                    end=end,
                    nodes=egress_map,
                )
            except Exception as exc:  # legacy cleanup must not block scanning
                detail_error = str(exc)
                egress_error = (
                    f"{egress_error}；{detail_error}" if egress_error else detail_error
                )

            while pages < REQUEST_AUDIT_MAX_PAGES:
                payload = await self.client.list_request_audits(
                    cursor=cursor,
                    page_size=REQUEST_AUDIT_PAGE_SIZE,
                    period=self._upstream_period(start),
                )
                items = payload.get("items", [])
                if not isinstance(items, list) or not items:
                    has_more = False
                    break
                pages += 1
                next_cursor = str(payload.get("nextCursor") or "")
                has_more = bool(payload.get("hasMore")) and bool(next_cursor)
                if not scan_head_id:
                    for head_item in items:
                        if not isinstance(head_item, dict):
                            continue
                        candidate_id = str(
                            head_item.get("id") or head_item.get("requestId") or ""
                        ).strip()
                        if candidate_id:
                            scan_head_id = candidate_id
                            scan_head_created_at = _parse_datetime(
                                head_item.get("createdAt")
                            )
                            break
                ids = [
                    str(item.get("id") or item.get("requestId") or "")
                    for item in items
                    if isinstance(item, dict)
                ]
                existing_ids = self.repository.existing_ids(ids)
                self.repository.refresh_client_keys(
                    item
                    for item in items
                    if isinstance(item, dict)
                    and str(item.get("provider") or "") == "grok_build"
                )
                page_has_overlap = False
                page_records: list[dict[str, Any]] = []
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    upstream_id = str(
                        item.get("id") or item.get("requestId") or ""
                    ).strip()
                    if (
                        initial_complete
                        and previous_boundary_id
                        and upstream_id == previous_boundary_id
                    ):
                        page_has_overlap = True
                        break
                    created_at = _parse_datetime(item.get("createdAt"))
                    if created_at is not None and created_at < start:
                        skipped_outside_day += 1
                        reached_day_start = True
                        break
                    if created_at is None or created_at >= end:
                        skipped_outside_day += 1
                        continue
                    if str(item.get("provider") or "") != "grok_build":
                        skipped_non_build += 1
                        continue
                    seen_records += 1
                    if not upstream_id:
                        continue
                    if upstream_id in existing_ids:
                        # Rows committed by a failed incremental attempt may
                        # sit ahead of the last durable upstream boundary. Keep
                        # paging until that boundary; only legacy states without
                        # one use a known local row as the stopping point.
                        if initial_complete and not previous_boundary_id:
                            page_has_overlap = True
                            break
                        continue
                    normalized = self._normalize_record(
                        item,
                        upstream_id,
                        _record_day_key(created_at),
                        created_at,
                        egress_map,
                    )
                    if normalized is not None:
                        page_records.append(normalized)

                # Commit each page before advancing a durable catch-up cursor.
                # A process interruption can therefore only replay the page;
                # it cannot create a gap in the local projection.
                inserted += self.repository.upsert_records(page_records)

                # Results are ordered newest-first by grok2api. The prior
                # upstream head is the durable overlap boundary; all older
                # pages were covered by the preceding successful scan.
                if page_has_overlap and initial_complete:
                    reached_overlap = True
                    break
                if reached_day_start:
                    break
                if not has_more:
                    break
                if next_cursor == cursor:
                    raise RuntimeError("grok2api 请求审计游标未推进")
                cursor = next_cursor
                if not initial_complete:
                    self.repository.save_state(
                        scope,
                        {
                            "day_key": identity,
                            "newest_upstream_id": scan_head_id,
                            "newest_created_at": scan_head_created_at,
                            "initial_cursor": cursor,
                        },
                    )

            all_records = self.repository.records_for_range(start, end)
            evaluations = self._audit_risk_evaluations(all_records)
            complete = bool(reached_day_start or not has_more or reached_overlap)
            boundary_id = scan_head_id or previous_boundary_id
            boundary_created_at = (
                scan_head_created_at if scan_head_id else state.get("newest_created_at")
            )
            state_values = {
                "day_key": identity,
                "newest_upstream_id": boundary_id,
                "newest_created_at": boundary_created_at,
                "initial_cursor": "" if complete else cursor,
                "initial_complete": complete,
                "last_scan_at": started_at,
                "last_success_at": utc_now(),
                "last_error": "",
                "last_pages": pages,
                "last_new_records": inserted,
                "last_seen_records": seen_records,
            }
            saved_state = self.repository.save_state(scope, state_values)
            self.repository.delete_older_than(
                self.repository.retention_cutoff(
                    self.settings.request_audit_retention_days
                )
            )
            # Do not trigger a batch of actions while the first historical
            # import is still being established. Subsequent scans count TPS
            # anomalies across the full local window, but only accounts with a
            # newly discovered high-risk row (or a retryable prior action) may
            # enter the mutation path. This prevents rescanning an old window
            # from repeatedly reporting or applying historical actions.
            trigger_account_ids = self._new_risk_account_ids(
                all_records,
                discovered_after=previous_success_at or started_at,
                evaluations=evaluations,
            )
            trigger_account_ids.update(
                self.repository.retryable_verification_account_ids()
            )
            pre_disable_checks = await self._process_pre_disable_checks(
                self._pre_disable_candidates(
                    all_records,
                    trigger_account_ids=trigger_account_ids,
                    evaluations=evaluations,
                )
                if initial_complete
                else []
            )
            activity = self._activity_payload(
                pages=pages,
                initial_complete=complete,
            )
            summary = self._summary_payload(
                window, all_records, evaluations=evaluations
            )
            return {
                "ok": True,
                "trigger": trigger,
                "day": current_day_key(),
                "window": self._window_payload(window),
                "mode": mode,
                "pages": pages,
                "newRecords": inserted,
                "seenRecords": seen_records,
                "skippedNonBuild": skipped_non_build,
                "skippedOutsideDay": skipped_outside_day,
                "skippedOutsideWindow": skipped_outside_day,
                "reachedOverlap": reached_overlap,
                "egressUpdated": egress_updated,
                "egressWarning": egress_error,
                "mediaInputBackfill": media_backfill,
                "clientKeyBackfill": client_key_backfill,
                "preDisableChecks": pre_disable_checks,
                "state": self._state_payload(saved_state, window=window),
                "activity": activity,
                "recommendedIntervalSeconds": activity["recommendedIntervalSeconds"],
                "summary": summary,
            }
        except Exception as exc:
            error = str(exc)
            state_error = error
            state_values: dict[str, Any] = {
                "day_key": identity,
                "last_scan_at": started_at,
                "last_error": state_error,
                "last_pages": pages,
                "last_new_records": inserted,
                "last_seen_records": seen_records,
            }
            if (
                not initial_complete
                and getattr(exc, "error_code", "") == "invalidCursor"
            ):
                state_error = f"{error}；首次扫描游标已重置"
                state_values["initial_cursor"] = ""
                state_values["last_error"] = state_error
            self.repository.save_state(scope, state_values)
            activity = self._activity_payload(
                pages=pages,
                initial_complete=False,
                scan_failed=True,
            )
            return {
                "ok": False,
                "trigger": trigger,
                "day": current_day_key(),
                "window": self._window_payload(window),
                "mode": mode,
                "pages": pages,
                "newRecords": inserted,
                "error": state_error,
                "activity": activity,
                "recommendedIntervalSeconds": activity["recommendedIntervalSeconds"],
            }

    async def _process_pre_disable_checks(
        self,
        records: list[dict[str, Any]],
    ) -> dict[str, int]:
        stats = {
            "requested": len(records),
            "flagged": 0,
            "clean": 0,
            "skipped": 0,
            "disabled": 0,
            "deprioritized": 0,
            "failed": 0,
        }
        if not records:
            return stats

        semaphore = asyncio.Semaphore(4)

        async def run(record: dict[str, Any]) -> dict[str, Any]:
            async with semaphore:
                return await self._process_pre_disable_candidate(record)

        outcomes = await asyncio.gather(
            *(run(record) for record in records),
            return_exceptions=True,
        )
        failed_action_statuses = {
            "action_failed",
            "deprioritize_failed",
            "task_protected",
        }
        for outcome in outcomes:
            if isinstance(outcome, BaseException):
                stats["failed"] += 1
                logger.error(
                    "request audit pre-disable check failed",
                    exc_info=(
                        type(outcome),
                        outcome,
                        outcome.__traceback__,
                    ),
                )
                continue
            status = str(outcome.get("status") or "")
            action_status = str(outcome.get("action_status") or "")
            checked_at = ensure_utc(outcome.get("checked_at"))
            completed_now = (
                checked_at is not None
                and checked_at >= utc_now() - timedelta(minutes=5)
            )
            if status == "flagged":
                if completed_now:
                    stats["flagged"] += 1
            elif status in {"clean", "session_confirmed"}:
                if completed_now:
                    stats["clean"] += 1
            else:
                stats["skipped"] += 1
            if completed_now:
                if action_status in {"disabled", "already_disabled"}:
                    stats["disabled"] += 1
                if action_status in {"deprioritized", "already_deprioritized"}:
                    stats["deprioritized"] += 1
            if status == "check_failed" or action_status in failed_action_statuses:
                stats["failed"] += 1
        return stats

    def _pre_disable_candidates(
        self,
        records: list[dict[str, Any]],
        *,
        trigger_account_ids: set[int] | None = None,
        evaluations: dict[str, AuditRiskEvaluation] | None = None,
    ) -> list[dict[str, Any]]:
        """Select one SSO/action candidate per account from registered rules."""

        grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for row in records:
            account_id = _positive_int(row.get("account_id"))
            if account_id:
                grouped[account_id].append(row)

        candidates: list[dict[str, Any]] = []
        thresholds = self._rule_thresholds()
        for account_id, rows in grouped.items():
            if (
                trigger_account_ids is not None
                and account_id not in trigger_account_ids
            ):
                continue
            rows_by_rule: dict[
                str, list[tuple[dict[str, Any], AuditRiskEvaluation]]
            ] = defaultdict(list)
            for row in rows:
                evaluation = self._evaluation_for(row, evaluations)
                classified = evaluation.classification
                if classified.name != "high" or not classified.rule_id:
                    continue
                if classified.rule_id == "media_input_observe":
                    continue
                if (
                    classified.rule_id == "reasoning_zero"
                    and media_input_blocks_reasoning_action(
                        _int_or_zero(row.get("media_input_images"))
                    )
                ):
                    continue
                rule = get_risk_rule(classified.rule_id)
                if rule is None or not rule.audit_action_mode:
                    continue
                if (
                    rule.id == "reasoning_zero"
                    and evaluation.reasoning_streak < evaluation.reasoning_min_count
                ):
                    continue
                rows_by_rule[rule.id].append((row, evaluation))

            matched: list[dict[str, Any]] = []
            for rule_id, rule_pairs in rows_by_rule.items():
                rule = get_risk_rule(rule_id)
                if rule is None:
                    continue
                min_count = rule_candidate_min_count(rule, thresholds)
                if rule.audit_action_mode == "tps_only":
                    min_count = max(
                        min_count,
                        int(self.settings.request_audit_tps_only_min_count),
                    )
                evidence_count = max(
                    len(rule_pairs),
                    max(
                        (
                            pair[1].reasoning_streak
                            for pair in rule_pairs
                            if pair[1].reasoning_streak > 0
                        ),
                        default=0,
                    ),
                )
                if evidence_count < min_count:
                    continue
                rule_rows = [pair[0] for pair in rule_pairs]
                latest = max(
                    rule_rows,
                    key=lambda row: ensure_utc(row.get("created_at"))
                    or datetime.min.replace(tzinfo=UTC),
                )
                latest_evaluation = next(
                    evaluation
                    for row, evaluation in rule_pairs
                    if row is latest
                )
                candidate = {
                    **latest,
                    "_action_mode": rule.audit_action_mode,
                    "_risk_rule_id": rule.id,
                    "_risk_rule_count": evidence_count,
                    "_risk_rule_min_count": min_count,
                    "_risk_reasons": list(latest_evaluation.classification.reasons),
                    "_reasoning_streak": latest_evaluation.reasoning_streak,
                    "_reasoning_min_count": latest_evaluation.reasoning_min_count,
                }
                if rule.audit_action_mode == "tps_only":
                    candidate.update(
                        {
                            "_tps_anomaly_count": evidence_count,
                            "_tps_min_count": min_count,
                            "_tps_max": max(
                                float(row.get("tps") or 0) for row in rule_rows
                            ),
                            "_tps_egress_node_ids": sorted(
                                {
                                    int(row["egress_node_id"])
                                    for row in rule_rows
                                    if _positive_int(row.get("egress_node_id"))
                                    is not None
                                }
                            ),
                        }
                    )
                matched.append(candidate)
            if matched:
                matched.sort(
                    key=lambda row: (
                        str(row.get("_action_mode")) == "quarantine",
                        ensure_utc(row.get("created_at"))
                        or datetime.min.replace(tzinfo=UTC),
                    ),
                    reverse=True,
                )
                candidates.append(matched[0])
        return candidates

    def _new_risk_account_ids(
        self,
        records: list[dict[str, Any]],
        *,
        discovered_after: datetime,
        evaluations: dict[str, AuditRiskEvaluation] | None = None,
    ) -> set[int]:
        boundary = ensure_utc(discovered_after) or utc_now()
        result: set[int] = set()
        for row in records:
            account_id = _positive_int(row.get("account_id"))
            if account_id is None:
                continue
            fetched_at = ensure_utc(row.get("fetched_at"))
            if fetched_at is None or fetched_at <= boundary:
                continue
            if (
                self._evaluation_for(row, evaluations).classification.name
                == "high"
            ):
                result.add(account_id)
        return result

    def _account_is_quarantined(self, account_id: int) -> bool:
        if self.accounts is None or account_id <= 0:
            return False
        assessment = self.accounts.get_assessment(account_id) or {}
        return str(assessment.get("monitor_status") or "") == "quarantined"

    async def _process_pre_disable_candidate(
        self,
        record: dict[str, Any],
    ) -> dict[str, Any]:
        account_id = int(record.get("account_id") or 0)
        audit_id = str(record.get("upstream_id") or "")
        created_at = ensure_utc(record.get("created_at")) or utc_now()
        verification = self.repository.create_verification(
            {
                "account_id": account_id,
                "audit_upstream_id": audit_id,
                "audit_created_at": created_at,
                "audit_tps": float(record.get("tps") or 0),
                "status": "pending",
                "action_status": "pending",
            }
        )
        existing_status = str(verification.get("status") or "")
        existing_action = str(verification.get("action_status") or "")
        finished_actions = {
            "disabled",
            "already_disabled",
        }
        if existing_action in finished_actions:
            return verification
        if (
            existing_action == "auto_quarantine_disabled"
            and not self.settings.request_audit_isolation_enabled
        ):
            return verification
        if existing_status == "checking":
            updated_at = ensure_utc(verification.get("updated_at"))
            if updated_at is not None and updated_at > utc_now() - timedelta(
                minutes=5
            ):
                return verification
        if self._account_is_quarantined(account_id):
            if existing_action != "pending":
                return verification
            return self.repository.update_verification(
                audit_id,
                {
                    "sso_verdict": "skipped",
                    "bot_flag": {},
                    "proxy_used": False,
                    "valid_session": None,
                    "email_match": None,
                    "status_code": 0,
                    "response_ms": 0,
                    "check_error": "",
                    "checked_at": utc_now(),
                    "status": "sso_skipped",
                    "action_status": "already_quarantined",
                    "action_error": "",
                },
            ) or verification
        return await self._apply_sso_skipped_action(record, verification)

    async def _apply_sso_skipped_action(
        self,
        record: dict[str, Any],
        verification: dict[str, Any],
    ) -> dict[str, Any]:
        common = {
            "sso_verdict": "skipped",
            "bot_flag": {},
            "proxy_used": False,
            "valid_session": None,
            "email_match": None,
            "status_code": 0,
            "response_ms": 0,
            "check_error": "",
            "checked_at": utc_now(),
        }
        return await self._apply_flagged_quarantine(
            record,
            verification,
            common=common,
            status="sso_skipped",
        )

    async def _apply_flagged_quarantine(
        self,
        record: dict[str, Any],
        verification: dict[str, Any],
        *,
        common: dict[str, Any],
        status: str = "flagged",
    ) -> dict[str, Any]:
        account_id = int(record.get("account_id") or 0)
        audit_id = str(record.get("upstream_id") or "")
        created_at = ensure_utc(record.get("created_at")) or utc_now()
        verdict = str(
            common.get("sso_verdict")
            or ("skipped" if status == "sso_skipped" else "flagged")
        )
        bot_flag = (
            common.get("bot_flag")
            if isinstance(common.get("bot_flag"), dict)
            else {}
        )
        proxy_used = bool(common.get("proxy_used"))
        raw_risk_reasons = record.get("_risk_reasons")
        if isinstance(raw_risk_reasons, (list, tuple)):
            risk_reasons = [str(value) for value in raw_risk_reasons if str(value)]
        else:
            risk_reasons = list(
                self._evaluation_for(record).classification.reasons
            )
        self.repository.clear_egress_recommendations_for_account(account_id)
        if not self.settings.request_audit_isolation_enabled:
            return self.repository.update_verification(
                audit_id,
                {
                    **common,
                    "status": status,
                    "action_status": "auto_quarantine_disabled",
                    "action_error": "",
                },
            ) or verification
        if self.account_service is None:
            return self.repository.update_verification(
                audit_id,
                {
                    **common,
                    "status": status,
                    "action_status": "action_failed",
                    "action_error": "自动停用服务尚未接入",
                },
            ) or verification
        action_mode = str(record.get("_action_mode") or "quarantine")
        note = (
            "请求审计 TPS 多次异常已达处置阈值后自动停用"
            if action_mode == "tps_only"
            else "请求审计高风险已达处置阈值后自动停用"
        )
        detail = {
            "auditId": audit_id,
            "riskRuleId": str(record.get("_risk_rule_id") or ""),
            "riskRuleCount": int(record.get("_risk_rule_count") or 1),
            "auditCreatedAt": _iso(created_at),
            "auditTps": round(float(record.get("tps") or 0), 2),
            "reasoningTokens": int(record.get("reasoning_tokens") or 0),
            "riskReasons": risk_reasons,
            "ssoVerdict": verdict,
            "botFlag": bot_flag,
            "proxyUsed": proxy_used,
        }
        if action_mode == "tps_only":
            detail.update(
                {
                    "tpsAnomalyCount": int(
                        record.get("_tps_anomaly_count")
                        or record.get("_risk_rule_count")
                        or 0
                    ),
                    "maxTps": round(
                        float(record.get("_tps_max") or record.get("tps") or 0),
                        2,
                    ),
                    "recommendation": "change_egress",
                }
            )
        try:
            action = await self.account_service.apply_auto_quarantine(
                account_id,
                source="request_audit",
                note=note,
                risk_score=max(float(self.settings.risk_high_floor), 85.0),
                force=True,
                permanent=True,
                detail=detail,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception(
                "request audit auto quarantine failed account=%s audit=%s",
                account_id,
                audit_id,
            )
            return self.repository.update_verification(
                audit_id,
                {
                    **common,
                    "status": status,
                    "action_status": "action_failed",
                    "action_error": str(exc)[:1000],
                },
            ) or verification

        action_status = str(action.get("actionStatus") or "action_failed")
        self.repository.set_action_for_account_statuses(
            account_id,
            statuses={"flagged", "session_confirmed", "sso_skipped"},
            action_status=action_status,
        )
        return self.repository.update_verification(
            audit_id,
            {
                **common,
                "status": status,
                "action_status": action_status,
                "action_error": "",
            },
        ) or verification

    @staticmethod
    def _window_payload(window: dict[str, Any]) -> dict[str, Any]:
        return {
            "preset": str(window["preset"]),
            "label": str(window["label"]),
            "startAt": _iso(window["start"]),
            "endAt": _iso(window["end"]),
            "isToday": bool(window["is_today"]),
        }

    def _activity_payload(
        self,
        *,
        pages: int = 0,
        initial_complete: bool = True,
        scan_failed: bool = False,
    ) -> dict[str, Any]:
        sample_end = utc_now() + timedelta(seconds=1)
        sample_start = sample_end - timedelta(minutes=REQUEST_AUDIT_ACTIVITY_MINUTES)
        recent = self.repository.records_for_range(sample_start, sample_end)
        measured = [
            float(row["tps"])
            for row in recent
            if _finite_float(row.get("tps")) is not None
            and float(row.get("tps") or 0) > 0
        ]
        requests = len(recent)
        request_rate = requests / REQUEST_AUDIT_ACTIVITY_MINUTES
        max_tps = max(measured, default=0.0)
        recent_evaluations = self._audit_risk_evaluations(recent)
        reasoning_zero_detected = any(
            self._evaluation_for(row, recent_evaluations).reasoning_detected
            for row in recent
        )
        reasons: list[str] = []

        if scan_failed:
            level = "normal"
            reasons.append("上次扫描异常，按常态间隔重试")
        elif not initial_complete or pages > 1:
            level = "busy"
            reasons.append("审计分页仍有积压")
        elif request_rate >= self.settings.request_audit_busy_requests_per_minute:
            level = "busy"
            reasons.append(f"最近请求速率 {request_rate:.1f}/分钟达到忙时阈值")
        elif (
            self.settings.request_audit_risk_enabled
            and (
                max_tps >= self.settings.degradation_tps
                or reasoning_zero_detected
            )
        ):
            level = "busy"
            reasons.append(
                "最近出现思考输出为 0 的风险请求"
                if reasoning_zero_detected
                else f"最近出现 {max_tps:.1f} Token/s 风险请求"
            )
        elif requests > 0:
            level = "normal"
            reasons.append("最近窗口仍有请求活动")
        else:
            level = "idle"
            reasons.append("最近窗口没有新的 grok_build 请求")

        interval_by_level = {
            "busy": self.settings.request_audit_busy_scan_interval_seconds,
            "normal": self.settings.request_audit_normal_scan_interval_seconds,
            "idle": self.settings.request_audit_idle_scan_interval_seconds,
        }
        recommended = (
            interval_by_level[level]
            if self.settings.request_audit_adaptive_scan_enabled
            else self.settings.request_audit_scan_interval_minutes * 60
        )
        return {
            "level": level,
            "label": {"busy": "忙时", "normal": "常态", "idle": "闲时"}[level],
            "requests": requests,
            "requestsPerMinute": round(request_rate, 1),
            "maxTps": round(max_tps, 1),
            "sampleMinutes": REQUEST_AUDIT_ACTIVITY_MINUTES,
            "reasons": reasons,
            "recommendedIntervalSeconds": int(recommended),
        }

    @staticmethod
    def _record_account_ids(records: list[dict[str, Any]]) -> set[int]:
        return {
            int(row["account_id"])
            for row in records
            if _positive_int(row.get("account_id")) is not None
        }

    def _cached_account_map(
        self,
        account_ids: set[int],
    ) -> dict[int, dict[str, Any]]:
        return {
            account_id: self._account_cache[account_id]
            for account_id in account_ids
            if account_id in self._account_cache
        }

    async def _upstream_account_map(
        self,
        account_ids: set[int],
    ) -> dict[int, dict[str, Any]]:
        requested_ids = {account_id for account_id in account_ids if account_id > 0}
        if not requested_ids:
            return {}
        now = asyncio.get_running_loop().time()
        fresh = (
            self._account_cache_at > 0
            and now - self._account_cache_at < REQUEST_AUDIT_ACCOUNT_CACHE_SECONDS
        )
        if fresh and requested_ids.issubset(self._account_cache_known_ids):
            return self._cached_account_map(requested_ids)

        async with self._account_cache_lock:
            now = asyncio.get_running_loop().time()
            fresh = (
                self._account_cache_at > 0
                and now - self._account_cache_at < REQUEST_AUDIT_ACCOUNT_CACHE_SECONDS
            )
            if not fresh:
                self._account_cache = {}
                self._account_cache_known_ids = set()
                self._account_cache_checked_at = None
            missing_ids = requested_ids - self._account_cache_known_ids
            if not missing_ids:
                return self._cached_account_map(requested_ids)
            try:
                values = (
                    await self.client.get_accounts_by_ids(missing_ids)
                    if len(missing_ids) <= 50
                    else await self.client.list_all_accounts(missing_ids)
                )
            except Exception:
                # Cache the failed lookup briefly so simultaneous table and
                # summary refreshes do not fan out duplicate upstream calls.
                self._account_cache_known_ids.update(missing_ids)
                self._account_cache_at = now
                raise
            for value in values:
                account_id = _positive_int(value.get("id"))
                if account_id is not None:
                    self._account_cache[account_id] = value
            self._account_cache_known_ids.update(missing_ids)
            self._account_cache_at = now
            self._account_cache_checked_at = utc_now()
            return self._cached_account_map(requested_ids)

    async def _egress_map(self) -> dict[int, dict[str, Any]]:
        now = asyncio.get_running_loop().time()
        if self._egress_cache_at > 0 and now - self._egress_cache_at < 240:
            return self._egress_cache
        async with self._egress_cache_lock:
            now = asyncio.get_running_loop().time()
            if self._egress_cache_at > 0 and now - self._egress_cache_at < 240:
                return self._egress_cache
            result: dict[int, dict[str, Any]] = {}
            page = 1
            while page <= 100:
                payload = await self.client.list_egress_nodes(
                    scope="grok_build", page=page, pageSize=500
                )
                items = payload.get("items", [])
                if not isinstance(items, list) or not items:
                    break
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    node_id = _positive_int(item.get("id"))
                    if node_id:
                        result[node_id] = item
                total = int(payload.get("total") or 0)
                size = int(payload.get("pageSize") or len(items) or 500)
                if (total > 0 and page * size >= total) or len(items) < size:
                    break
                page += 1
            self._egress_cache = result
            self._egress_cache_at = now
            return result

    def _normalize_record(
        self,
        item: dict[str, Any],
        upstream_id: str,
        day_key: str,
        created_at: datetime,
        egress_map: dict[int, dict[str, Any]],
    ) -> dict[str, Any]:
        egress_node_id = _positive_int(item.get("egressNodeId"))
        egress = egress_map.get(egress_node_id or 0, {})
        tps = calculate_audit_tps(item)
        status_code = _int_or_zero(item.get("statusCode"))
        media_input_images = max(0, _int_or_zero(item.get("mediaInputImages")))
        output_tokens = _int_or_zero(item.get("outputTokens"))
        reasoning_tokens = _int_or_zero(item.get("reasoningTokens"))
        risk_level, reasons = self._classify_values(
            tps=tps,
            status_code=status_code,
            output_tokens=output_tokens,
            reasoning_tokens=reasoning_tokens,
            first_token_ms=_nonnegative_int(item.get("firstTokenMs")),
            duration_ms=_int_or_zero(item.get("durationMs")),
            extra={
                "media_input_images": media_input_images,
                "model_upstream_model": str(item.get("modelUpstreamModel") or ""),
                "model_public_id": str(item.get("modelPublicId") or ""),
                "operation": str(item.get("operation") or ""),
                "reasoning_tokens_reported": "reasoningTokens" in item,
            },
        )
        raw_keys = (
            "id",
            "requestId",
            "provider",
            "operation",
            "modelPublicId",
            "modelUpstreamModel",
            "accountId",
            "accountName",
            "clientKeyId",
            "clientKeyName",
            "egressNodeId",
            "egressNodeName",
            "egressMode",
            "egressScope",
            "statusCode",
            "streaming",
            "inputTokens",
            "mediaInputImages",
            "outputTokens",
            "reasoningTokens",
            "totalTokens",
            "firstTokenMs",
            "durationMs",
            "outputTokensPerSecond",
            "errorCode",
            "createdAt",
        )
        raw = {key: item.get(key) for key in raw_keys if key in item}
        return {
            "upstream_id": upstream_id,
            "request_id": str(item.get("requestId") or ""),
            "day_key": day_key,
            "provider": "grok_build",
            "operation": str(item.get("operation") or ""),
            "model_public_id": str(item.get("modelPublicId") or ""),
            "model_upstream_model": str(item.get("modelUpstreamModel") or ""),
            "account_id": _positive_int(item.get("accountId")),
            "account_name": str(item.get("accountName") or ""),
            "client_key_id": _client_key_id(item.get("clientKeyId")),
            "client_key_name": _client_key_name(item.get("clientKeyName")),
            "egress_node_id": egress_node_id,
            "egress_node_name": str(
                item.get("egressNodeName") or egress.get("name") or ""
            ),
            # Kept as an empty compatibility column. A node's current exitIp
            # is a probe snapshot, not the IP used by this historical request.
            "egress_ip": "",
            "egress_mode": str(item.get("egressMode") or ""),
            "egress_scope": str(item.get("egressScope") or ""),
            "status_code": status_code,
            "streaming": bool(item.get("streaming")),
            "input_tokens": _int_or_zero(item.get("inputTokens")),
            "media_input_images": media_input_images,
            "output_tokens": output_tokens,
            "reasoning_tokens": reasoning_tokens,
            "reasoning_tokens_reported": "reasoningTokens" in item,
            "total_tokens": _int_or_zero(item.get("totalTokens")),
            "first_token_ms": _nonnegative_int(item.get("firstTokenMs")),
            "duration_ms": _int_or_zero(item.get("durationMs")),
            "tps": tps,
            "risk_level": risk_level,
            "risk_reasons": reasons,
            "raw": raw,
            "created_at": created_at,
            "fetched_at": utc_now(),
        }

    def _config_payload(self) -> dict[str, Any]:
        return {
            "enabled": self.settings.request_audit_enabled,
            "autoScanEnabled": self.settings.request_audit_auto_scan_enabled,
            "adaptiveScanEnabled": self.settings.request_audit_adaptive_scan_enabled,
            "fixedScanIntervalMinutes": self.settings.request_audit_scan_interval_minutes,
            "busyScanIntervalSeconds": self.settings.request_audit_busy_scan_interval_seconds,
            "normalScanIntervalSeconds": self.settings.request_audit_normal_scan_interval_seconds,
            "idleScanIntervalSeconds": self.settings.request_audit_idle_scan_interval_seconds,
            "busyRequestsPerMinute": self.settings.request_audit_busy_requests_per_minute,
            "liveRefreshEnabled": self.settings.request_audit_live_refresh_enabled,
            "liveRefreshSeconds": self.settings.request_audit_live_refresh_seconds,
            "riskEnabled": self.settings.request_audit_risk_enabled,
            "reasoningZeroRiskEnabled": risk_rule_enabled(
                "reasoning_zero",
                self._rule_thresholds(),
            ),
            "mediaInputObserveEnabled": risk_rule_enabled(
                "media_input_observe",
                self._rule_thresholds(),
            ),
            "rules": risk_rule_definitions(self._rule_thresholds(), scope="audit"),
            "tpsOnlyDeprioritizeEnabled": (
                self.settings.request_audit_tps_only_deprioritize_enabled
            ),
            "tpsOnlyPriority": self.settings.request_audit_tps_only_priority,
            "tpsOnlyMinCount": self.settings.request_audit_tps_only_min_count,
            "isolationEnabled": self.settings.request_audit_isolation_enabled,
            "ssoRecheckEnabled": False,
            "retentionDays": self.settings.request_audit_retention_days,
        }

    def status(self) -> dict[str, Any]:
        day_key = current_day_key()
        window = self.resolve_window(window_preset="today")
        state = self.repository.ensure_state(REQUEST_AUDIT_SCOPE)
        if state.get("day_key") != day_key:
            state = self.repository.state_defaults(REQUEST_AUDIT_SCOPE)
            state["day_key"] = day_key
        available = self.repository.available_range()
        activity = self._activity_payload(
            pages=int(state.get("last_pages") or 0),
            initial_complete=bool(state.get("initial_complete")),
        )
        schedule_enabled = bool(
            self.settings.scheduler_enabled
            and self.settings.request_audit_enabled
            and self.settings.request_audit_auto_scan_enabled
        )
        return {
            "day": day_key,
            "provider": "grok_build",
            "thresholds": self.thresholds,
            "configured": bool(
                self.settings.grok2api_admin_username
                and self.settings.grok2api_admin_password
            ),
            "config": self._config_payload(),
            "scan": self._state_payload(state, window=window),
            "activity": activity,
            "localRecords": self.repository.count_for_range(
                window["start"], window["end"]
            ),
            "availableRange": {
                "startAt": _iso(available["start"]),
                "endAt": _iso(available["end"]),
                "records": available["records"],
            },
            "schedule": {
                "enabled": schedule_enabled,
                "adaptive": self.settings.request_audit_adaptive_scan_enabled,
                "fixedIntervalMinutes": self.settings.request_audit_scan_interval_minutes,
                "busyIntervalSeconds": self.settings.request_audit_busy_scan_interval_seconds,
                "normalIntervalSeconds": self.settings.request_audit_normal_scan_interval_seconds,
                "idleIntervalSeconds": self.settings.request_audit_idle_scan_interval_seconds,
            },
        }

    async def list_page(
        self,
        *,
        page: int,
        page_size: int,
        account: str = "",
        account_id: int | None = None,
        risk: str = "",
        client_key: str = "",
        egress_node_id: int | None = None,
        window_preset: str = "today",
        start_at: Any = None,
        end_at: Any = None,
    ) -> dict[str, Any]:
        window = self.resolve_window(
            window_preset=window_preset,
            start_at=start_at,
            end_at=end_at,
        )
        page = max(1, page)
        page_size = max(1, min(page_size, 200))
        offset = (page - 1) * page_size
        pinned_account_id = _positive_int(account_id)
        # Text/egress filters can be applied in SQL. Risk filters still need the
        # complete window because consecutive reasoning state is computed in
        # Python and is not stored as a queryable column.
        if isinstance(self.repository, RequestAuditRepository) and not _needs_full_ledger_scan(
            risk
        ):
            client_keys = self._client_key_options(
                self.repository.client_key_pairs_for_range(
                    window["start"],
                    window["end"],
                )
            )
            total = self.repository.count_records_for_range(
                window["start"],
                window["end"],
                account=account,
                account_id=pinned_account_id,
                client_key=client_key,
                egress_node_id=egress_node_id,
            )
            page_items = self.repository.page_records_for_range(
                window["start"],
                window["end"],
                limit=page_size,
                offset=offset,
                account=account,
                account_id=pinned_account_id,
                client_key=client_key,
                egress_node_id=egress_node_id,
            )
            evaluations = self._ledger_page_evaluations(window, page_items)
        else:
            window_items = self.repository.records_for_range(
                window["start"],
                window["end"],
            )
            # Consecutive reasoning state belongs to the complete time window. A
            # text/egress filter must not rewrite a row's risk level by hiding the
            # preceding samples that established its streak.
            evaluations = self._audit_risk_evaluations(window_items)
            all_items = self._apply_ledger_row_filters(
                window_items,
                account=account,
                account_id=pinned_account_id,
                client_key=client_key,
                egress_node_id=egress_node_id,
            )
            client_keys = self._client_key_options(window_items)
            filtered_items = [
                item
                for item in all_items
                if self._risk_filter_matches(
                    self._evaluation_for(item, evaluations).classification,
                    risk,
                )
            ]
            # Risk streaks are evaluated chronologically above, but the workbench
            # is an operator-facing ledger and must show the newest request first.
            # Keep the two concerns separate so pagination never hides the latest
            # evidence behind older rows.
            filtered_items.sort(
                key=lambda item: (
                    ensure_utc(item.get("created_at"))
                    or datetime.min.replace(tzinfo=UTC),
                    str(item.get("upstream_id") or ""),
                ),
                reverse=True,
            )
            total = len(filtered_items)
            page_items = filtered_items[offset : offset + page_size]
        probe_map = self._probe_sample_map(page_items)
        account_ids = self._record_account_ids(page_items)
        verification_map = self.repository.verifications_for_audits(
            str(item.get("upstream_id") or "") for item in page_items
        )
        try:
            upstream_accounts = await self._upstream_account_map(account_ids)
        except Exception:
            upstream_accounts = self._cached_account_map(account_ids)
        return {
            "day": current_day_key(),
            "provider": "grok_build",
            "window": self._window_payload(window),
            "upstreamAccountSnapshotAt": (
                _iso(self._account_cache_checked_at) if account_ids else None
            ),
            "items": [
                self._record_payload(
                    item,
                    probe_samples=self._probe_samples_for_record(item, probe_map),
                    upstream_account=upstream_accounts.get(int(item["account_id"]))
                    if item.get("account_id")
                    else None,
                    verification=verification_map.get(
                        str(item.get("upstream_id") or "")
                    ),
                    evaluation=self._evaluation_for(item, evaluations),
                )
                for item in page_items
            ],
            "total": total,
            "page": page,
            "pageSize": page_size,
            "clientKeys": client_keys,
            "thresholds": self.thresholds,
        }

    def _ledger_page_evaluations(
        self,
        window: dict[str, Any],
        page_items: list[dict[str, Any]],
    ) -> dict[str, AuditRiskEvaluation]:
        if not page_items:
            return {}
        account_ids = self._record_account_ids(page_items)
        if account_ids:
            context_items = self.repository.records_for_range(
                window["start"],
                window["end"],
                account_ids=account_ids,
            )
        else:
            context_items = []
        seen = {str(item.get("upstream_id") or "") for item in context_items}
        for item in page_items:
            key = str(item.get("upstream_id") or "")
            if key and key not in seen:
                context_items.append(item)
                seen.add(key)
        return self._audit_risk_evaluations(context_items)

    @staticmethod
    def _apply_ledger_row_filters(
        records: list[dict[str, Any]],
        *,
        account: str = "",
        account_id: int | None = None,
        client_key: str = "",
        egress_node_id: int | None = None,
    ) -> list[dict[str, Any]]:
        items = records
        if account_id is not None:
            items = [item for item in items if item.get("account_id") == account_id]
        account_needle = account.strip().casefold()
        if account_needle:
            try:
                account_id_filter = int(account_needle)
            except ValueError:
                account_id_filter = 0
            items = [
                item
                for item in items
                if account_needle in str(item.get("account_name") or "").casefold()
                or account_needle in str(item.get("request_id") or "").casefold()
                or account_needle in str(item.get("client_key_name") or "").casefold()
                or account_needle in str(item.get("client_key_id") or "").casefold()
                or (
                    account_id_filter > 0
                    and item.get("account_id") == account_id_filter
                )
            ]
        client_key_needle = client_key.strip()
        if client_key_needle:
            items = [
                item
                for item in items
                if RequestAuditService._client_key_filter_matches(
                    item, client_key_needle
                )
            ]
        if egress_node_id is not None:
            items = [
                item
                for item in items
                if item.get("egress_node_id") == egress_node_id
            ]
        return items

    @staticmethod
    def _client_key_options(records: list[dict[str, Any]]) -> list[dict[str, str]]:
        options: dict[str, dict[str, str]] = {}
        unlabeled = False
        for item in records:
            key_id = str(item.get("client_key_id") or "").strip()
            key_name = str(item.get("client_key_name") or "").strip()
            if not key_id and not key_name:
                unlabeled = True
                continue
            identity = key_id or key_name
            current = options.get(identity)
            if current is None:
                options[identity] = {"id": identity, "name": key_name}
            elif key_name and not current["name"]:
                current["name"] = key_name
        values = sorted(
            options.values(),
            key=lambda item: (
                str(item.get("name") or "").casefold(),
                str(item.get("id") or ""),
            ),
        )
        if unlabeled:
            values.append({"id": "unlabeled", "name": "未记录 Key"})
        return values

    @staticmethod
    def _client_key_filter_matches(item: dict[str, Any], needle: str) -> bool:
        key_id = str(item.get("client_key_id") or "").strip()
        key_name = str(item.get("client_key_name") or "").strip()
        if needle == "unlabeled":
            return not key_id and not key_name
        return needle in {key_id, key_name}

    @staticmethod
    def _risk_filter_matches(
        classification: Classification,
        risk: str,
    ) -> bool:
        level = (
            classification.name
            if classification.name in {"watch", "high"}
            else "normal"
        )
        if not risk or risk == "all":
            return True
        if risk == "risky":
            return level in {"watch", "high"}
        return level == risk

    @staticmethod
    def _record_lookup_keys(row: dict[str, Any]) -> tuple[str, ...]:
        keys: list[str] = []
        request_id = str(row.get("request_id") or "").strip()
        if request_id:
            keys.append(f"request:{request_id}")
        audit_id = _positive_int(row.get("upstream_id"))
        if audit_id is not None:
            keys.append(f"audit:{audit_id}")
        return tuple(keys)

    @classmethod
    def _probe_samples_for_record(
        cls,
        row: dict[str, Any],
        probe_map: dict[str, list[dict[str, Any]]],
    ) -> list[dict[str, Any]]:
        values: list[dict[str, Any]] = []
        seen: set[str] = set()
        for key in cls._record_lookup_keys(row):
            for context in probe_map.get(key, []):
                sample_id = str((context.get("sample") or {}).get("id") or "")
                if sample_id and sample_id in seen:
                    continue
                if sample_id:
                    seen.add(sample_id)
                values.append(context)
        return values

    def _probe_sample_map(
        self,
        records: list[dict[str, Any]],
        *,
        include_response: bool = False,
        ignore_errors: bool = True,
    ) -> dict[str, list[dict[str, Any]]]:
        if self.probes is None or not records:
            return {}
        request_ids = {
            str(row.get("request_id") or "").strip()
            for row in records
            if str(row.get("request_id") or "").strip()
        }
        audit_ids = {
            int(row["upstream_id"])
            for row in records
            if _positive_int(row.get("upstream_id")) is not None
        }
        try:
            contexts = self.probes.samples_for_audits(
                request_ids=request_ids,
                audit_ids=audit_ids,
                include_response=include_response,
            )
        except Exception:
            if ignore_errors:
                return {}
            raise
        result: dict[str, list[dict[str, Any]]] = defaultdict(list)
        seen: dict[str, set[str]] = defaultdict(set)
        for context in contexts:
            sample = context.get("sample") or {}
            sample_id = str(sample.get("id") or "")
            keys: list[str] = []
            request_id = str(sample.get("request_id") or "").strip()
            audit_id = _positive_int(sample.get("audit_id"))
            if request_id:
                keys.append(f"request:{request_id}")
            if audit_id is not None:
                keys.append(f"audit:{audit_id}")
            for key in keys:
                if sample_id and sample_id in seen[key]:
                    continue
                if sample_id:
                    seen[key].add(sample_id)
                result[key].append(context)
        return result

    def probe_context(
        self,
        *,
        request_id: str = "",
        audit_id: int | None = None,
    ) -> dict[str, Any]:
        contexts = self._probe_sample_map(
            [
                {
                    "request_id": request_id,
                    "upstream_id": str(audit_id or ""),
                }
            ],
            include_response=True,
            ignore_errors=False,
        )
        flattened: list[dict[str, Any]] = []
        seen: set[str] = set()
        for values in contexts.values():
            for value in values:
                sample_id = str((value.get("sample") or {}).get("id") or "")
                if sample_id and sample_id in seen:
                    continue
                if sample_id:
                    seen.add(sample_id)
                flattened.append(value)
        return {
            "requestId": request_id,
            "auditId": audit_id,
            "samples": flattened,
        }

    async def summary(
        self,
        *,
        window_preset: str = "today",
        start_at: Any = None,
        end_at: Any = None,
    ) -> dict[str, Any]:
        window = self.resolve_window(
            window_preset=window_preset,
            start_at=start_at,
            end_at=end_at,
        )
        records = self.repository.records_for_range(window["start"], window["end"])
        evaluations = self._audit_risk_evaluations(records)
        assessments = self._assessment_payloads(records)
        account_ids = self._record_account_ids(records)
        verifications = self._latest_account_verifications(account_ids)
        upstream_result, nodes_result = await asyncio.gather(
            self._upstream_account_map(account_ids),
            self._egress_map(),
            return_exceptions=True,
        )
        if isinstance(upstream_result, BaseException):
            upstream_accounts = self._cached_account_map(account_ids)
        else:
            upstream_accounts = upstream_result
        accounts = self._account_payloads(
            records,
            assessments=assessments,
            upstream_accounts=upstream_accounts,
            verifications=verifications,
            evaluations=evaluations,
        )
        if isinstance(nodes_result, BaseException):
            # Node metadata is supplemental. Retain the last good snapshot and
            # keep the local audit projection available if upstream is busy.
            nodes = self._egress_cache
        else:
            nodes = nodes_result
        scope, identity = self._window_scope(window)
        state = self.repository.ensure_state(scope)
        if state.get("day_key") != identity:
            state = self.repository.state_defaults(scope)
            state["day_key"] = identity
        return {
            "day": current_day_key(),
            "provider": "grok_build",
            "window": self._window_payload(window),
            "thresholds": self.thresholds,
            "upstreamAccountSnapshotAt": (
                _iso(self._account_cache_checked_at) if account_ids else None
            ),
            "summary": self._summary_payload(
                window, records, accounts, evaluations=evaluations
            ),
            "accounts": accounts,
            "nodes": self._node_payloads(
                records,
                assessments=assessments,
                nodes=nodes,
                upstream_accounts=upstream_accounts,
                verifications=verifications,
                evaluations=evaluations,
            ),
            "trend": self._trend_payload(window, records, evaluations=evaluations),
            "scan": self._state_payload(state, window=window),
        }

    def _summary_payload(
        self,
        window: dict[str, Any],
        records: list[dict[str, Any]],
        account_values: list[dict[str, Any]] | None = None,
        *,
        evaluations: dict[str, AuditRiskEvaluation] | None = None,
    ) -> dict[str, Any]:
        measured = [
            float(row["tps"])
            for row in records
            if _finite_float(row.get("tps")) is not None
            and float(row.get("tps") or 0) > 0
        ]
        if account_values is None:
            evaluations = evaluations or self._audit_risk_evaluations(records)
            account_values = self._account_payloads(
                records, evaluations=evaluations
            )
        watch = sum(
            1 for row in account_values if row["riskLevel"] in {"watch", "high"}
        )
        high = sum(1 for row in account_values if row["riskLevel"] == "high")
        return {
            "requests": len(records),
            "measuredRequests": len(measured),
            "outputTokens": sum(int(row.get("output_tokens") or 0) for row in records),
            "averageTps": round(sum(measured) / len(measured), 1) if measured else 0,
            "p95Tps": round(_p95(measured), 1),
            "maxTps": round(max(measured, default=0), 1),
            "reasoningZeroRequests": sum(
                1
                for row in records
                if self._evaluation_for(row, evaluations).reasoning_detected
            ),
            "watchAccounts": watch,
            "highRiskAccounts": high,
            "accountCount": len(account_values),
            "lastSeenAt": _iso(
                max(
                    (row.get("created_at") for row in records if row.get("created_at")),
                    default=None,
                )
            ),
            "day": current_day_key(),
            "window": self._window_payload(window),
        }

    def _assessment_payloads(
        self, records: list[dict[str, Any]]
    ) -> dict[int, dict[str, Any]]:
        account_ids = sorted(
            {
                int(row["account_id"])
                for row in records
                if row.get("account_id") is not None
            }
        )
        return (
            self.accounts.get_assessments(account_ids)
            if self.accounts is not None and account_ids
            else {}
        )

    def _account_payloads(
        self,
        records: list[dict[str, Any]],
        *,
        assessments: dict[int, dict[str, Any]] | None = None,
        upstream_accounts: dict[int, dict[str, Any]] | None = None,
        verifications: dict[int, dict[str, Any]] | None = None,
        evaluations: dict[str, AuditRiskEvaluation] | None = None,
    ) -> list[dict[str, Any]]:
        groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in records:
            account_id = row.get("account_id")
            key = (
                str(account_id)
                if account_id
                else f"unknown:{row.get('account_name') or 'unknown'}"
            )
            groups[key].append(row)
        if assessments is None:
            assessments = self._assessment_payloads(records)
        upstream_accounts = upstream_accounts or {}
        if verifications is None:
            verifications = self._latest_account_verifications(
                self._record_account_ids(records)
            )
        result = [
            self._account_payload(
                rows,
                assessment=(
                    assessments.get(int(rows[0]["account_id"]), {})
                    if rows[0].get("account_id")
                    else {}
                ),
                upstream_account=(
                    upstream_accounts.get(int(rows[0]["account_id"]), {})
                    if rows[0].get("account_id")
                    else {}
                ),
                verification=(
                    verifications.get(int(rows[0]["account_id"]), {})
                    if rows[0].get("account_id")
                    else {}
                ),
                evaluations=evaluations,
            )
            for rows in groups.values()
        ]
        result.sort(
            key=lambda row: (
                _parse_datetime(row.get("lastSeenAt"))
                or datetime.min.replace(tzinfo=UTC)
            ),
            reverse=True,
        )
        return result

    def _latest_account_verifications(
        self,
        account_ids: list[int],
    ) -> dict[int, dict[str, Any]]:
        if self.account_service is not None:
            return self.account_service.latest_sso_verifications(account_ids)
        return self.repository.latest_verifications_for_accounts(account_ids)

    def _account_payload(
        self,
        rows: list[dict[str, Any]],
        *,
        assessment: dict[str, Any],
        upstream_account: dict[str, Any],
        verification: dict[str, Any],
        evaluations: dict[str, AuditRiskEvaluation] | None = None,
    ) -> dict[str, Any]:
        speeds = [
            float(row["tps"])
            for row in rows
            if _finite_float(row.get("tps")) is not None
            and float(row.get("tps") or 0) > 0
        ]
        max_tps = max(speeds, default=0.0)
        classifications = [
            self._evaluation_for(row, evaluations).classification for row in rows
        ]
        row_risks = [
            value.name if value.name in {"watch", "high"} else "normal"
            for value in classifications
        ]
        risk_rank = {"normal": 0, "watch": 1, "high": 2}
        risk_level = max(row_risks, key=risk_rank.get, default="normal")
        reasoning_evaluations = [
            self._evaluation_for(row, evaluations) for row in rows
        ]
        reasoning_zero_count = sum(
            1
            for value in reasoning_evaluations
            if value.reasoning_detected
        )
        reasoning_zero_streak, reasoning_zero_min_count = (
            self._reasoning_progress(reasoning_evaluations)
        )
        media_input_count = sum(
            1 for row in rows if _int_or_zero(row.get("media_input_images")) > 0
        )
        media_input_images = sum(
            max(0, _int_or_zero(row.get("media_input_images"))) for row in rows
        )
        media_observe_rows = [
            row
            for row, value in zip(rows, classifications, strict=True)
            if value.rule_id == "media_input_observe"
        ]
        media_observe_count = len(media_observe_rows)
        media_observe_images = sum(
            max(0, _int_or_zero(row.get("media_input_images")))
            for row in media_observe_rows
        )
        ordinary_risk_tps = max(
            (
                float(row.get("tps") or 0)
                for row, value in zip(rows, classifications, strict=True)
                if value.rule_id != "media_input_observe"
            ),
            default=0.0,
        )
        latest = max(
            rows,
            key=lambda row: (
                ensure_utc(row.get("created_at")) or datetime.min.replace(tzinfo=UTC)
            ),
        )
        account_id = int(rows[0]["account_id"]) if rows[0].get("account_id") else None
        monitor_status = str(assessment.get("monitor_status") or "")
        node_ids = sorted(
            {int(row["egress_node_id"]) for row in rows if row.get("egress_node_id")}
        )
        nodes = sorted(
            {
                str(row.get("egress_node_name") or row.get("egress_node_id") or "")
                for row in rows
                if str(row.get("egress_node_name") or row.get("egress_node_id") or "")
            }
        )
        watch_count = sum(1 for value in row_risks if value in {"watch", "high"})
        high_count = sum(1 for value in row_risks if value == "high")
        verification_payload = self._verification_payload(verification)
        egress_recommendation = (
            verification_payload.get("egressRecommendation")
            if verification_payload
            else None
        )
        return {
            "accountId": account_id,
            "accountName": str(latest.get("account_name") or ""),
            "requests": len(rows),
            "measuredRequests": len(speeds),
            "outputTokens": sum(int(row.get("output_tokens") or 0) for row in rows),
            "averageTps": round(sum(speeds) / len(speeds), 1) if speeds else 0,
            "p95Tps": round(_p95(speeds), 1),
            "maxTps": round(max_tps, 1),
            "latestTps": (
                round(float(latest.get("tps") or 0), 1) if latest.get("tps") else None
            ),
            "watchCount": watch_count,
            "highRiskCount": high_count,
            "reasoningZeroCount": reasoning_zero_count,
            "reasoningZeroStreak": reasoning_zero_streak,
            "reasoningZeroMinCount": reasoning_zero_min_count,
            "mediaInputCount": media_input_count,
            "mediaInputImages": media_input_images,
            "riskLevel": risk_level,
            "riskReasons": self._risk_reasons(
                ordinary_risk_tps,
                reasoning_zero_count=reasoning_zero_count,
                reasoning_zero_streak=reasoning_zero_streak,
                reasoning_zero_min_count=reasoning_zero_min_count,
                media_input_count=media_observe_count,
                media_input_images=media_observe_images,
            ),
            "egressNodeIds": node_ids,
            "egressNodes": nodes,
            "monitorStatus": monitor_status,
            "quarantined": monitor_status == "quarantined",
            "quarantineUntil": _iso(assessment.get("quarantine_until")),
            "disposition": public_disposition(assessment.get("disposition")),
            "probeSampleCount": _int_or_zero(assessment.get("sample_count")),
            "probeAnomalyCount": _int_or_zero(assessment.get("anomaly_count")),
            "probeReasoningZeroCount": _int_or_zero(
                assessment.get("reasoning_zero_count")
            ),
            "latestProbeSampleAt": _iso(assessment.get("latest_sample_at")),
            "upstreamAccountFound": bool(upstream_account),
            "upstreamEnabled": (
                bool(upstream_account.get("enabled"))
                if "enabled" in upstream_account
                else None
            ),
            "upstreamAuthStatus": str(upstream_account.get("authStatus") or ""),
            "preDisableCheck": verification_payload,
            "egressRecommendation": egress_recommendation,
            "priorityAction": (
                verification_payload.get("actionStatus")
                if verification_payload
                else ""
            ),
            "lastSeenAt": _iso(latest.get("created_at")),
        }

    def _node_payloads(
        self,
        records: list[dict[str, Any]],
        *,
        assessments: dict[int, dict[str, Any]],
        nodes: dict[int, dict[str, Any]],
        upstream_accounts: dict[int, dict[str, Any]],
        verifications: dict[int, dict[str, Any]],
        evaluations: dict[str, AuditRiskEvaluation] | None = None,
    ) -> list[dict[str, Any]]:
        groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in records:
            node_id = _positive_int(row.get("egress_node_id"))
            if node_id:
                key = f"node:{node_id}"
            else:
                scope = str(row.get("egress_scope") or "unknown").strip() or "unknown"
                mode = str(row.get("egress_mode") or "unknown").strip() or "unknown"
                key = f"unmapped:{scope}:{mode}"
            groups[key].append(row)

        result: list[dict[str, Any]] = []
        for key, rows in groups.items():
            account_values = self._account_payloads(
                rows,
                assessments=assessments,
                upstream_accounts=upstream_accounts,
                verifications=verifications,
                evaluations=evaluations,
            )
            risky_accounts = [
                value for value in account_values if value["riskLevel"] != "normal"
            ]
            speeds = [
                float(row["tps"])
                for row in rows
                if _finite_float(row.get("tps")) is not None
                and float(row.get("tps") or 0) > 0
            ]
            max_tps = max(speeds, default=0.0)
            classifications = [
                self._evaluation_for(row, evaluations).classification
                for row in rows
            ]
            row_risks = [
                value.name if value.name in {"watch", "high"} else "normal"
                for value in classifications
            ]
            risk_rank = {"normal": 0, "watch": 1, "high": 2}
            risk_level = max(row_risks, key=risk_rank.get, default="normal")
            reasoning_evaluations = [
                self._evaluation_for(row, evaluations) for row in rows
            ]
            reasoning_zero_count = sum(
                1
                for value in reasoning_evaluations
                if value.reasoning_detected
            )
            reasoning_zero_streak, reasoning_zero_min_count = (
                self._reasoning_progress(reasoning_evaluations)
            )
            media_input_count = sum(
                1 for row in rows if _int_or_zero(row.get("media_input_images")) > 0
            )
            media_input_images = sum(
                max(0, _int_or_zero(row.get("media_input_images"))) for row in rows
            )
            media_observe_rows = [
                row
                for row, value in zip(rows, classifications, strict=True)
                if value.rule_id == "media_input_observe"
            ]
            media_observe_count = len(media_observe_rows)
            media_observe_images = sum(
                max(0, _int_or_zero(row.get("media_input_images")))
                for row in media_observe_rows
            )
            ordinary_risk_tps = max(
                (
                    float(row.get("tps") or 0)
                    for row, value in zip(rows, classifications, strict=True)
                    if value.rule_id != "media_input_observe"
                ),
                default=0.0,
            )
            latest = max(
                rows,
                key=lambda row: (
                    ensure_utc(row.get("created_at"))
                    or datetime.min.replace(tzinfo=UTC)
                ),
            )
            node_id = _positive_int(latest.get("egress_node_id"))
            recommendations = [
                value.get("egressRecommendation")
                for value in account_values
                if value.get("egressRecommendation")
                and (
                    not value["egressRecommendation"].get("egressNodeIds")
                    or node_id
                    in value["egressRecommendation"].get("egressNodeIds", [])
                )
            ]
            node = nodes.get(node_id or 0, {})
            node_name = str(node.get("name") or latest.get("egress_node_name") or "")
            proxy_pool = bool(node.get("proxyPool")) if "proxyPool" in node else None
            enabled = bool(node.get("enabled")) if "enabled" in node else None
            result.append(
                {
                    "key": key,
                    "egressNodeId": node_id,
                    "egressNodeName": node_name,
                    "mapped": node_id is not None,
                    "latestProbeIp": str(node.get("exitIp") or ""),
                    "proxyPool": proxy_pool,
                    "enabled": enabled,
                    "requests": len(rows),
                    "measuredRequests": len(speeds),
                    "outputTokens": sum(
                        int(row.get("output_tokens") or 0) for row in rows
                    ),
                    "averageTps": (
                        round(sum(speeds) / len(speeds), 1) if speeds else 0
                    ),
                    "p95Tps": round(_p95(speeds), 1),
                    "maxTps": round(max_tps, 1),
                    "watchCount": sum(
                        1 for value in row_risks if value in {"watch", "high"}
                    ),
                    "highRiskCount": sum(
                        1 for value in row_risks if value == "high"
                    ),
                    "reasoningZeroCount": reasoning_zero_count,
                    "reasoningZeroStreak": reasoning_zero_streak,
                    "reasoningZeroMinCount": reasoning_zero_min_count,
                    "mediaInputCount": media_input_count,
                    "mediaInputImages": media_input_images,
                    "riskLevel": risk_level,
                    "riskReasons": self._risk_reasons(
                        ordinary_risk_tps,
                        reasoning_zero_count=reasoning_zero_count,
                        reasoning_zero_streak=reasoning_zero_streak,
                        reasoning_zero_min_count=reasoning_zero_min_count,
                        media_input_count=media_observe_count,
                        media_input_images=media_observe_images,
                    ),
                    "accountCount": len(account_values),
                    "riskAccountCount": len(risky_accounts),
                    "accounts": risky_accounts,
                    "lastSeenAt": _iso(latest.get("created_at")),
                    "egressRecommendation": recommendations[0]
                    if recommendations
                    else None,
                    "egressRecommendationCount": len(recommendations),
                }
            )
        result.sort(
            key=lambda row: (
                _parse_datetime(row.get("lastSeenAt"))
                or datetime.min.replace(tzinfo=UTC)
            ),
            reverse=True,
        )
        return result

    @staticmethod
    def _reasoning_progress(
        evaluations: list[AuditRiskEvaluation],
    ) -> tuple[int, int]:
        """Return a threshold/streak pair from one policy, never two maxima.

        A grouped account can contain several model policies. Pairing the
        largest streak with the largest threshold made the UI report a
        threshold that belonged to a different model. Prefer an actually
        promoted high evaluation, then the furthest active streak.
        """

        candidates = [
            value
            for value in evaluations
            if value.reasoning_mode == "required"
            and value.reasoning_min_count > 0
            and value.reasoning_streak > 0
        ]
        if not candidates:
            return 0, 0
        promoted = [
            value
            for value in candidates
            if value.classification.rule_id == "reasoning_zero"
            and value.reasoning_streak >= value.reasoning_min_count
        ]
        chosen = max(
            promoted or candidates,
            key=lambda value: (
                value.reasoning_streak >= value.reasoning_min_count,
                value.reasoning_streak,
                -value.reasoning_min_count,
            ),
        )
        return chosen.reasoning_streak, chosen.reasoning_min_count

    @staticmethod
    def _audit_row_key(row: dict[str, Any]) -> str:
        return str(row.get("upstream_id") or row.get("request_id") or "")

    def _audit_risk_evaluations(
        self,
        records: list[dict[str, Any]],
    ) -> dict[str, AuditRiskEvaluation]:
        """Classify rows once, then promote repeated required reasoning gaps.

        A single explicitly reported zero remains an observation. Only a
        consecutive sequence for the same account, upstream model and request
        operation becomes high risk. Media-input rows stay observational and
        never count toward isolation or auto-disable, even when the model
        policy is required. This keeps row display, filters, aggregation and
        the SSO action candidate path on one decision source.
        """

        thresholds = self._rule_thresholds()
        result: dict[str, AuditRiskEvaluation] = {}
        streaks: dict[tuple[int, str, str], int] = defaultdict(int)
        reasoning_rule_active = bool(
            thresholds.request_audit_risk_enabled
            and risk_rule_enabled("reasoning_zero", thresholds)
        )
        ordered = sorted(
            records,
            key=lambda row: (
                ensure_utc(row.get("created_at"))
                or datetime.min.replace(tzinfo=UTC),
                self._audit_row_key(row),
            ),
        )
        for row in ordered:
            row_key = self._audit_row_key(row)
            classification = self._classify_record_detail(row)
            policy = thresholds.reasoning_policy(
                model_upstream_model=str(row.get("model_upstream_model") or ""),
                model_public_id=str(row.get("model_public_id") or ""),
                operation=str(row.get("operation") or ""),
                media_input_images=_int_or_zero(row.get("media_input_images")),
            )
            evaluation = AuditRiskEvaluation(
                classification=classification,
                reasoning_mode=policy.mode,
                reasoning_min_count=policy.min_count,
            )
            account_id = _positive_int(row.get("account_id"))
            group_key = (
                account_id or 0,
                canonical_reasoning_model(
                    str(
                        row.get("model_upstream_model")
                        or row.get("model_public_id")
                        or ""
                    )
                ),
                str(row.get("operation") or "").strip().lower(),
            )
            applicable = bool(
                reasoning_rule_active
                and account_id is not None
                and policy.mode in {"required", "observe"}
                and 200 <= _int_or_zero(row.get("status_code")) < 300
                and bool(row.get("reasoning_tokens_reported"))
                and _int_or_zero(row.get("output_tokens"))
                >= policy.minimum_output_tokens
            )
            reasoning_detected = bool(
                applicable and _int_or_zero(row.get("reasoning_tokens")) <= 0
            )
            has_media = media_input_blocks_reasoning_action(
                _int_or_zero(row.get("media_input_images"))
            )
            if policy.mode != "required" or not applicable or has_media:
                streaks[group_key] = 0
            elif _int_or_zero(row.get("reasoning_tokens")) > 0:
                streaks[group_key] = 0
            else:
                streaks[group_key] += 1
                streak = streaks[group_key]
                evaluation = replace(evaluation, reasoning_streak=streak)

            if reasoning_detected:
                if (
                    classification.rule_id == "reasoning_zero"
                    and classification.reasons
                ):
                    reason = classification.reasons[-1]
                elif has_media:
                    reason = MEDIA_INPUT_REASONING_ZERO_REASON
                elif policy.mode == "required":
                    reason = "模型策略要求思考输出，但本次思考 Token 为 0"
                else:
                    reason = "当前模型与请求类型仅观察思考输出为 0"
                combined_rule_ids = tuple(
                    dict.fromkeys((*classification.rule_ids, "reasoning_zero"))
                )
                combined_reasons = tuple(
                    dict.fromkeys((*classification.reasons, reason))
                )
                if classification.name not in {"watch", "high"}:
                    classification = replace(
                        classification,
                        name="watch",
                        severity=3 if policy.mode == "required" and not has_media else 1,
                        anomalous=True,
                        hard=False,
                        rule_id="reasoning_zero",
                        rule_ids=combined_rule_ids,
                        reasons=combined_reasons,
                    )
                else:
                    classification = replace(
                        classification,
                        rule_ids=combined_rule_ids,
                        reasons=combined_reasons,
                    )

                streak = evaluation.reasoning_streak
                if (
                    policy.mode == "required"
                    and streak >= policy.min_count
                    and not has_media
                ):
                    promoted_reason = (
                        "同账号、上游模型和请求类型的思考输出连续为 0 "
                        f"{streak} 次，达到 {policy.min_count} 次阈值"
                    )
                    # Keep an independently strong primary rule such as
                    # fast_risk. Reasoning remains visible in rule_ids and
                    # reasons even when TPS is the action rule.
                    preserve_primary = bool(
                        classification.hard
                        and classification.rule_id
                        and classification.rule_id != "reasoning_zero"
                    )
                    classification = replace(
                        classification,
                        name="high",
                        severity=max(classification.severity, 3),
                        anomalous=True,
                        hard=True,
                        rule_id=(
                            classification.rule_id
                            if preserve_primary
                            else "reasoning_zero"
                        ),
                        rule_ids=tuple(
                            dict.fromkeys(
                                (*classification.rule_ids, "reasoning_zero")
                            )
                        ),
                        reasons=tuple(
                            dict.fromkeys(
                                (*classification.reasons, promoted_reason)
                            )
                        ),
                    )
                evaluation = replace(
                    evaluation,
                    classification=classification,
                    reasoning_detected=True,
                )
            result[row_key] = evaluation
        return result

    def _evaluation_for(
        self,
        row: dict[str, Any],
        evaluations: dict[str, AuditRiskEvaluation] | None = None,
    ) -> AuditRiskEvaluation:
        if evaluations is not None:
            value = evaluations.get(self._audit_row_key(row))
            if value is not None:
                return value
        classification = self._classify_record_detail(row)
        return AuditRiskEvaluation(classification=classification)

    def _classify_record_detail(self, row: dict[str, Any]) -> Classification:
        return classify_audit_sample(
            status_code=_int_or_zero(row.get("status_code")),
            output_tokens=_int_or_zero(row.get("output_tokens")),
            reasoning_tokens=_int_or_zero(row.get("reasoning_tokens")),
            first_token_ms=_nonnegative_int(row.get("first_token_ms")),
            duration_ms=_int_or_zero(row.get("duration_ms")),
            tps=_finite_float(row.get("tps")),
            thresholds=self._rule_thresholds(),
            extra={
                **row,
                "media_input_images": _int_or_zero(row.get("media_input_images")),
                "model_upstream_model": str(row.get("model_upstream_model") or ""),
                "model_public_id": str(row.get("model_public_id") or ""),
                "operation": str(row.get("operation") or ""),
                "reasoning_tokens_reported": bool(
                    row.get("reasoning_tokens_reported")
                ),
            },
        )

    def _classify_values(
        self,
        *,
        tps: float | None,
        status_code: int,
        output_tokens: int,
        reasoning_tokens: int,
        first_token_ms: int | None = None,
        duration_ms: int = 0,
        extra: dict[str, Any] | None = None,
    ) -> tuple[str, list[str]]:
        result = classify_audit_sample(
            status_code=status_code,
            output_tokens=output_tokens,
            reasoning_tokens=reasoning_tokens,
            first_token_ms=first_token_ms,
            duration_ms=duration_ms,
            tps=tps,
            thresholds=self._rule_thresholds(),
            extra=extra,
        )
        level = result.name if result.name in {"watch", "high"} else "normal"
        return level, list(result.reasons if level != "normal" else ())

    def _classify_record(
        self,
        row: dict[str, Any],
    ) -> tuple[str, list[str]]:
        result = self._classify_record_detail(row)
        level = result.name if result.name in {"watch", "high"} else "normal"
        return level, list(result.reasons if level != "normal" else ())

    def _classify(self, tps: float | None) -> tuple[str, list[str]]:
        if not self.settings.request_audit_risk_enabled:
            return "normal", []
        return classify_audit_tps(
            tps,
            self.settings.degradation_tps,
            self.settings.strong_degradation_tps,
        )

    def _risk_reasons(
        self,
        tps: float,
        *,
        reasoning_zero_count: int = 0,
        reasoning_zero_streak: int = 0,
        reasoning_zero_min_count: int = 0,
        media_input_count: int = 0,
        media_input_images: int = 0,
    ) -> list[str]:
        if not self.settings.request_audit_risk_enabled:
            return []
        reasons: list[str] = []
        if reasoning_zero_count:
            if reasoning_zero_streak >= reasoning_zero_min_count > 0:
                reasons.append(
                    f"思考输出为 0 已连续 {reasoning_zero_streak} 次，达到高风险阈值"
                )
            else:
                reasons.append(
                    f"成功请求思考输出为 0 共 {reasoning_zero_count} 次，当前仅观察"
                )
        if media_input_count and risk_rule_enabled(
            "media_input_observe",
            self._rule_thresholds(),
        ):
            reasons.append(
                f"Media Input 请求 {media_input_count} 次 / {media_input_images} 张，"
                "高 TPS 暂按观察"
            )
        if tps >= self.settings.strong_degradation_tps:
            reasons.append(
                f"峰值 {tps:.1f} Token/s ≥ {self.settings.strong_degradation_tps:g} TPS"
            )
        elif tps >= self.settings.degradation_tps:
            reasons.append(
                f"峰值 {tps:.1f} Token/s ≥ {self.settings.degradation_tps:g} TPS"
            )
        return reasons

    def _trend_payload(
        self,
        window: dict[str, Any],
        records: list[dict[str, Any]],
        *,
        evaluations: dict[str, AuditRiskEvaluation] | None = None,
    ) -> list[dict[str, Any]]:
        start = window["start"]
        end = window["end"]
        duration = end - start
        if duration <= timedelta(days=2):
            bucket_size = timedelta(hours=1)
            granularity = "hour"
        elif duration <= timedelta(days=14):
            bucket_size = timedelta(hours=6)
            granularity = "6hour"
        elif duration <= timedelta(days=45):
            bucket_size = timedelta(days=1)
            granularity = "day"
        else:
            bucket_size = timedelta(days=7)
            granularity = "week"
        bucket_seconds = bucket_size.total_seconds()
        count = max(1, math.ceil(duration.total_seconds() / bucket_seconds))
        buckets: list[dict[str, Any]] = []
        for index in range(count):
            bucket_start = start + bucket_size * index
            bucket_end = min(end, bucket_start + bucket_size)
            local = to_app_timezone(bucket_start) or bucket_start
            label = (
                local.strftime("%H:%M")
                if duration <= timedelta(days=1)
                else local.strftime("%m-%d %H:%M")
                if bucket_size < timedelta(days=1)
                else local.strftime("%m-%d")
            )
            buckets.append(
                {
                    "index": index,
                    "label": label,
                    "bucketStart": _iso(bucket_start),
                    "bucketEnd": _iso(bucket_end),
                    "granularity": granularity,
                    "requests": 0,
                    "measuredRequests": 0,
                    "averageTps": 0,
                    "maxTps": 0,
                    "watch": 0,
                    "high": 0,
                    "_values": [],
                }
            )
        for row in records:
            created = ensure_utc(row.get("created_at"))
            if created is None:
                continue
            index = int((created - start).total_seconds() // bucket_seconds)
            if index < 0 or index >= len(buckets):
                continue
            bucket = buckets[index]
            bucket["requests"] += 1
            tps = _finite_float(row.get("tps"))
            if tps is not None and tps > 0:
                bucket["measuredRequests"] += 1
                bucket["_values"].append(tps)
                bucket["maxTps"] = round(max(bucket["maxTps"], tps), 1)
            classification = self._evaluation_for(row, evaluations).classification
            risk_level = (
                classification.name
                if classification.name in {"watch", "high"}
                else "normal"
            )
            if risk_level in {"watch", "high"}:
                bucket["watch"] += 1
            if risk_level == "high":
                bucket["high"] += 1
        for bucket in buckets:
            values = bucket.pop("_values")
            bucket["averageTps"] = round(sum(values) / len(values), 1) if values else 0
        return buckets

    @staticmethod
    def _verification_payload(
        value: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        if not value:
            return None
        bot_flag = value.get("bot_flag")
        if not isinstance(bot_flag, dict):
            bot_flag = {}
        return {
            "auditId": str(value.get("audit_upstream_id") or ""),
            "auditCreatedAt": _iso(value.get("audit_created_at")),
            "auditTps": round(float(value.get("audit_tps") or 0), 2),
            "status": str(value.get("status") or "pending"),
            "ssoVerdict": str(value.get("sso_verdict") or ""),
            "proxyUsed": bool(value.get("proxy_used")),
            "validSession": (
                value.get("valid_session")
                if isinstance(value.get("valid_session"), bool)
                else None
            ),
            "emailMatch": (
                value.get("email_match")
                if isinstance(value.get("email_match"), bool)
                else None
            ),
            "statusCode": int(value.get("status_code") or 0),
            "responseMs": int(value.get("response_ms") or 0),
            "checkError": str(value.get("check_error") or ""),
            "botFlag": {
                "found": bool(bot_flag.get("found")),
                "source": bot_flag.get("source"),
                "details": str(bot_flag.get("details") or ""),
                "policy": str(bot_flag.get("policy") or ""),
                "risk": bot_flag.get("risk"),
                "event": str(bot_flag.get("event") or ""),
                "denied": bool(bot_flag.get("denied")),
                "flagged": bool(bot_flag.get("flagged")),
            },
            "actionStatus": str(value.get("action_status") or "pending"),
            "actionError": str(value.get("action_error") or ""),
            "egressRecommendation": (
                value.get("egress_recommendation")
                if isinstance(value.get("egress_recommendation"), dict)
                else None
            ),
            "previousPriority": (
                int(value["previous_priority"])
                if value.get("previous_priority") is not None
                else None
            ),
            "appliedPriority": (
                int(value["applied_priority"])
                if value.get("applied_priority") is not None
                else None
            ),
            "checkedAt": _iso(value.get("checked_at")),
            "updatedAt": _iso(value.get("updated_at")),
        }

    def _record_payload(
        self,
        row: dict[str, Any],
        *,
        probe_samples: list[dict[str, Any]] | None = None,
        upstream_account: dict[str, Any] | None = None,
        verification: dict[str, Any] | None = None,
        evaluation: AuditRiskEvaluation | None = None,
    ) -> dict[str, Any]:
        evaluation = evaluation or self._evaluation_for(row)
        classification = evaluation.classification
        risk_level = (
            classification.name
            if classification.name in {"watch", "high"}
            else "normal"
        )
        risk_reasons = list(
            classification.reasons if risk_level != "normal" else ()
        )
        upstream_account = upstream_account or {}
        return {
            "id": str(row.get("upstream_id") or ""),
            "requestId": str(row.get("request_id") or ""),
            "provider": str(row.get("provider") or "grok_build"),
            "operation": str(row.get("operation") or ""),
            "modelPublicId": str(row.get("model_public_id") or ""),
            "modelUpstreamModel": str(row.get("model_upstream_model") or ""),
            "accountId": int(row["account_id"]) if row.get("account_id") else None,
            "accountName": str(row.get("account_name") or ""),
            "clientKeyId": str(row.get("client_key_id") or ""),
            "clientKeyName": str(row.get("client_key_name") or ""),
            "upstreamAccountFound": bool(upstream_account),
            "upstreamEnabled": (
                bool(upstream_account.get("enabled"))
                if "enabled" in upstream_account
                else None
            ),
            "upstreamAuthStatus": str(upstream_account.get("authStatus") or ""),
            "egressNodeId": int(row["egress_node_id"])
            if row.get("egress_node_id")
            else None,
            "egressNodeName": str(row.get("egress_node_name") or ""),
            "egressMode": str(row.get("egress_mode") or ""),
            "egressScope": str(row.get("egress_scope") or ""),
            "statusCode": int(row.get("status_code") or 0),
            "streaming": bool(row.get("streaming")),
            "inputTokens": int(row.get("input_tokens") or 0),
            "mediaInputImages": int(row.get("media_input_images") or 0),
            "hasMediaInput": int(row.get("media_input_images") or 0) > 0,
            "outputTokens": int(row.get("output_tokens") or 0),
            "reasoningTokens": int(row.get("reasoning_tokens") or 0),
            "reasoningTokensReported": bool(row.get("reasoning_tokens_reported")),
            "totalTokens": int(row.get("total_tokens") or 0),
            "firstTokenMs": (
                int(row["first_token_ms"])
                if row.get("first_token_ms") is not None
                else None
            ),
            "durationMs": int(row.get("duration_ms") or 0),
            "tps": round(float(row["tps"]), 2) if row.get("tps") is not None else None,
            "riskLevel": risk_level,
            "riskReasons": risk_reasons,
            "riskRuleId": classification.rule_id,
            "riskRuleIds": list(classification.rule_ids),
            "reasoningZeroRisk": classification.rule_id in {
                "reasoning_zero",
                "reasoning_zero_observe",
            }
            or evaluation.reasoning_detected,
            "reasoningZeroStreak": evaluation.reasoning_streak,
            "reasoningZeroMinCount": evaluation.reasoning_min_count,
            "preDisableCheck": self._verification_payload(verification or {}),
            "probeSampleCount": len(probe_samples or []),
            "probeSamples": probe_samples or [],
            "createdAt": _iso(row.get("created_at")),
        }

    @classmethod
    def _state_payload(
        cls,
        state: dict[str, Any],
        *,
        window: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        result = {
            "day": str(state.get("day_key") or ""),
            "initialComplete": bool(state.get("initial_complete")),
            "initialResumePending": bool(state.get("initial_cursor")),
            "newestAuditId": str(state.get("newest_upstream_id") or ""),
            "newestCreatedAt": _iso(state.get("newest_created_at")),
            "lastScanAt": _iso(state.get("last_scan_at")),
            "lastSuccessAt": _iso(state.get("last_success_at")),
            "lastError": str(state.get("last_error") or ""),
            "lastPages": int(state.get("last_pages") or 0),
            "lastNewRecords": int(state.get("last_new_records") or 0),
            "lastSeenRecords": int(state.get("last_seen_records") or 0),
        }
        if window is not None:
            result["window"] = cls._window_payload(window)
        return result
