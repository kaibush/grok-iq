from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.routing import APIRoute
from sqlalchemy import select

from app.core.config import DEFAULT_DATABASE_PATH, Settings, should_auto_isolate
from app.persistence.database import Database
from app.persistence.models import AppSetting
from app.persistence.settings_repository import SettingsRepository
from app.services.settings_service import RuntimeSettingsService
from app.web.routes.settings import build_settings_router
from app.web.schemas import RuntimeSettingsInput


def build_service(tmp_path: Path) -> tuple[Database, Settings, RuntimeSettingsService]:
    settings = Settings(database_path=tmp_path / "grokiq.db")
    database = Database(settings.database_path)
    database.initialize()
    repository = SettingsRepository(database, settings)
    return database, settings, RuntimeSettingsService(settings, repository)


def test_default_database_path_is_independent_of_working_directory():
    settings = Settings(_env_file=None)

    assert settings.database_path == DEFAULT_DATABASE_PATH
    assert settings.database_path == Path(__file__).resolve().parents[1] / "data" / "grokiq.db"


def test_runtime_settings_are_encrypted_masked_and_reloadable(tmp_path: Path):
    database, settings, service = build_service(tmp_path)
    changed = service.update(
        {
            "grok2api_base_url": "http://grok2api.test:8000",
            "grok2api_admin_password": "secret-password",
            "probe_worker_concurrency": 4,
        }
    )
    assert changed == [
        "grok2api_admin_password",
        "grok2api_base_url",
        "probe_worker_concurrency",
    ]
    assert settings.probe_worker_concurrency == 4
    public = service.public_view()
    assert public["grok2apiAdminPasswordConfigured"] is True
    assert "secret-password" not in json.dumps(public)

    with database.session() as session:
        stored = session.scalar(select(AppSetting).where(AppSetting.key == "grok2api_admin_password"))
        assert stored is not None
        assert "secret-password" not in json.dumps(stored.value)

    reloaded_settings = Settings(database_path=tmp_path / "grokiq.db")
    reloaded = RuntimeSettingsService(reloaded_settings, SettingsRepository(database, reloaded_settings))
    reloaded.load()
    assert reloaded_settings.grok2api_admin_password == "secret-password"
    assert reloaded_settings.grok2api_base_url == "http://grok2api.test:8000"


def test_blank_secret_preserves_value_and_explicit_clear_removes_it():
    keep = RuntimeSettingsInput(grok2apiAdminPassword="")
    assert "grok2api_admin_password" not in keep.runtime_changes()

    clear = RuntimeSettingsInput(clearSecrets=["grok2apiAdminPassword"])
    assert clear.runtime_changes()["grok2api_admin_password"] == ""


def test_onboarding_requires_connection_credentials_and_persists_completion(
    tmp_path: Path,
):
    database, settings, service = build_service(tmp_path)

    assert service.onboarding_view() == {
        "completed": False,
        "ready": False,
        "requirements": {
            "grok2apiBaseUrl": True,
            "grok2apiAdminUsername": False,
            "grok2apiAdminPassword": False,
        },
    }
    with pytest.raises(ValueError, match="请先补全 grok2api"):
        service.complete_onboarding()

    service.update(
        {
            "grok2api_admin_username": "upstream-admin",
            "grok2api_admin_password": "upstream-password",
            "probe_worker_concurrency": 4,
            "probe_queue_limit": 2500,
            "scheduler_enabled": False,
            "quarantine_recovery_enabled": False,
            "scheduler_timezone": "Asia/Shanghai",
            "analysis_window_hours": 72,
        }
    )

    assert service.complete_onboarding()["completed"] is True
    assert service.onboarding_view()["ready"] is True
    assert settings.probe_worker_concurrency == 4
    assert settings.probe_queue_limit == 2500
    assert settings.scheduler_enabled is False
    assert settings.quarantine_recovery_enabled is False
    assert settings.scheduler_timezone == "Asia/Shanghai"
    assert settings.analysis_window_hours == 72

    reloaded_settings = Settings(database_path=tmp_path / "grokiq.db")
    reloaded = RuntimeSettingsService(
        reloaded_settings,
        SettingsRepository(database, reloaded_settings),
    )
    reloaded.load()
    assert reloaded.onboarding_view()["completed"] is True
    assert reloaded_settings.probe_worker_concurrency == 4


