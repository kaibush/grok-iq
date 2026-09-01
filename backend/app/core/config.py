from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any, ClassVar, Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.reasoning_policy import default_reasoning_model_policies

DEFAULT_DATABASE_PATH = Path(__file__).resolve().parents[2] / "data" / "grokiq.db"

DEFAULT_REGISTER_PROBE_PROFILE_IDS = ["quality-marker"]
DEFAULT_REGISTER_PROBE_STABILIZATION_SECONDS = 15.0
REGISTER_PROBE_EXECUTION_MODE = "chat"
REGISTER_PROBE_ROUNDS = 3
REGISTER_PROBE_PROXY_TARGETS = [{"kind": "current", "id": None}]

AutoIsolationMinStatus = Literal["watch", "suspect", "high_risk"]
ProbeTpsOverrideMode = Literal["off", "generation_window", "missing_reasoning"]
PROBE_TPS_OVERRIDE_MODES: tuple[ProbeTpsOverrideMode, ...] = (
    "off",
    "generation_window",
    "missing_reasoning",
)
AUTO_ISOLATION_STATUS_ORDER: tuple[AutoIsolationMinStatus, ...] = (
    "watch",
    "suspect",
    "high_risk",
)
DEFAULT_AUTO_ISOLATION_MIN_STATUS: AutoIsolationMinStatus = "high_risk"


def should_auto_isolate(
    status: str,
    *,
    enabled: bool,
    min_status: str = DEFAULT_AUTO_ISOLATION_MIN_STATUS,
) -> bool:
    """Return whether a probe status should enter the isolation zone.

    The configured minimum status and every more severe status match.
    ``healthy`` and ``quarantined`` are never used as thresholds.
    """

    if not enabled:
        return False
    order = {name: index for index, name in enumerate(AUTO_ISOLATION_STATUS_ORDER)}
    status_rank = order.get(str(status or "").strip())
    min_rank = order.get(
        str(min_status or "").strip(),
        order[DEFAULT_AUTO_ISOLATION_MIN_STATUS],
    )
    return status_rank is not None and status_rank >= min_rank


