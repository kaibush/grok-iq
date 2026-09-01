from __future__ import annotations

from typing import Any

from app.analyzer import risk_rule_definitions, risk_rule_enabled, thresholds_from_settings
from app.core.config import (
    DEFAULT_REGISTER_PROBE_PROFILE_IDS,
    REGISTER_PROBE_EXECUTION_MODE,
    REGISTER_PROBE_PROXY_TARGETS,
    Settings,
    normalize_probe_tps_override_mode,
)
from app.persistence.settings_repository import SettingsRepository
from app.services.runtime_settings_validator import RuntimeSettingsValidator

REGISTER_FIXED_STRATEGY_MIGRATION_KEY = "register_probe_fixed_strategy_v2"
PROBE_TPS_OVERRIDE_DEFAULT_MODE_KEY = "probe_tps_override_missing_reasoning_default_v1"
INITIAL_ONBOARDING_COMPLETED_KEY = "initial_onboarding_completed_v1"
RISK_RULE_SWITCH_FIELDS = {
    "reasoning_zero": "reasoning_zero_risk_enabled",
    "media_input_observe": "media_input_observe_enabled",
}


def fixed_register_probe_strategy() -> dict[str, Any]:
    return {
        "register_probe_execution_mode": REGISTER_PROBE_EXECUTION_MODE,
        "register_probe_proxy_targets": [
            dict(target) for target in REGISTER_PROBE_PROXY_TARGETS
        ],
    }


