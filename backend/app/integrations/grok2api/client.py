from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any

from curl_cffi.requests import AsyncSession as CurlAsyncSession

from app.core.config import Settings
from app.integrations.grok2api.chat_probe import ChatProbeRunner
from app.integrations.grok2api.http_session import open_curl_session


class IntegrationError(RuntimeError):
    """An error while talking to grok2api.

    The original implementation only kept a formatted string.  That made a
    transient scheduler response (for example ``upstream_cooling``) look the
    same as an invalid request or an authentication failure to the probe
    queue.  Keep the human-readable message for existing callers while also
    exposing the machine-readable response metadata used by retry and task
    detail rendering.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int = 0,
        error_code: str = "",
        error_type: str = "",
        retry_after_seconds: float = 0.0,
        response_body: str = "",
        request_id: str = "",
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.error_code = error_code
        self.error_type = error_type
        self.retry_after_seconds = max(0.0, retry_after_seconds)
        self.response_body = response_body
        self.request_id = request_id
        self.attempt_count = 1

    @property
    def transient(self) -> bool:
        return is_transient_gateway_error(
            status_code=self.status_code,
            error_code=self.error_code,
        )


TRANSIENT_GATEWAY_CODES = frozenset(
    {
        "client_key_account_scope_unavailable",
        "upstream_cooling",
        "upstream_model_cooling",
        "upstream_network_error",
        "upstream_saturated",
    }
)
MODEL_ACCOUNT_BIND_MISMATCH_HINT = "不存在或与模型来源不匹配"
MODEL_ACCOUNT_BIND_WINDOW_HINT = "官方 grok2api 校验模型绑定时只看最新约 1000 个账号"
MODEL_ACCOUNT_BIND_WINDOW_EGRESS_HINT = (
    "换出口请到账号页选中该账号，使用「批量设置出口」绑定新节点，不依赖模型绑定。"
)
MODEL_ACCOUNT_BIND_WINDOW_PROBE_HINT = (
    "若要钉住该账号做探测：在 grok2api 的 config.yaml 设置 qualityGuard.enabled: true 后重启 grok2api；"
    "质量守护 sidecar 容器可以不启动。"
)
QUALITY_GUARD_UNAVAILABLE_HINT = "质量守护配置暂不可用"
QUALITY_GUARD_UNAVAILABLE_CODE = "qualityGuardUnavailable"
ADMIN_REFRESH_COOKIE = "grok2api_admin_refresh"
ADMIN_TOKEN_REFRESH_SKEW_SECONDS = 30.0
ACCOUNT_BATCH_UPDATE_SIZE = 10_000
ACCOUNT_BATCH_FALLBACK_CONCURRENCY = 8
ACCOUNT_BATCH_FALLBACK_STATUSES = frozenset({400, 404, 405, 409, 422})

logger = logging.getLogger(__name__)


def model_account_bind_window_message(
    account_id: int,
    *,
    verified_account_id: int | None = None,
    missing_egress: bool = False,
    quality_guard_unavailable: bool = False,
    quality_guard_error: str = "",
) -> str:
    """Explain why an old grok2api account cannot be pinned."""

    prefix = (
        f"账号 {account_id} 超出当前 grok2api 的模型绑定窗口"
        f"（{MODEL_ACCOUNT_BIND_WINDOW_HINT}）"
    )
    if missing_egress:
        reason = "，且没有可用出口节点，无法做定向探测。"
    elif quality_guard_unavailable:
        reason = "，质量守护未开启，无法做定向探测。"
    elif verified_account_id is not None:
        reason = f"，探测无法钉到该账号，实际命中了账号 {verified_account_id}。"
    elif quality_guard_error:
        reason = f"，质量守护定向探测失败：{quality_guard_error}。"
    else:
        reason = "，无法做定向探测。"
    return (
        prefix
        + reason
        + MODEL_ACCOUNT_BIND_WINDOW_EGRESS_HINT
        + MODEL_ACCOUNT_BIND_WINDOW_PROBE_HINT
    )


def is_model_account_bind_mismatch(error: BaseException) -> bool:
    """Return whether grok2api refused a model account bind.

    Older grok2api builds validated bound accounts by listing the newest 1000
    grok_build rows, so existing older IDs returned HTTP 400. Current grok2api
    counts by ID, but probes still fall back to quality-guard pinning when
    this error appears.
    """

    if not isinstance(error, IntegrationError) or error.status_code != 400:
        return False
    haystack = " ".join(
        part
        for part in (error.error_code, str(error), error.response_body)
        if part
    )
    return MODEL_ACCOUNT_BIND_MISMATCH_HINT in haystack


def is_quality_guard_unavailable(error: BaseException) -> bool:
    """Return whether grok2api refused quality-guard because it is not configured."""

    if not isinstance(error, IntegrationError):
        return False
    if error.error_code == QUALITY_GUARD_UNAVAILABLE_CODE:
        return True
    haystack = " ".join(
        part
        for part in (error.error_code, str(error), error.response_body)
        if part
    )
    return QUALITY_GUARD_UNAVAILABLE_HINT in haystack


def is_transient_gateway_error(*, status_code: int, error_code: str) -> bool:
    """Return whether a failed probe may succeed after a short wait.

    A remaining quota value does not imply that the selector can lease the
    account right now.  These codes represent cooling, transport, or capacity
    state and are safe for GrokIQ to retry once the upstream scheduler
    has had time to recover.  Credential, model, and quota failures are left
    as final samples so they are not hidden by retries.
    """

    if error_code == "modelBindWindow":
        return False
    if error_code in TRANSIENT_GATEWAY_CODES:
        return True
    return status_code in {502, 503, 504}


def _parse_error_payload(raw: str) -> tuple[str, str, str]:
    """Extract ``code``, ``message`` and ``type`` from an OpenAI error body."""

    try:
        payload = json.loads(raw)
    except (TypeError, ValueError):
        return "", raw.strip(), ""
    if not isinstance(payload, dict):
        return "", raw.strip(), ""
    value = payload.get("error", payload)
    if isinstance(value, dict):
        code = str(value.get("code") or "")
        message = str(value.get("message") or "")
        error_type = str(value.get("type") or "")
        return code, message, error_type
    return "", str(value or raw).strip(), ""


def _parse_retry_after(value: str | None) -> float:
    if not value:
        return 0.0
    try:
        return max(0.0, float(value.strip()))
    except ValueError:
        try:
            parsed = parsedate_to_datetime(value)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=UTC)
            return max(0.0, (parsed.astimezone(UTC) - datetime.now(UTC)).total_seconds())
        except (TypeError, ValueError, OverflowError):
            return 0.0


def _parse_timestamp(value: Any) -> float:
    if not value:
        return 0.0
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError, OverflowError):
        return 0.0


def _response_error(
    *,
    context: str,
    status_code: int,
    body: str,
    retry_after: str | None = None,
    request_id: str = "",
) -> IntegrationError:
    code, message, error_type = _parse_error_payload(body)
    detail = message or body.strip() or f"HTTP {status_code}"
    return IntegrationError(
        f"{context} 返回 HTTP {status_code}: {detail[:1000]}",
        status_code=status_code,
        error_code=code,
        error_type=error_type,
        retry_after_seconds=_parse_retry_after(retry_after),
        response_body=body[:4000],
        request_id=request_id,
    )


@dataclass(slots=True, frozen=True)
class ChatProbeResult:
    request_id: str
    audit_id: int | None
    verified_account_id: int | None
    verified_egress_node_id: int | None
    status_code: int
    response_text: str
    reasoning_text: str
    response_sha256: str
    output_tokens: int
    reasoning_tokens: int
    reasoning_tokens_reported: bool
    visible_tokens: int
    chunk_count: int
    first_token_ms: int
    duration_ms: int
    generation_ms: int
    first_token_share: float
    tps: float
    expected_matched: bool
    usage: dict[str, Any]


@dataclass(slots=True, frozen=True)
class AccountUpdateFailure:
    account_id: int
    error: str


@dataclass(slots=True, frozen=True)
class AccountBatchUpdateResult:
    updated: int
    failures: tuple[AccountUpdateFailure, ...] = ()


@dataclass(slots=True, frozen=True)
class AccountBatchDeleteResult:
    deleted: int
    failures: tuple[AccountUpdateFailure, ...] = ()


class Grok2APIClient:
    """API-only integration with grok2api.

    Account and proxy lists are read live. For a probe run this adapter creates
    a temporary account-bound model route and (when needed) a temporary client
    key, calls the grok2api ``/v1/responses`` endpoint, and verifies the
    request audit. Normal checks preserve the account's current egress binding;
    explicit diagnostics may change it temporarily and restore it afterwards.
    """

    max_stream_bytes = 4 << 20

    def __init__(self, settings: Settings):
        self.settings = settings
        self._token = ""
        self._token_expires_at = 0.0
        self._refresh_token = ""
        self._login_lock = asyncio.Lock()
        self._chat_probe_runner = ChatProbeRunner(
            base_url=lambda: self.settings.normalized_gateway_base_url,
            session_factory=lambda: self._session(),
            find_audit=lambda request_id: self.find_audit(request_id),
            max_stream_bytes=lambda: self.max_stream_bytes,
            result_type=ChatProbeResult,
            error_type=IntegrationError,
            response_error=_response_error,
            parse_error_payload=_parse_error_payload,
        )

    def _session(self) -> CurlAsyncSession:
        return open_curl_session(
            impersonate=self.settings.grok2api_http_impersonate,
            base_url=self.settings.normalized_gateway_base_url,
        )

    def reset_credentials(self) -> None:
        """Drop cached login state after runtime connection settings change."""

        self._token = ""
        self._token_expires_at = 0.0
        self._refresh_token = ""

    def _token_is_usable(self) -> bool:
        if not self._token:
            return False
        if self._token_expires_at <= 0:
            return True
        return time.time() + ADMIN_TOKEN_REFRESH_SKEW_SECONDS < self._token_expires_at

    def _credentials_configured(self) -> bool:
        return bool(
            self.settings.grok2api_admin_username
            and self.settings.grok2api_admin_password
        )

    async def _auth_post(self, path: str, *, body: dict[str, Any], context: str) -> Any:
        try:
            async with self._session() as client:
                response = await client.post(
                    f"{self.settings.normalized_gateway_base_url}{path}",
                    json=body,
                    timeout=30,
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise IntegrationError(f"{context}请求失败: {exc}") from exc
        if response.status_code >= 300:
            raise _response_error(
                context=context,
                status_code=response.status_code,
                body=response.text[:4000],
                retry_after=response.headers.get("Retry-After"),
            )
        return response

    def _remember_admin_tokens(
        self,
        tokens: dict[str, Any],
        response: Any,
        *,
        refresh_rotated: bool,
    ) -> str:
        access_token = str(tokens.get("accessToken") or "")
        if not access_token:
            raise IntegrationError("管理员鉴权响应缺少 accessToken")
        self._token = access_token
        self._token_expires_at = _parse_timestamp(tokens.get("accessTokenExpiresAt"))
        refresh_token = str(response.cookies.get(ADMIN_REFRESH_COOKIE) or "")
        if refresh_token:
            self._refresh_token = refresh_token
        elif refresh_rotated:
            # grok2api rotates refresh tokens. Keeping the previous value would
            # guarantee another 401, so fall back to password login next time.
            self._refresh_token = ""
        return self._token

    async def _login_locked(self) -> str:
        if not self._credentials_configured():
            raise IntegrationError("尚未配置 grok2api 管理员凭据")
        response = await self._auth_post(
            "/api/admin/v1/auth/login",
            body={
                "username": self.settings.grok2api_admin_username,
                "password": self.settings.grok2api_admin_password,
            },
            context="管理员登录",
        )
        payload = response.json()
        data = payload.get("data", payload)
        tokens = data.get("tokens", {}) if isinstance(data, dict) else {}
        return self._remember_admin_tokens(tokens, response, refresh_rotated=False)

    async def _refresh_locked(self) -> str:
        if not self._refresh_token:
            raise IntegrationError("管理员刷新会话不存在", status_code=401)
        response = await self._auth_post(
            "/api/admin/v1/auth/refresh",
            body={"refreshToken": self._refresh_token},
            context="管理员会话刷新",
        )
        payload = response.json()
        tokens = payload.get("data", payload)
        if not isinstance(tokens, dict):
            tokens = {}
        return self._remember_admin_tokens(tokens, response, refresh_rotated=True)

    async def _admin_token(self) -> str:
        if self._token_is_usable():
            return self._token
        async with self._login_lock:
            if self._token_is_usable():
                return self._token
            if self._refresh_token:
                try:
                    return await self._refresh_locked()
                except IntegrationError:
                    self._refresh_token = ""
            self._token = ""
            self._token_expires_at = 0.0
            return await self._login_locked()

    async def _renew_admin_token(self, rejected_token: str) -> str:
        async with self._login_lock:
            if (
                self._token
                and self._token != rejected_token
                and self._token_is_usable()
            ):
                return self._token
            self._token = ""
            self._token_expires_at = 0.0
            if self._refresh_token:
                try:
                    return await self._refresh_locked()
                except IntegrationError:
                    self._refresh_token = ""
            return await self._login_locked()

    async def _invalidate_admin_token(self, rejected_token: str) -> None:
        async with self._login_lock:
            if self._token != rejected_token:
                return
            self._token = ""
            self._token_expires_at = 0.0
            self._refresh_token = ""

    async def admin_request(self, method: str, path: str, **kwargs: Any) -> Any:
        token = await self._admin_token()
        base_headers = dict(kwargs.pop("headers", {}))
        timeout = kwargs.pop("timeout", 180)

        async def send(current_token: str) -> Any:
            headers = {**base_headers, "Authorization": f"Bearer {current_token}"}
            try:
                async with self._session() as client:
                    return await client.request(
                        method,
                        f"{self.settings.normalized_gateway_base_url}{path}",
                        headers=headers,
                        timeout=timeout,
                        **kwargs,
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                raise IntegrationError(f"grok2api 请求失败: {exc}") from exc

        response = await send(token)
        if response.status_code == 401:
            token = await self._renew_admin_token(token)
            response = await send(token)
            if response.status_code == 401:
                await self._invalidate_admin_token(token)
        if response.status_code >= 300:
            raise _response_error(
                context="grok2api",
                status_code=response.status_code,
                body=response.text[:4000],
                retry_after=response.headers.get("Retry-After"),
            )
        if not response.content:
            return {}
        payload = response.json()
        return payload.get("data", payload)

    async def list_accounts(self, **params: Any) -> dict[str, Any]:
        query = {"provider": "grok_build", "page": 1, "pageSize": 50} | params
        return await self.admin_request("GET", "/api/admin/v1/accounts", params=query)

    async def list_all_accounts(
        self,
        account_ids: set[int] | None = None,
        **params: Any,
    ) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        page = 1
        while True:
            payload = await self.list_accounts(**params, page=page, pageSize=200)
            batch = list(payload.get("items", []))
            if account_ids is None:
                items.extend(batch)
            else:
                items.extend(item for item in batch if int(item.get("id") or 0) in account_ids)
            if not batch or page * int(payload.get("pageSize") or 200) >= int(payload.get("total") or 0):
                break
            if account_ids is not None and {int(item.get("id") or 0) for item in items} >= account_ids:
                break
            page += 1
        return items

    async def get_account(self, account_id: int) -> dict[str, Any]:
        return await self.admin_request("GET", f"/api/admin/v1/accounts/{account_id}")

    async def get_accounts_by_ids(self, account_ids: set[int]) -> list[dict[str, Any]]:
        """Load a small set of accounts by grok2api internal ID.

        The admin list supports ``#id`` as an exact primary-key lookup, so this
        avoids paging the entire account pool when a task list only needs a
        handful of missing labels.
        """

        requested = sorted(account_id for account_id in account_ids if account_id > 0)
        if not requested:
            return []
        items = await asyncio.gather(
            *(self._lookup_account_by_id(account_id) for account_id in requested)
        )
        return [item for item in items if item is not None]

    async def _lookup_account_by_id(self, account_id: int) -> dict[str, Any] | None:
        payload = await self.list_accounts(search=f"#{account_id}", page=1, pageSize=1)
        item = next(
            (
                candidate
                for candidate in payload.get("items", [])
                if int(candidate.get("id") or 0) == account_id
            ),
            None,
        )
        if item is not None:
            return item
        try:
            item = await self.get_account(account_id)
        except Exception:
            return None
        return item if int(item.get("id") or 0) == account_id else None

    async def list_egress_nodes(self, **params: Any) -> dict[str, Any]:
        query = {"scope": "grok_build", "page": 1, "pageSize": 100} | params
        return await self.admin_request("GET", "/api/admin/v1/egress-nodes", params=query)

    async def list_request_audits(
        self,
        *,
        cursor: str = "",
        page_size: int = 200,
        period: str = "24h",
    ) -> dict[str, Any]:
        """Read one cursor page from grok2api's request-audit ledger.

        The upstream endpoint is cursor ordered (newest first).  The caller
        persists the newest upstream boundary, even when that row is not a
        grok_build request, so ordinary scans transfer only newly-arrived pages.
        """

        query: dict[str, Any] = {
            "pagination": "cursor",
            "period": period,
            "pageSize": max(1, min(int(page_size), 500)),
            "sortBy": "createdAt",
            "sortOrder": "desc",
        }
        if cursor:
            query["cursor"] = cursor
        return await self.admin_request(
            "GET",
            "/api/admin/v1/request-audits",
            params=query,
        )

    async def set_egress_nodes_enabled(
        self,
        node_ids: list[int],
        enabled: bool,
    ) -> dict[str, Any]:
        return await self.admin_request(
            "PATCH",
            "/api/admin/v1/egress-nodes/batch",
            json={"ids": [str(node_id) for node_id in node_ids], "enabled": enabled},
        )

    async def create_egress_node(
        self,
        *,
        name: str,
        proxy_url: str,
        proxy_pool: bool,
        account_capacity: int,
        enabled: bool,
    ) -> dict[str, Any]:
        return await self.admin_request(
            "POST",
            "/api/admin/v1/egress-nodes",
            json={
                "name": name,
                "scope": "grok_build",
                "enabled": enabled,
                "proxyPool": proxy_pool,
                "accountCapacity": account_capacity,
                "proxyURL": proxy_url,
                "userAgent": "",
            },
        )

    async def update_egress_node(
        self,
        node_id: int,
        *,
        name: str,
        proxy_pool: bool,
        account_capacity: int,
        enabled: bool,
        proxy_url: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "name": name,
            "scope": "grok_build",
            "enabled": enabled,
            "proxyPool": proxy_pool,
            "accountCapacity": account_capacity,
            "userAgent": "",
        }
        if proxy_url is not None:
            payload["proxyURL"] = proxy_url
        return await self.admin_request(
            "PUT",
            f"/api/admin/v1/egress-nodes/{node_id}",
            json=payload,
        )

    async def delete_egress_nodes(self, node_ids: list[int]) -> dict[str, Any]:
        return await self.admin_request(
            "DELETE",
            "/api/admin/v1/egress-nodes",
            json={"ids": [str(node_id) for node_id in node_ids]},
        )

    async def test_egress_node(self, node_id: int) -> dict[str, Any]:
        return await self.admin_request(
            "POST",
            f"/api/admin/v1/egress-nodes/{node_id}/test",
        )

    async def set_account_enabled(self, account_id: int, enabled: bool) -> dict[str, Any]:
        return await self.admin_request(
            "PATCH", f"/api/admin/v1/accounts/{account_id}", json={"enabled": enabled}
        )

    async def set_account_priority(self, account_id: int, priority: int) -> dict[str, Any]:
        """Adjust one upstream account's routing priority without changing state."""

        return await self.admin_request(
            "PATCH",
            f"/api/admin/v1/accounts/{account_id}",
            json={"priority": int(priority)},
        )

    async def recover_account_at_priority(
        self,
        account_id: int,
        *,
        priority: int,
    ) -> dict[str, Any]:
        """Atomically re-enable a quarantined account at a guarded priority."""

        return await self.admin_request(
            "PATCH",
            f"/api/admin/v1/accounts/{account_id}",
            json={"enabled": True, "priority": priority},
        )

    async def set_accounts_enabled(
        self,
        account_ids: list[int],
        enabled: bool,
    ) -> AccountBatchUpdateResult:
        """Update many accounts with a bounded compatibility fallback.

        The native endpoint keeps large selections fast. Older grok2api
        versions and a stale ID inside one batch can reject the entire request,
        so compatible 4xx responses fall back to the single-account endpoint.
        """

        unique_ids = list(
            dict.fromkeys(account_id for account_id in account_ids if account_id > 0)
        )
        updated = 0
        failures: list[AccountUpdateFailure] = []
        for start in range(0, len(unique_ids), ACCOUNT_BATCH_UPDATE_SIZE):
            batch = unique_ids[start : start + ACCOUNT_BATCH_UPDATE_SIZE]
            try:
                result = await self.admin_request(
                    "PATCH",
                    "/api/admin/v1/accounts/batch",
                    json={
                        "ids": [str(account_id) for account_id in batch],
                        "provider": "grok_build",
                        "enabled": enabled,
                    },
                )
                updated += int(result.get("updated") or 0)
            except IntegrationError as exc:
                if exc.status_code not in ACCOUNT_BATCH_FALLBACK_STATUSES:
                    raise
                logger.warning(
                    "native account batch update failed with HTTP %s; "
                    "falling back to %s single-account updates",
                    exc.status_code,
                    len(batch),
                )
                fallback = await self._set_accounts_enabled_individually(
                    batch,
                    enabled,
                )
                updated += fallback.updated
                failures.extend(fallback.failures)
        return AccountBatchUpdateResult(updated=updated, failures=tuple(failures))

    async def _set_accounts_enabled_individually(
        self,
        account_ids: list[int],
        enabled: bool,
    ) -> AccountBatchUpdateResult:
        semaphore = asyncio.Semaphore(ACCOUNT_BATCH_FALLBACK_CONCURRENCY)

        async def update(account_id: int) -> AccountUpdateFailure | None:
            async with semaphore:
                try:
                    await self.set_account_enabled(account_id, enabled)
                except IntegrationError as exc:
                    return AccountUpdateFailure(
                        account_id=account_id,
                        error=str(exc),
                    )
                return None

        results = await asyncio.gather(
            *(update(account_id) for account_id in account_ids)
        )
        failures = tuple(result for result in results if result is not None)
        return AccountBatchUpdateResult(
            updated=len(account_ids) - len(failures),
            failures=failures,
        )

    async def delete_account(self, account_id: int) -> None:
        await self.admin_request(
            "DELETE", f"/api/admin/v1/accounts/{account_id}"
        )

    async def delete_accounts(
        self,
        account_ids: list[int],
    ) -> AccountBatchDeleteResult:
        """Delete many accounts concurrently, collecting per-account failures.

        grok2api exposes single-account deletion only, so this fans out bounded
        concurrent deletes and reports which ids could not be removed instead of
        aborting the whole selection on the first error.
        """

        unique_ids = list(
            dict.fromkeys(account_id for account_id in account_ids if account_id > 0)
        )
        semaphore = asyncio.Semaphore(ACCOUNT_BATCH_FALLBACK_CONCURRENCY)

        async def delete(account_id: int) -> AccountUpdateFailure | None:
            async with semaphore:
                try:
                    await self.delete_account(account_id)
                except IntegrationError as exc:
                    return AccountUpdateFailure(
                        account_id=account_id,
                        error=str(exc),
                    )
                return None

        results = await asyncio.gather(
            *(delete(account_id) for account_id in unique_ids)
        )
        failures = tuple(result for result in results if result is not None)
        return AccountBatchDeleteResult(
            deleted=len(unique_ids) - len(failures),
            failures=failures,
        )

    async def set_account_routing_settings(
        self,
        account_id: int,
        *,
        enabled: bool,
        priority: int,
        max_concurrent: int,
    ) -> dict[str, Any]:
        """Apply the diagnostic activation or its rollback in one upstream PATCH."""

        return await self.admin_request(
            "PATCH",
            f"/api/admin/v1/accounts/{account_id}",
            json={
                "enabled": enabled,
                "priority": priority,
                "maxConcurrent": max_concurrent,
            },
        )

    async def set_account_egress(self, account_id: int, target: dict[str, Any]) -> None:
        if target.get("kind") == "direct":
            updated = await self._set_accounts_egress_native(
                [account_id],
                None,
                mode="manual",
            )
            if updated != 1:
                raise IntegrationError("grok2api 未解除账号出口绑定")
            return
        node_id = int(target.get("id") or 0)
        if node_id <= 0:
            raise IntegrationError("代理目标缺少有效的出口节点 ID")
        updated = await self._set_accounts_egress_native(
            [account_id],
            node_id,
            mode="manual",
        )
        if updated != 1:
            raise IntegrationError("grok2api 未更新账号出口绑定")

    async def set_accounts_egress(
        self,
        account_ids: list[int],
        node_id: int | None,
        *,
        mode: str = "manual",
    ) -> AccountBatchUpdateResult:
        """Bind or unbind accounts with per-account fallback for stale batches."""

        if mode not in {"manual", "auto"}:
            raise IntegrationError("账号出口绑定模式无效")
        unique_ids = list(
            dict.fromkeys(account_id for account_id in account_ids if account_id > 0)
        )
        updated = 0
        failures: list[AccountUpdateFailure] = []
        for start in range(0, len(unique_ids), ACCOUNT_BATCH_UPDATE_SIZE):
            batch = unique_ids[start : start + ACCOUNT_BATCH_UPDATE_SIZE]
            try:
                updated += await self._set_accounts_egress_native(
                    batch,
                    node_id,
                    mode=mode,
                )
            except IntegrationError as exc:
                if exc.status_code not in ACCOUNT_BATCH_FALLBACK_STATUSES:
                    raise
                logger.warning(
                    "native egress batch update failed with HTTP %s; "
                    "falling back to %s single-account updates",
                    exc.status_code,
                    len(batch),
                )
                fallback = await self._set_accounts_egress_individually(
                    batch,
                    node_id,
                    mode=mode,
                )
                updated += fallback.updated
                failures.extend(fallback.failures)
        return AccountBatchUpdateResult(updated=updated, failures=tuple(failures))

    async def _set_accounts_egress_native(
        self,
        account_ids: list[int],
        node_id: int | None,
        *,
        mode: str,
    ) -> int:
        path = (
            f"/api/admin/v1/egress-nodes/{node_id}/accounts"
            if node_id is not None
            else "/api/admin/v1/egress-nodes/accounts"
        )
        result = await self.admin_request(
            "POST" if node_id is not None else "DELETE",
            path,
            json={
                "provider": "grok_build",
                "ids": [str(account_id) for account_id in account_ids],
                "mode": mode,
            },
        )
        return int(result.get("assigned") or 0)

    async def _set_accounts_egress_individually(
        self,
        account_ids: list[int],
        node_id: int | None,
        *,
        mode: str,
    ) -> AccountBatchUpdateResult:
        semaphore = asyncio.Semaphore(ACCOUNT_BATCH_FALLBACK_CONCURRENCY)

        async def update(account_id: int) -> AccountUpdateFailure | None:
            async with semaphore:
                try:
                    await self._set_accounts_egress_native(
                        [account_id],
                        node_id,
                        mode=mode,
                    )
                except IntegrationError as exc:
                    return AccountUpdateFailure(account_id=account_id, error=str(exc))
                return None

        results = await asyncio.gather(*(update(account_id) for account_id in account_ids))
        failures = tuple(result for result in results if result is not None)
        return AccountBatchUpdateResult(
            updated=len(account_ids) - len(failures),
            failures=failures,
        )

    async def restore_account_egress(
        self,
        account_id: int,
        original_node_id: int | None,
        original_mode: str,
    ) -> None:
        if original_node_id:
            updated = await self._set_accounts_egress_native(
                [account_id],
                original_node_id,
                mode=original_mode if original_mode in {"manual", "auto"} else "manual",
            )
        else:
            updated = await self._set_accounts_egress_native(
                [account_id],
                None,
                mode="manual",
            )
        if updated != 1:
            raise IntegrationError("grok2api 未恢复账号出口绑定")

    async def create_probe_route(
        self,
        *,
        account_id: int,
        upstream_model: str,
        allow_temporarily_unavailable: bool = False,
        bind_account: bool = True,
    ) -> tuple[str, str]:
        public_id = f"{self.settings.probe_route_prefix}-{account_id}-{uuid.uuid4().hex[:12]}"
        body: dict[str, Any] = {
            "publicId": public_id,
            "provider": "grok_build",
            "upstreamModel": upstream_model,
            "capability": "responses",
            "enabled": True,
        }
        if bind_account:
            body["accountIds"] = [str(account_id)]
        route = await self.admin_request(
            "POST",
            "/api/admin/v1/models",
            json=body,
        )
        route_id = str(route.get("id") or "")
        if not route_id:
            raise IntegrationError("创建临时探针路由后响应缺少路由 ID")
        public_model = str(route.get("publicId") or public_id)
        if route.get("available") is False and not allow_temporarily_unavailable:
            try:
                await self.delete_probe_route(route_id)
            finally:
                supported = int(route.get("supportedAccounts") or 0)
                raise IntegrationError(
                    f"目标账号当前不可调度方案模型 {upstream_model}"
                    f"（可用绑定账号数 {supported}），请检查账号启用状态和模型能力同步"
                )
        return route_id, public_model

    async def delete_probe_route(self, route_id: str) -> None:
        if route_id:
            await self.admin_request("DELETE", f"/api/admin/v1/models/{route_id}")

    async def list_client_keys(self, **params: Any) -> dict[str, Any]:
        query = {"page": 1, "pageSize": 20} | params
        return await self.admin_request("GET", "/api/admin/v1/client-keys", params=query)

    async def get_client_key_secret(self, key_id: str) -> str:
        payload = await self.admin_request("GET", f"/api/admin/v1/client-keys/{key_id}/secret")
        secret = str(payload.get("secret") or "")
        if not secret:
            raise IntegrationError("读取 Client Key secret 后响应缺少 secret")
        return secret

    async def create_probe_client_key(self, route_id: str) -> tuple[str, str]:
        payload = await self.admin_request(
            "POST",
            "/api/admin/v1/client-keys",
            json={
                "name": f"{self.settings.probe_route_prefix}-{uuid.uuid4().hex[:12]}",
                "enabled": True,
                "maxConcurrent": 1,
                "allowedModelIds": [str(route_id)],
                "providerScope": ["grok_build"],
            },
        )
        key = payload.get("key", {})
        key_id = str(key.get("id") or "")
        secret = str(payload.get("secret") or "")
        if not key_id or not secret:
            raise IntegrationError("创建临时探针 Client Key 后响应缺少 ID 或 secret")
        return key_id, secret

    async def delete_probe_client_key(self, key_id: str) -> None:
        if key_id:
            await self.admin_request("DELETE", f"/api/admin/v1/client-keys/{key_id}")

    async def find_audit(self, request_id: str) -> dict[str, Any] | None:
        for _ in range(20):
            payload = await self.admin_request(
                "GET",
                "/api/admin/v1/request-audits",
                params={
                    "pagination": "cursor",
                    "search": request_id,
                    "period": "24h",
                    "pageSize": 20,
                },
            )
            for item in payload.get("items", []):
                if item.get("requestId") == request_id:
                    return item
            await asyncio.sleep(0.25)
        return None

    async def chat_probe(
        self,
        *,
        api_key: str,
        public_model: str,
        account_id: int,
        system_prompt: str,
        prompt: str,
        expected: str,
        max_output_tokens: int,
        temperature: float | None,
        extra_body: dict[str, Any],
    ) -> ChatProbeResult:
        request_id = f"grokiq_{uuid.uuid4().hex}"
        return await self._chat_probe_runner.run(
            request_id=request_id,
            api_key=api_key,
            public_model=public_model,
            account_id=account_id,
            system_prompt=system_prompt,
            prompt=prompt,
            expected=expected,
            max_output_tokens=max_output_tokens,
            temperature=temperature,
            extra_body=extra_body,
        )

    async def quality_probe(
        self,
        *,
        client_key_id: str,
        public_model: str,
        account_id: int,
        egress_node_id: int,
        prompt: str,
        expected: str,
        max_output_tokens: int,
        pin_account: bool = False,
    ) -> ChatProbeResult:
        """Run grok2api's forced-egress quality probe and record its audit."""

        if not client_key_id:
            raise IntegrationError("快速出口质量探针需要临时 Client Key ID")
        request_body: dict[str, Any] = {
            "clientKeyId": client_key_id,
            "model": public_model,
            "prompt": prompt,
            "expected": expected,
        }
        extra_usage: dict[str, Any] | None = None
        if pin_account:
            request_body["accountId"] = str(account_id)
            extra_usage = {"account_bind_skipped": True}
        if max_output_tokens > 0:
            request_body["maxOutputTokens"] = max_output_tokens
        payload = await self.admin_request(
            "POST",
            f"/api/admin/v1/egress-nodes/{egress_node_id}/quality-test",
            json=request_body,
            timeout=300,
        )
        result = self._quality_result_from_payload(payload, extra_usage=extra_usage)
        return await self._verify_quality_probe_account(
            result,
            account_id=account_id,
            pin_account=pin_account,
        )

    async def quality_guard_probe(
        self,
        *,
        account_id: int,
        egress_node_id: int,
    ) -> ChatProbeResult:
        """Pin an old account through grok2api quality-guard without model bind."""

        if egress_node_id <= 0:
            raise IntegrationError("定向质量探测需要账号当前出口节点")
        try:
            payload = await self.admin_request(
                "POST",
                (
                    "/api/admin/v1/egress-quality-guard/nodes/"
                    f"{egress_node_id}/test"
                ),
                json={"accountId": str(account_id)},
                timeout=300,
            )
        except IntegrationError as exc:
            unavailable = is_quality_guard_unavailable(exc)
            raise IntegrationError(
                model_account_bind_window_message(
                    account_id,
                    quality_guard_unavailable=unavailable,
                    quality_guard_error="" if unavailable else str(exc),
                ),
                status_code=exc.status_code,
                error_code="modelBindWindow",
                error_type=exc.error_type,
                retry_after_seconds=exc.retry_after_seconds,
                response_body=exc.response_body,
                request_id=exc.request_id,
            ) from exc
        result = self._quality_result_from_payload(
            payload,
            extra_usage={
                "quality_guard": True,
                "account_bind_skipped": True,
            },
        )
        return await self._verify_quality_probe_account(
            result,
            account_id=account_id,
            pin_account=True,
        )

    def _quality_result_from_payload(
        self,
        payload: dict[str, Any],
        *,
        extra_usage: dict[str, Any] | None = None,
    ) -> ChatProbeResult:
        request_id = str(payload.get("requestId") or "")
        if not request_id:
            raise IntegrationError("出口质量探针响应缺少 requestId")
        duration_ms = int(payload.get("durationMs") or 0)
        first_token_ms = int(payload.get("firstTokenMs") or 0)
        generation_ms = int(
            payload.get("generationMs") or max(duration_ms - first_token_ms, 0)
        )
        output_tokens = int(payload.get("outputTokens") or 0)
        reasoning_tokens = int(payload.get("reasoningTokens") or 0)
        visible_tokens = int(payload.get("visibleTokens") or 0)
        usage = {
            "completion_tokens": output_tokens,
            "completion_tokens_details": {
                "reasoning_tokens": reasoning_tokens,
            },
            "quality_test": True,
        }
        if extra_usage:
            usage.update(extra_usage)
        return ChatProbeResult(
            request_id=request_id,
            audit_id=None,
            verified_account_id=None,
            verified_egress_node_id=None,
            status_code=int(payload.get("statusCode") or 0),
            response_text="",
            reasoning_text="",
            response_sha256=str(payload.get("responseSha256") or ""),
            output_tokens=output_tokens,
            reasoning_tokens=reasoning_tokens,
            reasoning_tokens_reported="reasoningTokens" in payload,
            visible_tokens=visible_tokens,
            chunk_count=int(payload.get("chunkCount") or 0),
            first_token_ms=first_token_ms,
            duration_ms=duration_ms,
            generation_ms=generation_ms,
            first_token_share=(
                first_token_ms / duration_ms if duration_ms > 0 else 0.0
            ),
            tps=float(payload.get("outputTokensPerSecond") or 0.0),
            expected_matched=bool(payload.get("expectedMatched")),
            usage=usage,
        )

    async def _verify_quality_probe_account(
        self,
        result: ChatProbeResult,
        *,
        account_id: int,
        pin_account: bool = False,
    ) -> ChatProbeResult:
        audit = await self.find_audit(result.request_id)
        if audit is None:
            error = IntegrationError(
                "出口质量探针审计未落库，未能核验实际账号和出口",
                request_id=result.request_id,
            )
            error.probe_result = result
            raise error
        verified_account_id = int(audit.get("accountId") or 0) or None
        verified_egress_node_id = int(audit.get("egressNodeId") or 0) or None
        result = replace(
            result,
            audit_id=int(audit.get("id") or 0) or None,
            verified_account_id=verified_account_id,
            verified_egress_node_id=verified_egress_node_id,
        )
        if verified_account_id != account_id:
            message = (
                model_account_bind_window_message(
                    account_id,
                    verified_account_id=verified_account_id,
                )
                if pin_account
                else f"请求实际命中账号 {verified_account_id}，目标账号为 {account_id}"
            )
            error = IntegrationError(
                message,
                request_id=result.request_id,
                error_code="modelBindWindow" if pin_account else "",
            )
            error.audit_id = result.audit_id
            error.verified_account_id = verified_account_id
            error.verified_egress_node_id = verified_egress_node_id
            error.probe_result = result
            raise error
        return result

    async def cleanup_stale_resources(self) -> dict[str, int]:
        routes_deleted = await self._cleanup_collection(
            path="/api/admin/v1/models",
            prefix=self.settings.probe_route_prefix,
            delete_path="/api/admin/v1/models/{id}",
            name_field="publicId",
        )
        keys_deleted = await self._cleanup_collection(
            path="/api/admin/v1/client-keys",
            prefix=self.settings.probe_route_prefix,
            delete_path="/api/admin/v1/client-keys/{id}",
            name_field="name",
        )
        return {"routes": routes_deleted, "clientKeys": keys_deleted}

    async def _cleanup_collection(
        self,
        *,
        path: str,
        prefix: str,
        delete_path: str,
        name_field: str,
    ) -> int:
        deleted = 0
        page = 1
        while True:
            payload = await self.admin_request(
                "GET", path, params={"search": prefix, "page": page, "pageSize": 200}
            )
            items = list(payload.get("items", []))
            for item in items:
                name = str(item.get(name_field) or "")
                item_id = str(item.get("id") or "")
                if name.startswith(f"{prefix}-") and item_id:
                    await self.admin_request("DELETE", delete_path.format(id=item_id))
                    deleted += 1
            if not items or page * 200 >= int(payload.get("total") or 0):
                break
            page += 1
        return deleted
