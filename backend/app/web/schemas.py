from __future__ import annotations

import hashlib
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class AuthLoginInput(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class AuthSetupInput(AuthLoginInput):
    confirm_password: str = Field(min_length=1, max_length=256)


class ClientKeyQuotaInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    api_key: str = Field(alias="apiKey", min_length=8, max_length=256)


class ClientKeyUsageInput(ClientKeyQuotaInput):
    period: Literal["24h", "7d", "30d", "90d", "custom"] = "24h"
    start: str = ""
    end: str = ""


class ChatProviderCreateInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str = Field(min_length=1, max_length=120)
    base_url: str = Field(alias="baseUrl", min_length=1, max_length=2000)
    api_key: str = Field(default="", alias="apiKey", max_length=8000)
    models: list[str] = Field(default_factory=list, max_length=2000)
    enabled: bool = True
    is_default: bool = Field(default=False, alias="isDefault")

    @model_validator(mode="after")
    def normalize_values(self) -> ChatProviderCreateInput:
        self.name = self.name.strip()
        self.base_url = self.base_url.strip()
        self.models = _normalize_model_names(self.models)
        if not self.name or not self.base_url:
            raise ValueError("提供商名称和 Base URL 为必填项")
        return self


class ChatProviderUpdateInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str | None = Field(default=None, min_length=1, max_length=120)
    base_url: str | None = Field(
        default=None,
        alias="baseUrl",
        min_length=1,
        max_length=2000,
    )
    api_key: str | None = Field(default=None, alias="apiKey", max_length=8000)
    clear_api_key: bool = Field(default=False, alias="clearApiKey")
    models: list[str] | None = Field(default=None, max_length=2000)
    enabled: bool | None = None
    is_default: bool | None = Field(default=None, alias="isDefault")

    @model_validator(mode="after")
    def normalize_values(self) -> ChatProviderUpdateInput:
        if self.name is not None:
            self.name = self.name.strip()
        if self.base_url is not None:
            self.base_url = self.base_url.strip()
        if self.models is not None:
            self.models = _normalize_model_names(self.models)
        return self

    def changes(self) -> dict[str, Any]:
        return self.model_dump(exclude_unset=True)


def _normalize_model_names(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        model = str(value or "").strip()
        if not model or model in seen:
            continue
        if len(model) > 255:
            raise ValueError("模型名称长度不能超过 255")
        result.append(model)
        seen.add(model)
    return result


class AccountActionInput(BaseModel):
    action: str
    note: str = ""
    propagate: bool = False
    quarantine_minutes: int | None = Field(default=None, ge=1, le=10080)
    priority: int | None = Field(default=None, ge=-2_000_000_000, le=2_000_000_000)


class AccountBatchUpdateInput(BaseModel):
    account_ids: list[int] = Field(min_length=1, max_length=100_000)
    enabled: bool


class AccountBatchActionInput(BaseModel):
    account_ids: list[int] = Field(min_length=1, max_length=1000)
    action: Literal["quarantine", "isolate", "restore"]
    note: str = Field(default="", max_length=2000)
    propagate: bool = True
    quarantine_minutes: int | None = Field(default=None, ge=1, le=10080)
    priority: int | None = Field(default=None, ge=-2_000_000_000, le=2_000_000_000)


class AccountBatchEgressInput(BaseModel):
    account_ids: list[int] = Field(min_length=1, max_length=100_000)
    egress_node_id: int | None = Field(default=None, ge=1)


class AccountBatchDeleteInput(BaseModel):
    account_ids: list[int] = Field(min_length=1, max_length=100_000)


class AccountOperatorNoteInput(BaseModel):
    note: str = Field(default="", max_length=2000)


class EgressNodeBatchUpdateInput(BaseModel):
    node_ids: list[int] = Field(min_length=1, max_length=5000)
    enabled: bool


class EgressNodeBatchDeleteInput(BaseModel):
    node_ids: list[int] = Field(min_length=1, max_length=5000)


class EgressNodeAccountBindingInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    node_ids: list[int] = Field(min_length=2, max_length=5000)
    accounts_per_node: int = Field(ge=1, le=100_000, alias="accountsPerNode")


class EgressNodeCreateInput(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    proxy_url: str = Field(min_length=1, max_length=8000)
    proxy_pool: bool = False
    account_capacity: int = Field(default=0, ge=0, le=100_000)
    enabled: bool = True


class EgressNodeUpdateInput(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    proxy_url: str = Field(default="", max_length=8000)
    proxy_pool: bool = False
    account_capacity: int = Field(default=0, ge=0, le=100_000)


class ProxyTargetInput(BaseModel):
    kind: Literal["current", "direct", "egress"]
    id: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def validate_target(self) -> ProxyTargetInput:
        if self.kind == "egress" and self.id is None:
            raise ValueError("egress 目标必须填写 id")
        if self.kind in {"current", "direct"}:
            self.id = None
        return self


def _validate_proxy_target_selection(
    targets: list[ProxyTargetInput], execution_mode: str
) -> None:
    if execution_mode == "quality_test" and any(
        target.kind != "egress" for target in targets
    ):
        raise ValueError("快速出口质量探针仅支持 grok_build 出口节点")
    if any(target.kind == "current" for target in targets) and any(
        target.kind != "current" for target in targets
    ):
        raise ValueError("账号当前出口不能与诊断出口混用")


def _normalize_profile_selection(
    profile_ids: list[str], profile_id: str, *, fallback: str = ""
) -> list[str]:
    candidates = profile_ids if profile_ids else [profile_id or fallback]
    result: list[str] = []
    seen: set[str] = set()
    for value in candidates:
        normalized = str(value or "").strip()
        if not normalized or normalized in seen:
            continue
        if len(normalized) > 64:
            raise ValueError("探针方案 ID 长度不能超过 64")
        result.append(normalized)
        seen.add(normalized)
    if not result:
        raise ValueError("至少选择一个探针方案")
    return result


class ProbeRunCreate(BaseModel):
    account_id: int = Field(gt=0)
    profile_id: str = "quality-marker"
    profile_ids: list[str] = Field(default_factory=list, max_length=1000)
    execution_mode: Literal["chat", "quality_test"] = "chat"
    rounds: int = Field(default=1, ge=1, le=20)
    proxy_targets: list[ProxyTargetInput] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def validate_request(self) -> ProbeRunCreate:
        self.profile_ids = _normalize_profile_selection(
            self.profile_ids, self.profile_id, fallback="quality-marker"
        )
        self.profile_id = self.profile_ids[0]
        _validate_proxy_target_selection(self.proxy_targets, self.execution_mode)
        return self


class ProbeRunBatchCreate(BaseModel):
    account_ids: list[int] = Field(min_length=1, max_length=100_000)
    profile_id: str = "quality-marker"
    profile_ids: list[str] = Field(default_factory=list, max_length=1000)
    execution_mode: Literal["chat", "quality_test"] = "chat"
    rounds: int = Field(default=1, ge=1, le=20)
    proxy_targets: list[ProxyTargetInput] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def validate_request(self) -> ProbeRunBatchCreate:
        self.profile_ids = _normalize_profile_selection(
            self.profile_ids, self.profile_id, fallback="quality-marker"
        )
        self.profile_id = self.profile_ids[0]
        _validate_proxy_target_selection(self.proxy_targets, self.execution_mode)
        return self


SecretSettingName = Literal[
    "grok2apiAdminPassword",
    "grokRegisterWebhookToken",
    "ssoProxy",
    "wechatAppSecret",
]


class OnboardingCompleteInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    grok2api_base_url: str | None = Field(
        default=None,
        alias="grok2apiBaseUrl",
        max_length=2000,
    )
    grok2api_admin_username: str | None = Field(
        default=None,
        alias="grok2apiAdminUsername",
        max_length=256,
    )
    grok2api_admin_password: str | None = Field(
        default=None,
        alias="grok2apiAdminPassword",
        max_length=8000,
    )
    probe_worker_concurrency: int | None = Field(
        default=None,
        alias="probeWorkerConcurrency",
        ge=1,
        le=32,
    )
    probe_queue_limit: int | None = Field(
        default=None,
        alias="probeQueueLimit",
        ge=1,
        le=100_000,
    )
    scheduler_enabled: bool | None = Field(
        default=None,
        alias="schedulerEnabled",
    )
    quarantine_recovery_enabled: bool | None = Field(
        default=None,
        alias="quarantineRecoveryEnabled",
    )
    scheduler_timezone: str | None = Field(
        default=None,
        alias="schedulerTimezone",
        max_length=80,
    )
    analysis_window_hours: int | None = Field(
        default=None,
        alias="analysisWindowHours",
        ge=1,
        le=24 * 365,
    )
    sso_proxy: str | None = Field(
        default=None,
        alias="ssoProxy",
        max_length=8000,
    )

    def runtime_changes(self) -> dict[str, Any]:
        values = self.model_dump(exclude_unset=True)
        return {
            key: value
            for key, value in values.items()
            if (isinstance(value, str) and value.strip())
            or isinstance(value, (bool, int))
        }


class RuntimeSettingsInput(BaseModel):
    """Editable settings exposed by the GrokIQ UI.

    Secret values are write-only. An omitted or blank secret keeps the current
    value; ``clearSecrets`` performs an explicit clear.
    """

    model_config = ConfigDict(populate_by_name=True)

    grok2api_base_url: str | None = Field(default=None, alias="grok2apiBaseUrl")
    grok2api_admin_username: str | None = Field(default=None, alias="grok2apiAdminUsername")
    grok2api_admin_password: str | None = Field(default=None, alias="grok2apiAdminPassword")
    grok2api_http_impersonate: str | None = Field(default=None, alias="grok2apiHttpImpersonate")
    grok_register_webhook_token: str | None = Field(default=None, alias="grokRegisterWebhookToken")
    sso_proxy: str | None = Field(default=None, alias="ssoProxy", max_length=8000)
    initial_probe_on_register: bool | None = Field(default=None, alias="initialProbeOnRegister")
    register_probe_stabilization_seconds: float | None = Field(
        default=None,
        alias="registerProbeStabilizationSeconds",
        ge=0,
        le=300,
    )
    register_probe_profile_ids: list[str] | None = Field(
        default=None, alias="registerProbeProfileIds", max_length=1000
    )
    register_probe_execution_mode: Literal["chat", "quality_test"] | None = Field(
        default=None, alias="registerProbeExecutionMode"
    )
    register_probe_rounds: int | None = Field(
        default=None, alias="registerProbeRounds", ge=1, le=20
    )
    register_probe_profile_rounds: dict[str, int] | None = Field(
        default=None, alias="registerProbeProfileRounds", max_length=1000
    )
    register_probe_proxy_targets: list[ProxyTargetInput] | None = Field(
        default=None, alias="registerProbeProxyTargets", max_length=20
    )
    register_probe_switch_on_degradation: bool | None = Field(
        default=None, alias="registerProbeSwitchOnDegradation"
    )
    register_priority_hold_enabled: bool | None = Field(
        default=None, alias="registerPriorityHoldEnabled"
    )
    register_priority_hold: int | None = Field(
        default=None,
        alias="registerPriorityHold",
        ge=-2_000_000_000,
        le=0,
    )
    register_callback_enabled: bool | None = Field(
        default=None, alias="registerCallbackEnabled"
    )
    register_callback_url: str | None = Field(
        default=None, alias="registerCallbackUrl", max_length=2000
    )
    register_callback_timeout_seconds: int | None = Field(
        default=None,
        alias="registerCallbackTimeoutSeconds",
        ge=1,
        le=60,
    )
    wechat_notification_enabled: bool | None = Field(
        default=None, alias="wechatNotificationEnabled"
    )
    wechat_app_id: str | None = Field(default=None, alias="wechatAppId", max_length=128)
    wechat_app_secret: str | None = Field(
        default=None, alias="wechatAppSecret", max_length=256
    )
    wechat_openid: str | None = Field(
        default=None, alias="wechatOpenid", max_length=256
    )
    wechat_template_id: str | None = Field(
        default=None, alias="wechatTemplateId", max_length=256
    )
    scheduler_enabled: bool | None = Field(default=None, alias="schedulerEnabled")
    quarantine_recovery_enabled: bool | None = Field(
        default=None, alias="quarantineRecoveryEnabled"
    )
    scheduler_timezone: str | None = Field(default=None, alias="schedulerTimezone")
    scheduler_misfire_grace_seconds: int | None = Field(
        default=None, alias="schedulerMisfireGraceSeconds", ge=1, le=86_400
    )
    recovery_cron: str | None = Field(default=None, alias="recoveryCron")
    scheduled_probe_register_cooldown_minutes: int | None = Field(
        default=None,
        alias="scheduledProbeRegisterCooldownMinutes",
        ge=0,
        le=7 * 24 * 60,
    )
    request_audit_enabled: bool | None = Field(
        default=None, alias="requestAuditEnabled"
    )
    request_audit_auto_scan_enabled: bool | None = Field(
        default=None, alias="requestAuditAutoScanEnabled"
    )
    request_audit_adaptive_scan_enabled: bool | None = Field(
        default=None, alias="requestAuditAdaptiveScanEnabled"
    )
    request_audit_scan_interval_minutes: int | None = Field(
        default=None,
        alias="requestAuditScanIntervalMinutes",
        ge=1,
        le=24 * 60,
    )
    request_audit_busy_scan_interval_seconds: int | None = Field(
        default=None,
        alias="requestAuditBusyScanIntervalSeconds",
        ge=15,
        le=300,
    )
    request_audit_normal_scan_interval_seconds: int | None = Field(
        default=None,
        alias="requestAuditNormalScanIntervalSeconds",
        ge=30,
        le=1800,
    )
    request_audit_idle_scan_interval_seconds: int | None = Field(
        default=None,
        alias="requestAuditIdleScanIntervalSeconds",
        ge=60,
        le=3600,
    )
    request_audit_busy_requests_per_minute: int | None = Field(
        default=None,
        alias="requestAuditBusyRequestsPerMinute",
        ge=1,
        le=100_000,
    )
    request_audit_live_refresh_enabled: bool | None = Field(
        default=None, alias="requestAuditLiveRefreshEnabled"
    )
    request_audit_live_refresh_seconds: int | None = Field(
        default=None,
        alias="requestAuditLiveRefreshSeconds",
        ge=10,
        le=300,
    )
    request_audit_risk_enabled: bool | None = Field(
        default=None, alias="requestAuditRiskEnabled"
    )
    reasoning_zero_risk_enabled: bool | None = Field(
        default=None, alias="reasoningZeroRiskEnabled"
    )
    reasoning_model_policies: list[dict[str, Any]] | None = Field(
        default=None, alias="reasoningModelPolicies", max_length=200
    )
    media_input_observe_enabled: bool | None = Field(
        default=None, alias="mediaInputObserveEnabled"
    )
    risk_rule_overrides: list[dict[str, Any]] | None = Field(
        default=None, alias="riskRuleOverrides", max_length=200
    )
    request_audit_tps_only_deprioritize_enabled: bool | None = Field(
        default=None, alias="requestAuditTpsOnlyDeprioritizeEnabled"
    )
    request_audit_tps_only_priority: int | None = Field(
        default=None,
        alias="requestAuditTpsOnlyPriority",
        ge=-2_000_000_000,
        le=0,
    )
    request_audit_tps_only_min_count: int | None = Field(
        default=None, alias="requestAuditTpsOnlyMinCount", ge=2, le=100
    )
    request_audit_isolation_enabled: bool | None = Field(
        default=None, alias="requestAuditIsolationEnabled"
    )
    request_audit_retention_days: int | None = Field(
        default=None,
        alias="requestAuditRetentionDays",
        ge=1,
        le=90,
    )
    probe_worker_concurrency: int | None = Field(default=None, alias="probeWorkerConcurrency", ge=1, le=32)
    probe_queue_limit: int | None = Field(default=None, alias="probeQueueLimit", ge=1, le=100_000)
    probe_step_delay_seconds: float | None = Field(default=None, alias="probeStepDelaySeconds", ge=0, le=60)
    probe_current_egress_interval_seconds: float | None = Field(
        default=None, alias="probeCurrentEgressIntervalSeconds", ge=0, le=300
    )
    probe_transient_retry_attempts: int | None = Field(
        default=None, alias="probeTransientRetryAttempts", ge=0, le=5
    )
    probe_transient_retry_base_seconds: float | None = Field(
        default=None, alias="probeTransientRetryBaseSeconds", ge=0.1, le=60
    )
    probe_transient_retry_max_seconds: float | None = Field(
        default=None, alias="probeTransientRetryMaxSeconds", ge=0.1, le=300
    )
    probe_route_prefix: str | None = Field(default=None, alias="probeRoutePrefix")
    probe_diagnostic_priority: int | None = Field(
        default=None,
        alias="probeDiagnosticPriority",
        ge=-2_000_000_000,
        le=0,
    )
    analysis_window_hours: int | None = Field(default=None, alias="analysisWindowHours", ge=1, le=24 * 365)
    degradation_tps: float | None = Field(default=None, alias="degradationTps", gt=0)
    strong_degradation_tps: float | None = Field(default=None, alias="strongDegradationTps", gt=0)
    probe_tps_override_enabled: bool | None = Field(
        default=None, alias="probeTpsOverrideEnabled"
    )
    probe_tps_override_mode: Literal[
        "off", "generation_window", "missing_reasoning"
    ] | None = Field(default=None, alias="probeTpsOverrideMode")
    probe_tps_override_min_first_token_ms: int | None = Field(
        default=None,
        alias="probeTpsOverrideMinFirstTokenMs",
        ge=0,
        le=600_000,
    )
    probe_tps_override_max_generation_ms: int | None = Field(
        default=None,
        alias="probeTpsOverrideMaxGenerationMs",
        ge=1,
        le=60_000,
    )
    consecutive_anomalies: int | None = Field(default=None, alias="consecutiveAnomalies", ge=2, le=20)
    cumulative_anomaly_rate: float | None = Field(
        default=None, alias="cumulativeAnomalyRate", ge=0.01, le=1
    )
    high_risk_hard_count: int | None = Field(
        default=None, alias="highRiskHardCount", ge=1, le=100
    )
    risk_anomaly_rate_weight: float | None = Field(
        default=None, alias="riskAnomalyRateWeight", ge=0, le=100
    )
    risk_hard_weight: float | None = Field(default=None, alias="riskHardWeight", ge=0, le=100)
    risk_hard_cap: float | None = Field(default=None, alias="riskHardCap", ge=0, le=100)
    risk_fast_weight: float | None = Field(default=None, alias="riskFastWeight", ge=0, le=100)
    risk_fast_cap: float | None = Field(default=None, alias="riskFastCap", ge=0, le=100)
    risk_marker_miss_weight: float | None = Field(
        default=None, alias="riskMarkerMissWeight", ge=0, le=100
    )
    risk_marker_miss_cap: float | None = Field(
        default=None, alias="riskMarkerMissCap", ge=0, le=100
    )
    risk_streak_weight: float | None = Field(
        default=None, alias="riskStreakWeight", ge=0, le=100
    )
    risk_streak_cap: float | None = Field(default=None, alias="riskStreakCap", ge=0, le=100)
    risk_score_cap: float | None = Field(default=None, alias="riskScoreCap", gt=0, le=100)
    risk_watch_floor: float | None = Field(default=None, alias="riskWatchFloor", ge=0, le=100)
    risk_suspect_floor: float | None = Field(
        default=None, alias="riskSuspectFloor", ge=0, le=100
    )
    risk_high_floor: float | None = Field(default=None, alias="riskHighFloor", ge=0, le=100)
    buffer_first_token_share: float | None = Field(
        default=None, alias="bufferFirstTokenShare", ge=0.5, le=0.99
    )
    min_generation_ms: int | None = Field(default=None, alias="minGenerationMs", ge=1, le=60_000)
    minimum_output_tokens: int | None = Field(default=None, alias="minimumOutputTokens", ge=1, le=4096)
    auto_quarantine: bool | None = Field(default=None, alias="autoQuarantine")
    auto_quarantine_recovery_enabled: bool | None = Field(
        default=None, alias="autoQuarantineRecoveryEnabled"
    )
    auto_isolation_enabled: bool | None = Field(
        default=None, alias="autoIsolationEnabled"
    )
    auto_isolation_min_status: Literal["watch", "suspect", "high_risk"] | None = Field(
        default=None, alias="autoIsolationMinStatus"
    )
    quality_retry_isolation_enabled: bool | None = Field(
        default=None, alias="qualityRetryIsolationEnabled"
    )
    quality_retry_isolation_interval_seconds: int | None = Field(
        default=None,
        alias="qualityRetryIsolationIntervalSeconds",
        ge=15,
        le=600,
    )
    quarantine_minutes: int | None = Field(default=None, alias="quarantineMinutes", ge=1, le=7 * 24 * 60)
    clear_secrets: list[SecretSettingName] = Field(default_factory=list, alias="clearSecrets")

    def runtime_changes(self) -> dict[str, Any]:
        values = self.model_dump(exclude_unset=True, exclude={"clear_secrets"})
        result = {key: value for key, value in values.items() if value is not None}
        for key in (
            "grok2api_admin_password",
            "grok_register_webhook_token",
            "sso_proxy",
            "wechat_app_secret",
        ):
            if result.get(key) == "":
                result.pop(key)
        clear_mapping = {
            "grok2apiAdminPassword": "grok2api_admin_password",
            "grokRegisterWebhookToken": "grok_register_webhook_token",
            "ssoProxy": "sso_proxy",
            "wechatAppSecret": "wechat_app_secret",
        }
        for alias in self.clear_secrets:
            result[clear_mapping[alias]] = ""
        return result


class RequestAuditScanInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    window_preset: Literal["today", "1h", "3h", "6h", "24h", "7d", "30d", "custom"] = Field(
        default="today", alias="window"
    )
    start_at: datetime | None = Field(default=None, alias="startAt")
    end_at: datetime | None = Field(default=None, alias="endAt")

    @model_validator(mode="after")
    def validate_window(self) -> RequestAuditScanInput:
        if (self.start_at is None) != (self.end_at is None):
            raise ValueError("自定义时间窗口需要完整的开始和结束时间")
        if self.window_preset == "custom" and self.start_at is None:
            raise ValueError("自定义时间窗口需要完整的开始和结束时间")
        return self


class ProfileInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    model: str = Field(min_length=1, max_length=160)
    system_prompt: str = Field(default="", max_length=8000)
    prompt: str = Field(min_length=1, max_length=16000)
    expected_text: str = Field(default="", max_length=2000)
    expected_output: str = Field(default="", max_length=500_000)
    expected_image_url: str = Field(default="", max_length=4000)
    # Zero means GrokIQ omits the output-token field and lets the upstream
    # route/model apply its own limit.
    max_output_tokens: int = Field(default=0, ge=0)
    temperature: float | None = Field(default=None, ge=0, le=2)
    extra_body: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True


class ProbePlanInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    profile_id: str = ""
    profile_ids: list[str] = Field(default_factory=list, max_length=1000)
    account_scope: Literal["fixed", "all_enabled", "risky_enabled"] = "fixed"
    account_ids: list[int] = Field(default_factory=list, max_length=100_000)
    proxy_targets: list[ProxyTargetInput] = Field(min_length=1, max_length=20)
    execution_mode: Literal["chat", "quality_test"] = "chat"
    rounds: int = Field(default=1, ge=1, le=20)
    cron_expression: str = Field(min_length=5, max_length=120)
    timezone: str = Field(default="UTC", min_length=1, max_length=80)
    enabled: bool = True
    overlap_policy: Literal["skip", "fill"] = "skip"
    priority: int = Field(default=200, ge=1, le=1000)

    @model_validator(mode="after")
    def validate_request(self) -> ProbePlanInput:
        self.profile_ids = _normalize_profile_selection(self.profile_ids, self.profile_id)
        self.profile_id = self.profile_ids[0]
        _validate_proxy_target_selection(self.proxy_targets, self.execution_mode)
        self.account_ids = list(
            dict.fromkeys(account_id for account_id in self.account_ids if account_id > 0)
        )
        if self.account_scope == "fixed" and not self.account_ids:
            raise ValueError("固定账号计划至少选择一个账号")
        if self.account_scope != "fixed":
            self.account_ids = []
        if self.execution_mode != "chat" or any(
            target.kind != "current" for target in self.proxy_targets
        ):
            raise ValueError("Cron 周期巡检仅支持完整对话和账号当前出口")
        return self


class ProbePlanEnabledInput(BaseModel):
    enabled: bool


class BulkIdsInput(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=500)


class SsoReportCreateInput(BaseModel):
    name: str = Field(default="", max_length=160)
    sso_content: str = Field(alias="ssoContent", min_length=1, max_length=4_000_000)
    proxy: str = Field(default="", max_length=8000)
    concurrency: int = Field(default=8, ge=1, le=32)
    request_timeout_seconds: int = Field(
        default=20,
        alias="requestTimeoutSeconds",
        ge=5,
        le=120,
    )


class AccountSsoReportInput(BaseModel):
    account_ids: list[int] = Field(min_length=1, max_length=1000)
    name: str = Field(default="", max_length=160)


class RegisterAccountEvent(BaseModel):
    event_id: str = Field(default="", max_length=120)
    event_type: str = Field(default="grok2api.account_imported", max_length=80)
    email: str = Field(min_length=3, max_length=255)
    sso: str = Field(default="", max_length=20000)
    grok2api_account_id: int | None = None
    bot_risk: bool = False
    bfs: int | str | None = None
    registration_id: str = ""
    occurred_at: str = Field(default="", max_length=80)

    @model_validator(mode="after")
    def normalize_event(self) -> RegisterAccountEvent:
        self.event_id = self.event_id.strip()
        self.event_type = self.event_type.strip() or "grok2api.account_imported"
        self.email = self.email.strip().lower()
        self.sso = self.sso.strip()
        self.registration_id = self.registration_id.strip()
        self.occurred_at = self.occurred_at.strip()
        if "@" not in self.email:
            raise ValueError("Webhook 邮箱格式无效")
        if not self.event_id:
            if self.registration_id:
                self.event_id = f"registration:{self.registration_id}:grok2api-imported"
            else:
                digest = hashlib.sha256(
                    f"{self.event_type}\n{self.email}".encode()
                ).hexdigest()[:32]
                self.event_id = f"legacy:{digest}"
        if len(self.event_id) < 3:
            raise ValueError("Webhook 事件 ID 无效")
        return self
