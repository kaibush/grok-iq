from __future__ import annotations

import random
import re
import uuid
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.core.clock import APP_TIMEZONE, APP_TIMEZONE_NAME, app_now, to_app_timezone, utc_now
from app.persistence.page_visit_repository import PageVisitRepository
from app.services.auth_service import AuthService
from app.services.linuxdo_oauth_service import LinuxDoOAuthService
from app.services.status_account_service import StatusAccountService

VISITOR_COOKIE_NAME = "grokiq_vid"
PERIODS = ("24h", "7d", "30d", "90d")
PERIOD_DAYS = {"7d": 7, "30d": 30, "90d": 90}
DEVICE_LABELS = {
    "desktop": "桌面",
    "mobile": "手机",
    "tablet": "平板",
    "bot": "爬虫",
    "other": "其他",
}
DIRECT_REFERRER_LABEL = "直接访问"
DEFAULT_PATH = "/status"
DEBOUNCE_SECONDS = 5
RETENTION_DAYS = 90
PRUNE_EVERY = 50
PATH_MAX_LENGTH = 200
HOST_MAX_LENGTH = 200
REFERRER_MAX_LENGTH = 400
IP_MAX_LENGTH = 64
UA_MAX_LENGTH = 400
COUNTRY_MAX_LENGTH = 8
LANGUAGE_MAX_LENGTH = 32
RECENT_LIMIT = 50
TOP_LIMIT = 20
_VISITOR_ID_RE = re.compile(
    r"^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$",
    re.IGNORECASE,
)


