from app.analyzer import (
    SampleMetrics,
    Thresholds,
    classify_audit_sample,
    classify_sample,
    risk_rule_definitions,
    risk_status,
)


def test_normal_throughput_does_not_fall_through_to_fast_risk():
    result = classify_sample(
        SampleMetrics(
            status_code=200,
            output_tokens=1753,
            reasoning_tokens=1161,
            first_token_ms=1210,
            duration_ms=25_446,
            egress_key="node:23",
        ),
        Thresholds(),
    )

    assert result.name == "normal"
    assert result.rule_id == ""
    assert result.tps < 150


def test_normal_audit_throughput_stays_normal():
    result = classify_audit_sample(
        status_code=200,
        output_tokens=1753,
        reasoning_tokens=1161,
        first_token_ms=1210,
        duration_ms=25_446,
        tps=72.3304,
        thresholds=Thresholds(),
    )

    assert result.name == "normal"
    assert result.rule_id == ""


def test_media_input_high_tps_is_observed_instead_of_high_risk():
    result = classify_audit_sample(
        status_code=200,
        output_tokens=42,
        reasoning_tokens=20,
        first_token_ms=3139,
        duration_ms=3149,
        tps=4200,
        thresholds=Thresholds(),
        extra={"media_input_images": 3},
    )

    assert result.name == "watch"
    assert result.rule_id == "media_input_observe"
    assert result.hard is False
    assert "Media Input" in result.reasons[0]


def test_media_input_observation_can_be_disabled():
    result = classify_audit_sample(
        status_code=200,
        output_tokens=42,
        reasoning_tokens=20,
        first_token_ms=3139,
        duration_ms=3149,
        tps=4200,
        thresholds=Thresholds(media_input_observe_enabled=False),
        extra={"media_input_images": 3},
    )

    assert result.name == "high"
    assert result.rule_id == "fast_risk"
    assert result.hard is True


def test_media_input_policy_keeps_reasoning_zero_as_observation():
    result = classify_audit_sample(
        status_code=200,
        output_tokens=42,
        reasoning_tokens=0,
        first_token_ms=3139,
        duration_ms=3149,
        tps=4200,
        thresholds=Thresholds(),
        extra={
            "media_input_images": 3,
            "model_upstream_model": "Build/grok-4.6",
            "operation": "messages",
            "reasoning_tokens_reported": True,
        },
    )

    assert result.name == "watch"
    assert result.rule_id == "media_input_observe"


def test_required_media_input_reasoning_zero_stays_observational():
    result = classify_audit_sample(
        status_code=200,
        output_tokens=155,
        reasoning_tokens=0,
        first_token_ms=100,
        duration_ms=1100,
        tps=40,
        thresholds=Thresholds(),
        extra={
            "media_input_images": 3,
            "model_upstream_model": "Build/grok-4.6",
            "operation": "chat",
            "reasoning_tokens_reported": True,
        },
    )

    assert result.name == "watch"
    assert result.hard is False
    assert result.rule_id == "reasoning_zero"
    assert any("不作为隔离或停用依据" in reason for reason in result.reasons)


def test_low_tps_buffering_does_not_trigger_buffered_hard():
    result = classify_sample(
        SampleMetrics(
            status_code=200,
            output_tokens=10,
            reasoning_tokens=5,
            first_token_ms=1000,
            duration_ms=1100,
            egress_key="node:23",
        ),
        Thresholds(minimum_output_tokens=1),
    )

    assert result.buffered is True
    assert result.tps == 100
    assert result.name == "normal"


def test_authoritative_upstream_tps_is_used_for_probe_classification():
    result = classify_sample(
        SampleMetrics(
            status_code=200,
            output_tokens=1932,
            reasoning_tokens=1885,
            first_token_ms=35_061,
            duration_ms=35_857,
            egress_key="node:38",
            measured_tps=53.88069275176395,
        ),
        Thresholds(),
    )

    assert result.tps == 53.88069275176395
    assert result.name == "normal"
    assert result.hard is False


