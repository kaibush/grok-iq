from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field, replace
from types import MappingProxyType
from typing import Any

from app.reasoning_policy import (
    ReasoningModelPolicy,
    default_reasoning_model_policies,
    normalize_reasoning_model_policies,
    resolve_reasoning_model_policy,
)


@dataclass(slots=True, frozen=True)
class RuleContext:
    """Normalized values made available to every sample risk rule.

    Keeping this context independent from the persistence models means a new
    rule can be registered once and reused by probe samples, request-audit
    rows, and future data sources without teaching each caller about the
    source-specific field names.
    """

    status_code: int
    output_tokens: int
    reasoning_tokens: int
    first_token_ms: int | None
    duration_ms: int
    generation_ms: int
    tps: float
    first_token_share: float
    buffered: bool
    expected_matched: bool | None
    scope: str = "probe"
    extra: Mapping[str, Any] = field(default_factory=dict)


@dataclass(slots=True, frozen=True)
class RuleMatch:
    """The result emitted by one registered rule."""

    classification: str
    severity: int = 0
    anomalous: bool = False
    hard: bool = False
    reason: str = ""


RuleEvaluator = Callable[[RuleContext, "Thresholds"], RuleMatch | None]
RuleReasonBuilder = Callable[[int, "Thresholds"], str]


@dataclass(slots=True, frozen=True)
class RiskRule:
    """A small, ordered, independently replaceable risk rule."""

    id: str
    label: str
    description: str
    evaluator: RuleEvaluator
    scopes: frozenset[str] = frozenset({"probe", "audit"})
    priority: int = 100
    configurable: bool = True
    default_enabled: bool = True
    classification: str = ""
    anomalous: bool = False
    hard: bool = False
    reason_builder: RuleReasonBuilder | None = None
    audit_action_mode: str = ""
    audit_min_count: int = 1


def risk_rule(
    *,
    rule_id: str,
    label: str,
    description: str,
    scopes: Iterable[str] = ("probe", "audit"),
    priority: int = 100,
    configurable: bool = True,
    default_enabled: bool = True,
    classification: str = "",
    anomalous: bool = False,
    hard: bool = False,
    reason_builder: RuleReasonBuilder | None = None,
    audit_action_mode: str = "",
    audit_min_count: int = 1,
) -> Callable[[RuleEvaluator], RuleEvaluator]:
    """Decorator for adding an extension rule with minimal boilerplate."""

    def decorate(evaluator: RuleEvaluator) -> RuleEvaluator:
        register_risk_rule(
            RiskRule(
                id=rule_id,
                label=label,
                description=description,
                evaluator=evaluator,
                scopes=frozenset(str(scope) for scope in scopes),
                priority=priority,
                configurable=configurable,
                default_enabled=default_enabled,
                classification=classification or rule_id,
                anomalous=anomalous,
                hard=hard,
                reason_builder=reason_builder,
                audit_action_mode=audit_action_mode,
                audit_min_count=max(1, int(audit_min_count)),
            )
        )
        return evaluator

    return decorate


class RiskRuleRegistry:
    """Registry used by all risk consumers.

    Integrations can call ``register`` at startup to add a rule.  Operators
    can then enable/disable or reprioritize it through ``risk_rule_overrides``
    without changing the evaluation pipeline.
    """

    def __init__(self) -> None:
        self._rules: dict[str, RiskRule] = {}

    def register(self, rule: RiskRule, *, replace: bool = False) -> RiskRule:
        normalized_id = str(rule.id or "").strip()
        if not normalized_id:
            raise ValueError("风险规则 ID 不能为空")
        if normalized_id in self._rules and not replace:
            raise ValueError(f"风险规则已存在: {normalized_id}")
        if normalized_id != rule.id:
            rule = RiskRule(
                id=normalized_id,
                label=rule.label,
                description=rule.description,
                evaluator=rule.evaluator,
                scopes=rule.scopes,
                priority=rule.priority,
                configurable=rule.configurable,
                default_enabled=rule.default_enabled,
                classification=rule.classification,
                anomalous=rule.anomalous,
                hard=rule.hard,
                reason_builder=rule.reason_builder,
                audit_action_mode=rule.audit_action_mode,
                audit_min_count=rule.audit_min_count,
            )
        self._rules[normalized_id] = rule
        return rule

    def unregister(self, rule_id: str) -> None:
        self._rules.pop(str(rule_id or "").strip(), None)

    def get(self, rule_id: str) -> RiskRule | None:
        return self._rules.get(str(rule_id or "").strip())

    def all(self, *, scope: str | None = None) -> tuple[RiskRule, ...]:
        values = tuple(self._rules.values())
        if scope:
            values = tuple(rule for rule in values if scope in rule.scopes)
        return tuple(sorted(values, key=lambda rule: (rule.priority, rule.id)))

    def definitions(
        self,
        *,
        thresholds: Thresholds | None = None,
        scope: str | None = None,
    ) -> list[dict[str, Any]]:
        values = [
            {
                "id": rule.id,
                "label": rule.label,
                "description": rule.description,
                "scopes": sorted(rule.scopes),
                "priority": rule_priority(rule, thresholds),
                "enabled": rule_enabled(rule, thresholds),
                "configurable": rule.configurable,
                "defaultEnabled": rule.default_enabled,
                "classification": rule.classification or rule.id,
                "anomalous": rule.anomalous,
                "hard": rule.hard,
                "auditActionMode": rule.audit_action_mode,
                "auditMinCount": rule_candidate_min_count(rule, thresholds),
            }
            for rule in self.all(scope=scope)
        ]
        return sorted(values, key=lambda value: (value["priority"], value["id"]))

    def evaluate(
        self,
        context: RuleContext,
        thresholds: Thresholds,
    ) -> tuple[RiskRule, RuleMatch] | None:
        for rule in _sorted_rules(self, scope=context.scope, thresholds=thresholds):
            if not rule_enabled(rule, thresholds):
                continue
            match = rule.evaluator(context, thresholds)
            if match is not None:
                return rule, match
        return None


