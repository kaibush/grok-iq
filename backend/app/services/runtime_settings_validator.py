from __future__ import annotations

import re
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from apscheduler.triggers.cron import CronTrigger

from app.core.config import Settings
from app.integrations.sso import normalize_proxy
from app.reasoning_policy import normalize_reasoning_model_policies


class RuntimeSettingsValidator:
    """Applies cross-field validation and normalization to runtime settings."""

    def validate(self, values: dict[str, object], fixed_strategy: dict[str, object]) -> Settings:
        candidate = Settings.model_validate(values | fixed_strategy)
        self._validate_risk(candidate)
        self._normalize_risk_rules(candidate)
        self._normalize_reasoning_model_policies(candidate)
        self._validate_request_audit(candidate)
        self._validate_retry(candidate)
        self._validate_connection(candidate)
        self._validate_scheduler(candidate)
        self._validate_route_prefix(candidate)
        self._normalize_register_strategy(candidate)
        self._normalize_register_callback(candidate)
        self._normalize_wechat(candidate)
        self._normalize_wechat_alerts(candidate)
        self._normalize_sso_proxy(candidate)
        return candidate

    @staticmethod
    def _validate_risk(candidate: Settings) -> None:
        if candidate.degradation_tps >= candidate.strong_degradation_tps:
            raise ValueError("降智信号 TPS 下限必须小于强降智信号 TPS 下限")
        if not (
            candidate.risk_watch_floor
            <= candidate.risk_suspect_floor
            <= candidate.risk_high_floor
            <= candidate.risk_score_cap
        ):
            raise ValueError("风险状态保底分必须满足观察 ≤ 疑似 ≤ 高风险 ≤ 总分上限")
        for label, weight, cap in (
            ("强信号", candidate.risk_hard_weight, candidate.risk_hard_cap),
            ("持续高速", candidate.risk_fast_weight, candidate.risk_fast_cap),
            (
                "标记缺失",
                candidate.risk_marker_miss_weight,
                candidate.risk_marker_miss_cap,
            ),
            ("连续信号", candidate.risk_streak_weight, candidate.risk_streak_cap),
        ):
            if weight > 0 and cap <= 0:
                raise ValueError(f"{label}权重大于 0 时封顶分必须大于 0")

    @staticmethod
    def _normalize_risk_rules(candidate: Settings) -> None:
        normalized: list[dict[str, object]] = []
        seen: set[str] = set()
        for raw in candidate.risk_rule_overrides:
            if not isinstance(raw, dict):
                raise ValueError("风险规则覆盖项必须是对象")
            rule_id = str(raw.get("id") or raw.get("ruleId") or "").strip()
            if not rule_id:
                raise ValueError("风险规则覆盖项缺少 ID")
            if len(rule_id) > 100:
                raise ValueError("风险规则 ID 不能超过 100 个字符")
            if rule_id in seen:
                raise ValueError(f"风险规则覆盖项重复: {rule_id}")
            seen.add(rule_id)
            item: dict[str, object] = {"id": rule_id}
            if "enabled" in raw:
                item["enabled"] = bool(raw["enabled"])
            if "priority" in raw:
                try:
                    priority = int(raw["priority"])
                except (TypeError, ValueError, OverflowError) as exc:
                    raise ValueError(f"风险规则优先级无效: {rule_id}") from exc
                if priority < -100_000 or priority > 100_000:
                    raise ValueError(f"风险规则优先级超出范围: {rule_id}")
                item["priority"] = priority
            # Preserve extension-owned scalar settings without coupling the
            # core validator to every future rule parameter.
            for key, value in raw.items():
                if key in {"id", "ruleId", "enabled", "priority"}:
                    continue
                if isinstance(value, (str, int, float, bool)) or value is None:
                    item[str(key)] = value
            normalized.append(item)
        candidate.risk_rule_overrides = normalized

    @staticmethod
    def _normalize_reasoning_model_policies(candidate: Settings) -> None:
        candidate.reasoning_model_policies = [
            policy.public_dict()
            for policy in normalize_reasoning_model_policies(
                candidate.reasoning_model_policies
            )
        ]

    @staticmethod
    def _validate_retry(candidate: Settings) -> None:
        if candidate.probe_transient_retry_base_seconds > candidate.probe_transient_retry_max_seconds:
            raise ValueError("探针重试基础等待不能大于最大等待")

    @staticmethod
    def _validate_request_audit(candidate: Settings) -> None:
        if not (
            candidate.request_audit_busy_scan_interval_seconds
            <= candidate.request_audit_normal_scan_interval_seconds
            <= candidate.request_audit_idle_scan_interval_seconds
        ):
            raise ValueError("请求审计间隔必须满足忙时 ≤ 常态 ≤ 闲时")

    @staticmethod
    def _validate_connection(candidate: Settings) -> None:
        parsed = urlsplit(candidate.grok2api_base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("grok2api 地址必须是有效的 HTTP(S) URL")

    @staticmethod
    def _validate_scheduler(candidate: Settings) -> None:
        try:
            zone = ZoneInfo(candidate.scheduler_timezone)
        except ZoneInfoNotFoundError as exc:
            raise ValueError("调度时区名称无效") from exc
        try:
            CronTrigger.from_crontab(candidate.recovery_cron, timezone=zone)
        except ValueError as exc:
            raise ValueError(f"隔离恢复 Cron 表达式无效: {exc}") from exc

    @staticmethod
    def _validate_route_prefix(candidate: Settings) -> None:
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{1,47}", candidate.probe_route_prefix):
            raise ValueError("临时资源前缀需为 2-48 位字母、数字、下划线或连字符")

    @staticmethod
    def _normalize_register_callback(candidate: Settings) -> None:
        candidate.register_callback_url = candidate.register_callback_url.strip()
        if not candidate.register_callback_enabled:
            return
        parsed = urlsplit(candidate.register_callback_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("开启回调通知前请填写有效的 HTTP(S) 通知地址")

    def _normalize_register_strategy(self, candidate: Settings) -> None:
        profile_ids = list(
            dict.fromkeys(
                str(value or "").strip()
                for value in candidate.register_probe_profile_ids
                if str(value or "").strip()
            )
        )
        if candidate.initial_probe_on_register and not profile_ids:
            raise ValueError("注册后探针至少选择一个探针方案")
        if candidate.register_probe_execution_mode not in {"chat", "quality_test"}:
            raise ValueError("注册探针执行模式无效")
        targets = self._normalize_register_targets(candidate.register_probe_proxy_targets)
        if candidate.initial_probe_on_register and not targets:
            raise ValueError("注册后探针至少选择一个出口目标")
        if candidate.register_probe_execution_mode == "quality_test" and any(
            target["kind"] != "egress" for target in targets
        ):
            raise ValueError("快速出口质量探针仅支持 grok_build 出口节点")
        if any(target["kind"] == "current" for target in targets) and any(
            target["kind"] != "current" for target in targets
        ):
            raise ValueError("账号当前出口不能与诊断出口混用")
        candidate.register_probe_profile_ids = profile_ids
        candidate.register_probe_proxy_targets = targets
        candidate.register_probe_profile_rounds = self._normalize_register_profile_rounds(
            profile_ids,
            candidate.register_probe_profile_rounds,
            candidate.register_probe_rounds,
        )

    @staticmethod
    def _normalize_register_profile_rounds(
        profile_ids: list[str],
        raw_rounds: dict[str, object] | None,
        default_rounds: int,
    ) -> dict[str, int]:
        source = raw_rounds if isinstance(raw_rounds, dict) else {}
        normalized: dict[str, int] = {}
        for profile_id in profile_ids:
            raw = source.get(profile_id, default_rounds)
            try:
                value = int(raw)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"探针方案 {profile_id} 的执行轮数无效") from exc
            if value < 1 or value > 20:
                raise ValueError(f"探针方案 {profile_id} 的执行轮数需在 1–20 之间")
            normalized[profile_id] = value
        return normalized

    @staticmethod
    def _normalize_register_targets(
        raw_targets: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        targets: list[dict[str, object]] = []
        seen_targets: set[tuple[str, int | None]] = set()
        for raw in raw_targets:
            kind = str(raw.get("kind") or "").strip()
            raw_id = raw.get("id")
            if kind in {"current", "direct"}:
                target_id = None
            elif kind == "egress":
                try:
                    target_id = int(raw_id)
                except (TypeError, ValueError) as exc:
                    raise ValueError("注册探针出口节点 ID 无效") from exc
                if target_id <= 0:
                    raise ValueError("注册探针出口节点 ID 必须大于 0")
            else:
                raise ValueError("注册探针出口目标类型无效")
            key = (kind, target_id)
            if key not in seen_targets:
                targets.append({"kind": kind, "id": target_id})
                seen_targets.add(key)
        return targets

    @staticmethod
    def _normalize_wechat(candidate: Settings) -> None:
        candidate.wechat_app_id = candidate.wechat_app_id.strip()
        candidate.wechat_app_secret = candidate.wechat_app_secret.strip()
        candidate.wechat_openid = candidate.wechat_openid.strip()
        candidate.wechat_template_id = candidate.wechat_template_id.strip()
        candidate.wechat_key_quality_template_id = (
            candidate.wechat_key_quality_template_id.strip()
        )
        candidate.wechat_upstream_health_template_id = (
            candidate.wechat_upstream_health_template_id.strip()
        )
        if not candidate.wechat_notification_enabled:
            return
        required = {
            "AppID": candidate.wechat_app_id,
            "AppSecret": candidate.wechat_app_secret,
            "OpenID": candidate.wechat_openid,
        }
        missing = [label for label, value in required.items() if not value]
        if missing:
            raise ValueError(f"开启微信推送前请填写：{'、'.join(missing)}")

    @staticmethod
    def _normalize_wechat_alerts(candidate: Settings) -> None:
        candidate.wechat_key_quality_keys = normalize_wechat_keys(
            candidate.wechat_key_quality_keys
        )
        if not candidate.wechat_notification_enabled:
            return
        if candidate.wechat_account_alert_enabled and not candidate.wechat_template_id:
            raise ValueError("开启账号异常通知前请填写对应模板 ID")
        if candidate.wechat_key_quality_enabled and not candidate.wechat_key_quality_template_id:
            raise ValueError("开启密钥正常率通知前请填写对应模板 ID")
        if (
            candidate.wechat_upstream_health_15m_enabled
            or candidate.wechat_upstream_health_30m_enabled
        ) and not candidate.wechat_upstream_health_template_id:
            raise ValueError("开启上游成功率通知前请填写对应模板 ID")

    @staticmethod
    def _normalize_sso_proxy(candidate: Settings) -> None:
        raw = (candidate.sso_proxy or "").strip()
        if not raw:
            candidate.sso_proxy = ""
            return
        candidate.sso_proxy = normalize_proxy(raw)


def normalize_wechat_keys(raw: list[object]) -> list[dict[str, object]]:
    values: list[dict[str, object]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("微信密钥通知项必须是对象")
        key_id = str(item.get("id") or "").strip()
        if not key_id:
            raise ValueError("微信密钥通知项缺少 Key ID")
        if len(key_id) > 160:
            raise ValueError("微信密钥 ID 不能超过 160 个字符")
        if key_id == "unlabeled":
            raise ValueError("未记录 Key 不能用于正常率通知")
        if key_id in seen:
            raise ValueError(f"微信密钥通知项重复: {key_id}")
        seen.add(key_id)
        name = str(item.get("name") or "").strip()
        if len(name) > 160:
            raise ValueError("微信密钥名称不能超过 160 个字符")
        normalized: dict[str, object] = {"id": key_id, "name": name}
        if "threshold" in item and item.get("threshold") is not None:
            try:
                threshold = float(item.get("threshold"))
            except (TypeError, ValueError) as exc:
                raise ValueError(f"微信密钥阈值无效: {key_id}") from exc
            if not 1 <= threshold <= 100:
                raise ValueError(f"微信密钥阈值需在 1–100 之间: {key_id}")
            normalized["threshold"] = round(threshold, 1)
        values.append(normalized)
    if len(values) > 100:
        raise ValueError("密钥正常率通知最多选择 100 个 Key")
    return values