def _flush_thresholds(**overrides):
    values = dict(
        probe_tps_override_enabled=True,
        probe_tps_override_min_first_token_ms=5000,
        probe_tps_override_max_generation_ms=800,
        strong_degradation_tps=240,
    )
    values.update(overrides)
    return Thresholds(**values)


def test_reasoning_burst_override_restores_generation_window_tps():
    result = classify_sample(
        SampleMetrics(
            status_code=200,
            output_tokens=1433,
            reasoning_tokens=1400,
            first_token_ms=23_309,
            duration_ms=23_809,
            egress_key="node:34",
            measured_tps=60.1873,
        ),
        _flush_thresholds(),
    )

    assert result.tps == 1433 * 1000 / 500
    assert result.name == "buffered_hard"
    assert any("短窗口 TPS 重算" in reason for reason in result.reasons)


def test_reasoning_burst_override_catches_window_between_max_and_grok2api_cliff():
    result = classify_sample(
        SampleMetrics(
            status_code=200,
            output_tokens=1234,
            reasoning_tokens=1176,
            first_token_ms=20_294,
            duration_ms=21_171,
            egress_key="node:34",
            measured_tps=58.2873,
        ),
        _flush_thresholds(),
    )

    assert result.tps == 1234 * 1000 / 877
    assert result.name == "buffered_hard"
    assert any("短窗口 TPS 重算" in reason for reason in result.reasons)


def test_reasoning_burst_override_keeps_already_high_generation_window_tps():
    measured = 1085 * 1000 / 1178
    result = classify_sample(
        SampleMetrics(
            status_code=200,
            output_tokens=1085,
            reasoning_tokens=1013,
            first_token_ms=14_655,
            duration_ms=15_833,
            egress_key="node:34",
            measured_tps=measured,
        ),
        _flush_thresholds(probe_tps_override_max_generation_ms=1000),
    )

    assert result.tps == measured
    assert result.name == "buffered_hard"


def test_reasoning_burst_override_requires_reasoning():
    thresholds = _flush_thresholds()
    no_reasoning = classify_sample(
        SampleMetrics(
            status_code=200,
            output_tokens=1234,
            reasoning_tokens=0,
            first_token_ms=20_294,
            duration_ms=21_171,
            egress_key="node:34",
            measured_tps=58.2873,
        ),
        thresholds,
    )
    long_generation = classify_sample(
        SampleMetrics(
            status_code=200,
            output_tokens=915,
            reasoning_tokens=890,
            first_token_ms=11_495,
            duration_ms=20_000,
            egress_key="node:38",
            measured_tps=78.0983,
        ),
        thresholds,
    )

    assert no_reasoning.tps == 58.2873
    assert long_generation.tps == 78.0983


def test_reasoning_burst_does_not_rewrite_real_generation_longer_than_first_token():
    result = classify_sample(
        SampleMetrics(
            status_code=200,
            output_tokens=1500,
            reasoning_tokens=100,
            first_token_ms=900,
            duration_ms=1900,
            egress_key="node:5",
            measured_tps=1500,
        ),
        _flush_thresholds(probe_tps_override_min_first_token_ms=0),
    )

    assert result.tps == 1500
    assert result.name == "fast_risk"


def test_audit_reasoning_burst_override_flags_deflated_upstream_tps():
    result = classify_audit_sample(
        status_code=200,
        output_tokens=1834,
        reasoning_tokens=1782,
        first_token_ms=24_540,
        duration_ms=25_307,
        tps=72.47,
        thresholds=_flush_thresholds(),
    )

    assert result.tps == 1834 * 1000 / 767
    assert result.name == "high"


