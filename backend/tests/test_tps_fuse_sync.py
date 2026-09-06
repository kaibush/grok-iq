from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.routing import APIRoute

from app.core.config import Settings
from app.integrations.grok2api.client import IntegrationError
from app.services.request_audit_service import RequestAuditService
from app.services.tps_fuse_sync import (
    TpsFuseSyncService,
    desired_tps_fuse,
    duration_minutes,
    should_sync_runtime_changes,
    tps_fuse_drifted,
    tps_fuse_matches,
)
from app.web.routes.settings import build_settings_router
from app.web.schemas import RuntimeSettingsInput


def configured_settings(**overrides: object) -> Settings:
    settings = Settings(_env_file=None)
    settings.grok2api_admin_username = "admin"
    settings.grok2api_admin_password = "secret"
    for key, value in overrides.items():
        setattr(settings, key, value)
    return settings


def test_desired_tps_fuse_mapping():
    settings = configured_settings(
        request_audit_enabled=True,
        request_audit_risk_enabled=True,
        strong_degradation_tps=300,
        request_audit_tps_only_min_count=4,
        request_audit_tps_cooldown_minutes=10,
        min_generation_ms=250,
        minimum_output_tokens=32,
        media_input_observe_enabled=True,
    )

    assert desired_tps_fuse(settings) == {
        "enabled": True,
        "hardTPS": 300.0,
        "minCount": 4,
        "cooldown": "10m",
        "minGenerationMs": 250,
        "minOutputTokens": 32,
        "skipMediaInput": True,
    }


def test_desired_tps_fuse_enabled_requires_both_switches():
    settings = configured_settings(
        request_audit_enabled=True,
        request_audit_risk_enabled=False,
    )
    assert desired_tps_fuse(settings)["enabled"] is False

    settings.request_audit_enabled = False
    settings.request_audit_risk_enabled = True
    assert desired_tps_fuse(settings)["enabled"] is False


def test_duration_minutes_normalizes_go_style_strings():
    assert duration_minutes("10m") == 10
    assert duration_minutes("10m0s") == 10
    assert duration_minutes("600s") == 10
    assert duration_minutes("1h") == 60
    assert duration_minutes(10) == 10
    assert duration_minutes("10m0s0ms") == 10


def test_tps_fuse_drift_detection_and_tolerance():
    desired = {
        "enabled": True,
        "hardTPS": 300.0,
        "minCount": 2,
        "cooldown": "10m",
        "minGenerationMs": 250,
        "minOutputTokens": 32,
        "skipMediaInput": True,
    }
    matching = {
        **desired,
        "hardTPS": 300.0000004,
        "cooldown": "10m0s",
    }
    drifted = {**desired, "hardTPS": 301.0}

    assert tps_fuse_matches(desired, matching) is True
    assert tps_fuse_drifted(desired, matching) is False
    assert tps_fuse_drifted(desired, drifted) is True
    assert tps_fuse_drifted(desired, None) is True
    assert tps_fuse_drifted(desired, {}) is True


def test_tps_fuse_matches_omitted_false_booleans():
    desired = desired_tps_fuse(
        configured_settings(
            request_audit_enabled=False,
            request_audit_risk_enabled=False,
            strong_degradation_tps=300,
            request_audit_tps_only_min_count=2,
            request_audit_tps_cooldown_minutes=10,
            min_generation_ms=250,
            minimum_output_tokens=32,
            media_input_observe_enabled=False,
        )
    )
    actual = {
        "hardTPS": 300,
        "minCount": 2,
        "cooldown": "10m0s",
        "minGenerationMs": 250,
        "minOutputTokens": 32,
    }

    assert desired["enabled"] is False
    assert desired["skipMediaInput"] is False
    assert tps_fuse_matches(desired, actual) is True


def test_should_sync_runtime_changes_for_mapped_and_credential_fields():
    assert should_sync_runtime_changes(["strong_degradation_tps"]) is True
    assert should_sync_runtime_changes(["request_audit_tps_cooldown_minutes"]) is True
    assert should_sync_runtime_changes(["grok2api_admin_password"]) is True
    assert should_sync_runtime_changes(["risk_fast_weight"]) is False
    assert should_sync_runtime_changes(["request_audit_auto_scan_enabled"]) is False


def build_update_route(
    *,
    changed: list[str],
    tps_fuse_sync: object | None = None,
) -> tuple[object, MagicMock]:
    runtime = MagicMock()
    runtime.update.return_value = changed
    runtime.public_view.return_value = {"ok": True}
    probes = SimpleNamespace(
        thresholds=object(),
        reconfigure=AsyncMock(),
        repository=MagicMock(),
    )
    sync = tps_fuse_sync or MagicMock()
    sync.sync = AsyncMock(return_value={"ok": True, "status": "synced", "error": ""})
    sync.public_view = MagicMock(
        return_value={"ok": True, "status": "idle", "error": ""}
    )
    router = build_settings_router(
        settings=Settings(_env_file=None),
        client=MagicMock(),
        accounts=MagicMock(),
        runtime_settings=runtime,
        probes=probes,  # type: ignore[arg-type]
        scheduler=SimpleNamespace(reconfigure=AsyncMock()),  # type: ignore[arg-type]
        wechat=MagicMock(),
        tps_fuse_sync=sync,  # type: ignore[arg-type]
    )
    route = next(
        item
        for item in router.routes
        if isinstance(item, APIRoute)
        and item.path == "/settings"
        and "PUT" in item.methods
    )
    return route.endpoint, sync