def normalize_probe_tps_override_mode(
    mode: str | None,
    *,
    enabled: bool | None = None,
) -> ProbeTpsOverrideMode:
    value = str(mode or "").strip()
    if value in PROBE_TPS_OVERRIDE_MODES:
        return value  # type: ignore[return-value]
    return "generation_window" if enabled else "off"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="GROKIQ_", env_file=".env", extra="ignore")

    app_name: str = "GrokIQ"
    host: str = "0.0.0.0"
    port: int = 8090
    debug: bool = False
    # Resolve the source-tree default from this module instead of the process
    # working directory. Starting ``python -m app.main`` from the repository
    # root and from ``backend/`` must address the same local database.
    database_path: Path = DEFAULT_DATABASE_PATH
    # Only bootstrap settings stay environment-backed. Runtime secrets saved
    # from the admin UI are encrypted with this Fernet key. When it is empty,
    # the application creates a mode-0600 key beside the SQLite database.
    runtime_secret_key: str = ""
    # JWT signing is bootstrap-only. When omitted, a mode-0600 key is generated
    # next to the GrokIQ database and therefore persists with the Docker volume.
    jwt_secret_key: str = ""
    jwt_ttl_seconds: int = Field(
        default=7 * 24 * 60 * 60,
        ge=7 * 24 * 60 * 60,
    )

    # grok2api remains the account source of truth. Lists are queried live and
    # credentials are never copied into this service.
    grok2api_base_url: str = "http://127.0.0.1:8000"
    grok2api_admin_username: str = ""
    grok2api_admin_password: str = ""
    grok2api_http_impersonate: str = "chrome"

    grok_register_webhook_token: str = ""
    # Optional proxy for SSO checks. Empty allows direct egress.
    sso_proxy: str = ""
    initial_probe_on_register: bool = True
    register_probe_stabilization_seconds: float = Field(
        default=DEFAULT_REGISTER_PROBE_STABILIZATION_SECONDS,
        ge=0,
        le=300,
    )
    register_probe_profile_ids: list[str] = Field(
        default_factory=lambda: list(DEFAULT_REGISTER_PROBE_PROFILE_IDS)
    )
    register_probe_execution_mode: str = REGISTER_PROBE_EXECUTION_MODE
    register_probe_rounds: int = Field(default=REGISTER_PROBE_ROUNDS, ge=1, le=20)
    register_probe_profile_rounds: dict[str, int] = Field(default_factory=dict)
    register_probe_proxy_targets: list[dict[str, Any]] = Field(
        default_factory=lambda: [
            dict(target) for target in REGISTER_PROBE_PROXY_TARGETS
        ]
    )
    register_probe_switch_on_degradation: bool = True
    register_priority_hold_enabled: bool = True
    register_priority_hold: int = Field(default=-1_000_000, ge=-2_000_000_000, le=0)
    register_callback_enabled: bool = False
    register_callback_url: str = ""
    register_callback_timeout_seconds: int = Field(default=10, ge=1, le=60)

    # The WeChat public-platform test account uses the same template-message
    # API as a normal public account, which keeps local development independent
    # from production account verification.
    wechat_notification_enabled: bool = False
    wechat_app_id: str = ""
    wechat_app_secret: str = ""
    wechat_openid: str = ""
    wechat_template_id: str = ""

    # User-created probe plans and GrokIQ-owned quarantine recovery are
    # independently configurable while sharing the same scheduler process.
    scheduler_enabled: bool = True
    quarantine_recovery_enabled: bool = True
    scheduler_timezone: str = "UTC"
    scheduler_misfire_grace_seconds: int = Field(default=300, ge=1, le=86_400)
    recovery_cron: str = "*/5 * * * *"
    scheduled_probe_register_cooldown_minutes: int = Field(
        default=360, ge=0, le=7 * 24 * 60
    )

    # Request-audit monitoring is independently switchable from probe plans.
    # The scheduler only projects new rows; dashboards always query the local
    # SQLite projection and can therefore refresh without hitting grok2api.
    request_audit_enabled: bool = True
    request_audit_auto_scan_enabled: bool = True
    request_audit_adaptive_scan_enabled: bool = True
    request_audit_scan_interval_minutes: int = Field(default=5, ge=1, le=24 * 60)
    request_audit_busy_scan_interval_seconds: int = Field(default=30, ge=15, le=300)
    request_audit_normal_scan_interval_seconds: int = Field(default=120, ge=30, le=1800)
    request_audit_idle_scan_interval_seconds: int = Field(default=300, ge=60, le=3600)
    request_audit_busy_requests_per_minute: int = Field(default=20, ge=1, le=100_000)
    request_audit_live_refresh_enabled: bool = True
    request_audit_live_refresh_seconds: int = Field(default=30, ge=10, le=300)
    request_audit_risk_enabled: bool = True
    # A successful response with no reasoning tokens is a degradation signal
    # even when throughput remains below the TPS thresholds.
    reasoning_zero_risk_enabled: bool = True
    # Reasoning output is only comparable when the actual upstream model and
    # request operation are expected to emit it. Unknown combinations default
    # to observation and never enter automatic account action directly.
    reasoning_model_policies: list[dict[str, Any]] = Field(
        default_factory=default_reasoning_model_policies
    )
    media_input_observe_enabled: bool = True
    # Ordered per-rule overrides. Unknown IDs are preserved so rules supplied
    # by a later integration can be configured without adding another column.
    # Example: [{"id": "reasoning_zero", "enabled": True, "priority": 50}]
    risk_rule_overrides: list[dict[str, Any]] = Field(default_factory=list)
    # Consecutive high-TPS rows cool the account first; a later consecutive
    # burst without a healthy TPS after cooldown then isolates.
    request_audit_tps_only_deprioritize_enabled: bool = True
    request_audit_tps_only_priority: int = Field(
        default=-1_000_000,
        ge=-2_000_000_000,
        le=0,
    )
    request_audit_tps_only_min_count: int = Field(default=2, ge=2, le=100)
    request_audit_tps_cooldown_minutes: int = Field(default=30, ge=1, le=1440)
    request_audit_isolation_enabled: bool = True
    request_audit_retention_days: int = Field(default=90, ge=1, le=90)

    # Persistent probe queue. A short Cron interval therefore cannot create
    # unbounded asyncio tasks.
    probe_worker_concurrency: int = Field(default=2, ge=1, le=32)
    probe_queue_limit: int = Field(default=10_000, ge=1, le=100_000)
    probe_step_delay_seconds: float = Field(default=0.6, ge=0, le=60)
    probe_current_egress_interval_seconds: float = Field(default=10.0, ge=0, le=300)
    # A failed proxy can put the pinned account into grok2api's short health
    # cooldown.  Local exponential retries are bounded and independently
    # configurable so a short Cron interval cannot create a retry storm.  An
    # explicit upstream Retry-After or account cooldown remains authoritative.
    probe_transient_retry_attempts: int = Field(default=2, ge=0, le=5)
    probe_transient_retry_base_seconds: float = Field(default=5.0, ge=0.1, le=60)
    probe_transient_retry_max_seconds: float = Field(default=30.0, ge=0.1, le=300)
    probe_route_prefix: str = "grokiq-probe"
    probe_diagnostic_priority: int = Field(default=-1_000_000, ge=-2_000_000_000, le=0)

    analysis_window_hours: int = Field(default=168, ge=1, le=24 * 365)
    degradation_tps: float = Field(default=150, gt=0)
    strong_degradation_tps: float = Field(default=500, gt=0)
    probe_tps_override_enabled: bool = True
    probe_tps_override_mode: ProbeTpsOverrideMode = "missing_reasoning"
    probe_tps_override_min_first_token_ms: int = Field(
        default=5000, ge=0, le=600_000
    )
    probe_tps_override_max_generation_ms: int = Field(
        default=1000, ge=1, le=60_000
    )
    consecutive_anomalies: int = Field(default=3, ge=2, le=20)
    cumulative_anomaly_rate: float = Field(default=0.5, ge=0.01, le=1)
    high_risk_hard_count: int = Field(default=2, ge=1, le=100)
    risk_anomaly_rate_weight: float = Field(default=30, ge=0, le=100)
    risk_hard_weight: float = Field(default=6, ge=0, le=100)
    risk_hard_cap: float = Field(default=24, ge=0, le=100)
    risk_fast_weight: float = Field(default=12, ge=0, le=100)
    risk_fast_cap: float = Field(default=30, ge=0, le=100)
    risk_marker_miss_weight: float = Field(default=16, ge=0, le=100)
    risk_marker_miss_cap: float = Field(default=32, ge=0, le=100)
    risk_streak_weight: float = Field(default=3, ge=0, le=100)
    risk_streak_cap: float = Field(default=15, ge=0, le=100)
    risk_score_cap: float = Field(default=100, gt=0, le=100)
    risk_watch_floor: float = Field(default=15, ge=0, le=100)
    risk_suspect_floor: float = Field(default=50, ge=0, le=100)
    risk_high_floor: float = Field(default=75, ge=0, le=100)
    buffer_first_token_share: float = Field(default=0.85, ge=0.5, le=0.99)
    min_generation_ms: int = Field(default=250, ge=1, le=60_000)
    minimum_output_tokens: int = Field(default=32, ge=1, le=4096)
    auto_quarantine: bool = False
    auto_quarantine_recovery_enabled: bool = True
    auto_isolation_enabled: bool = False
    auto_isolation_min_status: AutoIsolationMinStatus = (
        DEFAULT_AUTO_ISOLATION_MIN_STATUS
    )
    quality_retry_isolation_enabled: bool = False
    quality_retry_isolation_interval_seconds: int = Field(
        default=60, ge=15, le=600
    )
    quarantine_minutes: int = Field(default=30, ge=1, le=7 * 24 * 60)

    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    RUNTIME_FIELDS: ClassVar[tuple[str, ...]] = (
        "grok2api_base_url",
        "grok2api_admin_username",
        "grok2api_admin_password",
        "grok2api_http_impersonate",
        "grok_register_webhook_token",
        "sso_proxy",
        "initial_probe_on_register",
        "register_probe_stabilization_seconds",
        "register_probe_profile_ids",
        "register_probe_execution_mode",
        "register_probe_rounds",
        "register_probe_profile_rounds",
        "register_probe_proxy_targets",
        "register_probe_switch_on_degradation",
        "register_priority_hold_enabled",
        "register_priority_hold",
        "register_callback_enabled",
        "register_callback_url",
        "register_callback_timeout_seconds",
        "wechat_notification_enabled",
        "wechat_app_id",
        "wechat_app_secret",
        "wechat_openid",
        "wechat_template_id",
        "scheduler_enabled",
        "quarantine_recovery_enabled",
        "scheduler_timezone",
        "scheduler_misfire_grace_seconds",
        "recovery_cron",
        "scheduled_probe_register_cooldown_minutes",
        "request_audit_enabled",
        "request_audit_auto_scan_enabled",
        "request_audit_adaptive_scan_enabled",
        "request_audit_scan_interval_minutes",
        "request_audit_busy_scan_interval_seconds",
        "request_audit_normal_scan_interval_seconds",
        "request_audit_idle_scan_interval_seconds",
        "request_audit_busy_requests_per_minute",
        "request_audit_live_refresh_enabled",
        "request_audit_live_refresh_seconds",
        "request_audit_risk_enabled",
        "reasoning_zero_risk_enabled",
        "reasoning_model_policies",
        "media_input_observe_enabled",
        "risk_rule_overrides",
        "request_audit_tps_only_deprioritize_enabled",
        "request_audit_tps_only_priority",
        "request_audit_tps_only_min_count",
        "request_audit_tps_cooldown_minutes",
        "request_audit_isolation_enabled",
        "request_audit_retention_days",
        "probe_worker_concurrency",
        "probe_queue_limit",
        "probe_step_delay_seconds",
        "probe_current_egress_interval_seconds",
        "probe_transient_retry_attempts",
        "probe_transient_retry_base_seconds",
        "probe_transient_retry_max_seconds",
        "probe_route_prefix",
        "probe_diagnostic_priority",
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
        "auto_quarantine",
        "auto_quarantine_recovery_enabled",
        "auto_isolation_enabled",
        "auto_isolation_min_status",
        "quality_retry_isolation_enabled",
        "quality_retry_isolation_interval_seconds",
        "quarantine_minutes",
    )
    SECRET_RUNTIME_FIELDS: ClassVar[frozenset[str]] = frozenset(
        {
            "grok2api_admin_password",
            "grok_register_webhook_token",
            "sso_proxy",
            "wechat_app_secret",
        }
    )

    @property
    def normalized_gateway_base_url(self) -> str:
        return self.grok2api_base_url.rstrip("/")

    @property
    def cors_origin_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]

    def register_probe_rounds_by_profile(self) -> dict[str, int]:
        return {
            profile_id: int(
                self.register_probe_profile_rounds.get(
                    profile_id, self.register_probe_rounds
                )
            )
            for profile_id in self.register_probe_profile_ids
        }

    def apply_runtime(self, validated: Settings) -> None:
        """Update the shared settings object after a validated ORM write."""

        for field in self.RUNTIME_FIELDS:
            setattr(self, field, getattr(validated, field))

    def runtime_values(self) -> dict[str, object]:
        return {field: getattr(self, field) for field in self.RUNTIME_FIELDS}


@lru_cache
def get_settings() -> Settings:
    return Settings()