def test_missing_reasoning_override_restores_generation_window_without_first_token_gate():
    result = classify_sample(
        SampleMetrics(
            status_code=200,
            output_tokens=1085,
            reasoning_tokens=1013,
            first_token_ms=3000,
            duration_ms=3400,
            egress_key="node:34",
            measured_tps=60.2,
            has_reasoning_text=False,
        ),
        Thresholds(
            probe_tps_override_enabled=True,
            probe_tps_override_mode="missing_reasoning",
            probe_tps_override_min_first_token_ms=5000,
            probe_tps_override_max_generation_ms=1000,
        ),
    )

    assert result.tps == 1085 * 1000 / 400
    assert any("缺失思考正文 TPS 重算" in reason for reason in result.reasons)


def test_missing_reasoning_override_keeps_upstream_tps_when_thinking_text_exists():
    result = classify_sample(
        SampleMetrics(
            status_code=200,
            output_tokens=1085,
            reasoning_tokens=1013,
            first_token_ms=3000,
            duration_ms=3400,
            egress_key="node:34",
            measured_tps=60.2,
            has_reasoning_text=True,
        ),
        Thresholds(
            probe_tps_override_enabled=True,
            probe_tps_override_mode="missing_reasoning",
        ),
    )

    assert result.tps == 60.2
    assert all("缺失思考正文 TPS 重算" not in reason for reason in result.reasons)


def test_missing_reasoning_override_skips_audit_rows_without_stream_text():
    result = classify_audit_sample(
        status_code=200,
        output_tokens=1834,
        reasoning_tokens=1782,
        first_token_ms=24_540,
        duration_ms=25_307,
        tps=72.47,
        thresholds=Thresholds(
            probe_tps_override_enabled=True,
            probe_tps_override_mode="missing_reasoning",
        ),
    )

    assert result.tps == 72.47


def test_generation_window_mode_ignores_missing_reasoning_text():
    result = classify_sample(
        SampleMetrics(
            status_code=200,
            output_tokens=1085,
            reasoning_tokens=1013,
            first_token_ms=3000,
            duration_ms=3400,
            egress_key="node:34",
            measured_tps=60.2,
            has_reasoning_text=False,
        ),
        _flush_thresholds(),
    )

    assert result.tps == 60.2


def test_classifies_delayed_burst_as_buffered_hard():
    result = classify_sample(
        SampleMetrics(
            status_code=200,
            output_tokens=1000,
            reasoning_tokens=200,
            first_token_ms=49_000,
            duration_ms=49_050,
            egress_key="node:3",
        ),
        Thresholds(),
    )
    assert result.name == "buffered_hard"
    assert result.buffered is True
    assert result.tps == 20_000


def test_classifies_sustained_high_speed_as_fast_risk():
    result = classify_sample(
        SampleMetrics(
            status_code=200,
            output_tokens=1500,
            reasoning_tokens=100,
            first_token_ms=900,
            duration_ms=1900,
            egress_key="node:5",
        ),
        Thresholds(),
    )
    assert result.name == "fast_risk"
    assert result.buffered is False


def test_single_required_reasoning_zero_is_an_observation():
    result = classify_sample(
        SampleMetrics(
            status_code=200,
            output_tokens=300,
            reasoning_tokens=0,
            first_token_ms=1000,
            duration_ms=5000,
            egress_key="node:3",
            model_upstream_model="Build/grok-4.6",
            operation="chat",
            reasoning_tokens_reported=True,
        ),
        Thresholds(),
    )
    assert result.name == "reasoning_zero"
    assert result.anomalous is True
    assert result.hard is False
    assert result.rule_id == "reasoning_zero"


def test_reasoning_zero_can_be_disabled_through_rule_overrides():
    result = classify_sample(
        SampleMetrics(
            status_code=200,
            output_tokens=300,
            reasoning_tokens=0,
            first_token_ms=1000,
            duration_ms=2000,
            egress_key="node:3",
        ),
        Thresholds(
            risk_rule_overrides=(
                {"id": "reasoning_zero", "enabled": False},
            )
        ),
    )

    assert result.name == "elevated"
    assert result.rule_id == "elevated_tps"