def test_runtime_settings_reject_invalid_threshold_order(tmp_path: Path):
    _, _, service = build_service(tmp_path)
    with pytest.raises(ValueError, match="降智信号 TPS 下限"):
        service.update({"degradation_tps": 1000, "strong_degradation_tps": 500})


def test_runtime_settings_reject_retry_wait_order(tmp_path: Path):
    _, _, service = build_service(tmp_path)
    with pytest.raises(ValueError, match="重试基础等待"):
        service.update(
            {
                "probe_transient_retry_base_seconds": 20,
                "probe_transient_retry_max_seconds": 10,
            }
        )


def test_probe_tps_override_settings_are_persisted_and_exposed(tmp_path: Path):
    database, settings, service = build_service(tmp_path)

    changed = service.update(
        {
            "probe_tps_override_enabled": True,
            "probe_tps_override_min_first_token_ms": 5000,
            "probe_tps_override_max_generation_ms": 500,
        }
    )

    assert changed == [
        "probe_tps_override_enabled",
        "probe_tps_override_max_generation_ms",
        "probe_tps_override_min_first_token_ms",
        "probe_tps_override_mode",
    ]
    assert settings.probe_tps_override_enabled is True
    assert settings.probe_tps_override_mode == "generation_window"
    assert service.public_view()["probeTpsOverrideMode"] == "generation_window"
    assert service.public_view()["probeTpsOverrideMinFirstTokenMs"] == 5000
    assert service.public_view()["probeTpsOverrideMaxGenerationMs"] == 500

    reloaded_settings = Settings(database_path=tmp_path / "grokiq.db")
    reloaded = RuntimeSettingsService(
        reloaded_settings,
        SettingsRepository(database, reloaded_settings),
    )
    reloaded.load()
    assert reloaded_settings.probe_tps_override_enabled is True
    assert reloaded_settings.probe_tps_override_mode == "generation_window"


def test_probe_tps_override_defaults_to_missing_reasoning(tmp_path: Path):
    _, settings, service = build_service(tmp_path)

    assert settings.probe_tps_override_mode == "missing_reasoning"
    assert settings.probe_tps_override_enabled is True
    assert service.public_view()["probeTpsOverrideMode"] == "missing_reasoning"
    assert service.public_view()["probeTpsOverrideEnabled"] is True


def test_existing_settings_without_mode_default_to_missing_reasoning(tmp_path: Path):
    database, _settings, service = build_service(tmp_path)
    service.repository.save({"probe_tps_override_enabled": False})

    reloaded_settings = Settings(database_path=tmp_path / "grokiq.db")
    reloaded = RuntimeSettingsService(
        reloaded_settings,
        SettingsRepository(database, reloaded_settings),
    )
    reloaded.load()

    assert reloaded_settings.probe_tps_override_mode == "missing_reasoning"
    assert reloaded_settings.probe_tps_override_enabled is True


def test_existing_enabled_override_without_mode_stays_generation_window(tmp_path: Path):
    database, _settings, service = build_service(tmp_path)
    service.repository.save({"probe_tps_override_enabled": True})

    reloaded_settings = Settings(database_path=tmp_path / "grokiq.db")
    reloaded = RuntimeSettingsService(
        reloaded_settings,
        SettingsRepository(database, reloaded_settings),
    )
    reloaded.load()

    assert reloaded_settings.probe_tps_override_mode == "generation_window"
    assert reloaded_settings.probe_tps_override_enabled is True


def test_probe_tps_override_modes_are_exclusive(tmp_path: Path):
    _, settings, service = build_service(tmp_path)

    changed = service.update({"probe_tps_override_mode": "missing_reasoning"})

    assert "probe_tps_override_mode" in changed
    assert settings.probe_tps_override_mode == "missing_reasoning"
    assert settings.probe_tps_override_enabled is True
    assert service.public_view()["probeTpsOverrideMode"] == "missing_reasoning"

    service.update({"probe_tps_override_mode": "off"})
    assert settings.probe_tps_override_mode == "off"
    assert settings.probe_tps_override_enabled is False