def _override_map(value: Any) -> dict[str, dict[str, Any]]:
    """Normalize list/dict settings while tolerating future fields."""

    if isinstance(value, Mapping):
        source = value.items()
        result: dict[str, dict[str, Any]] = {}
        for raw_id, raw_config in source:
            rule_id = str(raw_id or "").strip()
            if not rule_id:
                continue
            result[rule_id] = (
                dict(raw_config) if isinstance(raw_config, Mapping) else {}
            )
        return result
    result = {}
    if isinstance(value, (list, tuple)):
        for raw in value:
            if not isinstance(raw, Mapping):
                continue
            rule_id = str(raw.get("id") or raw.get("ruleId") or "").strip()
            if not rule_id:
                continue
            result[rule_id] = {
                key: item
                for key, item in raw.items()
                if key not in {"id", "ruleId"}
            }
    return result


def rule_override(thresholds: Thresholds, rule_id: str) -> Mapping[str, Any]:
    return thresholds._risk_rule_override_map.get(rule_id, {})


def rule_enabled(rule: RiskRule, thresholds: Thresholds | None) -> bool:
    if not rule.configurable:
        return rule.default_enabled
    enabled = rule.default_enabled
    if thresholds is not None:
        override = rule_override(thresholds, rule.id)
        if "enabled" in override:
            enabled = bool(override["enabled"])
        # Keep the original dedicated switch as a compatibility alias.
        if rule.id == "reasoning_zero" and not thresholds.reasoning_zero_risk_enabled:
            enabled = False
        if rule.id == "media_input_observe" and not thresholds.media_input_observe_enabled:
            enabled = False
    return enabled


def risk_rule_enabled(rule_id: str, thresholds: Thresholds) -> bool:
    rule = DEFAULT_RISK_RULES.get(rule_id)
    return bool(rule and rule_enabled(rule, thresholds))


def classification_enabled(
    classification: str,
    thresholds: Thresholds,
) -> bool:
    for rule in DEFAULT_RISK_RULES.all():
        if (rule.classification or rule.id) == classification:
            return rule_enabled(rule, thresholds)
    return False


def get_risk_rule(rule_id: str) -> RiskRule | None:
    return DEFAULT_RISK_RULES.get(rule_id)


def rule_candidate_min_count(
    rule: RiskRule,
    thresholds: Thresholds | None,
) -> int:
    value: Any = rule.audit_min_count
    if thresholds is not None:
        value = rule_override(thresholds, rule.id).get("minCount", value)
    try:
        return max(1, int(value))
    except (TypeError, ValueError, OverflowError):
        return max(1, rule.audit_min_count)


def rule_priority(rule: RiskRule, thresholds: Thresholds | None) -> int:
    if thresholds is None:
        return rule.priority
    value = rule_override(thresholds, rule.id).get("priority", rule.priority)
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return rule.priority


def _sorted_rules(
    registry: RiskRuleRegistry,
    *,
    scope: str,
    thresholds: Thresholds,
) -> tuple[RiskRule, ...]:
    return tuple(
        sorted(
            registry.all(scope=scope),
            key=lambda rule: (rule_priority(rule, thresholds), rule.id),
        )
    )