def test_risk_rule_catalog_exposes_order_and_scope():
    values = risk_rule_definitions(Thresholds(), scope="audit")

    assert [value["priority"] for value in values] == sorted(
        value["priority"] for value in values
    )
    assert any(
        value["id"] == "reasoning_zero" and value["enabled"]
        for value in values
    )


def test_repeated_strong_signals_become_high_risk():
    status, score, reasons = risk_status(
        anomaly_count=5,
        hard_count=4,
        fast_count=2,
        marker_miss_count=0,
        anomaly_streak=3,
        sample_count=8,
        thresholds=Thresholds(),
    )
    assert status == "high_risk"
    assert score >= 75
    assert any("风险周期" in reason for reason in reasons)


def test_repeated_soft_signals_remain_suspect():
    status, _, _ = risk_status(
        anomaly_count=3,
        hard_count=0,
        fast_count=0,
        marker_miss_count=0,
        anomaly_streak=3,
        sample_count=3,
        thresholds=Thresholds(),
    )
    assert status == "suspect"


def test_sparse_anomalies_do_not_become_suspect_from_count_alone():
    status, score, _ = risk_status(
        anomaly_count=3,
        hard_count=0,
        fast_count=0,
        marker_miss_count=0,
        anomaly_streak=1,
        sample_count=10,
        thresholds=Thresholds(),
    )
    assert status == "watch"
    assert score >= 15


def test_cumulative_majority_of_soft_signals_becomes_suspect():
    status, score, reasons = risk_status(
        anomaly_count=3,
        hard_count=0,
        fast_count=0,
        marker_miss_count=0,
        anomaly_streak=1,
        sample_count=5,
        thresholds=Thresholds(),
    )
    assert status == "suspect"
    assert score >= 50
    assert any("达到 50%" in reason for reason in reasons)


def test_custom_score_factors_change_risk_score():
    _, default_score, _ = risk_status(
        anomaly_count=1,
        hard_count=1,
        fast_count=1,
        marker_miss_count=0,
        anomaly_streak=1,
        sample_count=4,
        thresholds=Thresholds(),
    )
    status, custom_score, _ = risk_status(
        anomaly_count=1,
        hard_count=1,
        fast_count=1,
        marker_miss_count=0,
        anomaly_streak=1,
        sample_count=4,
        thresholds=Thresholds(
            risk_anomaly_rate_weight=40,
            risk_hard_weight=10,
            risk_hard_cap=10,
            risk_fast_weight=20,
            risk_fast_cap=20,
            risk_streak_weight=5,
            risk_streak_cap=5,
        ),
    )

    assert status == "watch"
    assert default_score == 28.5
    assert custom_score == 45


def test_custom_cumulative_rate_and_hard_count_change_status():
    suspect, _, reasons = risk_status(
        anomaly_count=3,
        hard_count=2,
        fast_count=0,
        marker_miss_count=0,
        anomaly_streak=1,
        sample_count=5,
        thresholds=Thresholds(
            cumulative_anomaly_rate=0.8,
            high_risk_hard_count=3,
        ),
    )
    high_risk, _, _ = risk_status(
        anomaly_count=3,
        hard_count=2,
        fast_count=0,
        marker_miss_count=0,
        anomaly_streak=1,
        sample_count=5,
        thresholds=Thresholds(
            cumulative_anomaly_rate=0.6,
            high_risk_hard_count=2,
        ),
    )

    assert suspect == "watch"
    assert not any("达到 80%" in reason for reason in reasons)
    assert high_risk == "high_risk"


def test_audit_upstream_error_code_is_not_a_successful_2xx():
    result = classify_audit_sample(
        status_code=200,
        output_tokens=0,
        reasoning_tokens=0,
        first_token_ms=None,
        duration_ms=129_727,
        tps=None,
        thresholds=Thresholds(),
        extra={"errorCode": "upstream_stream_interrupted"},
    )

    assert result.name == "error"
    assert result.rule_id == "http_error"
    assert "upstream_stream_interrupted" in result.reasons[0]