def test_quarantine_recovery_setting_is_persisted_and_exposed(tmp_path: Path):
    database, settings, service = build_service(tmp_path)

    changed = service.update({"quarantine_recovery_enabled": False})

    assert changed == ["quarantine_recovery_enabled"]
    assert settings.quarantine_recovery_enabled is False
    assert service.public_view()["quarantineRecoveryEnabled"] is False

    reloaded_settings = Settings(database_path=tmp_path / "grokiq.db")
    reloaded = RuntimeSettingsService(
        reloaded_settings,
        SettingsRepository(database, reloaded_settings),
    )
    reloaded.load()
    assert reloaded_settings.quarantine_recovery_enabled is False


def test_auto_quarantine_recovery_policy_is_persisted_and_exposed(tmp_path: Path):
    database, settings, service = build_service(tmp_path)

    changed = service.update({"auto_quarantine_recovery_enabled": False})

    assert changed == ["auto_quarantine_recovery_enabled"]
    assert settings.auto_quarantine_recovery_enabled is False
    assert service.public_view()["autoQuarantineRecoveryEnabled"] is False

    reloaded_settings = Settings(database_path=tmp_path / "grokiq.db")
    reloaded = RuntimeSettingsService(
        reloaded_settings,
        SettingsRepository(database, reloaded_settings),
    )
    reloaded.load()
    assert reloaded_settings.auto_quarantine_recovery_enabled is False


def test_auto_isolation_setting_is_persisted_and_exposed(tmp_path: Path):
    database, settings, service = build_service(tmp_path)

    changed = service.update({
        "auto_isolation_enabled": True,
        "auto_isolation_min_status": "suspect",
    })

    assert changed == ["auto_isolation_enabled", "auto_isolation_min_status"]
    assert settings.auto_isolation_enabled is True
    assert settings.auto_isolation_min_status == "suspect"
    assert service.public_view()["autoIsolationEnabled"] is True
    assert service.public_view()["autoIsolationMinStatus"] == "suspect"

    reloaded_settings = Settings(database_path=tmp_path / "grokiq.db")
    reloaded = RuntimeSettingsService(
        reloaded_settings,
        SettingsRepository(database, reloaded_settings),
    )
    reloaded.load()
    assert reloaded_settings.auto_isolation_enabled is True
    assert reloaded_settings.auto_isolation_min_status == "suspect"


def test_quality_retry_isolation_setting_is_persisted_and_exposed(tmp_path: Path):
    database, settings, service = build_service(tmp_path)

    changed = service.update({
        "quality_retry_isolation_enabled": True,
        "quality_retry_isolation_interval_seconds": 45,
    })

    assert changed == [
        "quality_retry_isolation_enabled",
        "quality_retry_isolation_interval_seconds",
    ]
    assert settings.quality_retry_isolation_enabled is True
    assert settings.quality_retry_isolation_interval_seconds == 45
    assert service.public_view()["qualityRetryIsolationEnabled"] is True
    assert service.public_view()["qualityRetryIsolationIntervalSeconds"] == 45

    reloaded_settings = Settings(database_path=tmp_path / "grokiq.db")
    reloaded = RuntimeSettingsService(
        reloaded_settings,
        SettingsRepository(database, reloaded_settings),
    )
    reloaded.load()
    assert reloaded_settings.quality_retry_isolation_enabled is True
    assert reloaded_settings.quality_retry_isolation_interval_seconds == 45


def test_should_auto_isolate_matches_min_status_and_more_severe():
    assert should_auto_isolate("high_risk", enabled=False, min_status="watch") is False
    assert should_auto_isolate("watch", enabled=True, min_status="high_risk") is False
    assert should_auto_isolate("suspect", enabled=True, min_status="high_risk") is False
    assert should_auto_isolate("high_risk", enabled=True, min_status="high_risk") is True
    assert should_auto_isolate("watch", enabled=True, min_status="suspect") is False
    assert should_auto_isolate("suspect", enabled=True, min_status="suspect") is True
    assert should_auto_isolate("high_risk", enabled=True, min_status="suspect") is True
    assert should_auto_isolate("watch", enabled=True, min_status="watch") is True
    assert should_auto_isolate("healthy", enabled=True, min_status="watch") is False
    assert should_auto_isolate("quarantined", enabled=True, min_status="watch") is False
    assert should_auto_isolate("high_risk", enabled=True, min_status="unknown") is True