class PageVisitService:
    def __init__(
        self,
        repository: PageVisitRepository,
        auth_service: AuthService | None = None,
        linuxdo_oauth: LinuxDoOAuthService | None = None,
        status_accounts: StatusAccountService | None = None,
    ):
        self.repository = repository
        self.auth_service = auth_service
        self.linuxdo_oauth = linuxdo_oauth
        self.status_accounts = status_accounts

    def record_visit(
        self,
        *,
        path: str = "",
        referrer: str = "",
        user_agent: str = "",
        client_ip: str = "",
        authorization: str = "",
        visitor_cookie: str = "",
        linuxdo_cookie: str = "",
        status_cookie: str = "",
        request_host: str = "",
        country: str = "",
        language: str = "",
    ) -> dict[str, Any]:
        now = utc_now()
        day_key = (to_app_timezone(now) or app_now()).date().isoformat()
        normalized_path = _normalize_path(path)
        device = _device_from_ua(user_agent)
        visitor_id, set_cookie = _resolve_visitor_id(visitor_cookie)
        if device == "bot":
            return {
                "recorded": False,
                "visitor_id": visitor_id,
                "set_cookie": set_cookie,
            }
        if self.repository.recent_visitor_hit(
            visitor_id,
            normalized_path,
            now - timedelta(seconds=DEBOUNCE_SECONDS),
        ):
            return {
                "recorded": False,
                "visitor_id": visitor_id,
                "set_cookie": set_cookie,
            }
        linuxdo_user = self._linuxdo_user(linuxdo_cookie)
        status_account = self._status_account(status_cookie)
        self.repository.record(
            {
                "visitor_id": visitor_id,
                "visited_at": now,
                "day_key": day_key,
                "path": normalized_path,
                "referrer_host": _referrer_host(referrer, request_host),
                "referrer": _referrer_url(referrer),
                "device": device,
                "is_admin": self._is_admin(authorization),
                "client_ip": _client_ip(client_ip),
                "user_agent": (user_agent or "").strip()[:UA_MAX_LENGTH],
                "country": _country(country),
                "language": _language(language),
                "linuxdo_user_id": None if linuxdo_user is None else int(linuxdo_user["id"]),
                "linuxdo_username": "" if linuxdo_user is None else str(linuxdo_user.get("username") or ""),
                "linuxdo_name": "" if linuxdo_user is None else str(linuxdo_user.get("name") or ""),
                "linuxdo_avatar_url": (
                    "" if linuxdo_user is None else str(linuxdo_user.get("avatar_url") or "")
                ),
                "linuxdo_trust_level": None if linuxdo_user is None else linuxdo_user.get("trust_level"),
                "status_account_id": None if status_account is None else int(status_account["id"]),
                "status_account_username": ""
                if status_account is None
                else str(status_account.get("username") or ""),
            }
        )
        if linuxdo_user is not None and self.linuxdo_oauth is not None:
            self.linuxdo_oauth.touch_seen(int(linuxdo_user["id"]))
        if status_account is not None and self.status_accounts is not None:
            self.status_accounts.touch_seen(int(status_account["id"]))
        if random.randrange(PRUNE_EVERY) == 0:
            self.repository.prune_before(now - timedelta(days=RETENTION_DAYS))
        return {
            "recorded": True,
            "visitor_id": visitor_id,
            "set_cookie": set_cookie,
        }

    def overview(
        self,
        period: str = "24h",
        timezone: str = APP_TIMEZONE_NAME,
    ) -> dict[str, Any]:
        return self._payload(period, timezone, include_details=False)

    def details(
        self,
        period: str = "24h",
        timezone: str = APP_TIMEZONE_NAME,
    ) -> dict[str, Any]:
        return self._payload(period, timezone, include_details=True)

    def visit_ledger(
        self,
        *,
        period: str = "24h",
        timezone: str = APP_TIMEZONE_NAME,
        page: int = 1,
        page_size: int = 50,
        device: str = "",
        audience: str = "all",
        q: str = "",
    ) -> dict[str, Any]:
        resolved_period = _resolve_period(period)
        zone, timezone_name = _resolve_timezone(timezone)
        now = utc_now().astimezone(zone)
        start, end, _grain = _window(resolved_period, now)
        resolved_page = max(1, int(page or 1))
        resolved_size = min(100, max(1, int(page_size or 50)))
        resolved_device = device if device in DEVICE_LABELS else ""
        is_admin = _audience_flag(audience)
        rows, total = self.repository.list_page(
            start,
            end + timedelta(microseconds=1),
            device=resolved_device,
            is_admin=is_admin,
            query=q,
            offset=(resolved_page - 1) * resolved_size,
            limit=resolved_size,
        )
        return {
            "period": resolved_period,
            "timezone": timezone_name,
            "range": {
                "start": start.isoformat(),
                "end": end.isoformat(),
            },
            "page": resolved_page,
            "pageSize": resolved_size,
            "total": total,
            "items": _visit_items(rows, zone),
        }

    def _payload(
        self,
        period: str,
        timezone: str,
        *,
        include_details: bool,
    ) -> dict[str, Any]:
        resolved_period = _resolve_period(period)
        zone, timezone_name = _resolve_timezone(timezone)
        now = utc_now().astimezone(zone)
        start, end, grain = _window(resolved_period, now)
        all_rows = self.repository.list_between(start, end + timedelta(microseconds=1))
        public_rows = [row for row in all_rows if not row.get("is_admin")]
        admin_rows = [row for row in all_rows if row.get("is_admin")]
        previous_rows = self.repository.list_between(
            start - (end - start),
            start,
        )
        previous_public = [row for row in previous_rows if not row.get("is_admin")]
        pv, uv = _pv_uv(public_rows)
        previous_pv, previous_uv = _pv_uv(previous_public)
        today = (to_app_timezone(utc_now()) or app_now()).date()
        today_pv, today_uv = _pv_uv(_rows_for_day(public_rows, today.isoformat()))
        yesterday_uv = _pv_uv(
            _rows_for_day(
                public_rows + previous_public,
                (today - timedelta(days=1)).isoformat(),
            )
        )[1]
        series = _series(public_rows, start, end, grain, zone)
        payload = {
            "period": resolved_period,
            "timezone": timezone_name,
            "generatedAt": now.isoformat(),
            "range": {
                "start": start.isoformat(),
                "end": end.isoformat(),
            },
            "totals": {
                "pv": pv,
                "uv": uv,
                "todayPv": today_pv,
                "todayUv": today_uv,
                "yesterdayUv": yesterday_uv,
                "avgDailyPv": pv / max(1, _local_day_count(start, end, zone)),
            },
            "comparison": {
                "previousPv": previous_pv,
                "previousUv": previous_uv,
                "pvDelta": pv - previous_pv,
                "uvDelta": uv - previous_uv,
            },
            "peak": _peak(series),
            "series": series,
            "devices": _devices(public_rows),
        }
        if include_details:
            admin_pv, admin_uv = _pv_uv(admin_rows)
            payload["audience"] = {
                "public": {"pv": pv, "uv": uv},
                "admin": {"pv": admin_pv, "uv": admin_uv},
            }
            payload["paths"] = _paths(all_rows)
            payload["referrers"] = _referrers(all_rows)
            payload["ips"] = _ips(all_rows)
            payload["browsers"] = _browsers(all_rows)
            payload["recent"] = _recent(all_rows, zone)
        return payload

    def _is_admin(self, authorization: str) -> bool:
        if self.auth_service is None or not (authorization or "").strip():
            return False
        try:
            self.auth_service.authenticate_authorization(authorization)
        except Exception:
            return False
        return True

    def _linuxdo_user(self, linuxdo_cookie: str) -> dict[str, Any] | None:
        if self.linuxdo_oauth is None or not (linuxdo_cookie or "").strip():
            return None
        return self.linuxdo_oauth.user_from_cookie(linuxdo_cookie)

    def _status_account(self, status_cookie: str) -> dict[str, Any] | None:
        if self.status_accounts is None or not (status_cookie or "").strip():
            return None
        return self.status_accounts.user_from_cookie(status_cookie)


