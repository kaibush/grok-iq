from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta
from typing import Any

from app.core.clock import app_isoformat, to_app_timezone, utc_now
from app.core.config import Settings
from app.core.disposition import evidence_from, matches_disposition_source
from app.integrations.grok2api.client import Grok2APIClient, IntegrationError
from app.persistence.account_repository import AccountRepository
from app.persistence.probe_repository import ProbeRepository
from app.persistence.register_event_repository import RegisterEventRepository
from app.persistence.request_audit_repository import RequestAuditRepository
from app.persistence.sso_report_repository import SsoReportRepository
from app.services.account_timeline import build_account_timeline
from app.services.isolation_stats import compute_isolation_stats, resolve_stats_range

QUARANTINE_RECOVERY_PRIORITY = -2_000_000_000
PUBLIC_UPSTREAM_SUMMARY_TTL_SECONDS = 10.0
PUBLIC_UPSTREAM_PROVIDERS = ("grok_build", "grok_web", "grok_console")


class AccountService:
    def __init__(
        self,
        *,
        settings: Settings,
        client: Grok2APIClient,
        accounts: AccountRepository,
        probes: ProbeRepository,
        register_events: RegisterEventRepository | None = None,
        request_audits: RequestAuditRepository | None = None,
        sso_reports: SsoReportRepository | None = None,
    ):
        self.settings = settings
        self.client = client
        self.accounts = accounts
        self.probes = probes
        self.register_events = register_events
        self.request_audits = request_audits
        self.sso_reports = sso_reports
        self._public_summary_cache: tuple[float, dict[str, Any]] | None = None
        self._public_summary_lock = asyncio.Lock()

    async def list_accounts(
        self,
        *,
        page: int,
        page_size: int,
        search: str = "",
        enabled: str = "",
        upstream_status: str = "",
        monitor_status: str = "",
        recovery_guarded: str = "",
        sso_risk: str = "",
        egress_node_id: str = "",
    ) -> dict[str, Any]:
        upstream_filters = self._upstream_status_filter(upstream_status)
        if (
            monitor_status
            or recovery_guarded in {"true", "false"}
            or enabled in {"true", "false"}
            or sso_risk not in {"", "all"}
            or bool(str(egress_node_id or "").strip())
        ):
            upstream = await self.client.list_all_accounts(**upstream_filters)
            account_ids = [int(item.get("id") or 0) for item in upstream]
            assessments = self.accounts.get_assessments(account_ids)
            sso_account_ids = self._account_ids_with_sso(account_ids)
            verifications = self._latest_verifications(account_ids)
            values = [
                self._overlay(
                    item,
                    assessments.get(int(item.get("id") or 0)),
                    sso_available=int(item.get("id") or 0) in sso_account_ids,
                    verification=verifications.get(int(item.get("id") or 0)),
                )
                for item in upstream
                if self._matches(item, search=search, enabled=enabled)
                and self._matches_egress(item, egress_node_id)
                and self._matches_assessment(
                    assessments.get(int(item.get("id") or 0)),
                    monitor_status=monitor_status,
                    recovery_guarded=recovery_guarded,
                )
                and self._matches_sso_risk(
                    verifications.get(int(item.get("id") or 0)),
                    sso_available=int(item.get("id") or 0) in sso_account_ids,
                    sso_risk=sso_risk,
                )
            ]
            start = (page - 1) * page_size
            return {
                "items": values[start : start + page_size],
                "total": len(values),
                "page": page,
                "pageSize": page_size,
            }

        params: dict[str, Any] = {
            "page": page,
            "pageSize": page_size,
            **upstream_filters,
        }
        if search.strip():
            params["search"] = search.strip()
        payload = await self.client.list_accounts(**params)
        items = list(payload.get("items", []))
        account_ids = [int(item.get("id") or 0) for item in items]
        assessments = self.accounts.get_assessments(account_ids)
        sso_account_ids = self._account_ids_with_sso(account_ids)
        verifications = self._latest_verifications(account_ids)
        return {
            **payload,
            "items": [
                self._overlay(
                    item,
                    assessments.get(int(item.get("id") or 0)),
                    sso_available=int(item.get("id") or 0) in sso_account_ids,
                    verification=verifications.get(int(item.get("id") or 0)),
                )
                for item in items
            ],
        }

    async def detail(self, account_id: int, limit: int = 200) -> dict[str, Any]:
        account = await self.client.get_account(account_id)
        verification = self._latest_verifications([account_id]).get(account_id)
        return {
            "account": self._overlay(
                account,
                self.accounts.get_assessment(account_id),
                sso_available=account_id in self._account_ids_with_sso([account_id]),
                verification=verification,
            ),
            "history": self.probes.account_history(account_id, limit),
        }

    async def get_upstream_account(self, account_id: int) -> dict[str, Any]:
        """Return the live grok2api account payload without local overlays."""

        normalized_account_id = int(account_id)
        try:
            account = await self.client.get_account(normalized_account_id)
        except IntegrationError as exc:
            if exc.status_code == 404:
                return {
                    "accountId": normalized_account_id,
                    "missingUpstream": True,
                    "account": None,
                }
            raise
        except KeyError:
            return {
                "accountId": normalized_account_id,
                "missingUpstream": True,
                "account": None,
            }
        return {
            "accountId": normalized_account_id,
            "missingUpstream": False,
            "account": account,
        }

    def samples(
        self,
        account_id: int,
        *,
        page: int,
        page_size: int,
    ) -> dict[str, Any]:
        return self.probes.account_samples(
            account_id,
            page=page,
            page_size=page_size,
        )

    def timeline(self, account_id: int, limit: int = 50) -> dict[str, Any]:
        return build_account_timeline(
            self.accounts.database,
            account_id=account_id,
            limit=limit,
        )

    async def select_account_ids(
        self,
        *,
        search: str = "",
        enabled: str = "",
        upstream_status: str = "",
        monitor_status: str = "",
        recovery_guarded: str = "",
        sso_risk: str = "",
        egress_node_id: str = "",
    ) -> dict[str, Any]:
        """Return every probe-capable account matching the current UI filters."""

        upstream_params = self._upstream_status_filter(upstream_status)
        if search.strip():
            upstream_params["search"] = search.strip()
        upstream = await self.client.list_all_accounts(**upstream_params)
        assessments = (
            self.accounts.get_assessments(
                [int(item.get("id") or 0) for item in upstream]
            )
            if monitor_status or recovery_guarded in {"true", "false"}
            else {}
        )
        account_ids = [int(item.get("id") or 0) for item in upstream]
        sso_account_ids = self._account_ids_with_sso(account_ids)
        verifications = self._latest_verifications(account_ids)
        matched = [
            item
            for item in upstream
            if self._matches(item, search=search, enabled=enabled)
            and self._matches_assessment(
                assessments.get(int(item.get("id") or 0)),
                monitor_status=monitor_status,
                recovery_guarded=recovery_guarded,
            )
            and self._matches_sso_risk(
                verifications.get(int(item.get("id") or 0)),
                sso_available=int(item.get("id") or 0) in sso_account_ids,
                sso_risk=sso_risk,
            )
            and self._matches_egress(item, egress_node_id)
        ]
        selectable = [item for item in matched if self._is_probe_selectable(item)]
        return {
            "accountIds": [int(item["id"]) for item in selectable],
            "disabledAccountIds": [
                int(item["id"]) for item in selectable if not bool(item.get("enabled"))
            ],
            "matched": len(matched),
            "selectable": len(selectable),
            "excluded": len(matched) - len(selectable),
        }

    async def list_account_options(
        self,
        *,
        page: int,
        page_size: int,
        search: str = "",
        upstream_status: str = "",
        sso_risk: str = "",
    ) -> dict[str, Any]:
        """Return one compact live page for account pickers.

        Account pickers deliberately do not mirror upstream accounts locally.
        Pagination and search stay on the upstream API so thousands of accounts
        do not become one large response or one large browser render.
        """

        params: dict[str, Any] = {
            "page": page,
            "pageSize": page_size,
            **self._upstream_status_filter(upstream_status),
        }
        if search.strip():
            params["search"] = search.strip()
        payload = await self.client.list_accounts(**params)
        account_ids = [int(item.get("id") or 0) for item in payload.get("items", [])]
        verifications = self._latest_verifications(account_ids)
        sso_account_ids = self._account_ids_with_sso(account_ids)
        items = [
            {
                "id": str(item.get("id") or ""),
                "name": str(item.get("name") or ""),
                "email": str(item.get("email") or ""),
                "enabled": bool(item.get("enabled")),
                "authStatus": str(item.get("authStatus") or ""),
                "egressNodeId": (
                    str(item.get("egressNodeId"))
                    if int(item.get("egressNodeId") or 0) > 0
                    else None
                ),
                "egressAssignmentMode": str(item.get("egressAssignmentMode") or ""),
                **self._sso_overlay(
                    verifications.get(int(item.get("id") or 0)),
                    sso_available=int(item.get("id") or 0) in sso_account_ids,
                ),
            }
            for item in payload.get("items", [])
            if int(item.get("id") or 0) > 0
            and self._matches_sso_risk(
                verifications.get(int(item.get("id") or 0)),
                sso_available=int(item.get("id") or 0) in sso_account_ids,
                sso_risk=sso_risk,
            )
        ]
        return {
            "items": items,
            "total": int(payload.get("total") or 0),
            "page": int(payload.get("page") or page),
            "pageSize": int(payload.get("pageSize") or page_size),
        }

    async def public_upstream_account_summary(
        self, *, include_inventory: bool = False
    ) -> dict[str, Any]:
        """Return sanitized grok2api account counts for the public status page.

        The browser never talks to grok2api. Only integer aggregates leave
        this process; tokens, account identities, and upstream error bodies
        stay on the server. Inventory counts stay admin-only.
        """

        payload = await self._cached_public_upstream_summary()
        return _public_upstream_view(payload, include_inventory=include_inventory)

    async def _cached_public_upstream_summary(self) -> dict[str, Any]:
        cached = self._fresh_public_summary()
        if cached is not None:
            return cached

        async with self._public_summary_lock:
            cached = self._fresh_public_summary()
            if cached is not None:
                return cached
            try:
                raw = await self.client.admin_request(
                    "GET", "/api/admin/v1/accounts/summary"
                )
                payload = _public_upstream_summary(raw, reachable=True)
            except Exception:
                payload = _public_upstream_summary({}, reachable=False)
            self._public_summary_cache = (time.monotonic(), payload)
            return payload

    def _fresh_public_summary(self) -> dict[str, Any] | None:
        cached = self._public_summary_cache
        if (
            cached is not None
            and time.monotonic() - cached[0] < PUBLIC_UPSTREAM_SUMMARY_TTL_SECONDS
        ):
            return cached[1]
        return None

    async def dashboard(self, hours: int) -> dict[str, Any]:
        upstream = await self.client.admin_request(
            "GET", "/api/admin/v1/accounts/summary"
        )
        metrics = self.accounts.dashboard_metrics(hours)
        assessments = self.accounts.list_assessments(limit=8)
        assessment_ids = [int(item["account_id"]) for item in assessments]
        verifications = self._latest_verifications(assessment_ids)
        labels = await self.client.list_all_accounts(
            {int(item["account_id"]) for item in assessments}
        )
        labels_by_id = {int(item.get("id") or 0): item for item in labels}
        workers = {
            **(metrics.get("workers") or {}),
            **self.probes.worker_queue_stats(),
        }
        return {
            "upstream": upstream.get("providers", {}).get("grok_build", {}),
            **metrics,
            "workers": workers,
            "riskyAccounts": [
                self._overlay(
                    labels_by_id.get(
                        int(item["account_id"]), {"id": item["account_id"]}
                    ),
                    item,
                    verification=verifications.get(int(item["account_id"])),
                )
                for item in assessments
            ],
            "alerts": self.accounts.list_alerts(limit=8),
            "recentRuns": self.probes.list_runs(page=1, page_size=8)["items"],
            "queue": self.probes.queue_stats(),
        }

    async def action(
        self,
        *,
        account_id: int,
        action: str,
        note: str,
        propagate: bool,
        quarantine_minutes: int | None,
        priority: int | None = None,
    ) -> dict[str, Any]:
        allowed = {
            "healthy",
            "watch",
            "suspect",
            "high_risk",
            "quarantine",
            "isolate",
            "restore",
        }
        if action not in allowed:
            raise ValueError("账号动作无效")
        if action == "isolate":
            result = await self.isolate_account(
                account_id,
                note=note,
                source="manual",
            )
            action_status = str(result.get("actionStatus") or "")
            if action_status == "task_protected":
                raise ValueError("账号正在执行探针任务，设置恢复完成后再移入隔离区")
            if action_status == "already_quarantined":
                return {
                    "accountId": account_id,
                    "status": "quarantined",
                    "propagated": False,
                    "quarantineUntil": None,
                    "assessment": result.get("assessment"),
                    "actionStatus": action_status,
                }
            return {
                "accountId": account_id,
                "status": "quarantined",
                "propagated": bool(result.get("propagated")),
                "quarantineUntil": None,
                "assessment": result.get("assessment"),
                "actionStatus": action_status,
            }
        account = await self.client.get_account(account_id)
        current_enabled = bool(account.get("enabled"))
        propagated = False
        quarantine_until = None
        disabled_by_monitor: bool | None = None
        previous_enabled: bool | None = None
        status = action

        if action == "quarantine":
            status = "quarantined"
            quarantine_until = utc_now() + timedelta(
                minutes=quarantine_minutes or self.settings.quarantine_minutes
            )
            previous_enabled = current_enabled
            if propagate and current_enabled:
                await self.client.set_account_enabled(account_id, False)
                propagated = True
                disabled_by_monitor = True
            else:
                disabled_by_monitor = False
        elif action == "restore":
            status = "healthy"
            assessment = self.accounts.get_assessment(account_id) or {}
            should_enable = bool(assessment.get("previous_upstream_enabled"))
            if propagate and should_enable and priority is not None:
                await self.client.recover_account_at_priority(
                    account_id,
                    priority=int(priority),
                )
                propagated = True
            elif propagate and should_enable:
                await self.client.set_account_enabled(account_id, True)
                propagated = True
            elif priority is not None:
                await self.client.set_account_priority(account_id, int(priority))
            disabled_by_monitor = False
            previous_enabled = None

        assessment = self.accounts.set_manual_status(
            account_id=account_id,
            status=status,
            note=note,
            quarantine_until=quarantine_until,
            previous_upstream_enabled=previous_enabled,
            disabled_by_monitor=disabled_by_monitor,
            recovery_guarded=False if action == "quarantine" else None,
        )
        self.accounts.create_alert(
            account_id=account_id,
            kind="manual_action",
            severity="warning" if status != "healthy" else "info",
            title=f"账号状态调整为 {status}",
            detail={"note": note, "propagated": propagated, "priority": priority},
        )
        return {
            "accountId": account_id,
            "status": status,
            "propagated": propagated,
            "quarantineUntil": to_app_timezone(quarantine_until),
            "assessment": assessment,
        }

    async def action_many(
        self,
        *,
        account_ids: list[int],
        action: str,
        note: str,
        propagate: bool,
        quarantine_minutes: int | None,
        priority: int | None = None,
    ) -> dict[str, Any]:
        """Apply one account-level risk action with bounded concurrency."""

        if action not in {"quarantine", "isolate", "restore"}:
            raise ValueError("批量账号动作无效")
        unique_ids = list(
            dict.fromkeys(account_id for account_id in account_ids if account_id > 0)
        )
        if not unique_ids:
            raise ValueError("至少选择一个账号")

        locked_ids = self.probes.account_settings_locked_ids(set(unique_ids))
        assessments = self.accounts.get_assessments(unique_ids)
        already_ids: set[int] = set()
        already_key = ""
        if action == "quarantine":
            already_ids = {
                account_id
                for account_id, assessment in assessments.items()
                if str(assessment.get("monitor_status") or "") == "quarantined"
            } - locked_ids
            already_key = "alreadyQuarantinedAccountIds"
        elif action == "isolate":
            already_ids = {
                account_id
                for account_id, assessment in assessments.items()
                if self._is_isolation_zone(assessment)
            } - locked_ids
            already_key = "alreadyIsolatedAccountIds"
        else:
            already_ids = {
                account_id
                for account_id in unique_ids
                if account_id not in locked_ids
                and not self._is_quarantined(assessments.get(account_id))
            }
            already_key = "alreadyRestoredAccountIds"
        eligible_ids = [
            account_id
            for account_id in unique_ids
            if account_id not in locked_ids
            and account_id not in already_ids
        ]
        semaphore = asyncio.Semaphore(6)

        async def apply(account_id: int) -> tuple[int, str]:
            async with semaphore:
                try:
                    await self.action(
                        account_id=account_id,
                        action=action,
                        note=note,
                        propagate=propagate,
                        quarantine_minutes=quarantine_minutes,
                        priority=priority,
                    )
                except Exception as exc:
                    return account_id, str(exc)
            return account_id, ""

        values = await asyncio.gather(
            *(apply(account_id) for account_id in eligible_ids)
        )
        failures = [
            {"id": account_id, "error": error} for account_id, error in values if error
        ]
        failed_ids = [int(value["id"]) for value in failures]
        return {
            "requested": len(unique_ids),
            "eligible": len(eligible_ids),
            "updated": len(eligible_ids) - len(failures),
            "action": action,
            "skippedAccountIds": sorted(locked_ids),
            already_key: sorted(already_ids),
            "failedAccountIds": sorted(failed_ids),
            "failures": failures,
        }

    async def isolate_account(
        self,
        account_id: int,
        *,
        note: str = "",
        source: str = "manual",
        force: bool = False,
        automatic: bool = False,
        detail: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Move an account into the permanent isolation zone.

        Manual isolation always applies. Automatic callers honor
        ``auto_isolation_enabled`` unless ``force=True``.
        """

        normalized_account_id = int(account_id)
        assessment = self.accounts.get_assessment(normalized_account_id) or {}
        already_isolated = self._is_isolation_zone(assessment)
        if automatic and not self.settings.auto_isolation_enabled and not force:
            return {
                "accountId": normalized_account_id,
                "actionStatus": "auto_isolation_disabled",
                "propagated": False,
                "assessment": assessment,
            }
        if already_isolated and not force:
            return {
                "accountId": normalized_account_id,
                "actionStatus": "already_quarantined",
                "propagated": False,
                "assessment": assessment,
            }
        if normalized_account_id in self.probes.account_settings_locked_ids(
            {normalized_account_id}
        ):
            return {
                "accountId": normalized_account_id,
                "actionStatus": "task_protected",
                "propagated": False,
                "assessment": assessment,
            }

        account = await self.client.get_account(normalized_account_id)
        was_enabled = bool(account.get("enabled"))
        if was_enabled:
            await self.client.set_account_enabled(normalized_account_id, False)
        previous_enabled = assessment.get("previous_upstream_enabled")
        if previous_enabled is None:
            previous_enabled = was_enabled
        disabled_by_monitor = bool(assessment.get("disabled_by_monitor")) or was_enabled
        isolated = self.accounts.set_manual_status(
            account_id=normalized_account_id,
            status="quarantined",
            note=note,
            quarantine_until=None,
            previous_upstream_enabled=bool(previous_enabled),
            disabled_by_monitor=disabled_by_monitor,
            recovery_guarded=False,
            source=source or "manual",
            disposition_action="isolate",
            evidence=evidence_from(detail=detail, assessment=assessment),
        )
        action_status = "disabled" if was_enabled else "already_disabled"
        normalized_source = str(source or "manual").strip() or "manual"
        if normalized_source == "manual":
            alert_kind = "manual_isolate"
            severity = "warning"
            title = "账号已移入隔离区"
        else:
            alert_kind = (
                "auto_isolate"
                if normalized_source == "probe"
                else f"{normalized_source}_auto_isolate"[:48]
            )
            severity = "critical"
            title = (
                "账号已被自动移入隔离区"
                if was_enabled
                else "账号已处于停用状态并移入隔离区"
            )
        self.accounts.create_alert(
            account_id=normalized_account_id,
            kind=alert_kind,
            severity=severity,
            title=title,
            detail={
                "source": normalized_source,
                "actionStatus": action_status,
                "quarantineUntil": None,
                "recoveryMode": "permanent",
                **(detail or {}),
            },
        )
        return {
            "accountId": normalized_account_id,
            "actionStatus": action_status,
            "propagated": was_enabled,
            "quarantineUntil": None,
            "assessment": isolated,
        }

    async def apply_auto_quarantine(
        self,
        account_id: int,
        *,
        source: str,
        note: str,
        risk_score: float,
        detail: dict[str, Any] | None = None,
        force: bool = False,
        permanent: bool = False,
    ) -> dict[str, Any]:
        """Apply the shared automatic stop while respecting probe ownership.

        Callers are responsible for deciding that their evidence is strong
        enough.  This boundary owns the final upstream mutation, local
        quarantine state, alert, and a machine-readable action result.
        """

        normalized_account_id = int(account_id)
        assessment = self.accounts.get_assessment(normalized_account_id) or {}
        was_already_quarantined = (
            str(assessment.get("monitor_status") or "") == "quarantined"
        )
        if not self.settings.auto_quarantine and not force:
            return {
                "accountId": normalized_account_id,
                "actionStatus": "auto_quarantine_disabled",
                "assessment": assessment,
            }
        if self.request_audits is not None:
            self.request_audits.clear_egress_recommendations_for_account(
                normalized_account_id
            )
        if was_already_quarantined and not force:
            return {
                "accountId": normalized_account_id,
                "actionStatus": "already_quarantined",
                "assessment": assessment,
            }
        if normalized_account_id in self.probes.account_settings_locked_ids(
            {normalized_account_id}
        ):
            return {
                "accountId": normalized_account_id,
                "actionStatus": "task_protected",
                "assessment": assessment,
            }

        account = await self.client.get_account(normalized_account_id)
        was_enabled = bool(account.get("enabled"))
        if was_enabled:
            await self.client.set_account_enabled(normalized_account_id, False)
        previous_enabled = assessment.get("previous_upstream_enabled")
        if previous_enabled is None:
            previous_enabled = was_enabled
        disabled_by_monitor = bool(assessment.get("disabled_by_monitor")) or was_enabled
        until = None
        if not permanent and self.settings.auto_quarantine_recovery_enabled:
            until = utc_now() + timedelta(minutes=self.settings.quarantine_minutes)
        quarantined = self.accounts.set_manual_status(
            account_id=normalized_account_id,
            status="quarantined",
            note=note,
            quarantine_until=until,
            previous_upstream_enabled=bool(previous_enabled),
            disabled_by_monitor=disabled_by_monitor,
            recovery_guarded=False,
            source=source,
            disposition_action="isolate" if until is None else "quarantine",
            evidence=evidence_from(detail=detail, assessment=assessment),
        )
        action_status = (
            "disabled"
            if was_enabled
            else "already_quarantined"
            if was_already_quarantined
            else "already_disabled"
        )
        normalized_source = str(source or "monitor").strip() or "monitor"
        alert_kind = (
            "auto_quarantine"
            if normalized_source == "probe"
            else f"{normalized_source}_auto_quarantine"[:48]
        )
        self.accounts.create_alert(
            account_id=normalized_account_id,
            kind=alert_kind,
            severity="critical",
            title=(
                "账号已被自动停用"
                if was_enabled
                else "账号已处于停用状态并记录隔离"
            ),
            detail={
                "source": normalized_source,
                "actionStatus": action_status,
                "quarantineUntil": app_isoformat(until),
                "recoveryMode": (
                    "temporary" if until is not None else "permanent"
                ),
                "riskScore": float(risk_score),
                **(detail or {}),
            },
        )
        return {
            "accountId": normalized_account_id,
            "actionStatus": action_status,
            "quarantineUntil": to_app_timezone(until),
            "assessment": quarantined,
        }

    async def apply_tps_only_deprioritization(
        self,
        account_id: int,
        *,
        source: str,
        note: str,
        detail: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Lower an account's upstream priority for TPS-only anomalies.

        Kept for compatibility with historical request-audit rows. New
        TPS-only high-risk accounts are isolated instead of deprioritized
        because SSO can no longer confirm the account is clean.
        """

        normalized_account_id = int(account_id)
        target_priority = int(self.settings.request_audit_tps_only_priority)
        if not self.settings.request_audit_tps_only_deprioritize_enabled:
            return {
                "accountId": normalized_account_id,
                "actionStatus": "deprioritize_disabled",
                "priority": target_priority,
            }
        if normalized_account_id in self.probes.account_settings_locked_ids(
            {normalized_account_id}
        ):
            return {
                "accountId": normalized_account_id,
                "actionStatus": "task_protected",
                "priority": target_priority,
                "actionError": "账号正在执行探针任务，任务释放设置锁后重试",
            }
        account = await self.client.get_account(normalized_account_id)
        current_priority_raw = account.get("priority")
        try:
            current_priority = int(current_priority_raw)
        except (TypeError, ValueError):
            current_priority = 0
        if current_priority <= target_priority:
            return {
                "accountId": normalized_account_id,
                "actionStatus": "already_deprioritized",
                "priority": current_priority,
                "previousPriority": current_priority,
            }
        await self.client.set_account_priority(normalized_account_id, target_priority)
        normalized_source = str(source or "request_audit").strip() or "request_audit"
        self.accounts.create_alert(
            account_id=normalized_account_id,
            kind="request_audit_deprioritize",
            severity="warning",
            title="TPS 多次异常，账号已降低优先级",
            detail={
                "source": normalized_source,
                "actionStatus": "deprioritized",
                "previousPriority": current_priority,
                "priority": target_priority,
                "recommendation": "change_egress",
                **(detail or {}),
            },
        )
        return {
            "accountId": normalized_account_id,
            "actionStatus": "deprioritized",
            "priority": target_priority,
            "previousPriority": current_priority,
        }

    async def set_accounts_enabled(
        self,
        *,
        account_ids: list[int],
        enabled: bool,
    ) -> dict[str, Any]:
        unique_ids = list(
            dict.fromkeys(account_id for account_id in account_ids if account_id > 0)
        )
        if not unique_ids:
            raise ValueError("至少选择一个账号")
        locked_ids = self.probes.account_settings_locked_ids(set(unique_ids))
        eligible_ids = [
            account_id for account_id in unique_ids if account_id not in locked_ids
        ]
        update_result = (
            await self.client.set_accounts_enabled(eligible_ids, enabled)
            if eligible_ids
            else None
        )
        failures = list(update_result.failures) if update_result else []
        return {
            "requested": len(unique_ids),
            "eligible": len(eligible_ids),
            "updated": update_result.updated if update_result else 0,
            "enabled": enabled,
            "skippedAccountIds": sorted(locked_ids),
            "failedAccountIds": sorted(failure.account_id for failure in failures),
            "failures": [
                {"id": failure.account_id, "error": failure.error}
                for failure in failures
            ],
        }

    async def set_accounts_egress(
        self,
        *,
        account_ids: list[int],
        egress_node_id: int | None,
    ) -> dict[str, Any]:
        unique_ids = list(
            dict.fromkeys(account_id for account_id in account_ids if account_id > 0)
        )
        if not unique_ids:
            raise ValueError("至少选择一个账号")
        locked_ids = self.probes.account_settings_locked_ids(set(unique_ids))
        eligible_ids = [
            account_id for account_id in unique_ids if account_id not in locked_ids
        ]
        update_result = (
            await self.client.set_accounts_egress(
                eligible_ids,
                egress_node_id,
                mode="manual",
            )
            if eligible_ids
            else None
        )
        failures = list(update_result.failures) if update_result else []
        successful_ids = set(eligible_ids) - {
            int(failure.account_id) for failure in failures
        }
        if self.request_audits is not None:
            for account_id in successful_ids:
                self.request_audits.clear_egress_recommendations_for_account(
                    account_id
                )
        return {
            "requested": len(unique_ids),
            "eligible": len(eligible_ids),
            "updated": update_result.updated if update_result else 0,
            "egressNodeId": egress_node_id,
            "assignmentMode": "manual" if egress_node_id is not None else "",
            "skippedAccountIds": sorted(locked_ids),
            "failedAccountIds": sorted(failure.account_id for failure in failures),
            "failures": [
                {"id": failure.account_id, "error": failure.error}
                for failure in failures
            ],
        }

    async def ensure_account_egress(self, account: dict[str, Any]) -> dict[str, Any]:
        """Pin one unbound webhook account to the least-loaded healthy egress."""

        account_id = int(account.get("id") or 0)
        if account_id <= 0:
            raise ValueError("Webhook 账号缺少有效 ID")
        if int(account.get("egressNodeId") or 0) > 0:
            return account
        rebound = await self.rebind_account_egress(account)
        if rebound is None:
            raise ValueError("当前没有可用于自动绑定的健康 grok_build 出口")
        return rebound

    async def rebind_account_egress(
        self,
        account: dict[str, Any],
        *,
        exclude_node_ids: set[int] | None = None,
    ) -> dict[str, Any] | None:
        """Move one account onto the least-loaded healthy egress still unused."""

        account_id = int(account.get("id") or 0)
        if account_id <= 0:
            raise ValueError("Webhook 账号缺少有效 ID")
        excluded = {node_id for node_id in (exclude_node_ids or set()) if node_id > 0}
        current_id = int(account.get("egressNodeId") or 0)
        if current_id > 0:
            excluded.add(current_id)
        selected = await self._select_healthy_egress(exclude_node_ids=excluded)
        if selected is None:
            return None
        node_id = int(selected.get("id") or 0)
        if node_id <= 0:
            raise ValueError("自动绑定选出的出口节点 ID 无效")
        result = await self.client.set_accounts_egress(
            [account_id],
            node_id,
            mode="manual",
        )
        if result.updated != 1:
            reason = (
                result.failures[0].error if result.failures else "上游未更新账号绑定"
            )
            raise ValueError(f"Webhook 账号自动绑定出口失败：{reason}")
        return await self.client.get_account(account_id)

    async def _select_healthy_egress(
        self,
        *,
        exclude_node_ids: set[int],
    ) -> dict[str, Any] | None:
        payload = await self.client.list_egress_nodes(page=1, pageSize=500)
        candidates: list[dict[str, Any]] = []
        for node in payload.get("items", []):
            node_id = int(node.get("id") or 0)
            capacity = int(node.get("accountCapacity") or 0)
            assigned = int(node.get("assignedAccountCount") or 0)
            if node_id <= 0 or node_id in exclude_node_ids:
                continue
            if not bool(node.get("enabled")) or not bool(node.get("proxyConfigured")):
                continue
            if str(node.get("probeStatus") or "") != "healthy":
                continue
            if capacity > 0 and assigned >= capacity:
                continue
            candidates.append(node)
        if not candidates:
            return None
        return min(
            candidates,
            key=lambda node: (
                int(node.get("assignedAccountCount") or 0),
                int(node.get("id") or 0),
            ),
        )

    def _require_isolation_zone(self, account_id: int) -> dict[str, Any]:
        assessment = self.accounts.get_assessment(account_id)
        if not self._is_isolation_zone(assessment):
            raise ValueError("只有隔离区账号可以填写备注")
        return assessment or {}

    def _operator_note_payload(
        self,
        account_id: int,
        assessment: dict[str, Any],
    ) -> dict[str, Any]:
        notes = list(assessment.get("operator_notes") or [])
        return {
            "accountId": account_id,
            "notes": notes,
            "operatorNote": str(assessment.get("operator_note") or ""),
            "assessment": assessment,
        }

    async def add_operator_note(
        self,
        account_id: int,
        note: str,
    ) -> dict[str, Any]:
        """Append an operator remark on an isolated account."""

        normalized_account_id = int(account_id)
        normalized_note = str(note or "").strip()
        if not normalized_note:
            raise ValueError("备注不能为空")
        if len(normalized_note) > 2000:
            raise ValueError("备注不能超过 2000 个字符")
        self._require_isolation_zone(normalized_account_id)
        updated = self.accounts.add_operator_note(
            normalized_account_id,
            normalized_note,
        )
        return self._operator_note_payload(normalized_account_id, updated)

    async def update_operator_note(
        self,
        account_id: int,
        note_id: str,
        note: str,
    ) -> dict[str, Any]:
        """Edit one operator remark on an isolated account."""

        normalized_account_id = int(account_id)
        normalized_note_id = str(note_id or "").strip()
        normalized_note = str(note or "").strip()
        if not normalized_note_id:
            raise ValueError("备注不存在")
        if not normalized_note:
            raise ValueError("备注不能为空")
        if len(normalized_note) > 2000:
            raise ValueError("备注不能超过 2000 个字符")
        self._require_isolation_zone(normalized_account_id)
        updated = self.accounts.update_operator_note(
            normalized_account_id,
            normalized_note_id,
            normalized_note,
        )
        return self._operator_note_payload(normalized_account_id, updated)

    async def delete_operator_note(
        self,
        account_id: int,
        note_id: str,
    ) -> dict[str, Any]:
        """Delete one operator remark on an isolated account."""

        normalized_account_id = int(account_id)
        normalized_note_id = str(note_id or "").strip()
        if not normalized_note_id:
            raise ValueError("备注不存在")
        self._require_isolation_zone(normalized_account_id)
        updated = self.accounts.delete_operator_note(
            normalized_account_id,
            normalized_note_id,
        )
        return self._operator_note_payload(normalized_account_id, updated)

    def isolation_stats(self, *, start: str = "", end: str = "") -> dict[str, Any]:
        range_start, range_end = resolve_stats_range(start, end)
        events = (
            self.register_events.list_created_between(range_start, range_end)
            if self.register_events is not None
            else []
        )
        return compute_isolation_stats(
            assessments=self.accounts.list_isolation_zone(),
            register_events=events,
            start=range_start,
            end=range_end,
        )

    async def list_isolation_zone(
        self,
        *,
        page: int,
        page_size: int,
        search: str = "",
        upstream_status: str = "",
        sso_risk: str = "",
        egress_node_id: str = "",
        source: str = "",
    ) -> dict[str, Any]:
        assessments = self.accounts.list_isolation_zone()
        account_ids = [int(item["account_id"]) for item in assessments]
        upstream_by_id: dict[int, dict[str, Any]] = {}
        if account_ids:
            upstream_items = await self.client.get_accounts_by_ids(set(account_ids))
            upstream_by_id = {
                int(item.get("id") or 0): item for item in upstream_items
            }
        sso_account_ids = self._account_ids_with_sso(account_ids)
        verifications = self._latest_verifications(account_ids)
        values = []
        for assessment in assessments:
            account_id = int(assessment["account_id"])
            item = upstream_by_id.get(account_id)
            missing_upstream = item is None
            if missing_upstream:
                item = self._missing_upstream_stub(account_id)
            sso_available = False if missing_upstream else account_id in sso_account_ids
            verification = None if missing_upstream else verifications.get(account_id)
            overlaid = self._overlay(
                item,
                assessment,
                sso_available=sso_available,
                verification=verification,
            )
            if (
                self._matches(overlaid, search=search, enabled="")
                and self._matches_upstream_status(overlaid, upstream_status)
                and self._matches_egress(overlaid, egress_node_id)
                and self._matches_sso_risk(
                    verification,
                    sso_available=sso_available,
                    sso_risk=sso_risk,
                )
                and self._matches_source(overlaid, source)
            ):
                values.append(overlaid)
        start = (page - 1) * page_size
        return {
            "items": values[start : start + page_size],
            "total": len(values),
            "page": page,
            "pageSize": page_size,
        }

    async def delete_local_quarantine_records(
        self,
        *,
        account_ids: list[int],
    ) -> dict[str, Any]:
        unique_ids = list(
            dict.fromkeys(account_id for account_id in account_ids if account_id > 0)
        )
        if not unique_ids:
            raise ValueError("至少选择一个账号")
        locked_ids = self.probes.account_settings_locked_ids(set(unique_ids))
        eligible_ids = [
            account_id for account_id in unique_ids if account_id not in locked_ids
        ]
        deleted = 0
        failures: list[dict[str, Any]] = []
        for account_id in eligible_ids:
            try:
                self.accounts.delete_assessment(account_id)
                self.accounts.delete_alerts_for_account(account_id)
                self.probes.delete_samples_for_account(account_id)
            except Exception as exc:
                failures.append({"id": account_id, "error": str(exc)})
                continue
            deleted += 1
        return {
            "requested": len(unique_ids),
            "eligible": len(eligible_ids),
            "deleted": deleted,
            "skippedAccountIds": sorted(locked_ids),
            "failedAccountIds": sorted(int(item["id"]) for item in failures),
            "failures": failures,
        }

    async def delete_upstream_account(self, account_id: int) -> dict[str, Any]:
        await self.client.delete_account(account_id)
        self.accounts.create_alert(
            account_id=account_id,
            kind="upstream_delete",
            severity="warning",
            title="账号已通过 grok2api API 删除",
            detail={},
        )
        return {"deleted": True, "accountId": account_id}

    async def delete_upstream_accounts(
        self,
        *,
        account_ids: list[int],
    ) -> dict[str, Any]:
        unique_ids = list(
            dict.fromkeys(account_id for account_id in account_ids if account_id > 0)
        )
        if not unique_ids:
            raise ValueError("至少选择一个账号")
        locked_ids = self.probes.account_settings_locked_ids(set(unique_ids))
        eligible_ids = [
            account_id for account_id in unique_ids if account_id not in locked_ids
        ]
        delete_result = (
            await self.client.delete_accounts(eligible_ids) if eligible_ids else None
        )
        failures = list(delete_result.failures) if delete_result else []
        failed_account_ids = {failure.account_id for failure in failures}
        for account_id in eligible_ids:
            if account_id in failed_account_ids:
                continue
            self.accounts.create_alert(
                account_id=account_id,
                kind="upstream_delete",
                severity="warning",
                title="账号已通过 grok2api API 删除",
                detail={},
            )
        return {
            "requested": len(unique_ids),
            "eligible": len(eligible_ids),
            "deleted": delete_result.deleted if delete_result else 0,
            "skippedAccountIds": sorted(locked_ids),
            "failedAccountIds": sorted(failed_account_ids),
            "failures": [
                {"id": failure.account_id, "error": failure.error}
                for failure in failures
            ],
        }

    async def delete_quarantine_upstream_accounts(
        self,
        *,
        account_ids: list[int],
    ) -> dict[str, Any]:
        unique_ids = list(
            dict.fromkeys(account_id for account_id in account_ids if account_id > 0)
        )
        if not unique_ids:
            raise ValueError("至少选择一个账号")
        assessments = self.accounts.get_assessments(unique_ids)
        isolation_ids = [
            account_id
            for account_id in unique_ids
            if self._is_isolation_zone(assessments.get(account_id))
        ]
        skipped_not_quarantined = [
            account_id
            for account_id in unique_ids
            if not self._is_isolation_zone(assessments.get(account_id))
        ]
        if isolation_ids:
            result = await self.delete_upstream_accounts(account_ids=isolation_ids)
        else:
            result = {
                "requested": 0,
                "eligible": 0,
                "deleted": 0,
                "skippedAccountIds": [],
                "failedAccountIds": [],
                "failures": [],
            }
        result["requested"] = len(unique_ids)
        result["skippedNotQuarantinedAccountIds"] = sorted(skipped_not_quarantined)
        return result

    async def recover_due_quarantines(self) -> dict[str, Any]:
        restored = 0
        guarded = 0
        failed: list[dict[str, Any]] = []
        for assessment in self.accounts.due_quarantines():
            account_id = int(assessment["account_id"])
            try:
                should_enable = bool(assessment.get("previous_upstream_enabled"))
                if should_enable:
                    await self.client.recover_account_at_priority(
                        account_id,
                        priority=QUARANTINE_RECOVERY_PRIORITY,
                    )
                self.accounts.mark_restored(account_id, recovery_guarded=should_enable)
                if should_enable:
                    guarded += 1
                restored += 1
            except Exception as exc:
                failed.append({"accountId": account_id, "error": str(exc)})
        return {
            "restored": restored,
            "guarded": guarded,
            "priority": QUARANTINE_RECOVERY_PRIORITY,
            "failed": failed,
        }

    async def find_registered_account(
        self, account_id: int | None, email: str
    ) -> dict[str, Any] | None:
        if account_id:
            try:
                return await self.client.get_account(account_id)
            except Exception:
                pass
        payload = await self.client.list_accounts(search=email, page=1, pageSize=50)
        for account in payload.get("items", []):
            if str(account.get("email") or "").lower() == email.lower():
                return account
        return None

    @staticmethod
    def _upstream_status_filter(upstream_status: str) -> dict[str, str]:
        return {"status": upstream_status} if upstream_status else {}

    @staticmethod
    def _matches(item: dict[str, Any], *, search: str, enabled: str) -> bool:
        if enabled in {"true", "false"} and bool(item.get("enabled")) != (
            enabled == "true"
        ):
            return False
        if not search.strip():
            return True
        token = search.strip().lower()
        return (
            token in str(item.get("name") or "").lower()
            or token in str(item.get("email") or "").lower()
            or token == str(item.get("id") or "")
        )

    @staticmethod
    def _matches_upstream_status(item: dict[str, Any], upstream_status: str) -> bool:
        requested = str(upstream_status or "").strip()
        if not requested or requested == "all":
            return True
        if requested == "missing":
            return bool(item.get("missingUpstream"))
        auth_status = str(item.get("authStatus") or "")
        quota = item.get("quota") if isinstance(item.get("quota"), dict) else {}
        quota_status = str(quota.get("status") or "")
        enabled = bool(item.get("enabled"))
        if requested == "disabled":
            return not enabled
        if requested == "active":
            return enabled and auth_status in {"", "active"}
        if requested == "reauthRequired":
            return auth_status == "reauthRequired"
        if requested == "cooldown":
            return auth_status == "cooldown"
        if requested == "waitingReset":
            return quota_status == "waitingReset"
        if requested == "probing":
            return quota_status == "probing"
        return True

    @staticmethod
    def _matches_egress(item: dict[str, Any], egress_node_id: str) -> bool:
        requested = str(egress_node_id or "").strip().lower()
        if not requested or requested == "all":
            return True
        if requested in {"unbound", "none"}:
            return not str(item.get("egressNodeId") or "").strip()
        return str(item.get("egressNodeId") or "").strip() == requested

    @staticmethod
    def _is_quarantined(assessment: dict[str, Any] | None) -> bool:
        value = assessment or {}
        return str(value.get("monitor_status") or "") == "quarantined"

    @staticmethod
    def _is_isolation_zone(assessment: dict[str, Any] | None) -> bool:
        value = assessment or {}
        return (
            str(value.get("monitor_status") or "") == "quarantined"
            and value.get("quarantine_until") is None
        )

    @staticmethod
    def _missing_upstream_stub(account_id: int) -> dict[str, Any]:
        return {
            "id": account_id,
            "name": f"账号 #{account_id}",
            "enabled": False,
            "missingUpstream": True,
        }

    @staticmethod
    def _matches_assessment(
        assessment: dict[str, Any] | None,
        *,
        monitor_status: str,
        recovery_guarded: str,
    ) -> bool:
        value = assessment or {}
        if monitor_status and value.get("monitor_status", "healthy") != monitor_status:
            return False
        if recovery_guarded in {"true", "false"}:
            return bool(value.get("recovery_guarded")) == (recovery_guarded == "true")
        return True

    @staticmethod
    def _is_probe_selectable(item: dict[str, Any]) -> bool:
        auth_status = str(item.get("authStatus") or "")
        return not auth_status or auth_status == "active"

    def _account_ids_with_sso(self, account_ids: list[int]) -> set[int]:
        if self.register_events is None:
            return set()
        return self.register_events.account_ids_with_sso(account_ids)

    def _latest_verifications(self, account_ids: list[int]) -> dict[int, dict[str, Any]]:
        audit_values = (
            self.request_audits.latest_verifications_for_accounts(account_ids)
            if self.request_audits is not None
            else {}
        )
        report_values = (
            self.sso_reports.latest_account_results(account_ids)
            if self.sso_reports is not None
            else {}
        )
        merged = dict(audit_values)
        for account_id, value in report_values.items():
            report_value = self._sso_report_verification(value)
            current = merged.get(account_id)
            if (
                current is None
                or self._verification_time(report_value)
                >= self._verification_time(current)
            ):
                merged[account_id] = report_value
        return merged

    def latest_sso_verifications(
        self,
        account_ids: list[int],
    ) -> dict[int, dict[str, Any]]:
        """Expose the newest audit or account-report SSO evidence by account."""

        return self._latest_verifications(account_ids)

    @staticmethod
    def _verification_time(value: dict[str, Any]) -> float:
        raw = (
            value.get("checked_at")
            or value.get("updated_at")
            or value.get("_report_completed_at")
        )
        if hasattr(raw, "timestamp"):
            try:
                return float(raw.timestamp())
            except (TypeError, ValueError, OverflowError):
                pass
        try:
            return datetime.fromisoformat(str(raw).replace("Z", "+00:00")).timestamp()
        except (TypeError, ValueError, OverflowError):
            return 0.0

    @staticmethod
    def _sso_report_verification(value: dict[str, Any]) -> dict[str, Any]:
        bot_flag = value.get("bot_flag")
        if not isinstance(bot_flag, dict):
            bot_flag = {}
        verdict = str(value.get("verdict") or "error")
        if value.get("valid_session") is not True:
            status = "check_failed"
        elif value.get("email_match") is not True:
            status = "email_mismatch"
        elif bool(bot_flag.get("flagged")) or verdict.startswith("flagged"):
            status = "flagged"
        elif verdict == "clean":
            status = "clean"
        else:
            status = "check_failed"
        action = value.get("account_action")
        if not isinstance(action, dict):
            action = {}
        return {
            "account_id": int(value.get("account_id") or 0),
            "status": status,
            "sso_verdict": verdict,
            "bot_flag": bot_flag,
            "proxy_used": bool(value.get("_report_proxy_used")),
            "valid_session": value.get("valid_session"),
            "email_match": value.get("email_match"),
            "status_code": int(value.get("status_code") or 0),
            "response_ms": int(value.get("response_ms") or 0),
            "check_error": str(value.get("error") or ""),
            "action_status": str(action.get("status") or "not_required"),
            "action_error": str(action.get("error") or ""),
            "checked_at": value.get("checked_at") or value.get("_report_completed_at"),
            "updated_at": value.get("_report_completed_at"),
            "egress_recommendation": {},
            "_report_id": value.get("_report_id"),
        }

    @staticmethod
    def _sso_status(
        verification: dict[str, Any] | None,
        *,
        sso_available: bool,
    ) -> str:
        if not verification:
            return "unverified" if sso_available else "missing"
        status = str(verification.get("status") or "").strip()
        if status == "sso_skipped":
            return "unverified" if sso_available else "missing"
        if status == "missing_sso" or not sso_available:
            return "missing"
        if status in {
            "proxy_required",
            "invalid_session",
            "email_mismatch",
            "check_failed",
            "isolation_disabled",
        }:
            return "failed"
        if status == "flagged":
            return "flagged"
        if not status and bool(
            (verification.get("bot_flag") or {}).get("flagged")
            if isinstance(verification.get("bot_flag"), dict)
            else False
        ):
            return "flagged"
        if status in {"clean", "session_confirmed"}:
            return "clean"
        if status in {"pending", "checking"}:
            return "pending"
        return "unverified"

    @classmethod
    def _sso_overlay(
        cls,
        verification: dict[str, Any] | None,
        *,
        sso_available: bool,
    ) -> dict[str, Any]:
        value = verification or {}
        bot_flag = value.get("bot_flag")
        if not isinstance(bot_flag, dict):
            bot_flag = {}
        recommendation = value.get("egress_recommendation")
        if not isinstance(recommendation, dict) or not recommendation:
            recommendation = None
        return {
            "ssoRiskStatus": cls._sso_status(
                verification,
                sso_available=sso_available,
            ),
            "ssoRiskCheckedAt": value.get("checked_at"),
            "ssoBotFlagged": bool(bot_flag.get("flagged")),
            "ssoBotSource": bot_flag.get("source"),
            "ssoPreDisableAction": str(value.get("action_status") or ""),
            "egressRecommendation": recommendation,
        }

    @classmethod
    def _matches_sso_risk(
        cls,
        verification: dict[str, Any] | None,
        *,
        sso_available: bool,
        sso_risk: str,
    ) -> bool:
        requested = str(sso_risk or "").strip().lower()
        if requested in {"", "all"}:
            return True
        overlay = cls._sso_overlay(verification, sso_available=sso_available)
        if requested == "change_egress":
            recommendation = overlay.get("egressRecommendation") or {}
            return recommendation.get("type") == "change_egress"
        return overlay.get("ssoRiskStatus") == requested

    @staticmethod
    def _matches_source(overlaid: dict[str, Any], source: str) -> bool:
        assessment = overlaid.get("assessment")
        disposition = (
            assessment.get("disposition")
            if isinstance(assessment, dict)
            else {}
        )
        current = ""
        if isinstance(disposition, dict):
            current = str(disposition.get("source") or "")
        return matches_disposition_source(current, source)

    @staticmethod
    def _overlay(
        item: dict[str, Any],
        assessment: dict[str, Any] | None,
        *,
        sso_available: bool = False,
        verification: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {
            **item,
            "ssoAvailable": sso_available,
            **AccountService._sso_overlay(
                verification,
                sso_available=sso_available,
            ),
            "assessment": assessment
            or {
                "account_id": int(item.get("id") or 0),
                "monitor_status": "healthy",
                "risk_score": 0,
                "sample_count": 0,
                "anomaly_count": 0,
                "risk_reasons": [],
                "recovery_guarded": False,
            },
        }


def _count(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _provider_counts(value: Any) -> dict[str, int]:
    payload = value if isinstance(value, dict) else {}
    return {
        "total": _count(payload.get("total")),
        "available": _count(payload.get("available")),
    }


_PUBLIC_INVENTORY_KEYS = (
    "total",
    "available",
    "recovering",
    "attention",
    "recovery",
    "issues",
)


def _public_upstream_view(
    payload: dict[str, Any], *, include_inventory: bool
) -> dict[str, Any]:
    if include_inventory:
        return dict(payload)
    return {
        key: value
        for key, value in payload.items()
        if key not in _PUBLIC_INVENTORY_KEYS
    }


def _public_upstream_summary(raw: Any, *, reachable: bool) -> dict[str, Any]:
    payload = raw if isinstance(raw, dict) else {}
    providers_raw = payload.get("providers")
    providers = providers_raw if isinstance(providers_raw, dict) else {}
    recovery_raw = payload.get("recovery")
    recovery = recovery_raw if isinstance(recovery_raw, dict) else {}
    issues_raw = payload.get("issues")
    issues = issues_raw if isinstance(issues_raw, dict) else {}
    return {
        "reachable": reachable,
        "updatedAt": app_isoformat(utc_now()),
        "total": _count(payload.get("total")),
        "available": _count(payload.get("available")),
        "recovering": _count(payload.get("recovering")),
        "attention": _count(payload.get("attention")),
        "risk": _count(payload.get("risk")),
        "providers": {
            name: _provider_counts(providers.get(name))
            for name in PUBLIC_UPSTREAM_PROVIDERS
        },
        "recovery": {
            "cooldown": _count(recovery.get("cooldown")),
            "waitingReset": _count(recovery.get("waitingReset")),
            "probing": _count(recovery.get("probing")),
        },
        "issues": {
            "disabled": _count(issues.get("disabled")),
            "reauthRequired": _count(issues.get("reauthRequired")),
        },
    }
