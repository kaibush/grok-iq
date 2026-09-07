from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from app.core.clock import app_now, to_app_timezone
from app.core.config import Settings
from app.integrations.wechat.client import WeChatTestAccountClient

ABNORMAL_STATUS_RANK = {
    "watch": 1,
    "suspect": 2,
    "high_risk": 3,
    "quarantined": 4,
}
STATUS_LABELS = {
    "watch": "观察中",
    "suspect": "疑似异常",
    "high_risk": "高风险",
    "quarantined": "已隔离",
}
STATUS_COLORS = {
    "watch": "#D97706",
    "suspect": "#EA580C",
    "high_risk": "#DC2626",
    "quarantined": "#991B1B",
}
SOURCE_LABELS = {
    "probe": "自动探针",
    "manual": "任务中心",
    "retry": "任务重试",
    "cron": "定时计划",
    "register": "grok-register",
    "grok-register": "grok-register",
    "test": "配置测试",
}
DEFAULT_NOTIFICATION_TITLE = "账号异常提醒"
DEFAULT_NOTIFICATION_REMARK = "请登录监控后台查看样本证据并及时处理。"
KEY_QUALITY_NOTIFICATION_TITLE = "密钥正常率告警"
KEY_QUALITY_NOTIFICATION_REMARK = "请登录请求审计，按该 Key 过滤最近 1 小时流水。"
UPSTREAM_HEALTH_NOTIFICATION_TITLE = "上游成功率告警"
UPSTREAM_HEALTH_NOTIFICATION_REMARK = "请打开 /status 查看 15 / 30 分钟成功率。"
WECHAT_TEST_SCENARIOS = ("account", "keyQuality", "upstreamHealth")
logger = logging.getLogger(__name__)


def _compact(value: Any, limit: int) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else f"{text[: limit - 1]}…"


def _field(value: Any, color: str = "") -> dict[str, str]:
    result = {"value": str(value)}
    if color:
        result["color"] = color
    return result