def _resolve_period(value: str) -> str:
    period = (value or "").strip()
    return period if period in PERIODS else "24h"


def _resolve_timezone(value: str) -> tuple[Any, str]:
    name = (value or "").strip() or APP_TIMEZONE_NAME
    if name == APP_TIMEZONE_NAME:
        return APP_TIMEZONE, APP_TIMEZONE_NAME
    try:
        return ZoneInfo(name), name
    except (ZoneInfoNotFoundError, Exception):
        return APP_TIMEZONE, APP_TIMEZONE_NAME


def _window(period: str, now: datetime) -> tuple[datetime, datetime, str]:
    if period == "24h":
        return now - timedelta(hours=24), now, "hour"
    days = PERIOD_DAYS[period]
    start = now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(
        days=days - 1
    )
    return start, now, "day"


def _local_day_count(start: datetime, end: datetime, zone: Any) -> int:
    begin = start.astimezone(zone).date()
    finish = end.astimezone(zone)
    last = finish.date()
    if (
        finish.hour == 0
        and finish.minute == 0
        and finish.second == 0
        and finish.microsecond == 0
    ):
        last -= timedelta(days=1)
    return max(1, (last - begin).days + 1)


def _normalize_path(path: str) -> str:
    raw = (path or "").strip()
    if not raw:
        return DEFAULT_PATH
    lowered = raw.lower()
    if "http://" in lowered or "https://" in lowered:
        return DEFAULT_PATH
    parsed = urlparse(raw)
    if parsed.scheme or parsed.netloc:
        return DEFAULT_PATH
    value = parsed.path or ""
    if not value.startswith("/"):
        return DEFAULT_PATH
    return value[:PATH_MAX_LENGTH] or DEFAULT_PATH


def _referrer_url(referrer: str) -> str:
    text = (referrer or "").strip()
    if not text:
        return ""
    lowered = text.lower()
    if lowered.startswith(("javascript:", "data:", "vbscript:")):
        return ""
    return text[:REFERRER_MAX_LENGTH]


def _client_ip(value: str) -> str:
    return (value or "").strip()[:IP_MAX_LENGTH]


def _country(value: str) -> str:
    text = (value or "").strip().upper().replace("_", "-")
    if not text or text in {"XX", "T1"}:
        return text[:COUNTRY_MAX_LENGTH] if text in {"XX", "T1"} else ""
    return text[:COUNTRY_MAX_LENGTH]


def _language(value: str) -> str:
    first = (value or "").split(",", 1)[0].split(";", 1)[0].strip()
    return first[:LANGUAGE_MAX_LENGTH]


