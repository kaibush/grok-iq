from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any

from app.core.clock import (
    app_day_key,
    app_day_start,
    app_isoformat,
    parse_optional_datetime,
    utc_now,
)
from app.services.isolation_stats import resolve_stats_range

COOLING_STATUS = "cooling"
EXPIRED_STATUS = "expired"
ALL_STATUS = "all"
ALLOWED_STATUSES = {COOLING_STATUS, EXPIRED_STATUS, ALL_STATUS}
DEFAULT_LABEL = "高速 TPS 冷却"
MISSING_THINKING_ERROR = "missing_thinking"
MISSING_THINKING_LABEL = "grok2api 降智冷却"
MISSING_THINKING_SOURCE = "grok2api"
MISSING_THINKING_REASON = "grok2api 缺思考进入冷却"
EXPIRING_SOON_SECONDS = 120
_FAR_FUTURE = datetime(9999, 12, 31, tzinfo=UTC)
_FAR_PAST = datetime(1970, 1, 1, tzinfo=UTC)


def resolve_cooldown_list_range(
    start_raw: str | None,
    end_raw: str | None,
) -> tuple[datetime, datetime]:
    if not str(start_raw or "").strip() and not str(end_raw or "").strip():
        return resolve_stats_range("", "")
    return resolve_stats_range(start_raw, end_raw)