class WeChatAccountNotificationService:
    """Build and send one message when an account enters or escalates risk."""

    def __init__(self, settings: Settings, client: WeChatTestAccountClient):
        self.settings = settings
        self.client = client

    def reset_credentials(self) -> None:
        self.client.reset_credentials()

    @staticmethod
    def should_notify(
        previous: dict[str, Any] | None,
        current: dict[str, Any],
        *,
        force: bool = False,
    ) -> bool:
        current_rank = ABNORMAL_STATUS_RANK.get(
            str(current.get("monitor_status") or ""), 0
        )
        previous_rank = ABNORMAL_STATUS_RANK.get(
            str((previous or {}).get("monitor_status") or ""), 0
        )
        return current_rank > 0 and (force or current_rank > previous_rank)

    @staticmethod
    def _account_text(account: dict[str, Any]) -> str:
        account_id = int(account.get("id") or account.get("account_id") or 0)
        name = _compact(account.get("name"), 60)
        email = _compact(account.get("email"), 80)
        label = name or email or "未命名账号"
        if name and email:
            label = f"{name} ({email})"
        return _compact(f"{label} · #{account_id}", 150)

    @staticmethod
    def _message_time(current: dict[str, Any]) -> str:
        value = current.get("updated_at") or current.get("latest_sample_at")
        if isinstance(value, datetime):
            timestamp = to_app_timezone(value) or app_now()
        else:
            timestamp = app_now()
        return timestamp.strftime("%Y-%m-%d %H:%M:%S")

    def build_template_data(
        self,
        *,
        account: dict[str, Any],
        current: dict[str, Any],
        source: str,
    ) -> dict[str, dict[str, str]]:
        status = str(current.get("monitor_status") or "watch")
        reasons = [
            _compact(value, 100)
            for value in (current.get("risk_reasons") or [])
            if _compact(value, 100)
        ]
        reason = "；".join(reasons) or _compact(
            current.get("latest_classification") or "检测到异常样本", 180
        )
        latest_tps = float(current.get("latest_tps") or 0)
        average_tps = float(current.get("avg_tps") or 0)
        source_label = SOURCE_LABELS.get(source, source or "系统")
        remark = _compact(
            f"{DEFAULT_NOTIFICATION_REMARK} 来源：{source_label}",
            220,
        )
        return {
            "first": _field(
                DEFAULT_NOTIFICATION_TITLE,
                STATUS_COLORS.get(status, "#D97706"),
            ),
            "account": _field(self._account_text(account)),
            "status": _field(
                f"{STATUS_LABELS.get(status, status)}（{status}）",
                STATUS_COLORS.get(status, "#D97706"),
            ),
            "score": _field(f"{float(current.get('risk_score') or 0):.1f}"),
            "tps": _field(f"最新 {latest_tps:.1f} · 平均 {average_tps:.1f}"),
            "reason": _field(_compact(reason, 200)),
            "time": _field(self._message_time(current)),
            "remark": _field(remark),
        }

    async def notify_account_transition(
        self,
        *,
        account: dict[str, Any],
        previous: dict[str, Any] | None,
        current: dict[str, Any],
        source: str,
        force: bool = False,
    ) -> dict[str, Any]:
        account_id = int(account.get("id") or account.get("account_id") or 0)
        status = str(current.get("monitor_status") or "")
        if not self.settings.wechat_notification_enabled:
            logger.info(
                "wechat notification skipped account=%s status=%s source=%s reason=disabled",
                account_id,
                status,
                source,
            )
            return {"sent": 0, "skipped": "disabled"}
        if not self.should_notify(previous, current, force=force):
            reason = "healthy" if status not in ABNORMAL_STATUS_RANK else "unchanged"
            logger.info(
                "wechat notification skipped account=%s status=%s source=%s reason=%s",
                account_id,
                status,
                source,
                reason,
            )
            return {"sent": 0, "skipped": reason}
        result = await self.send_template(
            template_id=self.settings.wechat_template_id,
            template_data=self.build_template_data(
                account=account,
                current=current,
                source=source,
            ),
        )
        logger.info(
            "wechat notification sent account=%s status=%s source=%s force=%s sent=%s",
            account_id,
            status,
            source,
            force,
            result.get("sent", 0),
        )
        return result

    async def send_template(
        self,
        *,
        template_id: str,
        template_data: dict[str, dict[str, str]],
    ) -> dict[str, Any]:
        chosen = str(template_id or "").strip()
        if not chosen:
            return {"sent": 0, "skipped": "missing_template"}
        return await self.client.send_to_recipient(
            template_data=template_data,
            template_id=chosen,
        )

    @staticmethod
    def build_key_quality_template_data(
        *,
        key_id: str,
        key_name: str,
        window: str,
        rate: float,
        threshold: float,
        requests: int,
        watch_requests: int,
        high_risk_requests: int,
        occurred_at: datetime | None = None,
    ) -> dict[str, dict[str, str]]:
        label = _compact(key_name, 80) or _compact(key_id, 80) or "未命名 Key"
        if key_name and key_id and key_name != key_id:
            label = _compact(f"{key_name} · {key_id}", 150)
        timestamp = to_app_timezone(occurred_at) if occurred_at else app_now()
        if timestamp is None:
            timestamp = app_now()
        return {
            "first": _field(KEY_QUALITY_NOTIFICATION_TITLE, "#DC2626"),
            "key": _field(label),
            "window": _field(window),
            "rate": _field(f"{rate:.1f}%", "#DC2626"),
            "threshold": _field(f"{threshold:.1f}%"),
            "requests": _field(str(int(requests))),
            "abnormal": _field(
                f"观察 {int(watch_requests)} · 高风险 {int(high_risk_requests)}"
            ),
            "time": _field(timestamp.strftime("%Y-%m-%d %H:%M:%S")),
            "remark": _field(KEY_QUALITY_NOTIFICATION_REMARK),
        }

    @staticmethod
    def build_upstream_health_template_data(
        *,
        window: str,
        rate: float,
        threshold: float,
        requests: int,
        failed_requests: int,
        occurred_at: datetime | None = None,
    ) -> dict[str, dict[str, str]]:
        timestamp = to_app_timezone(occurred_at) if occurred_at else app_now()
        if timestamp is None:
            timestamp = app_now()
        return {
            "first": _field(UPSTREAM_HEALTH_NOTIFICATION_TITLE, "#DC2626"),
            "window": _field(window),
            "rate": _field(f"{rate:.1f}%", "#DC2626"),
            "threshold": _field(f"{threshold:.1f}%"),
            "requests": _field(str(int(requests))),
            "failed": _field(str(int(failed_requests))),
            "time": _field(timestamp.strftime("%Y-%m-%d %H:%M:%S")),
            "remark": _field(UPSTREAM_HEALTH_NOTIFICATION_REMARK),
        }

    async def send_test(self, scenario: str = "account") -> dict[str, Any]:
        if not self.settings.wechat_notification_enabled:
            raise ValueError("请先开启微信推送并保存设置")
        chosen = str(scenario or "account").strip() or "account"
        if chosen not in WECHAT_TEST_SCENARIOS:
            raise ValueError("未知的微信测试场景")
        if chosen == "keyQuality":
            template_id = self.settings.wechat_key_quality_template_id
            if not template_id:
                raise ValueError("请先填写密钥正常率模板 ID 并保存")
            template_data = self.build_key_quality_template_data(
                key_id="key-demo",
                key_name="测试密钥",
                window="最近 1 小时",
                rate=82.0,
                threshold=90.0,
                requests=50,
                watch_requests=6,
                high_risk_requests=3,
            )
        elif chosen == "upstreamHealth":
            template_id = self.settings.wechat_upstream_health_template_id
            if not template_id:
                raise ValueError("请先填写上游成功率模板 ID 并保存")
            template_data = self.build_upstream_health_template_data(
                window="最近 15 分钟",
                rate=72.0,
                threshold=80.0,
                requests=40,
                failed_requests=11,
            )
        else:
            template_id = self.settings.wechat_template_id
            if not template_id:
                raise ValueError("请先填写账号异常模板 ID 并保存")
            account = {
                "id": 10001,
                "name": "测试账号",
                "email": "test@example.com",
            }
            current = {
                "monitor_status": "high_risk",
                "risk_score": 86.5,
                "latest_tps": 628.4,
                "avg_tps": 412.7,
                "risk_reasons": ["风险周期连续异常达到阈值", "强降智信号达到 2 次"],
                "updated_at": app_now(),
            }
            template_data = self.build_template_data(
                account=account,
                current=current,
                source="test",
            )
        result = await self.send_template(
            template_id=template_id,
            template_data=template_data,
        )
        logger.info(
            "wechat test notification sent scenario=%s sent=%s",
            chosen,
            result.get("sent", 0),
        )
        return {**result, "templateId": template_id, "scenario": chosen}