def test_register_stabilization_setting_is_persisted_and_exposed(tmp_path: Path):
    database, settings, service = build_service(tmp_path)

    changed = service.update({"register_probe_stabilization_seconds": 8})

    assert changed == ["register_probe_stabilization_seconds"]
    assert settings.register_probe_stabilization_seconds == 8
    assert service.public_view()["registerProbeStabilizationSeconds"] == 8

    reloaded_settings = Settings(database_path=tmp_path / "grokiq.db")
    reloaded = RuntimeSettingsService(
        reloaded_settings,
        SettingsRepository(database, reloaded_settings),
    )
    reloaded.load()
    assert reloaded_settings.register_probe_stabilization_seconds == 8


def test_runtime_risk_formula_is_persisted_and_exposed(tmp_path: Path):
    database, settings, service = build_service(tmp_path)

    service.update(
        {
            "cumulative_anomaly_rate": 0.7,
            "high_risk_hard_count": 4,
            "risk_anomaly_rate_weight": 35,
            "risk_fast_weight": 8,
            "risk_fast_cap": 16,
            "risk_score_cap": 90,
            "risk_watch_floor": 10,
            "risk_suspect_floor": 45,
            "risk_high_floor": 70,
        }
    )

    public = service.public_view()
    assert public["cumulativeAnomalyRate"] == 0.7
    assert public["highRiskHardCount"] == 4
    assert public["riskAnomalyRateWeight"] == 35
    assert public["riskFastWeight"] == 8
    assert public["riskFastCap"] == 16
    assert public["riskScoreCap"] == 90
    assert public["riskWatchFloor"] == 10
    assert public["riskSuspectFloor"] == 45
    assert public["riskHighFloor"] == 70

    with database.session() as session:
        stored = session.scalar(
            select(AppSetting).where(AppSetting.key == "risk_anomaly_rate_weight")
        )
        assert stored is not None
        assert stored.value == 35

    reloaded_settings = Settings(database_path=tmp_path / "grokiq.db")
    reloaded = RuntimeSettingsService(
        reloaded_settings, SettingsRepository(database, reloaded_settings)
    )
    reloaded.load()
    assert reloaded_settings.cumulative_anomaly_rate == 0.7
    assert reloaded_settings.high_risk_hard_count == 4
    assert reloaded_settings.risk_score_cap == 90


def test_runtime_settings_reject_invalid_risk_formula(tmp_path: Path):
    _, _, service = build_service(tmp_path)

    with pytest.raises(ValueError, match="观察 ≤ 疑似 ≤ 高风险"):
        service.update(
            {
                "risk_watch_floor": 60,
                "risk_suspect_floor": 50,
            }
        )

    with pytest.raises(ValueError, match="持续高速权重"):
        service.update(
            {
                "risk_fast_weight": 5,
                "risk_fast_cap": 0,
            }
        )


def test_media_input_switch_synchronizes_the_rule_registry(tmp_path: Path):
    database, settings, service = build_service(tmp_path)

    changed = service.update({"media_input_observe_enabled": False})

    assert changed == ["media_input_observe_enabled", "risk_rule_overrides"]
    assert settings.media_input_observe_enabled is False
    assert settings.risk_rule_overrides == [
        {"id": "media_input_observe", "enabled": False}
    ]
    assert service.public_view()["mediaInputObserveEnabled"] is False

    reloaded_settings = Settings(database_path=tmp_path / "grokiq.db")
    reloaded = RuntimeSettingsService(
        reloaded_settings,
        SettingsRepository(database, reloaded_settings),
    )
    reloaded.load()
    assert reloaded.public_view()["mediaInputObserveEnabled"] is False


