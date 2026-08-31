from __future__ import annotations

from fastapi import APIRouter, Depends

from app.core.config import Settings
from app.integrations.grok2api.client import Grok2APIClient
from app.persistence.account_repository import AccountRepository
from app.persistence.probe_repository import ProbeRepository
from app.services.account_service import AccountService
from app.services.auth_service import AuthService
from app.services.chat_service import ChatService
from app.services.egress_service import EgressService
from app.services.export_service import ExportService
from app.services.probe_manager import ProbeManager
from app.services.register_integration import RegisterIntegrationService
from app.services.request_audit_service import RequestAuditService
from app.services.scheduler import SchedulerService
from app.services.settings_service import RuntimeSettingsService
from app.services.sso_report_service import SsoReportService
from app.services.update_check import UpdateCheckService
from app.services.wechat_notification import WeChatAccountNotificationService

from .auth import build_admin_auth_dependency
from .routes.accounts import build_accounts_router
from .routes.auth import build_auth_router
from .routes.chat import build_chat_router
from .routes.egress import build_egress_router
from .routes.exports import build_exports_router
from .routes.health import build_health_router
from .routes.integrations import (
    build_integrations_router,
    build_register_events_router,
)
from .routes.probes import build_probes_router
from .routes.public import build_public_router
from .routes.request_audits import build_request_audits_router
from .routes.settings import build_settings_router
from .routes.sso_reports import build_sso_reports_router
from .routes.system import build_system_router


def build_router(
    *,
    settings: Settings,
    client: Grok2APIClient,
    account_repository: AccountRepository,
    probe_repository: ProbeRepository,
    account_service: AccountService,
    egress_service: EgressService,
    probe_manager: ProbeManager,
    scheduler: SchedulerService,
    runtime_settings_service: RuntimeSettingsService,
    auth_service: AuthService,
    chat_service: ChatService,
    sso_reports: SsoReportService,
    register_integration: RegisterIntegrationService,
    wechat_notifications: WeChatAccountNotificationService,
    updates: UpdateCheckService,
    request_audits: RequestAuditService | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/api")
    require_admin = build_admin_auth_dependency(auth_service)
    protected = APIRouter(dependencies=[Depends(require_admin)])

    router.include_router(build_auth_router(auth_service, require_admin))
    router.include_router(
        build_health_router(
            settings=settings,
            client=client,
            probes=probe_repository,
            scheduler=scheduler,
            auth=auth_service,
        )
    )
    router.include_router(build_public_router(account_service, client, auth_service))
    router.include_router(
        build_integrations_router(settings, register_integration)
    )

    protected.include_router(build_accounts_router(account_service))
    protected.include_router(
        build_exports_router(
            ExportService(
                accounts=account_repository,
                probes=probe_repository,
                account_service=account_service,
                request_audits=request_audits,
            )
        )
    )
    protected.include_router(build_egress_router(client, egress_service))
    protected.include_router(
        build_probes_router(
            settings=settings,
            client=client,
            accounts=account_repository,
            repository=probe_repository,
            manager=probe_manager,
            scheduler=scheduler,
        )
    )
    protected.include_router(
        build_settings_router(
            settings=settings,
            client=client,
            accounts=account_repository,
            runtime_settings=runtime_settings_service,
            probes=probe_manager,
            scheduler=scheduler,
            wechat=wechat_notifications,
        )
    )
    protected.include_router(build_chat_router(chat_service))
    if request_audits is not None:
        protected.include_router(build_request_audits_router(request_audits))
    protected.include_router(build_sso_reports_router(sso_reports))
    protected.include_router(build_register_events_router(register_integration))
    protected.include_router(build_system_router(updates))

    router.include_router(protected)
    return router
