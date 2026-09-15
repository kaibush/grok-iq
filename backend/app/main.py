from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.analyzer import thresholds_from_settings
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.core.version import current_version
from app.integrations.grok2api.client import Grok2APIClient
from app.integrations.wechat.client import WeChatTestAccountClient
from app.persistence.account_repository import AccountRepository
from app.persistence.auth_repository import AuthRepository
from app.persistence.chat_provider_repository import ChatProviderRepository
from app.persistence.database import Database
from app.persistence.linuxdo_user_repository import LinuxDoUserRepository
from app.persistence.page_visit_repository import PageVisitRepository
from app.persistence.probe_repository import ProbeRepository
from app.persistence.register_event_repository import RegisterEventRepository
from app.persistence.request_audit_repository import RequestAuditRepository
from app.persistence.settings_repository import SettingsRepository
from app.persistence.sso_report_repository import SsoReportRepository
from app.persistence.status_account_repository import StatusAccountRepository
from app.persistence.wechat_alert_repository import WeChatAlertRepository
from app.services.account_service import AccountService
from app.services.auth_service import AuthService
from app.services.chat_service import ChatService
from app.services.egress_service import EgressService
from app.services.linuxdo_oauth_service import LinuxDoOAuthService
from app.services.page_visit_service import PageVisitService
from app.services.probe_manager import ProbeManager
from app.services.quality_retry_isolation import QualityRetryIsolationService
from app.services.register_integration import RegisterIntegrationService
from app.services.request_audit_service import RequestAuditService
from app.services.scheduler import SchedulerService
from app.services.settings_service import RuntimeSettingsService
from app.services.sso_report_service import SsoReportService
from app.services.status_account_service import StatusAccountService
from app.services.tps_fuse_sync import TpsFuseSyncService
from app.services.update_check import UpdateCheckService
from app.services.wechat_metric_alerts import WeChatMetricAlertService
from app.services.wechat_notification import WeChatAccountNotificationService
from app.web.exception_handlers import install_exception_handlers
from app.web.router import build_router

settings = get_settings()
probe_log_path = configure_logging(settings.database_path)
thresholds = thresholds_from_settings(settings)

database = Database(settings.database_path)
account_repository = AccountRepository(database)
auth_repository = AuthRepository(database)
chat_provider_repository = ChatProviderRepository(database, settings)
probe_repository = ProbeRepository(database)
request_audit_repository = RequestAuditRepository(database)
wechat_alert_repository = WeChatAlertRepository(database)
page_visit_repository = PageVisitRepository(database)
linuxdo_user_repository = LinuxDoUserRepository(database)
status_account_repository = StatusAccountRepository(database)
settings_repository = SettingsRepository(database, settings)
register_event_repository = RegisterEventRepository(database)
sso_report_repository = SsoReportRepository(database)
runtime_settings_service = RuntimeSettingsService(settings, settings_repository)
auth_service = AuthService(settings, auth_repository)
chat_service = ChatService(settings=settings, providers=chat_provider_repository)
sso_report_service = SsoReportService(
    sso_report_repository,
    register_events=register_event_repository,
    settings=settings,
)
grok_client = Grok2APIClient(settings)
tps_fuse_sync = TpsFuseSyncService(grok_client, settings)
wechat_client = WeChatTestAccountClient(settings)
wechat_notification_service = WeChatAccountNotificationService(
    settings, wechat_client
)
account_service = AccountService(
    settings=settings,
    client=grok_client,
    accounts=account_repository,
    probes=probe_repository,
    register_events=register_event_repository,
    request_audits=request_audit_repository,
    sso_reports=sso_report_repository,
)
sso_report_service.set_account_action_handler(
    lambda account_id, detail: account_service.apply_auto_quarantine(
        account_id,
        source="sso_report",
        note="SSO 检测发现 bot 标记后立即自动停用",
        risk_score=max(float(settings.risk_high_floor), 85.0),
        force=True,
        permanent=True,
        detail=detail,
    )
)
probe_manager = ProbeManager(
    settings=settings,
    repository=probe_repository,
    accounts=account_repository,
    client=grok_client,
    thresholds=thresholds,
    notifications=wechat_notification_service,
    account_service=account_service,
    log_path=probe_log_path,
)
egress_service = EgressService(client=grok_client, probes=probe_repository)
request_audit_service = RequestAuditService(
    settings=settings,
    client=grok_client,
    repository=request_audit_repository,
    accounts=account_repository,
    probes=probe_repository,
    account_service=account_service,
    tps_fuse_sync=tps_fuse_sync,
)
wechat_metric_alerts = WeChatMetricAlertService(
    settings=settings,
    notifications=wechat_notification_service,
    request_audits=request_audit_service,
    repository=wechat_alert_repository,
)
request_audit_service.metric_alert_callback = wechat_metric_alerts.evaluate_after_scan
linuxdo_oauth_service = LinuxDoOAuthService(
    settings,
    linuxdo_user_repository,
    auth_service.secret,
)
status_account_service = StatusAccountService(
    settings,
    status_account_repository,
    auth_service.secret,
)
page_visit_service = PageVisitService(
    page_visit_repository,
    auth_service=auth_service,
    linuxdo_oauth=linuxdo_oauth_service,
    status_accounts=status_account_service,
)
quality_retry_isolation_service = QualityRetryIsolationService(
    settings=settings,
    client=grok_client,
    account_service=account_service,
)
scheduler_service = SchedulerService(
    settings=settings,
    repository=probe_repository,
    probes=probe_manager,
    recovery_callback=account_service.recover_due_quarantines,
    request_audit_callback=request_audit_service.scan_scheduled,
    quality_retry_callback=quality_retry_isolation_service.scan,
)
register_integration_service = RegisterIntegrationService(
    settings=settings,
    repository=register_event_repository,
    accounts=account_repository,
    account_service=account_service,
    probes=probe_manager,
    notifications=wechat_notification_service,
)
probe_manager.register_integration = register_integration_service
update_check_service = UpdateCheckService()