@pytest.mark.asyncio
async def test_settings_update_syncs_mapped_fields_only():
    mapped_endpoint, mapped_sync = build_update_route(
        changed=["strong_degradation_tps"]
    )
    mapped_sync.sync = AsyncMock(
        return_value={"ok": True, "status": "synced", "error": ""}
    )

    mapped = await mapped_endpoint(RuntimeSettingsInput(strongDegradationTps=300))

    mapped_sync.sync.assert_awaited_once_with(trigger="settings")
    assert mapped["tpsFuseSync"]["ok"] is True
    assert mapped["changed"] == ["strong_degradation_tps"]

    unrelated_endpoint, unrelated_sync = build_update_route(
        changed=["risk_fast_weight"]
    )
    unrelated_sync.sync = AsyncMock(
        return_value={"ok": True, "status": "synced", "error": ""}
    )

    unrelated = await unrelated_endpoint(RuntimeSettingsInput(riskFastWeight=20))

    unrelated_sync.sync.assert_not_awaited()
    assert unrelated["changed"] == ["risk_fast_weight"]
    assert unrelated["tpsFuseSync"]["status"] == "idle"


@pytest.mark.asyncio
async def test_settings_update_records_sync_failure_without_raising():
    endpoint, sync = build_update_route(changed=["min_generation_ms"])
    sync.sync = AsyncMock(side_effect=RuntimeError("upstream down"))

    result = await endpoint(RuntimeSettingsInput(minGenerationMs=400))

    assert result["changed"] == ["min_generation_ms"]
    assert result["tpsFuseSync"] == {
        "ok": False,
        "status": "failed",
        "error": "upstream down",
    }


@pytest.mark.asyncio
async def test_sync_retries_conflict_then_succeeds():
    settings = configured_settings(strong_degradation_tps=300)
    desired = desired_tps_fuse(settings)
    drifted = {**desired, "hardTPS": 1.0}
    client = MagicMock()
    client.get_admin_settings = AsyncMock(
        side_effect=[
            {"revision": "1", "config": {"tpsFuse": drifted}},
            {"revision": "2", "config": {"tpsFuse": drifted}},
        ]
    )
    client.update_admin_settings = AsyncMock(
        side_effect=[
            IntegrationError(
                "conflict",
                status_code=409,
                error_code="settingsConflict",
            ),
            {"revision": "3", "config": {"tpsFuse": desired}},
        ]
    )
    service = TpsFuseSyncService(client, settings)

    result = await service.sync(trigger="settings")

    assert result["ok"] is True
    assert result["status"] == "synced"
    assert client.get_admin_settings.await_count == 2
    assert client.update_admin_settings.await_count == 2
    client.update_admin_settings.assert_any_await("1", {"tpsFuse": desired})
    client.update_admin_settings.assert_any_await("2", {"tpsFuse": desired})


@pytest.mark.asyncio
async def test_scan_sync_reports_drift_push_and_skips_matching_config():
    settings = configured_settings(request_audit_tps_cooldown_minutes=10)
    desired = desired_tps_fuse(settings)
    client = MagicMock()
    current = {
        "routing": {"stickyTTL": "30m", "cooldownBase": "2s"},
        "tpsFuse": {**desired, "cooldown": "9m"},
    }
    client.get_admin_settings = AsyncMock(
        return_value={"revision": "4", "config": current}
    )
    client.update_admin_settings = AsyncMock(return_value={"revision": "5"})
    service = TpsFuseSyncService(client, settings)

    drifted = await service.sync(trigger="scheduled")

    assert drifted == {"ok": True, "status": "drift_pushed", "error": ""}
    client.update_admin_settings.assert_awaited_once_with(
        "4",
        {
            "routing": {"stickyTTL": "30m", "cooldownBase": "2s"},
            "tpsFuse": desired,
        },
    )

    client.get_admin_settings = AsyncMock(
        return_value={"revision": "5", "config": {"tpsFuse": {**desired, "cooldown": "10m0s"}}}
    )
    client.update_admin_settings.reset_mock()
    matched = await service.sync(trigger="scheduled")
    assert matched["status"] == "synced"
    client.update_admin_settings.assert_not_awaited()


@pytest.mark.asyncio
async def test_scheduled_sync_skips_old_gateway_without_tps_fuse():
    settings = configured_settings()
    client = MagicMock()
    client.get_admin_settings = AsyncMock(
        return_value={"revision": "6", "config": {"routing": {"stickyTTL": "30m"}}}
    )
    client.update_admin_settings = AsyncMock()
    service = TpsFuseSyncService(client, settings)

    result = await service.sync(trigger="scheduled")

    assert result["ok"] is True
    assert result["status"] == "unsupported"
    client.update_admin_settings.assert_not_awaited()


@pytest.mark.asyncio
async def test_sync_client_error_does_not_raise():
    settings = configured_settings()
    client = MagicMock()
    client.get_admin_settings = AsyncMock(side_effect=IntegrationError("offline"))
    service = TpsFuseSyncService(client, settings)

    result = await service.sync(trigger="settings")

    assert result["ok"] is False
    assert result["status"] == "failed"
    assert "offline" in result["error"]


@pytest.mark.asyncio
async def test_request_audit_sync_failure_does_not_raise():
    sync = MagicMock()
    sync.sync = AsyncMock(side_effect=RuntimeError("boom"))
    service = RequestAuditService(
        settings=Settings(_env_file=None),
        client=MagicMock(),
        repository=MagicMock(),
        tps_fuse_sync=sync,
    )

    await service._sync_tps_fuse(trigger="scheduled")

    sync.sync.assert_awaited_once_with(trigger="scheduled")
