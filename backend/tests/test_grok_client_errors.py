from __future__ import annotations

import pytest

from app.core.config import Settings
from app.integrations.grok2api.client import Grok2APIClient, _response_error


class RecordingGrokClient(Grok2APIClient):
    def __init__(self) -> None:
        super().__init__(Settings())
        self.requests: list[tuple[str, str, dict[str, object]]] = []

    async def admin_request(self, method: str, path: str, **kwargs: object) -> dict[str, int]:
        self.requests.append((method, path, kwargs))
        body = kwargs.get("json")
        ids = body.get("ids", []) if isinstance(body, dict) else []
        return {"assigned": len(ids)}


def test_openai_error_response_keeps_scheduler_metadata():
    error = _response_error(
        context="/v1/responses",
        status_code=503,
        body=(
            '{"error":{"code":"client_key_account_scope_unavailable",'
            '"message":"temporarily unavailable","type":"server_error"}}'
        ),
        retry_after="7",
        request_id="request-1",
    )

    assert error.status_code == 503
    assert error.error_code == "client_key_account_scope_unavailable"
    assert error.error_type == "server_error"
    assert error.retry_after_seconds == 7
    assert error.request_id == "request-1"
    assert error.transient is True
    assert "temporarily unavailable" in str(error)


def test_quota_error_is_not_retried_as_scheduler_cooldown():
    error = _response_error(
        context="/v1/responses",
        status_code=429,
        body=(
            '{"error":{"code":"upstream_quota_exhausted",'
            '"message":"quota exhausted","type":"rate_limit_error"}}'
        ),
    )

    assert error.status_code == 429
    assert error.error_code == "upstream_quota_exhausted"
    assert error.transient is False


@pytest.mark.asyncio
async def test_batch_egress_binding_sends_mode_and_unbinds_with_delete():
    client = RecordingGrokClient()

    assigned = await client.set_accounts_egress([1, 2], 7, mode="auto")
    unassigned = await client.set_accounts_egress([1, 2], None)

    assert assigned.updated == 2
    assert unassigned.updated == 2
    assert client.requests == [
        (
            "POST",
            "/api/admin/v1/egress-nodes/7/accounts",
            {"json": {"provider": "grok_build", "ids": ["1", "2"], "mode": "auto"}},
        ),
        (
            "DELETE",
            "/api/admin/v1/egress-nodes/accounts",
            {"json": {"provider": "grok_build", "ids": ["1", "2"], "mode": "manual"}},
        ),
    ]


def test_model_account_bind_mismatch_detects_grok2api_window_error():
    from app.integrations.grok2api.client import is_model_account_bind_mismatch

    matched = IntegrationError(
        "grok2api 返回 HTTP 400: 模型参数无效: 账号 4725 不存在或与模型来源不匹配",
        status_code=400,
        error_code="modelCreateFailed",
    )
    other = IntegrationError(
        "grok2api 返回 HTTP 400: 请求参数无效",
        status_code=400,
        error_code="invalidRequest",
    )
    wrong_status = IntegrationError(
        "账号 4725 不存在或与模型来源不匹配",
        status_code=404,
    )

    assert is_model_account_bind_mismatch(matched) is True
    assert is_model_account_bind_mismatch(other) is False
    assert is_model_account_bind_mismatch(wrong_status) is False
    assert is_model_account_bind_mismatch(RuntimeError("nope")) is False


def test_model_account_bind_window_message_explains_official_grok2api_limit():
    from app.integrations.grok2api.client import model_account_bind_window_message

    pinned = model_account_bind_window_message(4725, verified_account_id=99)
    missing = model_account_bind_window_message(4725, missing_egress=True)

    assert "账号 4725" in pinned
    assert "最新约 1000 个账号" in pinned
    assert "实际命中了账号 99" in pinned
    assert "没有可用出口节点" in missing


@pytest.mark.asyncio
async def test_create_probe_route_omits_account_ids_when_unbound():
    client = Grok2APIClient(Settings())
    captured: dict[str, object] = {}

    async def admin_request(method: str, path: str, **kwargs: object) -> dict[str, str]:
        captured["method"] = method
        captured["path"] = path
        captured["json"] = kwargs["json"]
        return {"id": "9", "publicId": "grokiq-probe-unbound"}

    client.admin_request = admin_request  # type: ignore[method-assign]
    route_id, public_id = await client.create_probe_route(
        account_id=4725,
        upstream_model="grok-4.6",
        bind_account=False,
    )

    body = captured["json"]
    assert captured["method"] == "POST"
    assert captured["path"] == "/api/admin/v1/models"
    assert route_id == "9"
    assert public_id == "grokiq-probe-unbound"
    assert isinstance(body, dict)
    assert "accountIds" not in body
    assert body["upstreamModel"] == "grok-4.6"


@pytest.mark.asyncio
async def test_create_probe_route_binds_account_ids_by_default():
    client = Grok2APIClient(Settings())
    captured: dict[str, object] = {}

    async def admin_request(method: str, path: str, **kwargs: object) -> dict[str, str]:
        captured["json"] = kwargs["json"]
        return {"id": "8", "publicId": "grokiq-probe-bound"}

    client.admin_request = admin_request  # type: ignore[method-assign]
    await client.create_probe_route(account_id=4725, upstream_model="grok-4.6")

    body = captured["json"]
    assert isinstance(body, dict)
    assert body["accountIds"] == ["4725"]