def _client_summary(user_agent: str) -> tuple[str, str]:
    text = (user_agent or "").lower()
    os_name = "其他"
    if "windows" in text:
        os_name = "Windows"
    elif "iphone" in text or "ipad" in text or "ios" in text:
        os_name = "iOS"
    elif "android" in text:
        os_name = "Android"
    elif "mac os" in text or "macintosh" in text:
        os_name = "macOS"
    elif "linux" in text:
        os_name = "Linux"
    browser = "其他"
    if "edg/" in text or "edgios/" in text:
        browser = "Edge"
    elif "opr/" in text or "opera" in text:
        browser = "Opera"
    elif "firefox/" in text or "fxios/" in text:
        browser = "Firefox"
    elif "crios/" in text or "chrome/" in text:
        browser = "Chrome"
    elif "safari/" in text:
        browser = "Safari"
    return browser, os_name


def _referrer_host(referrer: str, request_host: str) -> str:
    host = _hostname(referrer)
    if not host:
        return ""
    if host == _hostname(request_host):
        return ""
    return host[:HOST_MAX_LENGTH]


def _hostname(value: str) -> str:
    text = (value or "").strip()
    if not text:
        return ""
    parsed = urlparse(text if "://" in text else f"//{text}")
    return (parsed.hostname or "").lower().rstrip(".")


def _device_from_ua(user_agent: str) -> str:
    text = (user_agent or "").strip().lower()
    if not text:
        return "other"
    if any(token in text for token in ("bot", "crawler", "spider", "preview")):
        return "bot"
    if any(token in text for token in ("ipad", "tablet")):
        return "tablet"
    if any(token in text for token in ("iphone", "android", "mobile")):
        return "mobile"
    return "desktop"


def _resolve_visitor_id(visitor_cookie: str) -> tuple[str, bool]:
    existing = (visitor_cookie or "").strip()
    if 32 <= len(existing) <= 36 and _VISITOR_ID_RE.fullmatch(existing):
        return existing.lower(), False
    return uuid.uuid4().hex, True


def _audience_flag(value: str) -> bool | None:
    audience = (value or "").strip().lower()
    if audience == "public":
        return False
    if audience == "admin":
        return True
    return None


def _rows_for_day(rows: list[dict[str, Any]], day_key: str) -> list[dict[str, Any]]:
    return [row for row in rows if str(row.get("day_key") or "") == day_key]


def _peak(series: list[dict[str, Any]]) -> dict[str, Any] | None:
    best: dict[str, Any] | None = None
    best_key = (-1, -1)
    for item in series:
        key = (int(item.get("pv") or 0), int(item.get("uv") or 0))
        if key > best_key:
            best = item
            best_key = key
    if best is None or best_key[0] <= 0:
        return None
    return {
        "label": best.get("label") or "",
        "pv": int(best.get("pv") or 0),
        "uv": int(best.get("uv") or 0),
    }


def _pv_uv(rows: list[dict[str, Any]]) -> tuple[int, int]:
    visitors = {str(row.get("visitor_id") or "") for row in rows}
    visitors.discard("")
    return len(rows), len(visitors)


def _as_local(value: Any, zone: Any) -> datetime | None:
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        converted = to_app_timezone(value)
        value = converted if converted is not None else value.replace(tzinfo=zone)
    return value.astimezone(zone)


def _bucket_start(value: datetime, grain: str) -> datetime:
    if grain == "hour":
        return value.replace(minute=0, second=0, microsecond=0)
    return value.replace(hour=0, minute=0, second=0, microsecond=0)


def _iter_buckets(
    start: datetime,
    end: datetime,
    grain: str,
    zone: Any,
) -> list[dict[str, Any]]:
    local_start = start.astimezone(zone)
    local_end = end.astimezone(zone)
    cursor = _bucket_start(local_start, grain)
    step = timedelta(hours=1) if grain == "hour" else timedelta(days=1)
    buckets: list[dict[str, Any]] = []
    while cursor < local_end:
        bucket_end = cursor + step
        buckets.append(
            {
                "start": cursor,
                "end": bucket_end,
                "label": cursor.strftime("%H:00" if grain == "hour" else "%m-%d"),
            }
        )
        cursor = bucket_end
    return buckets