@dataclass(slots=True, frozen=True)
class Thresholds:
    degradation_tps: float = 150
    strong_degradation_tps: float = 500
    probe_tps_override_enabled: bool = False
    probe_tps_override_mode: str = ""
    probe_tps_override_min_first_token_ms: int = 5000
    probe_tps_override_max_generation_ms: int = 1000
    minimum_output_tokens: int = 32
    buffer_first_token_share: float = 0.85
    min_generation_ms: int = 250
    consecutive_anomalies: int = 3
    cumulative_anomaly_rate: float = 0.5
    high_risk_hard_count: int = 2
    risk_anomaly_rate_weight: float = 30
    risk_hard_weight: float = 6
    risk_hard_cap: float = 24
    risk_fast_weight: float = 12
    risk_fast_cap: float = 30
    risk_marker_miss_weight: float = 16
    risk_marker_miss_cap: float = 32
    risk_streak_weight: float = 3
    risk_streak_cap: float = 15
    risk_score_cap: float = 100
    risk_watch_floor: float = 15
    risk_suspect_floor: float = 50
    risk_high_floor: float = 75
    reasoning_zero_risk_enabled: bool = True
    reasoning_model_policies: tuple[dict[str, Any], ...] | list[dict[str, Any]] = field(
        default_factory=default_reasoning_model_policies
    )
    media_input_observe_enabled: bool = True
    request_audit_risk_enabled: bool = True
    # A list/dict of {id, enabled, priority, ...} overrides.  Unknown IDs are
    # intentionally retained so a later plugin can become active without a
    # settings migration.
    risk_rule_overrides: Mapping[str, Any] | tuple[dict[str, Any], ...] = field(
        default_factory=dict
    )
    _risk_rule_override_map: Mapping[str, Mapping[str, Any]] = field(
        init=False,
        repr=False,
        compare=False,
    )
    _reasoning_model_policies: tuple[ReasoningModelPolicy, ...] = field(
        init=False,
        repr=False,
        compare=False,
    )

    def __post_init__(self) -> None:
        normalized = {
            rule_id: MappingProxyType(dict(config))
            for rule_id, config in _override_map(self.risk_rule_overrides).items()
        }
        object.__setattr__(
            self,
            "_risk_rule_override_map",
            MappingProxyType(normalized),
        )
        object.__setattr__(
            self,
            "_reasoning_model_policies",
            normalize_reasoning_model_policies(self.reasoning_model_policies),
        )

    def reasoning_policy(
        self,
        *,
        model_upstream_model: str = "",
        model_public_id: str = "",
        operation: str = "",
        media_input_images: int = 0,
    ) -> ReasoningModelPolicy:
        return resolve_reasoning_model_policy(
            self._reasoning_model_policies,
            model_upstream_model=model_upstream_model,
            model_public_id=model_public_id,
            operation=operation,
            media_input_images=media_input_images,
        )


@dataclass(slots=True, frozen=True)
class SampleMetrics:
    status_code: int
    output_tokens: int
    reasoning_tokens: int
    first_token_ms: int | None
    duration_ms: int
    egress_key: str
    expected_matched: bool | None = None
    model_upstream_model: str = ""
    model_public_id: str = ""
    operation: str = "chat"
    reasoning_tokens_reported: bool = False
    media_input_images: int = 0
    # When available, use grok2api's server-side TPS instead of reconstructing
    # it from locally observed stream timing.
    measured_tps: float | None = None
    # True/False when the probe stream is known; None for request-audit rows.
    has_reasoning_text: bool | None = None


@dataclass(slots=True, frozen=True)
class Classification:
    name: str
    severity: int
    tps: float
    generation_ms: int
    first_token_share: float
    anomalous: bool
    hard: bool
    buffered: bool
    rule_id: str = ""
    rule_ids: tuple[str, ...] = ()
    reasons: tuple[str, ...] = ()


def _match_classification(
    *,
    rule: RiskRule,
    match: RuleMatch,
    tps: float,
    generation_ms: int,
    first_token_share: float,
    buffered: bool,
) -> Classification:
    reason = match.reason or rule.label
    return Classification(
        match.classification,
        match.severity,
        tps,
        generation_ms,
        first_token_share,
        match.anomalous,
        match.hard,
        buffered,
        rule.id,
        (rule.id,),
        (reason,),
    )


def _context_error_code(context: RuleContext) -> str:
    extra = context.extra or {}
    return str(extra.get("error_code") or extra.get("errorCode") or "").strip()


def _rule_http_error(context: RuleContext, _thresholds: Thresholds) -> RuleMatch | None:
    error_code = _context_error_code(context)
    if context.status_code < 200 or context.status_code >= 300 or error_code:
        reason = f"上游异常：{error_code}" if error_code else ""
        return RuleMatch("error", severity=1, reason=reason)
    return None


def _rule_unmeasurable(context: RuleContext, _thresholds: Thresholds) -> RuleMatch | None:
    if context.first_token_ms is None or context.duration_ms <= context.first_token_ms:
        return RuleMatch("unmeasurable")
    return None


def _rule_marker_miss(context: RuleContext, _thresholds: Thresholds) -> RuleMatch | None:
    if context.scope == "probe" and context.expected_matched is False:
        return RuleMatch(
            "marker_miss",
            severity=5,
            anomalous=True,
            hard=True,
            reason="预期输出标记缺失",
        )
    return None


def _rule_insufficient_output(
    context: RuleContext, thresholds: Thresholds
) -> RuleMatch | None:
    if (
        context.scope == "probe"
        and context.output_tokens < thresholds.minimum_output_tokens
    ):
        return RuleMatch("insufficient")
    return None