def compute_cooldown_stats(
    *,
    rows: list[dict[str, Any]],
    assessments: dict[int, dict[str, Any]],
    start: datetime,
    end: datetime,
    min_count: int,
    cooldown_minutes: int,
    isolation_enabled: bool,
    extra_cooling: list[dict[str, Any]] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    current = now or utc_now()
    cooling_rows = _latest_cooling_by_account(rows)
    remaining_values = [
        remaining_seconds(_recommendation(row).get("cooldownUntil"), now=current)
        for row in cooling_rows.values()
    ]
    extra_items = extra_cooling or []
    remaining_values.extend(max(0, int(item.get("remainingSeconds") or 0)) for item in extra_items)
    expiring_soon = sum(1 for value in remaining_values if value <= EXPIRING_SOON_SECONDS)
    disabled_by_cooldown = sum(
        1 for row in cooling_rows.values() if bool(_recommendation(row).get("disabledByCooldown"))
    ) + sum(1 for item in extra_items if bool(item.get("disabledByCooldown")))
    cooled_events = [row for row in rows if _in_range(_cooled_at(row), start, end)]
    expired_events = [row for row in rows if _in_range(_expired_at(row), start, end)]
    unique_account_ids = {
        account_id for account_id in (_account_id(row) for row in cooled_events) if account_id > 0
    }
    isolated_after = sum(
        1
        for account_id in unique_account_ids
        if str((assessments.get(account_id) or {}).get("monitor_status") or "") == "quarantined"
    )
    return {
        "range": {
            "from": app_isoformat(start),
            "to": app_isoformat(end),
        },
        "policy": {
            "minCount": int(min_count),
            "cooldownMinutes": int(cooldown_minutes),
            "isolationEnabled": bool(isolation_enabled),
        },
        "zone": {
            "cooling": len(cooling_rows) + len(extra_items),
            "expiringSoon": expiring_soon,
            "disabledByCooldown": disabled_by_cooldown,
            "avgRemainingSeconds": (
                int(round(sum(remaining_values) / len(remaining_values))) if remaining_values else None
            ),
        },
        "events": {
            "cooled": len(cooled_events),
            "uniqueAccounts": len(unique_account_ids),
            "expired": len(expired_events),
            "released": len(expired_events),
            "isolatedAfter": isolated_after,
        },
        "trend": _trend(rows, start=start, end=end),
        "generatedAt": app_isoformat(current),
    }


def select_cooldown_zone_rows(
    rows: list[dict[str, Any]],
    *,
    status: str,
    start: datetime | None = None,
    end: datetime | None = None,
) -> list[dict[str, Any]]:
    grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        account_id = _account_id(row)
        if account_id > 0:
            grouped[account_id].append(row)

    cooling_items: list[dict[str, Any]] = []
    expired_items: list[dict[str, Any]] = []
    for account_id, account_rows in grouped.items():
        cooldown_count = len(account_rows)
        latest_cooling = _latest(
            [row for row in account_rows if str(row.get("action_status") or "") == "cooled"]
        )
        if latest_cooling is not None and status in {COOLING_STATUS, ALL_STATUS}:
            cooling_items.append(
                {
                    "account_id": account_id,
                    "status": COOLING_STATUS,
                    "verification": latest_cooling,
                    "cooldown_count": cooldown_count,
                }
            )
            continue
        if latest_cooling is not None or status == COOLING_STATUS:
            continue
        latest_expired = _latest(
            [
                row
                for row in account_rows
                if str(row.get("action_status") or "") == "cooldown_expired"
                and start is not None
                and end is not None
                and _in_range(_expired_event_time(row), start, end)
            ]
        )
        if latest_expired is None:
            continue
        expired_items.append(
            {
                "account_id": account_id,
                "status": EXPIRED_STATUS,
                "verification": latest_expired,
                "cooldown_count": cooldown_count,
            }
        )

    cooling_items.sort(key=_cooling_sort_key)
    expired_items.sort(key=_expired_sort_key, reverse=True)
    if status == COOLING_STATUS:
        return cooling_items
    if status == EXPIRED_STATUS:
        return expired_items
    return cooling_items + expired_items


def build_cooldown_zone_item(
    *,
    account_id: int,
    status: str,
    verification: dict[str, Any],
    cooldown_count: int,
    upstream: dict[str, Any],
    missing_upstream: bool,
    quarantined: bool,
    tps_min_count: int,
    cooldown_minutes: int,
    now: datetime | None = None,
) -> dict[str, Any]:
    recommendation = _recommendation(verification)
    current = now or utc_now()
    until = recommendation.get("cooldownUntil")
    remaining = 0 if status != COOLING_STATUS else remaining_seconds(until, now=current)
    min_count = _as_int(tps_min_count, 0)
    if min_count <= 0:
        min_count = _as_int(recommendation.get("tpsMinCount"), 0)
    minutes = _as_int(recommendation.get("minutes"), 0)
    if minutes <= 0:
        minutes = _as_int(cooldown_minutes, 0)
    audit_tps = _as_float(verification.get("audit_tps"), 0.0)
    max_tps_raw = recommendation.get("maxTps")
    max_tps = audit_tps if max_tps_raw is None or max_tps_raw == "" else _as_float(max_tps_raw, audit_tps)
    return {
        "id": account_id,
        "name": str(upstream.get("name") or f"账号 #{account_id}"),
        "email": str(upstream.get("email") or ""),
        "enabled": bool(upstream.get("enabled")),
        "missingUpstream": bool(missing_upstream),
        "quarantined": bool(quarantined),
        "status": status,
        "actionStatus": str(verification.get("action_status") or ""),
        "actionError": str(verification.get("action_error") or ""),
        "label": str(recommendation.get("label") or DEFAULT_LABEL),
        "reason": str(recommendation.get("reason") or ""),
        "source": str(recommendation.get("source") or "request_audit"),
        "cooledAt": _iso(recommendation.get("cooledAt")),
        "cooldownUntil": _iso(until),
        "expiredAt": _iso(recommendation.get("expiredAt")),
        "remainingSeconds": remaining,
        "cooldownMinutes": minutes,
        "tpsStreak": _as_int(recommendation.get("tpsStreak"), 0),
        "tpsMinCount": min_count,
        "maxTps": max_tps,
        "auditTps": audit_tps,
        "auditId": str(verification.get("audit_upstream_id") or ""),
        "auditCreatedAt": _iso(verification.get("audit_created_at")),
        "riskReasons": _string_list(recommendation.get("riskReasons") or recommendation.get("detail")),
        "disabledByCooldown": bool(recommendation.get("disabledByCooldown")),
        "releasedManually": bool(recommendation.get("releasedManually")),
        "cooldownCount": int(cooldown_count),
        "nextAction": (
            "isolate"
            if recommendation.get("nextAction") is None
            else str(recommendation.get("nextAction") or "")
        ),
    }


def remaining_seconds(value: Any, *, now: datetime | None = None) -> int:
    until = parse_optional_datetime(value)
    if until is None:
        return 0
    current = now or utc_now()
    return max(0, int((until - current).total_seconds()))


def account_id_of(account: dict[str, Any]) -> int:
    try:
        value = int(account.get("id") or 0)
    except (TypeError, ValueError, OverflowError):
        return 0
    return value if value > 0 else 0


def account_last_error(account: dict[str, Any]) -> str:
    raw = account.get("lastError")
    if raw is None or str(raw).strip() == "":
        raw = account.get("last_error")
    return str(raw or "").strip()


def is_missing_thinking_cooling(
    account: dict[str, Any],
    *,
    now: datetime | None = None,
) -> bool:
    if account_last_error(account) != MISSING_THINKING_ERROR:
        return False
    if not bool(account.get("enabled", True)):
        return False
    until = parse_optional_datetime(account.get("cooldownUntil") or account.get("cooldown_until"))
    return until is not None and until > (now or utc_now())


def build_missing_thinking_cooldown_item(
    account: dict[str, Any],
    *,
    quarantined: bool,
    now: datetime | None = None,
) -> dict[str, Any]:
    current = now or utc_now()
    account_id = account_id_of(account)
    until = parse_optional_datetime(account.get("cooldownUntil") or account.get("cooldown_until"))
    updated = parse_optional_datetime(account.get("updatedAt") or account.get("updated_at"))
    degrade_last = parse_optional_datetime(account.get("degradeLast") or account.get("degrade_last"))
    cooled_at = degrade_last or updated or current
    minutes = 0
    if until is not None:
        minutes = max(1, int((until - cooled_at).total_seconds() / 60))
    failure_count = _as_int(
        account.get("failureCount") or account.get("failure_count"),
        0,
    )
    degrade_hits = _as_int(
        account.get("degradeHits") or account.get("degrade_hits"),
        0,
    )
    verification = {
        "account_id": account_id,
        "action_status": "cooled",
        "action_error": "",
        "audit_upstream_id": "",
        "audit_created_at": cooled_at,
        "audit_tps": 0,
        "checked_at": updated or current,
        "egress_recommendation": {
            "kind": "missing_thinking_cooldown",
            "type": "missing_thinking_cooldown",
            "label": MISSING_THINKING_LABEL,
            "reason": MISSING_THINKING_REASON,
            "source": MISSING_THINKING_SOURCE,
            "cooledAt": cooled_at,
            "cooldownUntil": until,
            "minutes": minutes,
            "tpsStreak": failure_count,
            "tpsMinCount": 0,
            "disabledByCooldown": False,
            "nextAction": "",
            "riskReasons": [MISSING_THINKING_ERROR],
        },
    }
    payload = build_cooldown_zone_item(
        account_id=account_id,
        status=COOLING_STATUS,
        verification=verification,
        cooldown_count=max(degrade_hits, failure_count, 1),
        upstream=account,
        missing_upstream=False,
        quarantined=quarantined,
        tps_min_count=0,
        cooldown_minutes=minutes,
        now=current,
    )
    payload["tpsStreak"] = None
    payload["tpsMinCount"] = None
    payload["maxTps"] = None
    payload["auditTps"] = None
    payload["nextAction"] = ""
    return payload


def merge_cooldown_zone_items(
    local_items: list[dict[str, Any]],
    grok_items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    by_id: dict[int, dict[str, Any]] = {}
    for item in local_items:
        account_id = int(item.get("id") or 0)
        if account_id > 0:
            by_id[account_id] = item
    for item in grok_items:
        account_id = int(item.get("id") or 0)
        if account_id <= 0:
            continue
        current = by_id.get(account_id)
        if current is None or (
            item.get("status") == COOLING_STATUS and current.get("status") != COOLING_STATUS
        ):
            by_id[account_id] = item
    values = list(by_id.values())
    cooling = [item for item in values if item.get("status") == COOLING_STATUS]
    expired = [item for item in values if item.get("status") != COOLING_STATUS]
    cooling.sort(key=lambda item: parse_optional_datetime(item.get("cooldownUntil")) or _FAR_FUTURE)
    expired.sort(
        key=lambda item: parse_optional_datetime(item.get("expiredAt") or item.get("cooledAt")) or _FAR_PAST,
        reverse=True,
    )
    return cooling + expired


def matches_cooldown_search(item: dict[str, Any], search: str) -> bool:
    token = str(search or "").strip().lower()
    if not token:
        return True
    return (
        token in str(item.get("name") or "").lower()
        or token in str(item.get("email") or "").lower()
        or token == str(item.get("id") or "")
        or token in str(item.get("auditId") or "").lower()
        or token in str(item.get("label") or "").lower()
        or token in str(item.get("reason") or "").lower()
        or token in str(item.get("source") or "").lower()
    )


def _trend(
    rows: list[dict[str, Any]],
    *,
    start: datetime,
    end: datetime,
) -> list[dict[str, Any]]:
    days: list[str] = []
    cursor = app_day_start(start)
    last = app_day_start(end - timedelta(microseconds=1))
    while cursor <= last:
        key = app_day_key(cursor)
        if key:
            days.append(key)
        cursor += timedelta(days=1)
    cooled_by_day: dict[str, int] = defaultdict(int)
    expired_by_day: dict[str, int] = defaultdict(int)
    for row in rows:
        cooled_day = app_day_key(_cooled_at(row))
        if cooled_day:
            cooled_by_day[cooled_day] += 1
        expired_day = app_day_key(_expired_at(row))
        if expired_day:
            expired_by_day[expired_day] += 1
    return [
        {
            "day": day,
            "cooled": cooled_by_day.get(day, 0),
            "expired": expired_by_day.get(day, 0),
        }
        for day in days
    ]


def _latest_cooling_by_account(rows: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    latest: dict[int, dict[str, Any]] = {}
    for row in rows:
        if str(row.get("action_status") or "") != "cooled":
            continue
        account_id = _account_id(row)
        if account_id <= 0:
            continue
        current = latest.get(account_id)
        if current is None or _row_recency_key(row) > _row_recency_key(current):
            latest[account_id] = row
    return latest


def _latest(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not rows:
        return None
    return max(rows, key=_row_recency_key)


def _row_recency_key(row: dict[str, Any]) -> tuple[float, int]:
    stamp = parse_optional_datetime(row.get("checked_at")) or parse_optional_datetime(row.get("updated_at"))
    return (
        stamp.timestamp() if stamp is not None else 0.0,
        int(row.get("id") or 0),
    )


def _cooling_sort_key(item: dict[str, Any]) -> datetime:
    until = parse_optional_datetime(_recommendation(item.get("verification") or {}).get("cooldownUntil"))
    return until or _FAR_FUTURE


def _expired_sort_key(item: dict[str, Any]) -> datetime:
    recommendation = _recommendation(item.get("verification") or {})
    stamp = parse_optional_datetime(recommendation.get("expiredAt")) or parse_optional_datetime(
        recommendation.get("cooledAt")
    )
    return stamp or _FAR_PAST


def _recommendation(row: dict[str, Any] | None) -> dict[str, Any]:
    payload = row.get("egress_recommendation") if isinstance(row, dict) else None
    return payload if isinstance(payload, dict) else {}


def _cooled_at(row: dict[str, Any]) -> datetime | None:
    return parse_optional_datetime(_recommendation(row).get("cooledAt"))


def _expired_at(row: dict[str, Any]) -> datetime | None:
    return parse_optional_datetime(_recommendation(row).get("expiredAt"))


def _expired_event_time(row: dict[str, Any]) -> datetime | None:
    recommendation = _recommendation(row)
    return (
        parse_optional_datetime(recommendation.get("expiredAt"))
        or parse_optional_datetime(recommendation.get("cooledAt"))
        or parse_optional_datetime(row.get("updated_at"))
    )


def _in_range(value: datetime | None, start: datetime, end: datetime) -> bool:
    return value is not None and start <= value < end


def _account_id(row: dict[str, Any]) -> int:
    try:
        return int(row.get("account_id") or 0)
    except (TypeError, ValueError, OverflowError):
        return 0


def _iso(value: Any) -> str | None:
    parsed = parse_optional_datetime(value)
    if parsed is not None:
        return app_isoformat(parsed)
    if value is None or value == "":
        return None
    return str(value)


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _as_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _string_list(value: Any) -> list[str]:
    if isinstance(value, dict):
        value = value.get("riskReasons")
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if str(item).strip()]
