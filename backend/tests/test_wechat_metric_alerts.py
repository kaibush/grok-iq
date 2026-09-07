from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from app.core.clock import utc_now
from app.core.config import Settings
from app.persistence.database import Database
from app.persistence.wechat_alert_repository import WeChatAlertRepository
from app.services.wechat_metric_alerts import (
    KEY_QUALITY_RULE,
    MAX_ALERTS_PER_ROUND,
    UPSTREAM_HEALTH_RULE,
    WeChatMetricAlertService,
    quality_normal_rate,
    recover_threshold,
)


class StubNotifications:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.sent = 1

    async def send_template(
        self,
        *,
        template_id: str,
        template_data: dict[str, dict[str, str]],
    ) -> dict[str, Any]:
        self.calls.append(
            {"template_id": template_id, "template_data": template_data}
        )
        return {"sent": self.sent}


def _settings(**values: Any) -> Settings:
    payload = {
        "_env_file": None,
        "wechat_notification_enabled": True,
        "wechat_key_quality_enabled": True,
        "wechat_key_quality_template_id": "tpl-key",
        "wechat_key_quality_threshold": 90,
        "wechat_key_quality_min_requests": 20,
        "wechat_key_quality_cooldown_minutes": 30,
        "wechat_key_quality_keys": [{"id": "key-1", "name": "生产 Key"}],
        "wechat_upstream_health_template_id": "tpl-up",
        "wechat_upstream_health_15m_enabled": False,
        "wechat_upstream_health_30m_enabled": False,
    }
    payload.update(values)
    return Settings(**payload)


def _build(
    tmp_path: Path,
    *,
    settings: Settings | None = None,
    keys: list[dict[str, Any]] | None = None,
    health: dict[str, Any] | None = None,
) -> tuple[WeChatMetricAlertService, StubNotifications, WeChatAlertRepository]:
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = WeChatAlertRepository(database)
    notifications = StubNotifications()
    audits = MagicMock()
    audits.client_key_options_for_window.return_value = keys or []
    audits.recent_request_health.return_value = health or {
        "stale": False,
        "windows": {},
    }
    service = WeChatMetricAlertService(
        settings=settings or _settings(),
        notifications=notifications,  # type: ignore[arg-type]
        request_audits=audits,
        repository=repository,
    )
    return service, notifications, repository


def test_quality_normal_rate_uses_watch_and_high_risk_counts():
    assert quality_normal_rate(20, 1, 1) == 90.0
    assert quality_normal_rate(0, 0, 0) == 0.0
    assert recover_threshold(90) == 95.0
    assert recover_threshold(98) == 100.0


@pytest.mark.asyncio
async def test_metric_alerts_skip_when_wechat_disabled(tmp_path: Path):
    service, notifications, _ = _build(
        tmp_path,
        settings=_settings(wechat_notification_enabled=False),
        keys=[
            {
                "id": "key-1",
                "name": "生产 Key",
                "requestCount": 40,
                "watchRequests": 8,
                "highRiskRequests": 4,
            }
        ],
    )

    result = await service.evaluate_after_scan({"ok": True})

    assert result == {"skipped": "disabled", "sent": 0}
    assert notifications.calls == []


@pytest.mark.asyncio
async def test_metric_alerts_skip_stale_and_failed_scans(tmp_path: Path):
    service, notifications, _ = _build(
        tmp_path,
        health={"stale": True, "windows": {}},
        keys=[
            {
                "id": "key-1",
                "requestCount": 40,
                "watchRequests": 8,
                "highRiskRequests": 4,
            }
        ],
    )

    skipped = await service.evaluate_after_scan({"ok": True, "skipped": "busy"})
    failed = await service.evaluate_after_scan({"ok": False})
    stale = await service.evaluate_after_scan({"ok": True})

    assert skipped["skipped"] == "scan"
    assert failed["skipped"] == "scan"
    assert stale["skipped"] == "stale"
    assert notifications.calls == []


@pytest.mark.asyncio
async def test_key_quality_sends_one_message_per_selected_key(tmp_path: Path):
    service, notifications, repository = _build(
        tmp_path,
        settings=_settings(
            wechat_key_quality_keys=[
                {"id": "key-1", "name": "生产 Key"},
                {"id": "key-2", "name": "备用 Key", "threshold": 85},
                {"id": "unlabeled", "name": "未记录 Key"},
            ]
        ),
        keys=[
            {
                "id": "key-1",
                "name": "生产 Key",
                "requestCount": 40,
                "watchRequests": 6,
                "highRiskRequests": 2,
            },
            {
                "id": "key-2",
                "name": "备用 Key",
                "requestCount": 30,
                "watchRequests": 8,
                "highRiskRequests": 0,
            },
            {
                "id": "unlabeled",
                "name": "未记录 Key",
                "requestCount": 50,
                "watchRequests": 40,
                "highRiskRequests": 5,
            },
        ],
    )

    result = await service.evaluate_after_scan({"ok": True})

    assert result["sent"] == 2
    assert [item["template_id"] for item in notifications.calls] == [
        "tpl-key",
        "tpl-key",
    ]
    first = notifications.calls[0]["template_data"]
    assert first["first"]["value"] == "密钥正常率告警"
    assert "生产 Key" in first["key"]["value"]
    assert first["rate"]["value"] == "80.0%"
    assert first["window"]["value"] == "最近 1 小时"
    assert repository.get(KEY_QUALITY_RULE, "key-1")["status"] == "open"
    assert repository.get(KEY_QUALITY_RULE, "key-2")["status"] == "open"
    assert repository.get(KEY_QUALITY_RULE, "unlabeled") is None