def reasoning_model_policy(
    context: RuleContext,
    thresholds: Thresholds,
) -> ReasoningModelPolicy:
    return thresholds.reasoning_policy(
        model_upstream_model=str(
            context.extra.get("model_upstream_model")
            or context.extra.get("modelUpstreamModel")
            or ""
        ),
        model_public_id=str(
            context.extra.get("model_public_id")
            or context.extra.get("modelPublicId")
            or ""
        ),
        operation=str(context.extra.get("operation") or ""),
        media_input_images=_media_input_images(context),
    )


MEDIA_INPUT_REASONING_ZERO_REASON = (
    "Media Input 请求思考输出为 0，仅观察，不作为隔离或停用依据"
)


def media_input_blocks_reasoning_action(media_input_images: int) -> bool:
    """Media requests may be watched for thinking gaps, but never isolate."""

    return media_input_images > 0


def reasoning_zero_applicable(
    context: RuleContext,
    thresholds: Thresholds,
) -> tuple[ReasoningModelPolicy, bool]:
    policy = reasoning_model_policy(context, thresholds)
    reported = context.extra.get("reasoning_tokens_reported")
    if reported is None:
        reported = context.extra.get("reasoningTokensReported")
    applicable = bool(
        policy.mode in {"required", "observe"}
        and reported is True
        and context.status_code >= 200
        and context.status_code < 300
        and not _context_error_code(context)
        and context.output_tokens >= policy.minimum_output_tokens
    )
    return policy, applicable


def _rule_reasoning_zero(context: RuleContext, thresholds: Thresholds) -> RuleMatch | None:
    policy, applicable = reasoning_zero_applicable(context, thresholds)
    if (
        applicable
        and context.reasoning_tokens <= 0
    ):
        media_observe_only = media_input_blocks_reasoning_action(
            _media_input_images(context)
        )
        required = policy.mode == "required" and not media_observe_only
        classification = "reasoning_zero" if required else "reasoning_zero_observe"
        if media_observe_only:
            reason = MEDIA_INPUT_REASONING_ZERO_REASON
        elif required and context.scope == "audit":
            reason = (
                "思考输出为 0 候选；同账号、上游模型和请求类型连续 "
                f"{policy.min_count} 次后升级高风险"
            )
        elif required:
            reason = "模型策略要求思考输出，但本次思考 Token 为 0"
        else:
            reason = "当前模型与请求类型仅观察思考输出为 0"
        return RuleMatch(
            classification,
            severity=3 if required else 1,
            anomalous=True,
            # A single zero is an observation for every source. The audit
            # evaluator and probe aggregation promote a consecutive required
            # sequence only after its model policy threshold is reached.
            hard=False,
            reason=reason,
        )
    return None


def _media_input_images(context: RuleContext) -> int:
    value = context.extra.get("media_input_images")
    if value is None:
        value = context.extra.get("mediaInputImages")
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError, OverflowError):
        return 0


def _rule_media_input_observe(
    context: RuleContext, thresholds: Thresholds
) -> RuleMatch | None:
    images = _media_input_images(context)
    if images > 0 and context.tps >= thresholds.degradation_tps:
        return RuleMatch(
            "media_input_observe",
            severity=1,
            anomalous=True,
            reason=(
                f"Media Input {images} 张，TPS {context.tps:.1f} 暂按观察"
            ),
        )
    return None


def _rule_buffered_soft(context: RuleContext, thresholds: Thresholds) -> RuleMatch | None:
    if (
        thresholds.degradation_tps <= context.tps < thresholds.strong_degradation_tps
        and context.buffered
    ):
        return RuleMatch(
            "buffered_soft",
            severity=1,
            anomalous=True,
            reason=f"TPS ≥ {thresholds.degradation_tps:g} 且存在缓冲特征",
        )
    return None


def _rule_elevated(context: RuleContext, thresholds: Thresholds) -> RuleMatch | None:
    if thresholds.degradation_tps <= context.tps < thresholds.strong_degradation_tps:
        return RuleMatch(
            "elevated",
            severity=1,
            anomalous=True,
            reason=f"TPS ≥ {thresholds.degradation_tps:g}",
        )
    return None


def _rule_buffered_hard(context: RuleContext, thresholds: Thresholds) -> RuleMatch | None:
    if context.tps >= thresholds.strong_degradation_tps and context.buffered:
        return RuleMatch(
            "buffered_hard",
            severity=2,
            anomalous=True,
            hard=True,
            reason=f"TPS ≥ {thresholds.strong_degradation_tps:g} 且存在缓冲特征",
        )
    return None


def _rule_fast_risk(context: RuleContext, thresholds: Thresholds) -> RuleMatch | None:
    if context.tps >= thresholds.strong_degradation_tps:
        return RuleMatch(
            "fast_risk",
            severity=4,
            anomalous=True,
            hard=True,
            reason=f"TPS ≥ {thresholds.strong_degradation_tps:g}",
        )
    return None