def test_rule_registry_switch_updates_the_dedicated_media_setting(tmp_path: Path):
    _, settings, service = build_service(tmp_path)

    changed = service.update(
        {
            "risk_rule_overrides": [
                {"id": "media_input_observe", "enabled": False, "priority": 55}
            ]
        }
    )

    assert changed == ["media_input_observe_enabled", "risk_rule_overrides"]
    assert settings.media_input_observe_enabled is False
    assert service.public_view()["mediaInputObserveEnabled"] is False


def test_loading_legacy_dedicated_switch_backfills_rule_override(tmp_path: Path):
    database, settings, service = build_service(tmp_path)
    repository = SettingsRepository(database, settings)
    repository.save({"media_input_observe_enabled": False})

    service.load()

    assert settings.media_input_observe_enabled is False
    assert settings.risk_rule_overrides == [
        {"id": "media_input_observe", "enabled": False}
    ]
    assert repository.load()["risk_rule_overrides"] == [
        {"id": "media_input_observe", "enabled": False}
    ]


@pytest.mark.asyncio
async def test_saving_risk_formula_recalculates_existing_accounts():
    settings = Settings(_env_file=None)
    runtime = MagicMock()
    runtime.update.return_value = ["risk_fast_weight"]
    runtime.public_view.return_value = {"riskFastWeight": 20}
    probes = SimpleNamespace(
        thresholds=object(),
        reconfigure=AsyncMock(),
        repository=MagicMock(),
    )
    accounts = MagicMock()
    scheduler = SimpleNamespace(reconfigure=AsyncMock())
    router = build_settings_router(
        settings=settings,
        client=MagicMock(),
        accounts=accounts,
        runtime_settings=runtime,
        probes=probes,  # type: ignore[arg-type]
        scheduler=scheduler,  # type: ignore[arg-type]
        wechat=MagicMock(),
    )
    route = next(
        route
        for route in router.routes
        if isinstance(route, APIRoute)
        and route.path == "/settings"
        and "PUT" in route.methods
    )

    result = await route.endpoint(RuntimeSettingsInput(riskFastWeight=20))

    probes.reconfigure.assert_awaited_once()
    accounts.recalculate_all.assert_called_once_with(
        probes.thresholds,
        settings.analysis_window_hours,
    )
    scheduler.reconfigure.assert_awaited_once()
    assert result["riskFastWeight"] == 20


def test_registration_strategy_migrates_to_fixed_current_egress_policy(tmp_path: Path):
    database, settings, service = build_service(tmp_path)
    repository = SettingsRepository(database, settings)
    repository.save(
        {
            "initial_probe_on_register": False,
            "register_probe_profile_ids": ["custom-profile"],
            "register_probe_execution_mode": "quality_test",
            "register_probe_rounds": 8,
            "register_probe_proxy_targets": [{"kind": "egress", "id": 7}],
        }
    )

    service.load()

    assert settings.initial_probe_on_register is True
    assert settings.register_probe_profile_ids == ["custom-profile"]
    assert settings.register_probe_execution_mode == "chat"
    assert settings.register_probe_rounds == 8
    assert settings.register_probe_proxy_targets == [
        {"kind": "current", "id": None}
    ]
    stored = repository.load()
    assert stored["register_probe_profile_ids"] == ["custom-profile"]
    assert stored["register_probe_execution_mode"] == "chat"
    assert stored["register_probe_rounds"] == 8
    assert stored["register_probe_proxy_targets"] == [
        {"kind": "current", "id": None}
    ]