class RuntimeSettingsService:
    """Validates, persists, masks, and hot-applies operator settings."""

    _validator = RuntimeSettingsValidator()

    def __init__(self, settings: Settings, repository: SettingsRepository):
        self.settings = settings
        self.repository = repository

    def load(self) -> None:
        overrides = self.repository.load()
        if not self.repository.migration_applied(
            REGISTER_FIXED_STRATEGY_MIGRATION_KEY
        ):
            migrated = {
                "initial_probe_on_register": True,
                **fixed_register_probe_strategy(),
            }
            profiles = overrides.get("register_probe_profile_ids")
            if not isinstance(profiles, list) or not any(
                str(profile or "").strip() for profile in profiles
            ):
                migrated["register_probe_profile_ids"] = list(
                    DEFAULT_REGISTER_PROBE_PROFILE_IDS
                )
            overrides.update(migrated)
            self.repository.save(migrated)
            self.repository.mark_migration_applied(
                REGISTER_FIXED_STRATEGY_MIGRATION_KEY
            )
        if not self.repository.migration_applied(
            PROBE_TPS_OVERRIDE_DEFAULT_MODE_KEY
        ):
            if "probe_tps_override_mode" not in overrides:
                if overrides.get("probe_tps_override_enabled") is True:
                    migrated = {
                        "probe_tps_override_mode": "generation_window",
                        "probe_tps_override_enabled": True,
                    }
                else:
                    migrated = {
                        "probe_tps_override_mode": "missing_reasoning",
                        "probe_tps_override_enabled": True,
                    }
                overrides.update(migrated)
                self.repository.save(migrated)
            self.repository.mark_migration_applied(
                PROBE_TPS_OVERRIDE_DEFAULT_MODE_KEY
            )
        if not overrides:
            return
        synchronized = self._synchronize_risk_rule_switches(dict(overrides))
        synchronized = self._synchronize_probe_tps_override(synchronized)
        if synchronized != overrides:
            self.repository.save(
                {
                    key: value
                    for key, value in synchronized.items()
                    if key in Settings.RUNTIME_FIELDS
                }
            )
            overrides = synchronized
        candidate = self._validate(self.settings.model_dump() | overrides)
        self.settings.apply_runtime(candidate)

    def update(self, values: dict[str, Any]) -> list[str]:
        changes = {
            key: value for key, value in values.items() if key in Settings.RUNTIME_FIELDS
        }
        if not changes:
            return []
        changes = self._synchronize_risk_rule_switches(changes)
        changes = self._synchronize_probe_tps_override(changes)
        candidate = self._validate(self.settings.model_dump() | changes)
        normalized = {key: getattr(candidate, key) for key in changes}
        self.repository.save(normalized)
        self.settings.apply_runtime(candidate)
        return sorted(normalized)

    def _synchronize_risk_rule_switches(
        self,
        changes: dict[str, Any],
    ) -> dict[str, Any]:
        """Keep dedicated switches and registry overrides as one setting.

        The request-audit workspace exposes compact dedicated switches while
        the global risk settings page edits the extensible rule registry.  A
        change from either UI must therefore update both representations;
        otherwise one page could show a rule as enabled while evaluation uses
        the value saved by the other page.
        """

        explicit_keys = set(changes)
        overrides_changed = "risk_rule_overrides" in explicit_keys
        raw_overrides = changes.get(
            "risk_rule_overrides",
            self.settings.risk_rule_overrides,
        )
        if not isinstance(raw_overrides, list) or not all(
            isinstance(item, dict) for item in raw_overrides
        ):
            return changes
        overrides = [dict(item) for item in raw_overrides]
        override_values = {
            str(item.get("id") or item.get("ruleId") or "").strip(): item
            for item in overrides
        }
        overrides_modified = False

        for rule_id, field_name in RISK_RULE_SWITCH_FIELDS.items():
            if field_name in explicit_keys:
                enabled = bool(changes[field_name])
                current = override_values.get(rule_id)
                if current is None:
                    current = {"id": rule_id, "enabled": enabled}
                    overrides.append(current)
                    override_values[rule_id] = current
                    overrides_modified = True
                elif current.get("enabled") != enabled:
                    current["enabled"] = enabled
                    overrides_modified = True
                continue
            if not overrides_changed:
                continue
            current = override_values.get(rule_id)
            if current is not None and "enabled" in current:
                changes[field_name] = bool(current["enabled"])

        if overrides_modified:
            changes["risk_rule_overrides"] = overrides
        return changes

    def _synchronize_probe_tps_override(
        self,
        changes: dict[str, Any],
    ) -> dict[str, Any]:
        mode_present = "probe_tps_override_mode" in changes
        enabled_present = "probe_tps_override_enabled" in changes
        if not mode_present and not enabled_present:
            return changes
        if mode_present:
            enabled = bool(
                changes.get(
                    "probe_tps_override_enabled",
                    self.settings.probe_tps_override_enabled,
                )
            )
            mode = normalize_probe_tps_override_mode(
                str(changes.get("probe_tps_override_mode") or ""),
                enabled=enabled,
            )
            changes["probe_tps_override_mode"] = mode
            changes["probe_tps_override_enabled"] = mode != "off"
            return changes
        enabled = bool(changes.get("probe_tps_override_enabled", False))
        changes["probe_tps_override_mode"] = (
            "generation_window" if enabled else "off"
        )
        changes["probe_tps_override_enabled"] = enabled
        return changes

    @classmethod
    def _validate(cls, values: dict[str, Any]) -> Settings:
        return cls._validator.validate(values, fixed_register_probe_strategy())

    def public_view(self) -> dict[str, Any]:
        s = self.settings
        risk_thresholds = thresholds_from_settings(s)
        return {
            "grok2apiBaseUrl": s.grok2api_base_url,
            "grok2apiAdminUsername": s.grok2api_admin_username,
            "grok2apiAdminPasswordConfigured": bool(s.grok2api_admin_password),
            "grok2apiHttpImpersonate": s.grok2api_http_impersonate,
            "grokRegisterWebhookTokenConfigured": bool(s.grok_register_webhook_token),
            "ssoProxyConfigured": bool(s.sso_proxy),
            "initialProbeOnRegister": s.initial_probe_on_register,
            "registerProbeStabilizationSeconds": (
                s.register_probe_stabilization_seconds
            ),
            "registerProbeProfileIds": s.register_probe_profile_ids,
            "registerProbeExecutionMode": s.register_probe_execution_mode,
            "registerProbeRounds": s.register_probe_rounds,
            "registerProbeProfileRounds": s.register_probe_rounds_by_profile(),
            "registerProbeProxyTargets": s.register_probe_proxy_targets,
            "registerProbeSwitchOnDegradation": s.register_probe_switch_on_degradation,
            "registerPriorityHoldEnabled": s.register_priority_hold_enabled,
            "registerPriorityHold": s.register_priority_hold,
            "registerCallbackEnabled": s.register_callback_enabled,
            "registerCallbackUrl": s.register_callback_url,
            "registerCallbackTimeoutSeconds": s.register_callback_timeout_seconds,
            "wechatNotificationEnabled": s.wechat_notification_enabled,
            "wechatAppId": s.wechat_app_id,
            "wechatAppSecretConfigured": bool(s.wechat_app_secret),
            "wechatOpenid": s.wechat_openid,
            "wechatTemplateId": s.wechat_template_id,
            "schedulerEnabled": s.scheduler_enabled,
            "quarantineRecoveryEnabled": s.quarantine_recovery_enabled,
            "schedulerTimezone": s.scheduler_timezone,
            "schedulerMisfireGraceSeconds": s.scheduler_misfire_grace_seconds,
            "recoveryCron": s.recovery_cron,
            "scheduledProbeRegisterCooldownMinutes": (
                s.scheduled_probe_register_cooldown_minutes
            ),
            "requestAuditEnabled": s.request_audit_enabled,
            "requestAuditAutoScanEnabled": s.request_audit_auto_scan_enabled,
            "requestAuditAdaptiveScanEnabled": (
                s.request_audit_adaptive_scan_enabled
            ),
            "requestAuditScanIntervalMinutes": (
                s.request_audit_scan_interval_minutes
            ),
            "requestAuditBusyScanIntervalSeconds": (
                s.request_audit_busy_scan_interval_seconds
            ),
            "requestAuditNormalScanIntervalSeconds": (
                s.request_audit_normal_scan_interval_seconds
            ),
            "requestAuditIdleScanIntervalSeconds": (
                s.request_audit_idle_scan_interval_seconds
            ),
            "requestAuditBusyRequestsPerMinute": (
                s.request_audit_busy_requests_per_minute
            ),
            "requestAuditLiveRefreshEnabled": (
                s.request_audit_live_refresh_enabled
            ),
            "requestAuditLiveRefreshSeconds": (
                s.request_audit_live_refresh_seconds
            ),
            "requestAuditRiskEnabled": s.request_audit_risk_enabled,
            "reasoningZeroRiskEnabled": risk_rule_enabled(
                "reasoning_zero",
                risk_thresholds,
            ),
            "reasoningModelPolicies": s.reasoning_model_policies,
            "mediaInputObserveEnabled": risk_rule_enabled(
                "media_input_observe",
                risk_thresholds,
            ),
            "riskRuleOverrides": s.risk_rule_overrides,
            "riskRules": risk_rule_definitions(risk_thresholds),
            "requestAuditTpsOnlyDeprioritizeEnabled": (
                s.request_audit_tps_only_deprioritize_enabled
            ),
            "requestAuditTpsOnlyPriority": s.request_audit_tps_only_priority,
            "requestAuditTpsOnlyMinCount": s.request_audit_tps_only_min_count,
            "requestAuditTpsCooldownMinutes": s.request_audit_tps_cooldown_minutes,
            "requestAuditIsolationEnabled": s.request_audit_isolation_enabled,
            "requestAuditRetentionDays": s.request_audit_retention_days,
            "probeWorkerConcurrency": s.probe_worker_concurrency,
            "probeQueueLimit": s.probe_queue_limit,
            "probeStepDelaySeconds": s.probe_step_delay_seconds,
            "probeCurrentEgressIntervalSeconds": s.probe_current_egress_interval_seconds,
            "probeTransientRetryAttempts": s.probe_transient_retry_attempts,
            "probeTransientRetryBaseSeconds": s.probe_transient_retry_base_seconds,
            "probeTransientRetryMaxSeconds": s.probe_transient_retry_max_seconds,
            "probeRoutePrefix": s.probe_route_prefix,
            "probeDiagnosticPriority": s.probe_diagnostic_priority,
            "analysisWindowHours": s.analysis_window_hours,
            "degradationTps": s.degradation_tps,
            "strongDegradationTps": s.strong_degradation_tps,
            "probeTpsOverrideEnabled": s.probe_tps_override_enabled,
            "probeTpsOverrideMode": s.probe_tps_override_mode,
            "probeTpsOverrideMinFirstTokenMs": (
                s.probe_tps_override_min_first_token_ms
            ),
            "probeTpsOverrideMaxGenerationMs": (
                s.probe_tps_override_max_generation_ms
            ),
            "consecutiveAnomalies": s.consecutive_anomalies,
            "cumulativeAnomalyRate": s.cumulative_anomaly_rate,
            "highRiskHardCount": s.high_risk_hard_count,
            "riskAnomalyRateWeight": s.risk_anomaly_rate_weight,
            "riskHardWeight": s.risk_hard_weight,
            "riskHardCap": s.risk_hard_cap,
            "riskFastWeight": s.risk_fast_weight,
            "riskFastCap": s.risk_fast_cap,
            "riskMarkerMissWeight": s.risk_marker_miss_weight,
            "riskMarkerMissCap": s.risk_marker_miss_cap,
            "riskStreakWeight": s.risk_streak_weight,
            "riskStreakCap": s.risk_streak_cap,
            "riskScoreCap": s.risk_score_cap,
            "riskWatchFloor": s.risk_watch_floor,
            "riskSuspectFloor": s.risk_suspect_floor,
            "riskHighFloor": s.risk_high_floor,
            "bufferFirstTokenShare": s.buffer_first_token_share,
            "minGenerationMs": s.min_generation_ms,
            "minimumOutputTokens": s.minimum_output_tokens,
            "autoQuarantine": s.auto_quarantine,
            "autoQuarantineRecoveryEnabled": s.auto_quarantine_recovery_enabled,
            "autoIsolationEnabled": s.auto_isolation_enabled,
            "autoIsolationMinStatus": s.auto_isolation_min_status,
            "qualityRetryIsolationEnabled": s.quality_retry_isolation_enabled,
            "qualityRetryIsolationIntervalSeconds": (
                s.quality_retry_isolation_interval_seconds
            ),
            "quarantineMinutes": s.quarantine_minutes,
            "bootstrap": {
                "host": s.host,
                "port": s.port,
                "databasePath": str(s.database_path),
                "corsOrigins": s.cors_origin_list,
            },
        }

    def onboarding_view(self) -> dict[str, Any]:
        requirements = {
            "grok2apiBaseUrl": bool(self.settings.grok2api_base_url.strip()),
            "grok2apiAdminUsername": bool(
                self.settings.grok2api_admin_username.strip()
            ),
            "grok2apiAdminPassword": bool(self.settings.grok2api_admin_password),
        }
        return {
            "completed": self.repository.flag_exists(
                INITIAL_ONBOARDING_COMPLETED_KEY
            ),
            "ready": all(requirements.values()),
            "requirements": requirements,
        }

    def complete_onboarding(self) -> dict[str, Any]:
        state = self.onboarding_view()
        if not state["ready"]:
            raise ValueError("请先补全 grok2api 地址、管理员用户名和密码")
        self.repository.set_flag(INITIAL_ONBOARDING_COMPLETED_KEY)
        return self.onboarding_view()

    def reveal_secret(self, name: str) -> str:
        """Return one persisted runtime secret for the authenticated settings UI."""

        secrets = {
            "grok2apiAdminPassword": self.settings.grok2api_admin_password,
            "grokRegisterWebhookToken": self.settings.grok_register_webhook_token,
            "ssoProxy": self.settings.sso_proxy,
            "wechatAppSecret": self.settings.wechat_app_secret,
        }
        if name not in secrets:
            raise ValueError("不支持读取该敏感设置")
        return secrets[name]