DEFAULT_RISK_RULES = RiskRuleRegistry()
for _builtin_rule in (
    RiskRule(
        "http_error",
        "请求错误",
        "非 2xx 或带上游错误码的响应不参与风险统计",
        _rule_http_error,
        priority=10,
        configurable=False,
    ),
    RiskRule(
        "unmeasurable",
        "不可测量",
        "缺少有效首 Token/生成窗口",
        _rule_unmeasurable,
        scopes=frozenset({"probe"}),
        priority=20,
        configurable=False,
    ),
    RiskRule(
        "marker_miss",
        "标记缺失",
        "探针预期输出未匹配",
        _rule_marker_miss,
        scopes=frozenset({"probe"}),
        priority=30,
        classification="marker_miss",
        anomalous=True,
        hard=True,
        reason_builder=lambda count, _thresholds: f"预期标记缺失 {count} 次",
    ),
    RiskRule(
        "insufficient_output",
        "输出不足",
        "探针输出 Token 少于最低要求",
        _rule_insufficient_output,
        scopes=frozenset({"probe"}),
        priority=40,
    ),
    RiskRule(
        "reasoning_zero",
        "思考输出为 0",
        (
            "按上游模型、请求类型、字段上报和连续次数识别思考输出为 0；"
            "含 Media Input 的请求只观察，不升级隔离或停用"
        ),
        _rule_reasoning_zero,
        # Throughput and Media Input rules run first so an observed reasoning
        # gap cannot hide an independently high TPS signal. Consecutive
        # reasoning promotion is evaluated separately by the audit/probe
        # aggregators and therefore remains available when another rule wins.
        priority=110,
        classification="reasoning_zero",
        anomalous=True,
        hard=False,
        reason_builder=lambda count, _thresholds: (
            f"成功请求思考输出为 0 共 {count} 次"
        ),
        audit_action_mode="quarantine",
        audit_min_count=2,
    ),
    RiskRule(
        "media_input_observe",
        "Media Input 暂时观察",
        "审计请求包含媒体输入且 TPS 达到异常阈值时只记为观察，避免媒体 Token/TPS 偏高直接触发账号处置",
        _rule_media_input_observe,
        scopes=frozenset({"audit"}),
        priority=60,
        classification="media_input_observe",
        anomalous=True,
    ),
    RiskRule(
        "buffered_soft",
        "缓冲型异常",
        "异常 TPS 同时满足缓冲特征",
        _rule_buffered_soft,
        scopes=frozenset({"probe"}),
        priority=70,
        classification="buffered_soft",
        anomalous=True,
    ),
    RiskRule(
        "elevated_tps",
        "TPS 异常",
        "TPS 达到异常阈值但未达到强异常",
        _rule_elevated,
        priority=80,
        classification="elevated",
        anomalous=True,
    ),
    RiskRule(
        "buffered_hard",
        "缓冲型强异常",
        "强异常 TPS 同时满足缓冲特征",
        _rule_buffered_hard,
        scopes=frozenset({"probe"}),
        priority=90,
        classification="buffered_hard",
        anomalous=True,
        hard=True,
    ),
    RiskRule(
        "fast_risk",
        "高速强异常",
        "TPS 达到强异常阈值",
        _rule_fast_risk,
        priority=100,
        classification="fast_risk",
        anomalous=True,
        hard=True,
        reason_builder=lambda count, _thresholds: (
            f"持续生成型高速样本 {count} 次"
        ),
        audit_action_mode="tps_only",
        audit_min_count=2,
    ),
):
    DEFAULT_RISK_RULES.register(_builtin_rule)


def register_risk_rule(rule: RiskRule, *, replace: bool = False) -> RiskRule:
    """Register a rule for all subsequently evaluated samples."""

    return DEFAULT_RISK_RULES.register(rule, replace=replace)


def risk_rule_definitions(
    thresholds: Thresholds | None = None,
    *,
    scope: str | None = None,
) -> list[dict[str, Any]]:
    return DEFAULT_RISK_RULES.definitions(thresholds=thresholds, scope=scope)


def active_anomaly_classifications(thresholds: Thresholds | None = None) -> set[str]:
    result: set[str] = set()
    for rule in DEFAULT_RISK_RULES.all():
        if thresholds is not None and not rule_enabled(rule, thresholds):
            continue
        if rule.anomalous:
            result.add(rule.classification or rule.id)
            if rule.id == "reasoning_zero":
                result.add("reasoning_zero_observe")
    return result