def test_registration_strategy_updates_only_allow_profile_selection(tmp_path: Path):
    database, settings, service = build_service(tmp_path)
    service.load()

    service.update(
        {
            "register_probe_profile_ids": ["profile-a", "profile-b"],
            "register_probe_execution_mode": "quality_test",
            "register_probe_rounds": 9,
            "register_probe_proxy_targets": [{"kind": "egress", "id": 7}],
        }
    )

    assert settings.register_probe_profile_ids == ["profile-a", "profile-b"]
    assert settings.register_probe_execution_mode == "chat"
    assert settings.register_probe_rounds == 9
    assert settings.register_probe_proxy_targets == [
        {"kind": "current", "id": None}
    ]

    reloaded_settings = Settings(database_path=tmp_path / "grokiq.db")
    reloaded = RuntimeSettingsService(
        reloaded_settings, SettingsRepository(database, reloaded_settings)
    )
    reloaded.load()
    assert reloaded_settings.register_probe_profile_ids == [
        "profile-a",
        "profile-b",
    ]
    assert reloaded_settings.register_probe_execution_mode == "chat"
    assert reloaded_settings.register_probe_rounds == 9
    assert reloaded_settings.register_probe_profile_rounds == {
        "profile-a": 9,
        "profile-b": 9,
    }
    assert reloaded_settings.register_probe_proxy_targets == [
        {"kind": "current", "id": None}
    ]


def test_registration_strategy_persists_per_profile_rounds(tmp_path: Path):
    _database, settings, service = build_service(tmp_path)
    service.load()

    service.update(
        {
            "register_probe_profile_ids": ["profile-a", "profile-b"],
            "register_probe_rounds": 3,
            "register_probe_profile_rounds": {
                "profile-a": 1,
                "profile-b": 5,
            },
        }
    )

    assert settings.register_probe_profile_ids == ["profile-a", "profile-b"]
    assert settings.register_probe_rounds == 3
    assert settings.register_probe_profile_rounds == {
        "profile-a": 1,
        "profile-b": 5,
    }
    assert service.public_view()["registerProbeProfileRounds"] == {
        "profile-a": 1,
        "profile-b": 5,
    }

    reloaded_settings = Settings(database_path=tmp_path / "grokiq.db")
    reloaded = RuntimeSettingsService(
        reloaded_settings, SettingsRepository(_database, reloaded_settings)
    )
    reloaded.load()
    assert reloaded_settings.register_probe_profile_rounds == {
        "profile-a": 1,
        "profile-b": 5,
    }


def test_registration_strategy_preserves_profile_order(tmp_path: Path):
    _database, settings, service = build_service(tmp_path)
    service.load()

    service.update(
        {
            "register_probe_profile_ids": ["profile-b", "profile-a"],
            "register_probe_profile_rounds": {
                "profile-a": 2,
                "profile-b": 5,
            },
        }
    )

    assert settings.register_probe_profile_ids == ["profile-b", "profile-a"]
    assert list(settings.register_probe_rounds_by_profile()) == [
        "profile-b",
        "profile-a",
    ]
    assert service.public_view()["registerProbeProfileIds"] == [
        "profile-b",
        "profile-a",
    ]

    reloaded_settings = Settings(database_path=tmp_path / "grokiq.db")
    reloaded = RuntimeSettingsService(
        reloaded_settings, SettingsRepository(_database, reloaded_settings)
    )
    reloaded.load()
    assert reloaded_settings.register_probe_profile_ids == [
        "profile-b",
        "profile-a",
    ]


def test_registration_strategy_rejects_invalid_profile_rounds(tmp_path: Path):
    _database, _settings, service = build_service(tmp_path)
    service.load()
    with pytest.raises(ValueError, match="执行轮数需在 1–20 之间"):
        service.update(
            {
                "register_probe_profile_ids": ["profile-a"],
                "register_probe_profile_rounds": {"profile-a": 21},
            }
        )


def test_register_probe_switch_setting_is_persisted(tmp_path: Path):
    _database, settings, service = build_service(tmp_path)

    changed = service.update({"register_probe_switch_on_degradation": False})

    assert changed == ["register_probe_switch_on_degradation"]
    assert settings.register_probe_switch_on_degradation is False
    assert service.public_view()["registerProbeSwitchOnDegradation"] is False

    reloaded_settings = Settings(database_path=tmp_path / "grokiq.db")
    reloaded = RuntimeSettingsService(
        reloaded_settings, SettingsRepository(_database, reloaded_settings)
    )
    reloaded.load()
    assert reloaded_settings.register_probe_switch_on_degradation is False


