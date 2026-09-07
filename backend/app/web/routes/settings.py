from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Response

from app.core.config import Settings
from app.integrations.grok2api.client import Grok2APIClient
from app.persistence.account_repository import AccountRepository
from app.services.probe_manager import ProbeManager
from app.services.scheduler import SchedulerService
from app.services.settings_service import RuntimeSettingsService
from app.services.tps_fuse_sync import TpsFuseSyncService, should_sync_runtime_changes
from app.services.wechat_notification import WeChatAccountNotificationService
from app.web.schemas import OnboardingCompleteInput, RuntimeSettingsInput, WechatTestInput

from ._shared import disable_client_cache


def build_settings_router(
    *,
    settings: Settings,
    client: Grok2APIClient,
    accounts: AccountRepository,
    runtime_settings: RuntimeSettingsService,
    probes: ProbeManager,
    scheduler: SchedulerService,
    wechat: WeChatAccountNotificationService,
    tps_fuse_sync: TpsFuseSyncService | None = None,
) -> APIRouter:
    router = APIRouter()
    tps_fuse = tps_fuse_sync or TpsFuseSyncService(client, settings)

    def settings_payload(**extra: Any) -> dict[str, Any]:
        return {**runtime_settings.public_view(), "tpsFuseSync": tps_fuse.public_view(), **extra}

    @router.get("/settings")
    def get_runtime_settings() -> dict[str, Any]:
        return settings_payload()

    @router.get("/onboarding")
    def get_onboarding() -> dict[str, Any]:
        return runtime_settings.onboarding_view()

    @router.get("/settings/secrets/{secret_name}")
    def reveal_runtime_secret(
        secret_name: str,
        response: Response,
    ) -> dict[str, str]:
        disable_client_cache(response)
        return {"value": runtime_settings.reveal_secret(secret_name)}

    @router.put("/settings")
    async def update_runtime_settings(
        payload: RuntimeSettingsInput,
    ) -> dict[str, Any]:
        changed = runtime_settings.update(payload.runtime_changes())
        if any(key.startswith("grok2api_") for key in changed):
            client.reset_credentials()
        if any(key.startswith("wechat_") for key in changed):
            wechat.reset_credentials()
        await probes.reconfigure()
        risk_fields = {
            "analysis_window_hours",
            "degradation_tps",
            "strong_degradation_tps",
            "probe_tps_override_enabled",
            "probe_tps_override_mode",
            "probe_tps_override_min_first_token_ms",
            "probe_tps_override_max_generation_ms",
            "consecutive_anomalies",
            "cumulative_anomaly_rate",
            "high_risk_hard_count",
            "risk_anomaly_rate_weight",
            "risk_hard_weight",
            "risk_hard_cap",
            "risk_fast_weight",
            "risk_fast_cap",
            "risk_marker_miss_weight",
            "risk_marker_miss_cap",
            "risk_streak_weight",
            "risk_streak_cap",
            "risk_score_cap",
            "risk_watch_floor",
            "risk_suspect_floor",
            "risk_high_floor",
            "buffer_first_token_share",
            "min_generation_ms",
            "minimum_output_tokens",
            "reasoning_zero_risk_enabled",
            "reasoning_model_policies",
            "media_input_observe_enabled",
            "risk_rule_overrides",
        }
        if risk_fields.intersection(changed):
            accounts.recalculate_all(
                probes.thresholds,
                settings.analysis_window_hours,
            )
            probes.repository.refresh_all_run_summaries()
        await scheduler.reconfigure()
        if should_sync_runtime_changes(changed):
            try:
                tps_fuse_result = await tps_fuse.sync(trigger="settings")
            except Exception as exc:
                tps_fuse_result = {
                    "ok": False,
                    "status": "failed",
                    "error": str(exc),
                }
            return {
                **runtime_settings.public_view(),
                "changed": changed,
                "tpsFuseSync": tps_fuse_result,
            }
        return settings_payload(changed=changed)

    @router.post("/settings/test-grok2api")
    async def test_grok2api_settings() -> dict[str, Any]:
        client.reset_credentials()
        summary = await client.admin_request(
            "GET", "/api/admin/v1/accounts/summary"
        )
        return {
            "ok": True,
            "baseUrl": settings.grok2api_base_url,
            "grokBuild": summary.get("providers", {}).get("grok_build", {}),
        }

    @router.post("/onboarding/complete")
    async def complete_onboarding(
        payload: OnboardingCompleteInput,
    ) -> dict[str, Any]:
        changed = runtime_settings.update(payload.runtime_changes())
        if any(key.startswith("grok2api_") for key in changed):
            client.reset_credentials()
        await probes.reconfigure()
        if "analysis_window_hours" in changed:
            accounts.recalculate_all(
                probes.thresholds,
                settings.analysis_window_hours,
            )
        await scheduler.reconfigure()
        state = runtime_settings.onboarding_view()
        if not state["ready"]:
            raise ValueError("请先补全 grok2api 地址、管理员用户名和密码")
        summary = await client.admin_request(
            "GET", "/api/admin/v1/accounts/summary"
        )
        completed = runtime_settings.complete_onboarding()
        return {
            **completed,
            "settings": runtime_settings.public_view(),
            "connection": {
                "ok": True,
                "baseUrl": settings.grok2api_base_url,
                "grokBuild": summary.get("providers", {}).get("grok_build", {}),
            },
        }

    @router.post("/settings/test-wechat")
    async def test_wechat_settings(
        payload: WechatTestInput | None = None,
    ) -> dict[str, Any]:
        scenario = (payload or WechatTestInput()).scenario
        result = await wechat.send_test(scenario)
        return {"ok": True, **result}

    return router