def rule_metadata(rule_id: str) -> RuleMatch | None:
    """Return conservative metadata for persisted classification names."""

    mapping = {
        "elevated": RuleMatch("elevated", severity=1, anomalous=True),
        "buffered_soft": RuleMatch("buffered_soft", severity=1, anomalous=True),
        "buffered_hard": RuleMatch("buffered_hard", severity=2, anomalous=True, hard=True),
        "fast_risk": RuleMatch("fast_risk", severity=4, anomalous=True, hard=True),
        "marker_miss": RuleMatch("marker_miss", severity=5, anomalous=True, hard=True),
        # The persisted name represents both the initial observation and a
        # promoted consecutive signal. ``ProbeSample.severity`` distinguishes
        # the latter for hard-signal trend queries; the name alone is not hard.
        "reasoning_zero": RuleMatch("reasoning_zero", severity=3, anomalous=True),
        "reasoning_zero_observe": RuleMatch(
            "reasoning_zero_observe", severity=1, anomalous=True
        ),
    }
    if rule_id in mapping:
        return mapping[rule_id]
    rule = DEFAULT_RISK_RULES.get(rule_id)
    if rule is None:
        for candidate in DEFAULT_RISK_RULES.all():
            if (candidate.classification or candidate.id) == rule_id:
                rule = candidate
                break
    if rule is None:
        return None
    return RuleMatch(
        rule.classification or rule.id,
        anomalous=rule.anomalous,
        hard=rule.hard,
    )


def aggregate_rule_reasons(
    rule_counts: Mapping[str, int],
    thresholds: Thresholds,
) -> list[str]:
    reasons: list[str] = []
    for rule in _sorted_rules(
        DEFAULT_RISK_RULES,
        scope="probe",
        thresholds=thresholds,
    ):
        count = int(rule_counts.get(rule.classification or rule.id, 0) or 0)
        if count <= 0:
            continue
        if rule.reason_builder is not None:
            reasons.append(rule.reason_builder(count, thresholds))
        elif rule.anomalous:
            reasons.append(f"{rule.label} {count} 次")
    return reasons


def thresholds_from_settings(settings: Any) -> Thresholds:
    values: dict[str, Any] = {}
    for field_name, field_info in Thresholds.__dataclass_fields__.items():
        if not field_info.init or not hasattr(settings, field_name):
            continue
        values[field_name] = getattr(settings, field_name)
    return Thresholds(**values)


def probe_tps_override_mode(thresholds: Thresholds) -> str:
    mode = str(getattr(thresholds, "probe_tps_override_mode", "") or "").strip()
    if mode in {"generation_window", "missing_reasoning", "off"}:
        return mode
    return "generation_window" if thresholds.probe_tps_override_enabled else "off"


def classify_sample(sample: SampleMetrics, thresholds: Thresholds) -> Classification:
    upstream_tps = 0.0
    if sample.first_token_ms is None:
        generation_ms = 0
        tps = 0.0
        first_token_share = 0.0
    else:
        generation_ms = sample.duration_ms - sample.first_token_ms
        upstream_tps = (
            float(sample.measured_tps)
            if sample.measured_tps is not None
            else (
                sample.output_tokens * 1000.0 / generation_ms
                if sample.output_tokens > 0 and generation_ms > 0
                else 0.0
            )
        )
        tps = effective_probe_tps(
            output_tokens=sample.output_tokens,
            reasoning_tokens=sample.reasoning_tokens,
            first_token_ms=sample.first_token_ms,
            generation_ms=generation_ms,
            upstream_tps=upstream_tps,
            thresholds=thresholds,
            has_reasoning_text=sample.has_reasoning_text,
        )
        first_token_share = (
            sample.first_token_ms / sample.duration_ms
            if sample.duration_ms > 0
            else 0.0
        )
    buffered = bool(
        sample.first_token_ms is not None
        and generation_ms > 0
        and (
            first_token_share >= thresholds.buffer_first_token_share
            or generation_ms < thresholds.min_generation_ms
        )
    )
    context = RuleContext(
        status_code=sample.status_code,
        output_tokens=sample.output_tokens,
        reasoning_tokens=sample.reasoning_tokens,
        first_token_ms=sample.first_token_ms,
        duration_ms=sample.duration_ms,
        generation_ms=generation_ms,
        tps=tps,
        first_token_share=first_token_share,
        buffered=buffered,
        expected_matched=sample.expected_matched,
        scope="probe",
        extra={
            "model_upstream_model": sample.model_upstream_model,
            "model_public_id": sample.model_public_id,
            "operation": sample.operation,
            "reasoning_tokens_reported": sample.reasoning_tokens_reported,
            "media_input_images": sample.media_input_images,
        },
    )
    evaluated = DEFAULT_RISK_RULES.evaluate(context, thresholds)
    if evaluated is None:
        classification = Classification(
            "normal",
            0,
            tps,
            generation_ms,
            first_token_share,
            False,
            False,
            buffered,
        )
    else:
        rule, match = evaluated
        classification = _match_classification(
            rule=rule,
            match=match,
            tps=tps,
            generation_ms=generation_ms,
            first_token_share=first_token_share,
            buffered=buffered,
        )
    return _with_override_tps_reason(
        classification,
        upstream_tps=upstream_tps,
        generation_ms=generation_ms,
        thresholds=thresholds,
    )