@asynccontextmanager
async def lifespan(_: FastAPI):
    database.initialize()
    runtime_settings_service.load()
    chat_service.bootstrap()
    grok_client.reset_credentials()
    await probe_manager.reconfigure()
    probe_repository.reconcile_sample_metrics_from_request_audits()
    probe_repository.backfill_probe_upstream_tps()
    # Recompute classifications even when audit metrics were already copied.
    # Older samples can retain a classification produced from the local stream
    # clock, while their persisted TPS now reflects grok2api's authoritative
    # server timing.
    account_repository.recalculate_all(
        probe_manager.thresholds,
        settings.analysis_window_hours,
    )
    probe_repository.refresh_all_run_summaries()
    account_repository.migrate_fixed_egress_risk_formula(
        probe_manager.thresholds,
        settings.analysis_window_hours,
    )
    account_repository.migrate_all_egress_risk_formula(
        probe_manager.thresholds,
        settings.analysis_window_hours,
    )
    await probe_manager.start()
    await register_integration_service.start()
    await sso_report_service.start()
    await scheduler_service.start()
    tps_fuse_sync.schedule_startup_sync()
    await update_check_service.start()
    try:
        yield
    finally:
        await update_check_service.stop()
        await scheduler_service.stop()
        await sso_report_service.stop()
        await register_integration_service.stop()
        await probe_manager.stop()
        database.dispose()


app = FastAPI(
    title=settings.app_name,
    version=current_version().removeprefix("v"),
    lifespan=lifespan,
)
install_exception_handlers(app)


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(
    build_router(
        settings=settings,
        client=grok_client,
        account_repository=account_repository,
        probe_repository=probe_repository,
        account_service=account_service,
        egress_service=egress_service,
        probe_manager=probe_manager,
        request_audits=request_audit_service,
        page_visits=page_visit_service,
        linuxdo_oauth=linuxdo_oauth_service,
        status_accounts=status_account_service,
        scheduler=scheduler_service,
        runtime_settings_service=runtime_settings_service,
        tps_fuse_sync=tps_fuse_sync,
        auth_service=auth_service,
        chat_service=chat_service,
        sso_reports=sso_report_service,
        register_integration=register_integration_service,
        wechat_notifications=wechat_notification_service,
        updates=update_check_service,
    )
)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
        http="h11",
    )