@pytest.mark.asyncio
async def test_key_quality_ignores_insufficient_samples_and_respects_cooldown(
    tmp_path: Path,
):
    keys = [
        {
            "id": "key-1",
            "name": "生产 Key",
            "requestCount": 5,
            "watchRequests": 5,
            "highRiskRequests": 0,
        }
    ]
    service, notifications, repository = _build(tmp_path, keys=keys)

    first = await service.evaluate_after_scan({"ok": True})
    assert first["sent"] == 0
    assert notifications.calls == []
    assert repository.get(KEY_QUALITY_RULE, "key-1") is None

    keys[0]["requestCount"] = 40
    keys[0]["watchRequests"] = 8
    opened = await service.evaluate_after_scan({"ok": True})
    assert opened["sent"] == 1

    again = await service.evaluate_after_scan({"ok": True})
    assert again["sent"] == 0
    assert len(notifications.calls) == 1

    state = repository.get(KEY_QUALITY_RULE, "key-1")
    assert state is not None
    repository.upsert(
        rule_id=KEY_QUALITY_RULE,
        subject_id="key-1",
        status="open",
        last_value=float(state["last_value"]),
        last_fired_at=utc_now() - timedelta(minutes=31),
        extra=state.get("extra") or {},
    )
    cooled = await service.evaluate_after_scan({"ok": True})
    assert cooled["sent"] == 1
    assert len(notifications.calls) == 2


@pytest.mark.asyncio
async def test_key_quality_recovers_silently_above_hysteresis(tmp_path: Path):
    keys = [
        {
            "id": "key-1",
            "name": "生产 Key",
            "requestCount": 40,
            "watchRequests": 8,
            "highRiskRequests": 2,
        }
    ]
    service, notifications, repository = _build(tmp_path, keys=keys)
    await service.evaluate_after_scan({"ok": True})
    assert repository.get(KEY_QUALITY_RULE, "key-1")["status"] == "open"

    keys[0]["watchRequests"] = 1
    keys[0]["highRiskRequests"] = 0
    recovered = await service.evaluate_after_scan({"ok": True})

    assert recovered["sent"] == 0
    assert recovered["recovered"] == 1
    assert len(notifications.calls) == 1
    assert repository.get(KEY_QUALITY_RULE, "key-1")["status"] == "closed"


@pytest.mark.asyncio
async def test_metric_alerts_cap_unsent_keys_so_the_next_round_can_still_fire(
    tmp_path: Path,
):
    selected = [{"id": f"key-{index}", "name": f"Key {index}"} for index in range(12)]
    keys = [
        {
            "id": item["id"],
            "name": item["name"],
            "requestCount": 40,
            "watchRequests": 10,
            "highRiskRequests": 2,
        }
        for item in selected
    ]
    service, notifications, repository = _build(
        tmp_path,
        settings=_settings(wechat_key_quality_keys=selected),
        keys=keys,
    )

    first = await service.evaluate_after_scan({"ok": True})
    assert first["sent"] == MAX_ALERTS_PER_ROUND
    assert first["capped"] == 2
    assert len(notifications.calls) == MAX_ALERTS_PER_ROUND
    assert repository.get(KEY_QUALITY_RULE, "key-0")["status"] == "open"
    assert repository.get(KEY_QUALITY_RULE, "key-10") is None

    second = await service.evaluate_after_scan({"ok": True})
    assert second["sent"] == 2
    assert repository.get(KEY_QUALITY_RULE, "key-10")["status"] == "open"
    assert repository.get(KEY_QUALITY_RULE, "key-11")["status"] == "open"


@pytest.mark.asyncio
async def test_upstream_health_watches_status_success_rate(tmp_path: Path):
    service, notifications, repository = _build(
        tmp_path,
        settings=_settings(
            wechat_key_quality_enabled=False,
            wechat_upstream_health_15m_enabled=True,
            wechat_upstream_health_30m_enabled=True,
            wechat_upstream_health_15m_threshold=80,
            wechat_upstream_health_30m_threshold=80,
            wechat_upstream_health_15m_min_requests=10,
            wechat_upstream_health_30m_min_requests=20,
        ),
        health={
            "stale": False,
            "windows": {
                "15m": {"requests": 20, "failedRequests": 6, "successRate": 70.0},
                "30m": {"requests": 40, "failedRequests": 4, "successRate": 90.0},
            },
        },
    )

    result = await service.evaluate_after_scan({"ok": True})

    assert result["sent"] == 1
    payload = notifications.calls[0]["template_data"]
    assert notifications.calls[0]["template_id"] == "tpl-up"
    assert payload["first"]["value"] == "上游成功率告警"
    assert payload["window"]["value"] == "最近 15 分钟"
    assert payload["rate"]["value"] == "70.0%"
    assert payload["failed"]["value"] == "6"
    assert repository.get(UPSTREAM_HEALTH_RULE, "15m")["status"] == "open"
    assert repository.get(UPSTREAM_HEALTH_RULE, "30m") is None