def generation_window_tps(output_tokens: int, generation_ms: int) -> float:
    if output_tokens <= 0 or generation_ms <= 0:
        return 0.0
    return output_tokens * 1000.0 / generation_ms


def effective_probe_tps(
    *,
    output_tokens: int,
    reasoning_tokens: int,
    first_token_ms: int | None,
    generation_ms: int,
    upstream_tps: float,
    thresholds: Thresholds,
    has_reasoning_text: bool | None = None,
) -> float:
    """Return TPS used for probe/audit risk.

    grok2api deflates flush rows to output / duration when the generation
    tail is under 1000ms. That hides the burst the operator actually sees.
    When a selected clue matches, grok-iq restores output / generation window.
    """
    if not should_override_probe_tps(
        output_tokens=output_tokens,
        reasoning_tokens=reasoning_tokens,
        first_token_ms=first_token_ms,
        generation_ms=generation_ms,
        thresholds=thresholds,
        has_reasoning_text=has_reasoning_text,
    ):
        return upstream_tps
    return generation_window_tps(output_tokens, generation_ms)


def should_override_probe_tps(
    *,
    output_tokens: int,
    reasoning_tokens: int,
    first_token_ms: int | None,
    generation_ms: int,
    thresholds: Thresholds,
    has_reasoning_text: bool | None = None,
) -> bool:
    mode = probe_tps_override_mode(thresholds)
    if mode == "off" or output_tokens <= 0 or generation_ms <= 0:
        return False
    if mode == "missing_reasoning":
        return reasoning_tokens > 0 and has_reasoning_text is False
    if not (
        reasoning_tokens > 0
        and first_token_ms is not None
        and first_token_ms >= thresholds.probe_tps_override_min_first_token_ms
    ):
        return False
    if generation_ms <= thresholds.probe_tps_override_max_generation_ms:
        return True
    generation_tps = generation_window_tps(output_tokens, generation_ms)
    return bool(
        generation_ms < first_token_ms
        and generation_tps >= thresholds.strong_degradation_tps
    )


def _override_tps_reason(
    *,
    mode: str,
    upstream_tps: float,
    generation_ms: int,
    tps: float,
) -> str | None:
    if abs(upstream_tps - tps) <= 0.01:
        return None
    if mode == "missing_reasoning":
        return (
            "缺失思考正文 TPS 重算："
            f"上游上报了推理 Token 但没有思考正文，按 {generation_ms}ms "
            f"生成窗口从 {upstream_tps:.1f} 重算为 {tps:.1f}"
        )
    return (
        "短窗口 TPS 重算："
        f"上游 {upstream_tps:.1f} 被压成全程均速，按 {generation_ms}ms "
        f"生成窗口重算为 {tps:.1f}"
    )


def _with_override_tps_reason(
    classification: Classification,
    *,
    upstream_tps: float,
    generation_ms: int,
    thresholds: Thresholds,
) -> Classification:
    reason = _override_tps_reason(
        mode=probe_tps_override_mode(thresholds),
        upstream_tps=upstream_tps,
        generation_ms=generation_ms,
        tps=classification.tps,
    )
    if reason is None:
        return classification
    return replace(
        classification,
        reasons=tuple(dict.fromkeys((*classification.reasons, reason))),
    )