def test_register_priority_hold_setting_is_persisted(tmp_path: Path):
    _database, settings, service = build_service(tmp_path)

    changed = service.update(
        {
            "register_priority_hold_enabled": False,
            "register_priority_hold": -500,
        }
    )

    assert changed == [
        "register_priority_hold",
        "register_priority_hold_enabled",
    ]
    assert settings.register_priority_hold_enabled is False
    assert settings.register_priority_hold == -500
    public = service.public_view()
    assert public["registerPriorityHoldEnabled"] is False
    assert public["registerPriorityHold"] == -500

    reloaded_settings = Settings(database_path=tmp_path / "grokiq.db")
    reloaded = RuntimeSettingsService(
        reloaded_settings, SettingsRepository(_database, reloaded_settings)
    )
    reloaded.load()
    assert reloaded_settings.register_priority_hold_enabled is False
    assert reloaded_settings.register_priority_hold == -500


def test_register_callback_setting_requires_url_and_is_persisted(tmp_path: Path):
    _database, settings, service = build_service(tmp_path)
    with pytest.raises(ValueError, match="通知地址"):
        service.update({"register_callback_enabled": True})

    changed = service.update(
        {
            "register_callback_enabled": True,
            "register_callback_url": (
                "http://grok-register:8787/api/integrations/grokiq/notify"
            ),
            "register_callback_timeout_seconds": 8,
        }
    )
    assert changed == [
        "register_callback_enabled",
        "register_callback_timeout_seconds",
        "register_callback_url",
    ]
    public = service.public_view()
    assert public["registerCallbackEnabled"] is True
    assert public["registerCallbackUrl"].endswith("/notify")
    assert public["registerCallbackTimeoutSeconds"] == 8

    reloaded_settings = Settings(database_path=tmp_path / "grokiq.db")
    reloaded = RuntimeSettingsService(
        reloaded_settings, SettingsRepository(_database, reloaded_settings)
    )
    reloaded.load()
    assert reloaded_settings.register_callback_enabled is True
    assert reloaded_settings.register_callback_timeout_seconds == 8


def test_wechat_notifications_require_channel_credentials(tmp_path: Path):
    database, settings, service = build_service(tmp_path)
    with pytest.raises(ValueError, match="AppID、AppSecret、OpenID"):
        service.update({"wechat_notification_enabled": True})

    changed = service.update(
        {
            "wechat_notification_enabled": True,
            "wechat_app_id": "wx-test",
            "wechat_app_secret": "wechat-secret",
            "wechat_openid": "openid-test",
        }
    )
    assert changed == [
        "wechat_app_id",
        "wechat_app_secret",
        "wechat_notification_enabled",
        "wechat_openid",
    ]
    assert settings.wechat_notification_enabled is True
    assert settings.wechat_account_alert_enabled is False
    assert service.public_view()["wechatAppSecretConfigured"] is True
    assert service.public_view()["wechatAccountAlertEnabled"] is False

    with database.session() as session:
        stored = session.scalar(
            select(AppSetting).where(AppSetting.key == "wechat_app_secret")
        )
        assert stored is not None
        assert "wechat-secret" not in json.dumps(stored.value)


def test_wechat_account_alert_requires_template(tmp_path: Path):
    _, settings, service = build_service(tmp_path)
    with pytest.raises(ValueError, match="账号异常"):
        service.update(
            {
                "wechat_notification_enabled": True,
                "wechat_app_id": "wx-test",
                "wechat_app_secret": "wechat-secret",
                "wechat_openid": "openid-test",
                "wechat_account_alert_enabled": True,
            }
        )

    changed = service.update(
        {
            "wechat_notification_enabled": True,
            "wechat_app_id": "wx-test",
            "wechat_app_secret": "wechat-secret",
            "wechat_openid": "openid-test",
            "wechat_account_alert_enabled": True,
            "wechat_template_id": "template-account",
        }
    )
    assert "wechat_account_alert_enabled" in changed
    assert settings.wechat_account_alert_enabled is True
    assert service.public_view()["wechatAccountAlertEnabled"] is True


