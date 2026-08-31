from __future__ import annotations

from unittest.mock import MagicMock

from fastapi.routing import APIRoute

from app.core.config import Settings
from app.web.router import build_router

EXPECTED_ROUTES = {
    ("GET", "/api/auth/status"),
    ("POST", "/api/auth/setup"),
    ("POST", "/api/auth/login"),
    ("GET", "/api/auth/me"),
    ("POST", "/api/auth/logout"),
    ("GET", "/api/health"),
    ("GET", "/api/public/upstream-accounts"),
    ("POST", "/api/public/client-key-quota"),
    ("POST", "/api/public/client-key-usage"),
    ("GET", "/api/system/version"),
    ("POST", "/api/system/update/check"),
    ("GET", "/api/dashboard"),
    ("GET", "/api/exports/quarantine"),
    ("GET", "/api/exports/high-risk"),
    ("GET", "/api/exports/request-audits"),
    ("GET", "/api/exports/probe-samples"),
    ("GET", "/api/accounts"),
    ("GET", "/api/accounts/selection"),
    ("GET", "/api/accounts/options"),
    ("PUT", "/api/accounts/batch"),
    ("POST", "/api/accounts/batch/action"),
    ("DELETE", "/api/accounts/batch"),
    ("PUT", "/api/accounts/batch/egress"),
    ("GET", "/api/accounts/quarantine"),
    ("GET", "/api/accounts/quarantine/stats"),
    ("DELETE", "/api/accounts/quarantine/local"),
    ("GET", "/api/accounts/{account_id}"),
    ("GET", "/api/accounts/{account_id}/samples"),
    ("GET", "/api/accounts/{account_id}/timeline"),
    ("GET", "/api/accounts/{account_id}/upstream"),
    ("POST", "/api/accounts/{account_id}/operator-notes"),
    ("PATCH", "/api/accounts/{account_id}/operator-notes/{note_id}"),
    ("DELETE", "/api/accounts/{account_id}/operator-notes/{note_id}"),
    ("POST", "/api/accounts/{account_id}/action"),
    ("DELETE", "/api/accounts/{account_id}"),
    ("GET", "/api/egress-nodes"),
    ("PATCH", "/api/egress-nodes/batch"),
    ("POST", "/api/egress-nodes"),
    ("PUT", "/api/egress-nodes/{node_id}"),
    ("DELETE", "/api/egress-nodes"),
    ("POST", "/api/egress-nodes/{node_id}/test"),
    ("POST", "/api/egress-nodes/bind-accounts"),
    ("GET", "/api/probe-profiles"),
    ("POST", "/api/probe-profiles"),
    ("PUT", "/api/probe-profiles/{profile_id}"),
    ("DELETE", "/api/probe-profiles/{profile_id}"),
    ("DELETE", "/api/probe-profiles"),
    ("GET", "/api/probe-plans"),
    ("POST", "/api/probe-plans"),
    ("PUT", "/api/probe-plans/{plan_id}"),
    ("PUT", "/api/probe-plans/{plan_id}/enabled"),
    ("DELETE", "/api/probe-plans/{plan_id}"),
    ("DELETE", "/api/probe-plans"),
    ("POST", "/api/probe-plans/batch/run"),
    ("POST", "/api/probe-plans/{plan_id}/run"),
    ("POST", "/api/probe-runs"),
    ("POST", "/api/probe-runs/batch"),
    ("GET", "/api/probe-runs"),
    ("GET", "/api/probe-workers"),
    ("GET", "/api/probe-workers/logs"),
    ("POST", "/api/probe-runs/batch/cancel"),
    ("POST", "/api/probe-runs/batch/restore-account-settings"),
    ("GET", "/api/probe-runs/selection"),
    ("POST", "/api/probe-runs/preview-samples"),
    ("GET", "/api/probe-runs/{run_id}"),
    ("POST", "/api/probe-runs/{run_id}/cancel"),
    ("POST", "/api/probe-runs/{run_id}/retry"),
    ("POST", "/api/probe-runs/{run_id}/restore-account-settings"),
    ("DELETE", "/api/probe-runs/{run_id}"),
    ("DELETE", "/api/probe-samples/{sample_id}"),
    ("DELETE", "/api/probe-runs"),
    ("GET", "/api/scheduler"),
    ("DELETE", "/api/scheduler/executions/{execution_id}"),
    ("DELETE", "/api/scheduler/executions"),
    ("GET", "/api/settings"),
    ("GET", "/api/onboarding"),
    ("GET", "/api/settings/secrets/{secret_name}"),
    ("PUT", "/api/settings"),
    ("POST", "/api/settings/test-grok2api"),
    ("POST", "/api/onboarding/complete"),
    ("POST", "/api/settings/test-wechat"),
    ("POST", "/api/integrations/grok-register/account-created"),
    ("POST", "/api/integrations/grok-register/account-imported"),
    ("GET", "/api/register-webhook-events"),
    ("GET", "/api/chat/providers"),
    ("POST", "/api/chat/providers"),
    ("PUT", "/api/chat/providers/{provider_id}"),
    ("DELETE", "/api/chat/providers/{provider_id}"),
    ("GET", "/api/chat/providers/{provider_id}/api-key"),
    ("POST", "/api/chat/providers/{provider_id}/sync-models"),
    ("GET", "/api/chat/models"),
    ("POST", "/api/responses"),
    ("POST", "/api/chat/completions"),
    ("GET", "/api/sso-reports"),
    ("POST", "/api/sso-reports"),
    ("POST", "/api/sso-reports/accounts"),
    ("DELETE", "/api/sso-reports"),
    ("GET", "/api/sso-reports/{report_id}"),
    ("DELETE", "/api/sso-reports/{report_id}"),
}

PUBLIC_PATHS = {
    "/api/auth/status",
    "/api/auth/setup",
    "/api/auth/login",
    "/api/health",
    "/api/public/upstream-accounts",
    "/api/public/client-key-quota",
    "/api/public/client-key-usage",
    "/api/integrations/grok-register/account-created",
    "/api/integrations/grok-register/account-imported",
}



def build_test_router():
    dependency = MagicMock()
    dependency.setup_required.return_value = False
    return build_router(
        settings=Settings(_env_file=None),
        client=MagicMock(),
        account_repository=MagicMock(),
        probe_repository=MagicMock(),
        account_service=MagicMock(),
        egress_service=MagicMock(),
        probe_manager=MagicMock(),
        scheduler=MagicMock(),
        runtime_settings_service=MagicMock(),
        auth_service=dependency,
        chat_service=MagicMock(),
        sso_reports=MagicMock(),
        register_integration=MagicMock(),
        wechat_notifications=MagicMock(),
        updates=MagicMock(),
    )


def effective_routes(router):
    for route in router.routes:
        contexts = getattr(route, "effective_route_contexts", None)
        if contexts is None:
            yield route
            continue
        yield from contexts()


def test_business_router_package_preserves_method_and_path_contract():
    router = build_test_router()
    routes = {
        (method, route.path)
        for route in effective_routes(router)
        if isinstance(route, APIRoute) or isinstance(route.original_route, APIRoute)
        for method in route.methods
    }
    assert routes == EXPECTED_ROUTES


def test_only_auth_health_public_status_and_register_webhooks_are_public():
    router = build_test_router()
    for route in effective_routes(router):
        if not isinstance(route, APIRoute) and not isinstance(
            route.original_route, APIRoute
        ):
            continue
        if route.path in PUBLIC_PATHS:
            assert not route.dependencies, route.path
        else:
            assert route.dependencies, route.path