def classify_audit_sample(
    *,
    status_code: int,
    output_tokens: int,
    reasoning_tokens: int,
    first_token_ms: int | None,
    duration_ms: int,
    tps: float | None,
    thresholds: Thresholds,
    expected_matched: bool | None = None,
    extra: Mapping[str, Any] | None = None,
) -> Classification:
    """Classify an upstream request-audit row using the same rule registry.

    Audit rows do not carry probe marker/buffering evidence, so only rules
    registered for the ``audit`` scope participate.  The returned names stay
    compatible with the existing request-audit API (``watch``/``high``).
    """

    measured_tps = max(0.0, float(tps or 0.0))
    safe_duration_ms = max(0, int(duration_ms or 0))
    generation_ms = max(0, safe_duration_ms - int(first_token_ms or 0))
    first_token_share = (
        int(first_token_ms or 0) / safe_duration_ms if safe_duration_ms > 0 else 0.0
    )
    buffered = bool(
        first_token_ms is not None
        and generation_ms > 0
        and (
            first_token_share >= thresholds.buffer_first_token_share
            or generation_ms < thresholds.min_generation_ms
        )
    )
    extra_values = extra or {}
    has_reasoning_text = extra_values.get("has_reasoning_text")
    if not isinstance(has_reasoning_text, bool):
        has_reasoning_text = None
    effective_tps = effective_probe_tps(
        output_tokens=max(0, int(output_tokens or 0)),
        reasoning_tokens=max(0, int(reasoning_tokens or 0)),
        first_token_ms=first_token_ms,
        generation_ms=generation_ms,
        upstream_tps=measured_tps,
        thresholds=thresholds,
        has_reasoning_text=has_reasoning_text,
    )
    context = RuleContext(
        status_code=int(status_code or 0),
        output_tokens=max(0, int(output_tokens or 0)),
        reasoning_tokens=max(0, int(reasoning_tokens or 0)),
        first_token_ms=first_token_ms,
        duration_ms=safe_duration_ms,
        generation_ms=generation_ms,
        tps=effective_tps,
        first_token_share=first_token_share,
        buffered=buffered,
        expected_matched=expected_matched,
        scope="audit",
        extra=extra or {},
    )
    if not thresholds.request_audit_risk_enabled:
        classification = Classification(
            "normal",
            0,
            effective_tps,
            generation_ms,
            first_token_share,
            False,
            False,
            buffered,
        )
    else:
        evaluated = DEFAULT_RISK_RULES.evaluate(context, thresholds)
        if evaluated is None:
            classification = Classification(
                "normal",
                0,
                effective_tps,
                generation_ms,
                first_token_share,
                False,
                False,
                buffered,
            )
        else:
            rule, match = evaluated
            if match.classification in {"error", "unmeasurable", "normal"}:
                classification = _match_classification(
                    rule=rule,
                    match=match,
                    tps=effective_tps,
                    generation_ms=generation_ms,
                    first_token_share=first_token_share,
                    buffered=buffered,
                )
            else:
                # Request-audit consumers use a compact severity vocabulary while the
                # persisted rule ID remains available for filtering and explanations.
                level = "high" if match.hard else "watch"
                mapped = RuleMatch(
                    classification=level,
                    severity=match.severity,
                    anomalous=True,
                    hard=match.hard,
                    reason=match.reason,
                )
                classification = _match_classification(
                    rule=rule,
                    match=mapped,
                    tps=effective_tps,
                    generation_ms=generation_ms,
                    first_token_share=first_token_share,
                    buffered=buffered,
                )
    return _with_override_tps_reason(
        classification,
        upstream_tps=measured_tps,
        generation_ms=generation_ms,
        thresholds=thresholds,
    )


def maximum_anomaly_streak(
    classifications: Iterable[str],
    anomaly_names: set[str] | frozenset[str] | None = None,
) -> int:
    active_names = anomaly_names or active_anomaly_classifications()
    maximum = current = 0
    for name in classifications:
        if name in active_names:
            current += 1
            maximum = max(maximum, current)
        elif name not in {"error", "unmeasurable", "insufficient"}:
            current = 0
    return maximum


def risk_status(
    *,
    anomaly_count: int,
    hard_count: int,
    fast_count: int,
    marker_miss_count: int,
    anomaly_streak: int,
    sample_count: int,
    thresholds: Thresholds,
    reasoning_zero_count: int = 0,
) -> tuple[str, float, list[str]]:
    reasons: list[str] = []
    anomaly_rate = anomaly_count / sample_count if sample_count else 0.0
    consecutive = anomaly_streak >= thresholds.consecutive_anomalies
    cumulative = (
        anomaly_count >= thresholds.consecutive_anomalies
        and anomaly_rate >= thresholds.cumulative_anomaly_rate
    )
    repeated = consecutive or cumulative
    strong_repeated = repeated and hard_count >= thresholds.high_risk_hard_count
    if consecutive:
        reasons.append(f"风险周期连续降智信号达到 {thresholds.consecutive_anomalies} 次")
    elif cumulative:
        reasons.append(
            f"风险周期降智信号占比 {anomaly_count}/{sample_count}，达到 "
            f"{thresholds.cumulative_anomaly_rate:.0%}"
        )
    if fast_count:
        reasons.append(f"持续生成型高速样本 {fast_count} 次")
    if marker_miss_count:
        reasons.append(f"预期标记缺失 {marker_miss_count} 次")
    if reasoning_zero_count:
        reasons.append(f"成功请求思考输出为 0 共 {reasoning_zero_count} 次")
    if hard_count:
        reasons.append(f"强降智信号 {hard_count} 次")

    score = min(
        thresholds.risk_score_cap,
        anomaly_rate * thresholds.risk_anomaly_rate_weight
        + min(hard_count * thresholds.risk_hard_weight, thresholds.risk_hard_cap)
        + min(fast_count * thresholds.risk_fast_weight, thresholds.risk_fast_cap)
        + min(
            marker_miss_count * thresholds.risk_marker_miss_weight,
            thresholds.risk_marker_miss_cap,
        )
        + min(
            anomaly_streak * thresholds.risk_streak_weight,
            thresholds.risk_streak_cap,
        ),
    )

    if strong_repeated:
        return "high_risk", round(max(score, thresholds.risk_high_floor), 1), reasons
    if repeated:
        return "suspect", round(max(score, thresholds.risk_suspect_floor), 1), reasons
    if anomaly_count:
        return "watch", round(max(score, thresholds.risk_watch_floor), 1), reasons
    return "healthy", round(score, 1), reasons