def test_existing_wechat_channel_keeps_account_alerts_enabled(tmp_path: Path):
    database, settings, service = build_service(tmp_path)
    repository = SettingsRepository(database, settings)
    repository.save(
        {
            "wechat_notification_enabled": True,
            "wechat_app_id": "wx-test",
            "wechat_app_secret": "wechat-secret",
            "wechat_openid": "openid-test",
            "wechat_template_id": "template-account",
        }
    )

    service.load()

    assert settings.wechat_account_alert_enabled is True
    assert repository.load()["wechat_account_alert_enabled"] is True


def test_wechat_metric_alert_settings_require_templates_and_reject_unlabeled_keys(
    tmp_path: Path,
):
    _, _, service = build_service(tmp_path)
    with pytest.raises(ValueError, match="密钥正常率模板"):
        service.update(
            {
                "wechat_notification_enabled": True,
                "wechat_app_id": "wx-test",
                "wechat_app_secret": "wechat-secret",
                "wechat_openid": "openid-test",
                "wechat_template_id": "template-account",
                "wechat_key_quality_enabled": True,
            }
        )

    with pytest.raises(ValueError, match="上游成功率模板"):
        service.update(
            {
                "wechat_notification_enabled": True,
                "wechat_app_id": "wx-test",
                "wechat_app_secret": "wechat-secret",
                "wechat_openid": "openid-test",
                "wechat_template_id": "template-account",
                "wechat_upstream_health_15m_enabled": True,
            }
        )

    with pytest.raises(ValueError, match="未记录 Key"):
        service.update(
            {
                "wechat_notification_enabled": True,
                "wechat_app_id": "wx-test",
                "wechat_app_secret": "wechat-secret",
                "wechat_openid": "openid-test",
                "wechat_template_id": "template-account",
                "wechat_key_quality_template_id": "template-key",
                "wechat_key_quality_enabled": True,
                "wechat_key_quality_keys": [{"id": "unlabeled", "name": "未记录 Key"}],
            }
        )

    changed = service.update(
        {
            "wechat_notification_enabled": True,
            "wechat_app_id": "wx-test",
            "wechat_app_secret": "wechat-secret",
            "wechat_openid": "openid-test",
            "wechat_template_id": "template-account",
            "wechat_key_quality_template_id": "template-key",
            "wechat_upstream_health_template_id": "template-up",
            "wechat_key_quality_enabled": True,
            "wechat_key_quality_threshold": 88,
            "wechat_key_quality_keys": [
                {"id": "key-1", "name": "生产 Key", "threshold": 80},
                {"id": "key-2", "name": "备用"},
            ],
        }
    )
    assert "wechat_key_quality_keys" in changed
    public = service.public_view()
    assert public["wechatKeyQualityTemplateId"] == "template-key"
    assert public["wechatKeyQualityKeys"] == [
        {"id": "key-1", "name": "生产 Key", "threshold": 80.0},
        {"id": "key-2", "name": "备用"},
    ]


def test_sso_proxy_is_encrypted_masked_and_clearable(tmp_path: Path):
    database, settings, service = build_service(tmp_path)
    changed = service.update({"sso_proxy": "user:pass@127.0.0.1:8080"})
    assert changed == ["sso_proxy"]
    assert settings.sso_proxy == "http://user:pass@127.0.0.1:8080"
    public = service.public_view()
    assert public["ssoProxyConfigured"] is True
    assert "pass" not in json.dumps(public)
    assert service.reveal_secret("ssoProxy") == "http://user:pass@127.0.0.1:8080"

    with database.session() as session:
        stored = session.scalar(select(AppSetting).where(AppSetting.key == "sso_proxy"))
        assert stored is not None
        assert "pass" not in json.dumps(stored.value)

    keep = RuntimeSettingsInput(ssoProxy="")
    assert "sso_proxy" not in keep.runtime_changes()
    clear = RuntimeSettingsInput(clearSecrets=["ssoProxy"])
    assert clear.runtime_changes()["sso_proxy"] == ""

    service.update(clear.runtime_changes())
    assert settings.sso_proxy == ""
    assert service.public_view()["ssoProxyConfigured"] is False


def test_invalid_sso_proxy_is_rejected(tmp_path: Path):
    _database, _settings, service = build_service(tmp_path)
    with pytest.raises(ValueError, match="代理"):
        service.update({"sso_proxy": "not-a-proxy"})
