import asyncio
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from app.core.config import Settings
from app.integrations.grok2api.client import Grok2APIClient, IntegrationError
from app.persistence.database import Database
from app.persistence.models import ProbeProfile
from app.persistence.probe_repository import ProbeRepository
from app.persistence.seeds import DEFAULT_PROFILES
from app.web.schemas import ProfileInput


class StubStreamResponse:
    status_code = 200
    headers: dict[str, str] = {}

    async def aiter_content(self, *args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        yield b'data: {"type":"response.output_text.delta","delta":"OK"}\n\n'
        yield (
            b'data: {"type":"response.completed","response":{"usage":{"output_tokens":1,'
            b'"output_tokens_details":{"reasoning_tokens":0}}}}\n\n'
        )

    async def aclose(self) -> None:
        return None


class ReasoningStreamResponse(StubStreamResponse):
    async def aiter_content(self, *args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        yield (
            'data: {"type":"response.reasoning_text.delta",'
            '"delta":"\u5148\u5206\u6790\u9898\u76ee"}\n\n'
        ).encode()
        yield b'data: {"type":"response.output_text.delta","delta":"OK"}\n\n'
        yield (
            b'data: {"type":"response.completed","response":{"usage":{"output_tokens":8,'
            b'"output_tokens_details":{"reasoning_tokens":5}}}}\n\n'
        )


class ReasoningCompletedStreamResponse(StubStreamResponse):
    async def aiter_content(self, *args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        yield b'data: {"type":"response.output_text.delta","delta":"OK"}\n\n'
        payload = {
            "type": "response.completed",
            "response": {
                "usage": {
                    "output_tokens": 8,
                    "output_tokens_details": {"reasoning_tokens": 5},
                },
                "output": [
                    {
                        "type": "reasoning",
                        "summary": [{"type": "summary_text", "text": "先分析题目"}],
                    }
                ],
            },
        }
        yield f"data: {__import__('json').dumps(payload, ensure_ascii=False)}\n\n".encode()


class ReasoningSummaryDeltaStreamResponse(StubStreamResponse):
    async def aiter_content(self, *args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        yield (
            'data: {"type":"response.reasoning_summary_text.delta",'
            '"delta":"先分析题目"}\n\n'
        ).encode()
        yield b'data: {"type":"response.output_text.delta","delta":"OK"}\n\n'
        yield (
            b'data: {"type":"response.completed","response":{"usage":{"output_tokens":8,'
            b'"output_tokens_details":{"reasoning_tokens":5}}}}\n\n'
        )


class ReasoningSummaryDoneStreamResponse(StubStreamResponse):
    async def aiter_content(self, *args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        yield (
            'data: {"type":"response.reasoning_summary_text.done",'
            '"text":"先分析题目"}\n\n'
        ).encode()
        yield b'data: {"type":"response.output_text.delta","delta":"OK"}\n\n'
        yield (
            b'data: {"type":"response.completed","response":{"usage":{"output_tokens":8,'
            b'"output_tokens_details":{"reasoning_tokens":5}}}}\n\n'
        )


class HangingAfterCompleteResponse:
    status_code = 200
    headers: dict[str, str] = {}

    def __init__(self) -> None:
        self.quit_now = MagicMock()
        self.curl = MagicMock()
        self.astream_task = None

    async def aiter_content(self, *args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        yield b'data: {"type":"response.output_text.delta","delta":"OK"}\n\n'
        yield (
            b'data: {"type":"response.completed","response":{"usage":{"output_tokens":1,'
            b'"output_tokens_details":{"reasoning_tokens":0}}}}\n\n'
        )
        await asyncio.sleep(30)

    async def aclose(self) -> None:
        await asyncio.sleep(30)


class StubStreamSession:
    def __init__(self, request_body: dict[str, Any]):
        self.request_body = request_body
        self.url = ""

    async def __aenter__(self):  # type: ignore[no-untyped-def]
        return self

    async def __aexit__(self, *_: Any):  # type: ignore[no-untyped-def]
        return None

    async def post(self, url: str, *, json: dict[str, Any], **kwargs: Any):
        self.url = url
        self.request_body.update(json)
        self.request_body["_url"] = url
        self.request_body["_headers"] = dict(kwargs.get("headers") or {})
        return StubStreamResponse()


def test_profile_input_follows_upstream_output_limit_by_default():
    profile = ProfileInput(name="probe", model="model", prompt="prompt")

    assert profile.max_output_tokens == 0


def test_profile_source_distinguishes_built_in_and_custom(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = ProbeRepository(database)
    repository.seed_defaults()

    custom_id = repository.create_profile(
        {"name": "custom", "model": "grok-4.5", "prompt": "prompt"}
    )
    profiles = {profile["id"]: profile for profile in repository.list_profiles()}

    assert profiles["quality-marker"]["built_in"] is True
    assert profiles[custom_id]["built_in"] is False


def test_default_profiles_migrate_to_follow_upstream_once(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    legacy_limits = {values["id"]: 256 for values in DEFAULT_PROFILES}
    legacy_limits["html-preview"] = 4096
    with database.transaction() as session:
        for values in DEFAULT_PROFILES:
            session.add(ProbeProfile(**(values | {"max_output_tokens": legacy_limits[values["id"]]})))

    repository = ProbeRepository(database)
    repository.seed_defaults()

    profiles = {profile["id"]: profile for profile in repository.list_profiles()}
    assert all(profiles[profile_id]["max_output_tokens"] == 0 for profile_id in legacy_limits)

    repository.update_profile("html-preview", {"max_output_tokens": 8192})
    repository.seed_defaults()

    assert repository.get_profile("html-preview")["max_output_tokens"] == 8192


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("max_output_tokens", "expected"),
    [(0, None), (2048, 2048)],
)
async def test_chat_probe_only_sends_explicit_output_limit(
    monkeypatch: pytest.MonkeyPatch,
    max_output_tokens: int,
    expected: int | None,
):
    request_body: dict[str, Any] = {}
    client = Grok2APIClient(Settings())
    monkeypatch.setattr(client, "_session", lambda: StubStreamSession(request_body))

    async def find_audit(_: str) -> dict[str, Any]:
        return {"id": "1", "accountId": "7", "egressNodeId": "2"}

    monkeypatch.setattr(client, "find_audit", find_audit)

    await client.chat_probe(
        api_key="key",
        public_model="model",
        account_id=7,
        system_prompt="",
        prompt="prompt",
        expected="OK",
        max_output_tokens=max_output_tokens,
        temperature=None,
        extra_body={},
    )

    assert request_body.get("_url", "").endswith("/v1/responses")
    assert request_body.get("input") == [{"role": "user", "content": "prompt"}]
    assert request_body.get("store") is False
    assert request_body.get("reasoning") == {"summary": "auto"}
    assert "X-Thread-ID" not in request_body.get("_headers", {})
    assert "messages" not in request_body
    assert "max_tokens" not in request_body
    assert request_body.get("max_output_tokens") == expected


@pytest.mark.asyncio
async def test_chat_probe_keeps_explicit_store_and_reasoning(
    monkeypatch: pytest.MonkeyPatch,
):
    request_body: dict[str, Any] = {}
    client = Grok2APIClient(Settings())
    monkeypatch.setattr(client, "_session", lambda: StubStreamSession(request_body))

    async def find_audit(_: str) -> dict[str, Any]:
        return {"id": "1", "accountId": "7", "egressNodeId": "2"}

    monkeypatch.setattr(client, "find_audit", find_audit)

    await client.chat_probe(
        api_key="key",
        public_model="model",
        account_id=7,
        system_prompt="",
        prompt="prompt",
        expected="OK",
        max_output_tokens=0,
        temperature=None,
        extra_body={"store": True, "reasoning": {"effort": "high"}},
    )

    assert request_body.get("store") is True
    assert request_body.get("reasoning") == {"effort": "high"}


@pytest.mark.asyncio
async def test_chat_probe_finishes_when_upstream_hangs_after_completed(
    monkeypatch: pytest.MonkeyPatch,
):
    request_body: dict[str, Any] = {}

    class HangingSession(StubStreamSession):
        async def post(self, url: str, *, json: dict[str, Any], **kwargs: Any):
            await super().post(url, json=json, **kwargs)
            return HangingAfterCompleteResponse()

    client = Grok2APIClient(Settings())
    monkeypatch.setattr(client, "_session", lambda: HangingSession(request_body))

    async def find_audit(_: str) -> dict[str, Any]:
        return {"id": "1", "accountId": "7", "egressNodeId": "2"}

    monkeypatch.setattr(client, "find_audit", find_audit)

    result = await asyncio.wait_for(
        client.chat_probe(
            api_key="key",
            public_model="model",
            account_id=7,
            system_prompt="",
            prompt="prompt",
            expected="OK",
            max_output_tokens=0,
            temperature=None,
            extra_body={},
        ),
        timeout=2,
    )

    assert result.response_text == "OK"
    assert result.expected_matched is True


@pytest.mark.asyncio
async def test_chat_probe_keeps_response_evidence_when_audit_hits_wrong_account(
    monkeypatch: pytest.MonkeyPatch,
):
    request_body: dict[str, Any] = {}
    client = Grok2APIClient(Settings())
    monkeypatch.setattr(client, "_session", lambda: StubStreamSession(request_body))

    async def find_audit(_: str) -> dict[str, Any]:
        return {"id": "9", "accountId": "8", "egressNodeId": "2"}

    monkeypatch.setattr(client, "find_audit", find_audit)

    with pytest.raises(IntegrationError, match="实际命中账号 8") as caught:
        await client.chat_probe(
            api_key="key",
            public_model="model",
            account_id=7,
            system_prompt="",
            prompt="prompt",
            expected="OK",
            max_output_tokens=0,
            temperature=None,
            extra_body={},
        )

    error = caught.value
    result = error.probe_result
    assert error.request_id == result.request_id
    assert error.audit_id == 9
    assert error.verified_account_id == 8
    assert error.verified_egress_node_id == 2
    assert result.response_text == "OK"
    assert result.output_tokens == 1


@pytest.mark.asyncio
async def test_chat_probe_keeps_reasoning_text_with_response(
    monkeypatch: pytest.MonkeyPatch,
):
    request_body: dict[str, Any] = {}

    class ReasoningSession(StubStreamSession):
        async def post(self, url: str, *, json: dict[str, Any], **kwargs: Any):
            await super().post(url, json=json, **kwargs)
            return ReasoningStreamResponse()

    client = Grok2APIClient(Settings())
    monkeypatch.setattr(client, "_session", lambda: ReasoningSession(request_body))

    async def find_audit(_: str) -> dict[str, Any]:
        return {"id": "1", "accountId": "7", "egressNodeId": "2"}

    monkeypatch.setattr(client, "find_audit", find_audit)

    result = await client.chat_probe(
        api_key="key",
        public_model="model",
        account_id=7,
        system_prompt="",
        prompt="prompt",
        expected="OK",
        max_output_tokens=0,
        temperature=None,
        extra_body={},
    )

    assert result.response_text == "OK"
    assert result.reasoning_text == "先分析题目"
    assert result.reasoning_tokens == 5


async def _run_chat_probe(monkeypatch: pytest.MonkeyPatch, response_cls: type) -> Any:
    request_body: dict[str, Any] = {}

    class Session(StubStreamSession):
        async def post(self, url: str, *, json: dict[str, Any], **kwargs: Any):
            await super().post(url, json=json, **kwargs)
            return response_cls()

    client = Grok2APIClient(Settings())
    monkeypatch.setattr(client, "_session", lambda: Session(request_body))

    async def find_audit(_: str) -> dict[str, Any]:
        return {"id": "1", "accountId": "7", "egressNodeId": "2"}

    monkeypatch.setattr(client, "find_audit", find_audit)
    return await client.chat_probe(
        api_key="key",
        public_model="model",
        account_id=7,
        system_prompt="",
        prompt="prompt",
        expected="OK",
        max_output_tokens=0,
        temperature=None,
        extra_body={},
    )


@pytest.mark.asyncio
async def test_chat_probe_keeps_reasoning_from_completed_output(
    monkeypatch: pytest.MonkeyPatch,
):
    result = await _run_chat_probe(monkeypatch, ReasoningCompletedStreamResponse)
    assert result.response_text == "OK"
    assert result.reasoning_text == "先分析题目"


@pytest.mark.asyncio
async def test_chat_probe_keeps_reasoning_from_summary_done(
    monkeypatch: pytest.MonkeyPatch,
):
    result = await _run_chat_probe(monkeypatch, ReasoningSummaryDoneStreamResponse)
    assert result.response_text == "OK"
    assert result.reasoning_text == "先分析题目"


@pytest.mark.asyncio
async def test_chat_probe_keeps_reasoning_summary_text_delta(
    monkeypatch: pytest.MonkeyPatch,
):
    result = await _run_chat_probe(
        monkeypatch, ReasoningSummaryDeltaStreamResponse
    )
    assert result.response_text == "OK"
    assert result.reasoning_text == "先分析题目"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("max_output_tokens", "expected"),
    [(0, None), (1024, 1024)],
)
async def test_quality_probe_only_sends_explicit_output_limit(
    monkeypatch: pytest.MonkeyPatch,
    max_output_tokens: int,
    expected: int | None,
):
    request_body: dict[str, Any] = {}
    client = Grok2APIClient(Settings())

    async def admin_request(_: str, __: str, **kwargs: Any) -> dict[str, Any]:
        request_body.update(kwargs["json"])
        return {
            "requestId": "request-1",
            "statusCode": 200,
            "durationMs": 1000,
            "firstTokenMs": 100,
            "generationMs": 900,
            "outputTokens": 100,
            "reasoningTokens": 20,
            "visibleTokens": 80,
            "expectedMatched": True,
        }

    async def find_audit(_: str) -> dict[str, Any]:
        return {"id": "1", "accountId": "7", "egressNodeId": "2"}

    monkeypatch.setattr(client, "admin_request", admin_request)
    monkeypatch.setattr(client, "find_audit", find_audit)

    await client.quality_probe(
        client_key_id="3",
        public_model="model",
        account_id=7,
        egress_node_id=2,
        prompt="prompt",
        expected="OK",
        max_output_tokens=max_output_tokens,
    )

    assert request_body.get("maxOutputTokens") == expected
    assert "accountId" not in request_body


@pytest.mark.asyncio
async def test_quality_probe_sends_account_id_only_when_pinning(
    monkeypatch: pytest.MonkeyPatch,
):
    request_body: dict[str, Any] = {}
    client = Grok2APIClient(Settings())

    async def admin_request(_: str, __: str, **kwargs: Any) -> dict[str, Any]:
        request_body.update(kwargs["json"])
        return {
            "requestId": "request-2",
            "statusCode": 200,
            "durationMs": 1000,
            "firstTokenMs": 100,
            "generationMs": 900,
            "outputTokens": 100,
            "reasoningTokens": 20,
            "visibleTokens": 80,
            "expectedMatched": True,
        }

    async def find_audit(_: str) -> dict[str, Any]:
        return {"id": "1", "accountId": "7", "egressNodeId": "2"}

    monkeypatch.setattr(client, "admin_request", admin_request)
    monkeypatch.setattr(client, "find_audit", find_audit)

    result = await client.quality_probe(
        client_key_id="3",
        public_model="model",
        account_id=7,
        egress_node_id=2,
        prompt="prompt",
        expected="OK",
        max_output_tokens=0,
        pin_account=True,
    )

    assert request_body.get("accountId") == "7"
    assert result.usage["account_bind_skipped"] is True
    assert result.usage["quality_test"] is True


@pytest.mark.asyncio
async def test_quality_probe_pin_mismatch_explains_bind_window(
    monkeypatch: pytest.MonkeyPatch,
):
    client = Grok2APIClient(Settings())

    async def admin_request(_: str, __: str, **kwargs: Any) -> dict[str, Any]:
        return {
            "requestId": "request-3",
            "statusCode": 200,
            "durationMs": 1000,
            "firstTokenMs": 100,
            "generationMs": 900,
            "outputTokens": 100,
            "reasoningTokens": 20,
            "visibleTokens": 80,
            "expectedMatched": True,
        }

    async def find_audit(_: str) -> dict[str, Any]:
        return {"id": "1", "accountId": "99", "egressNodeId": "2"}

    monkeypatch.setattr(client, "admin_request", admin_request)
    monkeypatch.setattr(client, "find_audit", find_audit)

    with pytest.raises(IntegrationError) as exc_info:
        await client.quality_probe(
            client_key_id="3",
            public_model="model",
            account_id=7,
            egress_node_id=2,
            prompt="prompt",
            expected="OK",
            max_output_tokens=0,
            pin_account=True,
        )

    error = exc_info.value
    assert error.error_code == "modelBindWindow"
    assert "账号 7" in str(error)
    assert "最新约 1000 个账号" in str(error)
    assert "实际命中了账号 99" in str(error)
    assert "批量设置出口" in str(error)


@pytest.mark.asyncio
async def test_quality_guard_probe_pins_account_and_verifies_audit(
    monkeypatch: pytest.MonkeyPatch,
):
    client = Grok2APIClient(Settings())
    captured: dict[str, Any] = {}

    async def admin_request(method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        captured["method"] = method
        captured["path"] = path
        captured["json"] = kwargs["json"]
        return {
            "requestId": "guard-1",
            "statusCode": 200,
            "durationMs": 1200,
            "firstTokenMs": 300,
            "generationMs": 900,
            "outputTokens": 80,
            "reasoningTokens": 12,
            "visibleTokens": 68,
            "expectedMatched": True,
            "outputTokensPerSecond": 66.6,
        }

    async def find_audit(_: str) -> dict[str, Any]:
        return {"id": "3", "accountId": "4725", "egressNodeId": "110"}

    monkeypatch.setattr(client, "admin_request", admin_request)
    monkeypatch.setattr(client, "find_audit", find_audit)

    result = await client.quality_guard_probe(account_id=4725, egress_node_id=110)

    assert captured["method"] == "POST"
    assert captured["path"] == (
        "/api/admin/v1/egress-quality-guard/nodes/110/test"
    )
    assert captured["json"] == {"accountId": "4725"}
    assert result.request_id == "guard-1"
    assert result.verified_account_id == 4725
    assert result.verified_egress_node_id == 110
    assert result.usage["quality_guard"] is True
    assert result.usage["account_bind_skipped"] is True


@pytest.mark.asyncio
async def test_quality_guard_probe_unavailable_explains_enable_steps(
    monkeypatch: pytest.MonkeyPatch,
):
    client = Grok2APIClient(Settings())

    async def admin_request(*_: Any, **__: Any) -> dict[str, Any]:
        raise IntegrationError(
            "grok2api 返回 HTTP 503: 质量守护配置暂不可用",
            status_code=503,
            error_code="qualityGuardUnavailable",
        )

    monkeypatch.setattr(client, "admin_request", admin_request)

    with pytest.raises(IntegrationError) as exc_info:
        await client.quality_guard_probe(account_id=4725, egress_node_id=110)

    error = exc_info.value
    assert error.status_code == 503
    assert error.error_code == "modelBindWindow"
    assert "质量守护未开启" in str(error)
    assert "批量设置出口" in str(error)
    assert "qualityGuard.enabled: true" in str(error)
    assert "sidecar 容器可以不启动" in str(error)
