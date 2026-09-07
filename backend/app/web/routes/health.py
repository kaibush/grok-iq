from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from app.core.clock import app_now
from app.core.config import Settings
from app.integrations.grok2api.client import Grok2APIClient
from app.persistence.probe_repository import ProbeRepository
from app.services.auth_service import AuthService
from app.services.scheduler import SchedulerService


def build_health_router(
    *,
    settings: Settings,
    client: Grok2APIClient,
    probes: ProbeRepository,
    scheduler: SchedulerService,
    auth: AuthService,
) -> APIRouter:
    router = APIRouter()

    @router.get("/health")
    async def health(request: Request) -> dict[str, Any]:
        auth_state = auth.status(request.headers.get("authorization", ""))
        basic: dict[str, Any] = {
            "status": "ok",
            "time": app_now(),
            "setupRequired": auth_state["setupRequired"],
        }
        if not auth_state["authenticated"]:
            return basic

        # Health is deliberately best-effort: an unavailable upstream must not
        # hide GrokIQ's own queue and scheduler health.
        try:
            summary = await client.admin_request(
                "GET", "/api/admin/v1/accounts/summary"
            )
            upstream = {
                "available": True,
                "summary": summary.get("providers", {}).get("grok_build", {}),
            }
        except Exception as exc:
            upstream = {"available": False, "error": str(exc)}

        return {
            **basic,
            "upstream": upstream,
            "queue": probes.queue_stats(),
            "scheduler": {
                "enabled": settings.scheduler_enabled,
                "plansEnabled": settings.scheduler_enabled,
                "systemRecoveryEnabled": settings.quarantine_recovery_enabled,
                "running": scheduler.scheduler.running,
            },
            "integration": {
                "adminConfigured": bool(
                    settings.grok2api_admin_username
                    and settings.grok2api_admin_password
                ),
                "wechatNotificationEnabled": settings.wechat_notification_enabled,
                "wechatConfigured": bool(
                    settings.wechat_app_id
                    and settings.wechat_app_secret
                    and settings.wechat_openid
                ),
            },
        }

    return router