def _series(
    rows: list[dict[str, Any]],
    start: datetime,
    end: datetime,
    grain: str,
    zone: Any,
) -> list[dict[str, Any]]:
    grouped: dict[datetime, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        instant = _as_local(row.get("visited_at"), zone)
        if instant is None:
            continue
        grouped[_bucket_start(instant, grain)].append(row)
    items: list[dict[str, Any]] = []
    for bucket in _iter_buckets(start, end, grain, zone):
        pv, uv = _pv_uv(grouped.get(bucket["start"], []))
        items.append(
            {
                "start": bucket["start"].isoformat(),
                "end": bucket["end"].isoformat(),
                "label": bucket["label"],
                "pv": pv,
                "uv": uv,
            }
        )
    return items


def _devices(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        device = str(row.get("device") or "other")
        if device not in DEVICE_LABELS:
            device = "other"
        grouped[device].append(row)
    items: list[dict[str, Any]] = []
    for device, label in DEVICE_LABELS.items():
        pv, uv = _pv_uv(grouped.get(device, []))
        if pv == 0 and uv == 0:
            continue
        items.append({"id": device, "label": label, "pv": pv, "uv": uv})
    return items


def _paths(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row.get("path") or "")].append(row)
    items = []
    for path, group in grouped.items():
        pv, uv = _pv_uv(group)
        items.append({"path": path, "pv": pv, "uv": uv})
    items.sort(key=lambda item: (-item["pv"], item["path"]))
    return items[:TOP_LIMIT]


def _ips(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row.get("client_ip") or "")].append(row)
    items = []
    for ip, group in grouped.items():
        pv, uv = _pv_uv(group)
        items.append({"ip": ip, "label": ip or "未知 IP", "pv": pv, "uv": uv})
    items.sort(key=lambda item: (-item["pv"], item["ip"]))
    return items[:TOP_LIMIT]


def _browsers(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        browser, os_name = _client_summary(str(row.get("user_agent") or ""))
        grouped[f"{browser} · {os_name}"].append(row)
    items = []
    for label, group in grouped.items():
        pv, uv = _pv_uv(group)
        items.append({"label": label, "pv": pv, "uv": uv})
    items.sort(key=lambda item: (-item["pv"], item["label"]))
    return items[:TOP_LIMIT]


def _referrers(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row.get("referrer_host") or "")].append(row)
    items = []
    for host, group in grouped.items():
        pv, uv = _pv_uv(group)
        items.append(
            {
                "host": host,
                "label": DIRECT_REFERRER_LABEL if not host else host,
                "pv": pv,
                "uv": uv,
            }
        )
    items.sort(key=lambda item: (-item["pv"], item["host"]))
    return items[:TOP_LIMIT]


def _recent(rows: list[dict[str, Any]], zone: Any) -> list[dict[str, Any]]:
    ordered = sorted(rows, key=_recent_sort_key, reverse=True)
    return _visit_items(ordered[:RECENT_LIMIT], zone)


def _visit_items(rows: list[dict[str, Any]], zone: Any) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for row in rows:
        instant = _as_local(row.get("visited_at"), zone)
        user_agent = str(row.get("user_agent") or "")
        browser, os_name = _client_summary(user_agent)
        items.append(
            {
                "visitedAt": instant.isoformat() if instant else "",
                "path": str(row.get("path") or ""),
                "referrerHost": str(row.get("referrer_host") or ""),
                "referrer": str(row.get("referrer") or ""),
                "device": str(row.get("device") or "other"),
                "isAdmin": bool(row.get("is_admin")),
                "clientIp": str(row.get("client_ip") or ""),
                "visitorId": str(row.get("visitor_id") or ""),
                "userAgent": user_agent,
                "browser": browser,
                "os": os_name,
                "country": str(row.get("country") or ""),
                "language": str(row.get("language") or ""),
                "linuxdoUserId": row.get("linuxdo_user_id"),
                "linuxdoUsername": str(row.get("linuxdo_username") or ""),
                "linuxdoName": str(row.get("linuxdo_name") or ""),
                "linuxdoAvatarUrl": str(row.get("linuxdo_avatar_url") or ""),
                "linuxdoTrustLevel": row.get("linuxdo_trust_level"),
                "statusAccountId": row.get("status_account_id"),
                "statusAccountUsername": str(row.get("status_account_username") or ""),
            }
        )
    return items


def _recent_sort_key(row: dict[str, Any]) -> tuple[float, int]:
    visited_at = row.get("visited_at")
    stamp = visited_at.timestamp() if isinstance(visited_at, datetime) else 0.0
    return stamp, int(row.get("id") or 0)
