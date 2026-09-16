from __future__ import annotations

import math
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import delete, func, or_, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.core.clock import utc_now

from .database import Database
from .models import (
    ProbeDurationEstimate,
    ProbePlan,
    ProbeProfile,
    ProbeRun,
    ProbeSample,
    RequestAuditRecord,
    ScheduleExecution,
    model_dict,
)
from .probe_catalog_seeder import (
    PROBE_DURATION_ESTIMATE_BACKFILL_KEY as _PROBE_DURATION_ESTIMATE_BACKFILL_KEY,
)
from .probe_catalog_seeder import (
    SAFE_CURRENT_EGRESS_MIGRATION_KEY as _SAFE_CURRENT_EGRESS_MIGRATION_KEY,
)
from .probe_catalog_seeder import ProbeCatalogSeeder
from .probe_queue_writer import ProbeQueueWriter, QueuePolicy
from .probe_run_reader import ProbeRunReader
from .seeds import DEFAULT_PROFILE_IDS

ACTIVE_RUN_STATUSES = {"queued", "running", "cancel_requested", "recovering"}
CANCELLABLE_RUN_STATUSES = {"queued", "running", "recovering"}
EXECUTING_RUN_STATUSES = {"running", "cancel_requested", "recovering"}
ESTIMATED_RUN_STATUSES = {"queued", "running"}
TERMINAL_RUN_STATUSES = {"completed", "completed_with_errors", "failed", "cancelled"}
BLOCKING_ACCOUNT_RESTORE_STATUSES = {"restoring", "restore_failed"}
DEGRADATION_CLASSIFICATIONS = frozenset(
    {
        "elevated",
        "buffered_soft",
        "buffered_hard",
        "fast_risk",
        "marker_miss",
        "reasoning_zero",
        "reasoning_zero_observe",
    }
)
PROBE_WARNING_CLASSIFICATIONS = frozenset({"insufficient"})
PROBE_DURATION_ESTIMATE_BACKFILL_KEY = _PROBE_DURATION_ESTIMATE_BACKFILL_KEY
SAFE_CURRENT_EGRESS_MIGRATION_KEY = _SAFE_CURRENT_EGRESS_MIGRATION_KEY


def _profile_ids(profile_ids: Any, profile_id: Any = "") -> list[str]:
    values = (
        profile_ids if isinstance(profile_ids, list) and profile_ids else [profile_id]
    )
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = str(value or "").strip()
        if normalized and normalized not in seen:
            result.append(normalized)
            seen.add(normalized)
    return result


def _profile_dict(profile: ProbeProfile) -> dict[str, Any]:
    result = model_dict(profile)
    result["built_in"] = profile.id in DEFAULT_PROFILE_IDS
    return result


def _finite_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


class QueueFullError(ValueError):
    pass


class RunStateError(ValueError):
    pass


@dataclass(slots=True, frozen=True)
class RunExecutionContext:
    run: dict[str, Any]
    profile: dict[str, Any]


@dataclass(slots=True, frozen=True)
class AccountSettingsSnapshot:
    enabled: bool
    priority: int
    max_concurrent: int
    egress_node_id: int | None
    egress_assignment_mode: str
    diagnostic_priority: int
    diagnostic_max_concurrent: int


class ProbeRepository:
    def __init__(self, database: Database):
        self.database = database
        self._catalog_seeder = ProbeCatalogSeeder()
        self._queue_writer = ProbeQueueWriter(
            database,
            QueuePolicy(
                active_statuses=ACTIVE_RUN_STATUSES,
                restore_statuses=BLOCKING_ACCOUNT_RESTORE_STATUSES,
            ),
            profile_ids=_profile_ids,
            require_profiles=lambda session, profile_ids: self._require_profiles(
                session, profile_ids, require_enabled=True
            ),
            queue_full_error=QueueFullError,
            run_state_error=RunStateError,
        )
        self._run_reader = ProbeRunReader(
            database,
            active_statuses=ACTIVE_RUN_STATUSES,
            cancellable_statuses=CANCELLABLE_RUN_STATUSES,
            executing_statuses=EXECUTING_RUN_STATUSES,
            estimated_statuses=ESTIMATED_RUN_STATUSES,
            terminal_statuses=TERMINAL_RUN_STATUSES,
            restore_statuses=BLOCKING_ACCOUNT_RESTORE_STATUSES,
            degradation_classifications=DEGRADATION_CLASSIFICATIONS,
            profile_dict=_profile_dict,
        )

    def reconcile_sample_metrics_from_request_audits(self) -> int:
        """Copy authoritative server timing into samples created by chat probes.

        The local stream clock can observe visible content after a buffered
        reasoning block.  Request audits contain grok2api's canonical timing
        and TPS, so matching samples must use those values before risk scores
        are recalculated.
        """

        updated = 0
        with self.database.transaction() as session:
            rows = session.execute(
                select(ProbeSample, RequestAuditRecord)
                .join(
                    RequestAuditRecord,
                    ProbeSample.request_id == RequestAuditRecord.request_id,
                )
                .where(ProbeSample.request_id != "")
            ).all()
            for sample, audit in rows:
                tps = _finite_float(audit.tps)
                if tps is None:
                    continue
                changed = any(
                    (
                        sample.output_tokens != audit.output_tokens,
                        sample.reasoning_tokens != audit.reasoning_tokens,
                        sample.first_token_ms != (audit.first_token_ms or 0),
                        sample.duration_ms != audit.duration_ms,
                        sample.generation_ms
                        != max(0, audit.duration_ms - (audit.first_token_ms or 0)),
                        sample.upstream_tps is None
                        or abs(float(sample.upstream_tps or 0) - tps) > 1e-9,
                    )
                )
                if not changed:
                    continue
                sample.output_tokens = audit.output_tokens
                sample.reasoning_tokens = audit.reasoning_tokens
                sample.visible_tokens = max(
                    0, audit.output_tokens - audit.reasoning_tokens
                )
                sample.first_token_ms = audit.first_token_ms or 0
                sample.duration_ms = audit.duration_ms
                sample.generation_ms = max(
                    0, audit.duration_ms - (audit.first_token_ms or 0)
                )
                sample.first_token_share = (
                    sample.first_token_ms / sample.duration_ms
                    if sample.duration_ms > 0
                    else 0.0
                )
                sample.upstream_tps = tps
                sample.tps = tps
                updated += 1
        return updated

    def backfill_probe_upstream_tps(self) -> int:
        """Preserve legacy probe TPS before the override feature rewrites it."""
        with self.database.transaction() as session:
            samples = session.scalars(
                select(ProbeSample).where(ProbeSample.upstream_tps.is_(None))
            ).all()
            for sample in samples:
                sample.upstream_tps = sample.tps
            return len(samples)

    def seed_defaults(self) -> None:
        with self.database.transaction() as session:
            self._catalog_seeder.seed(session)

    @staticmethod
    def _is_legacy_direct_only(targets: Any) -> bool:
        return ProbeCatalogSeeder.is_legacy_direct_only(targets)

    # Profiles -----------------------------------------------------------------
    def list_profiles(self) -> list[dict[str, Any]]:
        with self.database.session() as session:
            values = session.scalars(
                select(ProbeProfile).order_by(
                    ProbeProfile.created_at.desc(), ProbeProfile.id.desc()
                )
            ).all()
            return [_profile_dict(value) for value in values]

    def get_profile(self, profile_id: str) -> dict[str, Any] | None:
        with self.database.session() as session:
            value = session.get(ProbeProfile, profile_id)
            return _profile_dict(value) if value else None

    def create_profile(self, values: dict[str, Any]) -> str:
        profile_id = uuid.uuid4().hex
        with self.database.transaction() as session:
            session.add(ProbeProfile(id=profile_id, **values))
        return profile_id

    def update_profile(self, profile_id: str, values: dict[str, Any]) -> dict[str, Any]:
        with self.database.transaction() as session:
            profile = session.get(ProbeProfile, profile_id)
            if profile is None:
                raise ValueError("探针方案不存在")
            for key, value in values.items():
                setattr(profile, key, value)
            profile.updated_at = utc_now()
            result = _profile_dict(profile)
        return result

    def delete_profile(self, profile_id: str) -> None:
        with self.database.transaction() as session:
            profile = session.get(ProbeProfile, profile_id)
            if profile is None:
                raise ValueError("探针方案不存在")
            used_by_run = session.scalar(
                select(func.count(ProbeRun.id)).where(ProbeRun.profile_id == profile_id)
            )
            plan_selections = session.execute(
                select(ProbePlan.profile_id, ProbePlan.profile_ids)
            ).all()
            used_by_plan = any(
                profile_id in _profile_ids(selected_ids, primary_id)
                for primary_id, selected_ids in plan_selections
            )
            if used_by_run or used_by_plan:
                raise RunStateError("探针方案已有计划或历史任务，请停用而不是删除")
            session.delete(profile)

    def delete_profiles(self, profile_ids: list[str]) -> dict[str, Any]:
        unique_ids = list(dict.fromkeys(value for value in profile_ids if value))
        with self.database.transaction() as session:
            profiles_by_id = {
                profile.id: profile
                for profile in session.scalars(
                    select(ProbeProfile).where(ProbeProfile.id.in_(unique_ids))
                ).all()
            }
            used_by_run = set(
                session.scalars(
                    select(ProbeRun.profile_id)
                    .where(ProbeRun.profile_id.in_(unique_ids))
                    .distinct()
                ).all()
            )
            plan_selections = session.execute(
                select(ProbePlan.profile_id, ProbePlan.profile_ids)
            ).all()
            used_by_plan = {
                profile_id
                for primary_id, selected_ids in plan_selections
                for profile_id in _profile_ids(selected_ids, primary_id)
                if profile_id in profiles_by_id
            }
            protected_ids = used_by_run | used_by_plan
            deleted_ids = [
                profile_id
                for profile_id in unique_ids
                if profile_id in profiles_by_id and profile_id not in protected_ids
            ]
            for profile_id in deleted_ids:
                session.delete(profiles_by_id[profile_id])

        missing_ids = [
            profile_id for profile_id in unique_ids if profile_id not in profiles_by_id
        ]
        protected_in_request = [
            profile_id for profile_id in unique_ids if profile_id in protected_ids
        ]
        return {
            "requested": len(unique_ids),
            "deleted": len(deleted_ids),
            "skipped": len(missing_ids) + len(protected_in_request),
            "protected": len(protected_in_request),
            "missing": len(missing_ids),
            "protectedIds": protected_in_request,
            "missingIds": missing_ids,
        }

    @staticmethod
    def _plan_dict(plan: ProbePlan) -> dict[str, Any]:
        result = model_dict(plan)
        selected_profile_ids = _profile_ids(
            result.get("profile_ids"), result.get("profile_id")
        )
        result["profile_ids"] = selected_profile_ids
        if selected_profile_ids:
            result["profile_id"] = selected_profile_ids[0]
        return result

    @staticmethod
    def _require_profiles(
        session: Any,
        profile_ids: list[str],
        *,
        require_enabled: bool,
    ) -> list[str]:
        selected_profile_ids = _profile_ids(profile_ids)
        if not selected_profile_ids:
            raise ValueError("至少选择一个探针方案")
        profiles = session.scalars(
            select(ProbeProfile).where(ProbeProfile.id.in_(selected_profile_ids))
        ).all()
        by_id = {profile.id: profile for profile in profiles}
        missing = [
            profile_id for profile_id in selected_profile_ids if profile_id not in by_id
        ]
        if missing:
            raise ValueError(f"探针方案不存在: {', '.join(missing)}")
        disabled = [
            profile_id
            for profile_id in selected_profile_ids
            if require_enabled and not by_id[profile_id].enabled
        ]
        if disabled:
            raise ValueError(f"探针方案已停用: {', '.join(disabled)}")
        return selected_profile_ids

    # Cron plans ----------------------------------------------------------------
    def list_plans(self) -> list[dict[str, Any]]:
        with self.database.session() as session:
            values = session.scalars(
                select(ProbePlan).order_by(
                    ProbePlan.enabled.desc(), ProbePlan.name.asc()
                )
            ).all()
            return [self._plan_dict(value) for value in values]

    def get_plan(self, plan_id: str) -> dict[str, Any] | None:
        with self.database.session() as session:
            value = session.get(ProbePlan, plan_id)
            return self._plan_dict(value) if value else None

    def create_plan(self, values: dict[str, Any]) -> str:
        plan_id = uuid.uuid4().hex
        with self.database.transaction() as session:
            selected_profile_ids = self._require_profiles(
                session,
                _profile_ids(values.get("profile_ids"), values.get("profile_id")),
                require_enabled=False,
            )
            values = {
                **values,
                "profile_id": selected_profile_ids[0],
                "profile_ids": selected_profile_ids,
            }
            session.add(ProbePlan(id=plan_id, **values))
        return plan_id

    def update_plan(self, plan_id: str, values: dict[str, Any]) -> dict[str, Any]:
        with self.database.transaction() as session:
            plan = session.get(ProbePlan, plan_id)
            if plan is None:
                raise ValueError("Cron 探针计划不存在")
            if "profile_id" in values or "profile_ids" in values:
                selected_profile_ids = self._require_profiles(
                    session,
                    _profile_ids(
                        values.get("profile_ids"),
                        values.get("profile_id", plan.profile_id),
                    ),
                    require_enabled=False,
                )
                values = {
                    **values,
                    "profile_id": selected_profile_ids[0],
                    "profile_ids": selected_profile_ids,
                }
            for key, value in values.items():
                setattr(plan, key, value)
            plan.updated_at = utc_now()
            result = self._plan_dict(plan)
        return result

    def delete_plan(self, plan_id: str) -> None:
        with self.database.transaction() as session:
            plan = session.get(ProbePlan, plan_id)
            if plan is None:
                raise ValueError("Cron 探针计划不存在")
            active = session.scalar(
                select(func.count(ProbeRun.id)).where(
                    ProbeRun.plan_id == plan_id,
                    ProbeRun.status.in_(ACTIVE_RUN_STATUSES),
                )
            )
            if active:
                raise RunStateError("计划仍有排队或执行中的任务")
            session.delete(plan)

    def delete_plans(self, plan_ids: list[str]) -> dict[str, Any]:
        unique_ids = list(dict.fromkeys(value for value in plan_ids if value))
        with self.database.transaction() as session:
            plans_by_id = {
                plan.id: plan
                for plan in session.scalars(
                    select(ProbePlan).where(ProbePlan.id.in_(unique_ids))
                ).all()
            }
            active_ids = set(
                session.scalars(
                    select(ProbeRun.plan_id)
                    .where(
                        ProbeRun.plan_id.in_(unique_ids),
                        ProbeRun.status.in_(ACTIVE_RUN_STATUSES),
                    )
                    .distinct()
                ).all()
            )
            deleted_ids = [
                plan_id
                for plan_id in unique_ids
                if plan_id in plans_by_id and plan_id not in active_ids
            ]
            for plan_id in deleted_ids:
                session.delete(plans_by_id[plan_id])

        missing_ids = [plan_id for plan_id in unique_ids if plan_id not in plans_by_id]
        active_in_request = [plan_id for plan_id in unique_ids if plan_id in active_ids]
        return {
            "requested": len(unique_ids),
            "deleted": len(deleted_ids),
            "skipped": len(missing_ids) + len(active_in_request),
            "active": len(active_in_request),
            "missing": len(missing_ids),
            "activeIds": active_in_request,
            "missingIds": missing_ids,
        }

    # Persistent queue ----------------------------------------------------------
    def create_run(
        self,
        *,
        account_id: int,
        account_name: str,
        account_email: str,
        account_created_at: Any = None,
        profile_id: str,
        rounds: int,
        proxy_targets: list[dict[str, Any]],
        trigger: str,
        priority: int,
        queue_limit: int,
        plan_id: str | None = None,
        parent_run_id: str | None = None,
        source_event_id: str | None = None,
        execution_mode: str = "chat",
    ) -> str:
        return self._queue_writer.create_run(
            account_id=account_id,
            account_name=account_name,
            account_email=account_email,
            account_created_at=account_created_at,
            profile_id=profile_id,
            rounds=rounds,
            proxy_targets=proxy_targets,
            trigger=trigger,
            priority=priority,
            queue_limit=queue_limit,
            plan_id=plan_id,
            parent_run_id=parent_run_id,
            source_event_id=source_event_id,
            execution_mode=execution_mode,
        )

    def create_manual_runs_batch(
        self,
        *,
        accounts: list[dict[str, Any]],
        rounds: int,
        proxy_targets: list[dict[str, Any]],
        execution_mode: str,
        priority: int,
        queue_limit: int,
        profile_ids: list[str] | None = None,
        profile_id: str = "",
    ) -> dict[str, Any]:
        return self._queue_writer.create_manual_runs_batch(
            accounts=accounts,
            rounds=rounds,
            proxy_targets=proxy_targets,
            execution_mode=execution_mode,
            priority=priority,
            queue_limit=queue_limit,
            profile_ids=profile_ids,
            profile_id=profile_id,
        )

    def create_register_runs(
        self,
        *,
        source_event_id: str,
        account: dict[str, Any],
        profile_ids: list[str],
        rounds: int,
        proxy_targets: list[dict[str, Any]],
        execution_mode: str,
        priority: int,
        queue_limit: int,
    ) -> dict[str, Any]:
        return self._queue_writer.create_register_runs(
            source_event_id=source_event_id,
            account=account,
            profile_ids=profile_ids,
            rounds=rounds,
            proxy_targets=proxy_targets,
            execution_mode=execution_mode,
            priority=priority,
            queue_limit=queue_limit,
        )

    def create_plan_runs_batch(
        self,
        *,
        plan_id: str,
        accounts: list[dict[str, Any]],
        profile_ids: list[str],
        rounds: int,
        proxy_targets: list[dict[str, Any]],
        execution_mode: str,
        priority: int,
        queue_limit: int,
        register_cooldown_minutes: int = 0,
    ) -> dict[str, Any]:
        return self._queue_writer.create_plan_runs_batch(
            plan_id=plan_id,
            accounts=accounts,
            profile_ids=profile_ids,
            rounds=rounds,
            proxy_targets=proxy_targets,
            execution_mode=execution_mode,
            priority=priority,
            queue_limit=queue_limit,
            register_cooldown_minutes=register_cooldown_minutes,
        )

    def has_active_run(self, *, account_id: int, plan_id: str | None = None) -> bool:
        with self.database.session() as session:
            statement = select(func.count(ProbeRun.id)).where(
                ProbeRun.account_id == account_id,
                ProbeRun.status.in_(ACTIVE_RUN_STATUSES),
            )
            if plan_id is not None:
                statement = statement.where(ProbeRun.plan_id == plan_id)
            return bool(session.scalar(statement))

    def has_executing_run(
        self, *, account_id: int, exclude_run_id: str | None = None
    ) -> bool:
        """Return whether an account currently has an executing worker lease."""

        with self.database.session() as session:
            statement = select(func.count(ProbeRun.id)).where(
                ProbeRun.account_id == account_id,
                ProbeRun.status.in_(EXECUTING_RUN_STATUSES),
            )
            if exclude_run_id is not None:
                statement = statement.where(ProbeRun.id != exclude_run_id)
            return bool(session.scalar(statement))

    def account_settings_locked_ids(self, account_ids: set[int]) -> set[int]:
        """Return accounts whose upstream settings may still be restored by a run."""

        if not account_ids:
            return set()
        with self.database.session() as session:
            return set(
                session.scalars(
                    select(ProbeRun.account_id)
                    .where(
                        ProbeRun.account_id.in_(account_ids),
                        or_(
                            ProbeRun.status.in_(EXECUTING_RUN_STATUSES),
                            ProbeRun.account_restore_status.in_(
                                BLOCKING_ACCOUNT_RESTORE_STATUSES
                            ),
                            ProbeRun.diagnostic_activation_active.is_(True),
                        ),
                    )
                    .distinct()
                ).all()
            )

    def active_egress_references(self) -> dict[str, set[int]]:
        """Return node and current-account references that active runs still need."""

        with self.database.session() as session:
            values = session.execute(
                select(
                    ProbeRun.account_id,
                    ProbeRun.proxy_targets,
                    ProbeRun.original_egress_node_id,
                ).where(
                    or_(
                        ProbeRun.status.in_(ACTIVE_RUN_STATUSES),
                        ProbeRun.account_restore_status.in_(
                            BLOCKING_ACCOUNT_RESTORE_STATUSES
                        ),
                        ProbeRun.diagnostic_activation_active.is_(True),
                    )
                )
            ).all()

        node_ids: set[int] = set()
        current_account_ids: set[int] = set()
        for account_id, targets, original_node_id in values:
            if int(original_node_id or 0) > 0:
                node_ids.add(int(original_node_id))
            for target in targets or []:
                kind = str(target.get("kind") or "")
                if kind == "egress" and int(target.get("id") or 0) > 0:
                    node_ids.add(int(target["id"]))
                elif kind == "current" and int(account_id or 0) > 0:
                    current_account_ids.add(int(account_id))
        return {
            "nodeIds": node_ids,
            "currentAccountIds": current_account_ids,
        }

    def has_blocking_account_restore(
        self,
        *,
        account_id: int,
        exclude_run_id: str | None = None,
    ) -> bool:
        """Protect an uncertain upstream account state from later probe runs."""

        with self.database.session() as session:
            statement = select(func.count(ProbeRun.id)).where(
                ProbeRun.account_id == account_id,
                (
                    ProbeRun.account_restore_status.in_(
                        BLOCKING_ACCOUNT_RESTORE_STATUSES
                    )
                    | ProbeRun.diagnostic_activation_active.is_(True)
                ),
            )
            if exclude_run_id is not None:
                statement = statement.where(ProbeRun.id != exclude_run_id)
            return bool(session.scalar(statement))

    def active_plan_run_count(self, plan_id: str) -> int:
        with self.database.session() as session:
            return int(
                session.scalar(
                    select(func.count(ProbeRun.id)).where(
                        ProbeRun.plan_id == plan_id,
                        ProbeRun.status.in_(ACTIVE_RUN_STATUSES),
                    )
                )
                or 0
            )

    def claim_next(self, worker_id: str) -> RunExecutionContext | None:
        now = utc_now()
        with self.database.transaction() as session:
            executing_accounts = (
                select(ProbeRun.account_id.label("account_id"))
                .where(ProbeRun.status.in_(EXECUTING_RUN_STATUSES))
                .distinct()
                .subquery()
            )
            restore_blocked_accounts = (
                select(ProbeRun.account_id.label("account_id"))
                .where(
                    ProbeRun.account_restore_status.in_(
                        BLOCKING_ACCOUNT_RESTORE_STATUSES
                    )
                    | ProbeRun.diagnostic_activation_active.is_(True)
                )
                .distinct()
                .subquery()
            )
            chosen = session.scalar(
                select(ProbeRun)
                .where(
                    ProbeRun.status == "queued",
                    ProbeRun.account_id.not_in(select(executing_accounts.c.account_id)),
                    ProbeRun.account_id.not_in(
                        select(restore_blocked_accounts.c.account_id)
                    ),
                )
                .order_by(
                    ProbeRun.priority.asc(),
                    ProbeRun.queued_at.asc(),
                    ProbeRun.created_at.asc(),
                )
                .limit(1)
            )
            if chosen is None:
                return None
            chosen.status = "running"
            chosen.worker_id = worker_id
            chosen.started_at = chosen.started_at or now
            chosen.heartbeat_at = now
            profile = session.get(ProbeProfile, chosen.profile_id)
            if profile is None:
                chosen.status = "failed"
                chosen.error = "探针方案已不存在"
                chosen.completed_at = now
                return None
            return RunExecutionContext(model_dict(chosen), model_dict(profile))

    def get_run_context(self, run_id: str) -> RunExecutionContext | None:
        with self.database.session() as session:
            run = session.get(ProbeRun, run_id)
            if run is None:
                return None
            profile = session.get(ProbeProfile, run.profile_id)
            if profile is None:
                return None
            return RunExecutionContext(model_dict(run), model_dict(profile))

    def set_upstream_context(
        self,
        *,
        run_id: str,
        original_node_id: int | None,
        original_mode: str,
        route_id: str,
        public_model: str,
        client_key_id: str,
    ) -> None:
        with self.database.transaction() as session:
            run = session.get(ProbeRun, run_id)
            if run is None:
                return
            run.original_egress_node_id = original_node_id
            run.original_egress_assignment_mode = original_mode
            run.temporary_route_id = route_id
            run.temporary_public_model = public_model
            run.temporary_client_key_id = client_key_id
            run.heartbeat_at = utc_now()

    def ensure_account_settings_snapshot(
        self,
        *,
        run_id: str,
        enabled: bool,
        priority: int,
        max_concurrent: int,
        egress_node_id: int | None,
        egress_assignment_mode: str,
        diagnostic_priority: int,
        diagnostic_max_concurrent: int,
    ) -> AccountSettingsSnapshot:
        """Persist the rollback source before any upstream account mutation.

        The first snapshot wins. A recovered/requeued run therefore keeps the
        original settings captured before its first diagnostic activation.
        """

        with self.database.transaction() as session:
            run = session.get(ProbeRun, run_id)
            if run is None:
                raise ValueError("探针任务不存在")
            if run.account_settings_snapshot_at is None:
                run.original_account_enabled = enabled
                run.original_account_priority = priority
                run.original_account_max_concurrent = max_concurrent
                run.original_egress_node_id = egress_node_id
                run.original_egress_assignment_mode = egress_assignment_mode
                run.account_settings_snapshot_at = utc_now()
                run.diagnostic_priority = diagnostic_priority
                run.diagnostic_max_concurrent = diagnostic_max_concurrent
            run.heartbeat_at = utc_now()
            return self._account_settings_snapshot(run)

    def account_settings_snapshot(self, run_id: str) -> AccountSettingsSnapshot | None:
        with self.database.session() as session:
            run = session.get(ProbeRun, run_id)
            if run is None or run.account_settings_snapshot_at is None:
                return None
            return self._account_settings_snapshot(run)

    @staticmethod
    def _account_settings_snapshot(run: ProbeRun) -> AccountSettingsSnapshot:
        return AccountSettingsSnapshot(
            enabled=bool(run.original_account_enabled),
            priority=int(run.original_account_priority or 0),
            max_concurrent=int(run.original_account_max_concurrent or 1),
            egress_node_id=run.original_egress_node_id,
            egress_assignment_mode=str(run.original_egress_assignment_mode or ""),
            diagnostic_priority=int(run.diagnostic_priority or 0),
            diagnostic_max_concurrent=int(run.diagnostic_max_concurrent or 1),
        )

    def set_diagnostic_activation(self, run_id: str, active: bool) -> None:
        with self.database.transaction() as session:
            run = session.get(ProbeRun, run_id)
            if run is None:
                return
            run.diagnostic_activation_active = active
            if active:
                run.account_restore_status = "pending"
                run.account_restore_source = ""
                run.account_restore_error = ""
                run.account_restored_at = None
            run.heartbeat_at = utc_now()

    def mark_account_mutation_pending(self, run_id: str) -> None:
        """Persist restore intent immediately before changing upstream account state."""

        with self.database.transaction() as session:
            run = session.get(ProbeRun, run_id)
            if run is None:
                raise ValueError("探针任务不存在")
            run.account_restore_status = "pending"
            run.account_restore_source = ""
            run.account_restore_error = ""
            run.account_restored_at = None
            run.heartbeat_at = utc_now()

    def begin_account_restore(self, run_id: str, source: str) -> None:
        with self.database.transaction() as session:
            run = session.get(ProbeRun, run_id)
            if run is None:
                raise ValueError("探针任务不存在")
            run.account_restore_status = "restoring"
            run.account_restore_source = source
            run.account_restore_attempts += 1
            run.account_restore_attempted_at = utc_now()
            run.account_restore_error = ""
            run.heartbeat_at = utc_now()

    def finish_account_restore(self, run_id: str, source: str, error: str = "") -> None:
        with self.database.transaction() as session:
            run = session.get(ProbeRun, run_id)
            if run is None:
                return
            run.account_restore_source = source
            run.account_restore_error = error[:4000]
            if error:
                run.account_restore_status = "restore_failed"
            else:
                run.account_restore_status = {
                    "manual": "manual_restored",
                    "startup": "startup_restored",
                }.get(source, "automatic_restored")
                run.diagnostic_activation_active = False
                run.account_restored_at = utc_now()
            run.heartbeat_at = utc_now()

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self.database.session() as session:
            run = session.get(ProbeRun, run_id)
            return model_dict(run) if run else None

    def list_runs_for_source_event(self, source_event_id: str) -> list[dict[str, Any]]:
        event_id = str(source_event_id or "").strip()
        if not event_id:
            return []
        with self.database.session() as session:
            runs = session.scalars(
                select(ProbeRun)
                .where(ProbeRun.source_event_id == event_id)
                .order_by(ProbeRun.created_at.asc())
            ).all()
            return [model_dict(run) for run in runs]

    def clear_upstream_context(self, run_id: str) -> None:
        with self.database.transaction() as session:
            run = session.get(ProbeRun, run_id)
            if run is None:
                return
            run.temporary_route_id = ""
            run.temporary_public_model = ""
            run.temporary_client_key_id = ""
            run.current_round = None
            run.current_target_key = None
            run.heartbeat_at = utc_now()

    def set_current_step(self, run_id: str, round_number: int, target_key: str) -> None:
        with self.database.transaction() as session:
            run = session.get(ProbeRun, run_id)
            if run is None:
                return
            run.current_round = round_number
            run.current_target_key = target_key
            run.heartbeat_at = utc_now()

    def is_cancel_requested(self, run_id: str) -> bool:
        with self.database.session() as session:
            run = session.get(ProbeRun, run_id)
            return bool(run and run.cancel_requested)

    def completed_step_keys(self, run_id: str) -> set[tuple[int, str]]:
        with self.database.session() as session:
            return set(
                session.execute(
                    select(ProbeSample.round_number, ProbeSample.target_key).where(
                        ProbeSample.run_id == run_id
                    )
                ).all()
            )

    def add_sample(self, run_id: str, values: dict[str, Any]) -> None:
        with self.database.transaction() as session:
            run = session.get(ProbeRun, run_id)
            if run is None:
                return
            existing = session.scalar(
                select(ProbeSample.id).where(
                    ProbeSample.run_id == run_id,
                    ProbeSample.round_number == values["round_number"],
                    ProbeSample.target_key == values["target_key"],
                )
            )
            if existing:
                return
            session.add(
                ProbeSample(
                    id=uuid.uuid4().hex,
                    run_id=run_id,
                    account_id=run.account_id,
                    **values,
                )
            )
            duration_ms = int(values.get("duration_ms") or 0)
            if duration_ms > 0:
                now = utc_now()
                statement = sqlite_insert(ProbeDurationEstimate).values(
                    profile_id=run.profile_id,
                    execution_mode=run.execution_mode,
                    sample_count=1,
                    total_duration_ms=duration_ms,
                    created_at=now,
                    updated_at=now,
                )
                session.execute(
                    statement.on_conflict_do_update(
                        index_elements=["profile_id", "execution_mode"],
                        set_={
                            "sample_count": ProbeDurationEstimate.sample_count + 1,
                            "total_duration_ms": (
                                ProbeDurationEstimate.total_duration_ms + duration_ms
                            ),
                            "updated_at": now,
                        },
                    )
                )
            run.completed_steps += 1
            if values.get("status") == "error":
                run.error_count += 1
            classification = str(values.get("classification") or "")
            summary = dict(run.summary or {})
            raw_counts = summary.get("classifications")
            counts = dict(raw_counts) if isinstance(raw_counts, dict) else {}
            if classification:
                counts[classification] = int(counts.get(classification, 0)) + 1
            tps = _finite_float(values.get("tps"))
            upstream_tps = _finite_float(values.get("upstream_tps"))
            tps_sum = _finite_float(summary.get("tps_sum")) or 0.0
            tps_count = int(summary.get("tps_count") or 0)
            max_tps = _finite_float(summary.get("max_tps"))
            upstream_tps_sum = _finite_float(summary.get("upstream_tps_sum")) or 0.0
            upstream_tps_count = int(summary.get("upstream_tps_count") or 0)
            max_upstream_tps = _finite_float(summary.get("max_upstream_tps"))
            if tps is not None and tps > 0:
                tps_sum += tps
                tps_count += 1
                max_tps = max(max_tps or 0.0, tps)
            if upstream_tps is not None and upstream_tps > 0:
                upstream_tps_sum += upstream_tps
                upstream_tps_count += 1
                max_upstream_tps = max(max_upstream_tps or 0.0, upstream_tps)
            summary.update(
                {
                    "total": run.total_steps,
                    "completed": run.completed_steps,
                    "errors": run.error_count,
                    "sample_count": run.completed_steps,
                    "anomaly_count": sum(
                        int(counts.get(name, 0)) for name in DEGRADATION_CLASSIFICATIONS
                    ),
                    "warning_count": sum(
                        int(counts.get(name, 0))
                        for name in PROBE_WARNING_CLASSIFICATIONS
                    ),
                    "classifications": counts,
                    "max_tps": max_tps,
                    "avg_tps": (tps_sum / tps_count) if tps_count else None,
                    "tps_sum": tps_sum,
                    "tps_count": tps_count,
                    "max_upstream_tps": max_upstream_tps,
                    "avg_upstream_tps": (
                        upstream_tps_sum / upstream_tps_count
                        if upstream_tps_count
                        else None
                    ),
                    "upstream_tps_sum": upstream_tps_sum,
                    "upstream_tps_count": upstream_tps_count,
                }
            )
            run.summary = summary
            run.heartbeat_at = utc_now()

    @staticmethod
    def _build_run_summary(run: ProbeRun, sample_values: list[Any]) -> dict[str, Any]:
        counts: dict[str, int] = {}
        tps_values: list[float] = []
        upstream_tps_values: list[float] = []
        for classification, raw_tps, raw_upstream_tps in sample_values:
            name = str(classification or "").strip()
            if name:
                counts[name] = counts.get(name, 0) + 1
            tps = _finite_float(raw_tps)
            if tps is not None and tps > 0:
                tps_values.append(tps)
            upstream_tps = _finite_float(raw_upstream_tps)
            if upstream_tps is None:
                upstream_tps = tps
            if upstream_tps is not None and upstream_tps > 0:
                upstream_tps_values.append(upstream_tps)
        return {
            "total": run.total_steps,
            # Execution progress is intentionally retained after an operator
            # removes a stored sample. It describes what the worker completed,
            # while sample_count describes the evidence that still exists.
            "completed": run.completed_steps,
            "errors": run.error_count,
            "sample_count": len(sample_values),
            "anomaly_count": sum(
                counts.get(name, 0) for name in DEGRADATION_CLASSIFICATIONS
            ),
            "warning_count": sum(
                counts.get(name, 0) for name in PROBE_WARNING_CLASSIFICATIONS
            ),
            "classifications": counts,
            "max_tps": max(tps_values) if tps_values else None,
            "avg_tps": (sum(tps_values) / len(tps_values)) if tps_values else None,
            "tps_sum": sum(tps_values),
            "tps_count": len(tps_values),
            "max_upstream_tps": (
                max(upstream_tps_values) if upstream_tps_values else None
            ),
            "avg_upstream_tps": (
                sum(upstream_tps_values) / len(upstream_tps_values)
                if upstream_tps_values
                else None
            ),
            "upstream_tps_sum": sum(upstream_tps_values),
            "upstream_tps_count": len(upstream_tps_values),
        }

    def _refresh_run_summary(self, session: Session, run: ProbeRun) -> None:
        sample_values = session.execute(
            select(
                ProbeSample.classification,
                ProbeSample.tps,
                ProbeSample.upstream_tps,
            ).where(
                ProbeSample.run_id == run.id
            )
        ).all()
        run.summary = self._build_run_summary(run, sample_values)

    def refresh_all_run_summaries(self) -> int:
        with self.database.transaction() as session:
            runs = session.scalars(select(ProbeRun)).all()
            for run in runs:
                self._refresh_run_summary(session, run)
            return len(runs)

    def finish_run(
        self, run_id: str, status: str | None = None, error: str = ""
    ) -> dict[str, Any]:
        now = utc_now()
        with self.database.transaction() as session:
            run = session.get(ProbeRun, run_id)
            if run is None:
                raise ValueError("探针任务不存在")
            self._refresh_run_summary(session, run)
            if status is None:
                status = (
                    "completed" if run.error_count == 0 else "completed_with_errors"
                )
            run.status = status
            run.error = error[:4000]
            run.cancel_requested = status == "cancelled"
            run.current_round = None
            run.current_target_key = None
            run.completed_at = now
            run.heartbeat_at = now
            result = model_dict(run)
        return result

    def request_cancel(self, run_id: str) -> str:
        with self.database.transaction() as session:
            run = session.get(ProbeRun, run_id)
            if run is None:
                raise ValueError("探针任务不存在")
            if run.status in TERMINAL_RUN_STATUSES:
                return run.status
            run.cancel_requested = True
            if run.status == "queued":
                run.status = "cancelled"
                run.completed_at = utc_now()
            else:
                run.status = "cancel_requested"
                run.heartbeat_at = utc_now()
            return run.status

    def request_cancel_many(
        self, run_ids: list[str]
    ) -> tuple[dict[str, int], list[str]]:
        unique_ids = list(dict.fromkeys(run_id for run_id in run_ids if run_id))
        now = utc_now()
        summary = {
            "requested": len(unique_ids),
            "cancelled": 0,
            "cancelRequested": 0,
            "alreadyStopping": 0,
            "skipped": 0,
        }
        interrupt_ids: list[str] = []
        with self.database.transaction() as session:
            runs_by_id = {
                run.id: run
                for run in session.scalars(
                    select(ProbeRun).where(ProbeRun.id.in_(unique_ids))
                ).all()
            }
            for run_id in unique_ids:
                run = runs_by_id.get(run_id)
                if run is None or run.status in TERMINAL_RUN_STATUSES:
                    summary["skipped"] += 1
                    continue
                if run.status == "cancel_requested":
                    summary["alreadyStopping"] += 1
                    interrupt_ids.append(run.id)
                    continue
                run.cancel_requested = True
                if run.status == "queued":
                    run.status = "cancelled"
                    run.completed_at = now
                    summary["cancelled"] += 1
                else:
                    run.status = "cancel_requested"
                    run.heartbeat_at = now
                    summary["cancelRequested"] += 1
                    interrupt_ids.append(run.id)
        return summary, interrupt_ids

    def delete_run(self, run_id: str) -> int:
        with self.database.transaction() as session:
            run = session.get(ProbeRun, run_id)
            if run is None:
                raise ValueError("探针任务不存在")
            if run.status not in TERMINAL_RUN_STATUSES:
                raise RunStateError("排队或执行中的任务需要先取消")
            self._ensure_restore_resolved(run)
            account_id = run.account_id
            session.delete(run)
            return account_id

    def delete_sample(self, sample_id: str) -> int:
        with self.database.transaction() as session:
            sample = session.get(ProbeSample, sample_id)
            if sample is None:
                raise ValueError("探针样本不存在")
            run = session.get(ProbeRun, sample.run_id)
            if run is None:
                raise ValueError("样本所属探针任务不存在")
            if run.status not in TERMINAL_RUN_STATUSES:
                raise RunStateError("任务仍在排队或执行，结束后才能删除样本")
            account_id = sample.account_id
            session.delete(sample)
            session.flush()
            self._refresh_run_summary(session, run)
            return account_id

    def delete_samples_for_account(self, account_id: int) -> int:
        """Delete probe samples for one account while keeping probe runs."""

        with self.database.transaction() as session:
            result = session.execute(
                delete(ProbeSample).where(ProbeSample.account_id == account_id)
            )
            return int(result.rowcount or 0)

    def delete_runs(self, run_ids: list[str]) -> tuple[int, set[int], list[str]]:
        """Delete every deletable run, skipping the ones still holding state.

        Selecting across pages regularly mixes in active runs and runs whose
        account settings are still pending restore. Those are reported back as
        skipped instead of failing the whole batch.
        """

        deleted = 0
        account_ids: set[int] = set()
        skipped: list[str] = []
        with self.database.transaction() as session:
            values = session.scalars(
                select(ProbeRun).where(ProbeRun.id.in_(run_ids))
            ).all()
            for value in values:
                if value.status not in TERMINAL_RUN_STATUSES or self._restore_pending(
                    value
                ):
                    skipped.append(value.id)
                    continue
                account_ids.add(value.account_id)
                session.delete(value)
                deleted += 1
        return deleted, account_ids, skipped

    def retry_values(self, run_id: str) -> dict[str, Any]:
        with self.database.session() as session:
            run = session.get(ProbeRun, run_id)
            if run is None:
                raise ValueError("探针任务不存在")
            if run.status not in TERMINAL_RUN_STATUSES:
                raise RunStateError("当前任务尚未结束")
            self._ensure_restore_resolved(run)
            return {
                "account_id": run.account_id,
                "account_name": run.account_name,
                "account_email": run.account_email,
                "account_created_at": run.account_created_at,
                "profile_id": run.profile_id,
                "execution_mode": run.execution_mode,
                "rounds": run.rounds,
                "proxy_targets": run.proxy_targets,
                "parent_run_id": run.id,
                "source_event_id": run.source_event_id,
            }

    def has_child_run(self, run_id: str) -> bool:
        with self.database.session() as session:
            return (
                session.scalar(
                    select(func.count(ProbeRun.id)).where(
                        ProbeRun.parent_run_id == run_id
                    )
                )
                or 0
            ) > 0

    def register_tried_egress_node_ids(self, run: dict[str, Any]) -> set[int]:
        """Return egress nodes already used by this register-probe chain."""

        account_id = int(run.get("account_id") or 0)
        source_event_id = str(run.get("source_event_id") or "").strip()
        if account_id <= 0:
            return set()
        with self.database.session() as session:
            filters = [ProbeRun.account_id == account_id]
            if source_event_id:
                filters.append(ProbeRun.source_event_id == source_event_id)
            else:
                related_ids = self._ancestor_run_ids(session, str(run.get("id") or ""))
                related_ids.add(str(run.get("id") or ""))
                filters.append(ProbeRun.id.in_(related_ids))
            run_ids = list(session.scalars(select(ProbeRun.id).where(*filters)).all())
            node_ids = {
                int(node_id)
                for node_id in session.scalars(
                    select(ProbeRun.original_egress_node_id).where(
                        ProbeRun.id.in_(run_ids),
                        ProbeRun.original_egress_node_id.is_not(None),
                    )
                ).all()
                if int(node_id or 0) > 0
            }
            sample_nodes = session.execute(
                select(
                    ProbeSample.egress_node_id, ProbeSample.verified_egress_node_id
                ).where(ProbeSample.run_id.in_(run_ids))
            ).all()
        for egress_node_id, verified_node_id in sample_nodes:
            for node_id in (egress_node_id, verified_node_id):
                if int(node_id or 0) > 0:
                    node_ids.add(int(node_id))
        return node_ids

    @staticmethod
    def _ancestor_run_ids(session: Session, run_id: str) -> set[str]:
        related = {run_id} if run_id else set()
        current_id = run_id
        for _ in range(20):
            parent_id = session.scalar(
                select(ProbeRun.parent_run_id).where(ProbeRun.id == current_id)
            )
            if not parent_id or parent_id in related:
                break
            related.add(parent_id)
            current_id = parent_id
        return related

    @staticmethod
    def _restore_pending(run: ProbeRun) -> bool:
        return bool(
            run.account_restore_status in BLOCKING_ACCOUNT_RESTORE_STATUSES
            or run.diagnostic_activation_active
        )

    def _ensure_restore_resolved(self, run: ProbeRun) -> None:
        if self._restore_pending(run):
            raise RunStateError("账号原设置尚未恢复，请先在任务详情中同步原设置")

    def interrupted_runs(self) -> list[dict[str, Any]]:
        with self.database.transaction() as session:
            runs = session.scalars(
                select(ProbeRun).where(
                    ProbeRun.status.in_({"running", "cancel_requested", "recovering"})
                )
            ).all()
            result = []
            for run in runs:
                run.status = "recovering"
                run.heartbeat_at = utc_now()
                result.append(model_dict(run))
            return result

    def finish_recovery(self, run_id: str, cleanup_error: str = "") -> None:
        with self.database.transaction() as session:
            run = session.get(ProbeRun, run_id)
            if run is None:
                return
            run.temporary_route_id = ""
            run.temporary_public_model = ""
            run.temporary_client_key_id = ""
            run.current_round = None
            run.current_target_key = None
            run.worker_id = None
            if cleanup_error:
                # State restoration is more important than silently resuming a
                # probe. Keep the snapshot and expose the manual synchronization
                # action instead of running with uncertain upstream settings.
                run.status = "failed"
                run.completed_at = utc_now()
            elif run.cancel_requested:
                run.status = "cancelled"
                run.completed_at = utc_now()
            else:
                run.status = "queued"
                run.queued_at = utc_now()
            if cleanup_error:
                run.error = f"重启恢复清理: {cleanup_error}"[:4000]

    def select_run_ids(
        self,
        *,
        status: str = "",
        search: str = "",
        account_id: int | None = None,
        plan_id: str | None = None,
        created_from: Any = None,
        created_to: Any = None,
    ) -> dict[str, Any]:
        return self._run_reader.select_run_ids(
            status=status,
            search=search,
            account_id=account_id,
            plan_id=plan_id,
            created_from=created_from,
            created_to=created_to,
        )

    def list_runs(
        self,
        *,
        page: int,
        page_size: int,
        status: str = "",
        search: str = "",
        account_id: int | None = None,
        plan_id: str | None = None,
        created_from: Any = None,
        created_to: Any = None,
    ) -> dict[str, Any]:
        return self._run_reader.list_runs(
            page=page,
            page_size=page_size,
            status=status,
            search=search,
            account_id=account_id,
            plan_id=plan_id,
            created_from=created_from,
            created_to=created_to,
        )

    def latest_runs_by_account_ids(
        self,
        account_ids: list[int] | set[int] | tuple[int, ...],
    ) -> dict[int, dict[str, Any]]:
        return self._run_reader.latest_runs_by_account_ids(account_ids)

    def run_detail(self, run_id: str) -> dict[str, Any] | None:
        return self._run_reader.run_detail(run_id)

    def preview_samples_for_runs(self, run_ids: list[str] | tuple[str, ...] = ()) -> list[dict[str, Any]]:
        return self._run_reader.preview_samples_for_runs(run_ids)

    def samples_for_audits(
        self,
        *,
        request_ids: list[str] | set[str] = (),
        audit_ids: list[int] | set[int] = (),
        include_response: bool = False,
    ) -> list[dict[str, Any]]:
        return self._run_reader.samples_for_audits(
            request_ids=request_ids,
            audit_ids=audit_ids,
            include_response=include_response,
        )

    def persist_account_created_at(self, values: dict[int, datetime | None]) -> None:
        updates = {
            account_id: created_at
            for account_id, created_at in values.items()
            if account_id > 0 and created_at is not None
        }
        if not updates:
            return
        with self.database.transaction() as session:
            runs = session.scalars(
                select(ProbeRun).where(
                    ProbeRun.account_id.in_(updates),
                    ProbeRun.account_created_at.is_(None),
                )
            ).all()
            for run in runs:
                run.account_created_at = updates[run.account_id]

    def account_history(self, account_id: int, limit: int = 200) -> dict[str, Any]:
        return self._run_reader.account_history(account_id, limit)

    def list_samples_for_export(
        self,
        *,
        account_id: int | None = None,
        limit: int = 5000,
    ) -> list[ProbeSample]:
        capped = min(max(int(limit), 1), 5000)
        with self.database.session() as session:
            query = select(ProbeSample).order_by(
                ProbeSample.created_at.desc(),
                ProbeSample.id.desc(),
            )
            if account_id:
                query = query.where(ProbeSample.account_id == int(account_id))
            return list(session.scalars(query.limit(capped)).all())

    def account_samples(
        self,
        account_id: int,
        *,
        page: int,
        page_size: int,
    ) -> dict[str, Any]:
        return self._run_reader.account_samples(
            account_id,
            page=page,
            page_size=page_size,
        )

    def queue_stats(self) -> dict[str, int]:
        return self._run_reader.queue_stats()

    def worker_queue_stats(self) -> dict[str, int]:
        return self._run_reader.worker_queue_stats()

    # Scheduler execution history ----------------------------------------------
    def start_schedule_execution(self, schedule_key: str) -> str:
        execution_id = uuid.uuid4().hex
        with self.database.transaction() as session:
            session.add(
                ScheduleExecution(
                    id=execution_id, schedule_key=schedule_key, status="running"
                )
            )
        return execution_id

    def finish_schedule_execution(
        self,
        execution_id: str,
        *,
        status: str,
        message: str = "",
        detail: dict[str, Any] | None = None,
    ) -> None:
        with self.database.transaction() as session:
            execution = session.get(ScheduleExecution, execution_id)
            if execution is None:
                return
            execution.status = status
            execution.message = message[:500]
            execution.detail = detail or {}
            execution.completed_at = utc_now()

    def list_schedule_executions(self, limit: int = 100) -> list[dict[str, Any]]:
        with self.database.session() as session:
            values = session.scalars(
                select(ScheduleExecution)
                .order_by(ScheduleExecution.started_at.desc())
                .limit(limit)
            ).all()
            return [model_dict(value) for value in values]

    def delete_schedule_execution(self, execution_id: str) -> None:
        with self.database.transaction() as session:
            execution = session.get(ScheduleExecution, execution_id)
            if execution is None:
                raise ValueError("调度执行记录不存在")
            if execution.status == "running":
                raise RunStateError("执行中的调度记录不能删除")
            session.delete(execution)

    def delete_schedule_executions(self, execution_ids: list[str]) -> dict[str, Any]:
        unique_ids = list(dict.fromkeys(value for value in execution_ids if value))
        with self.database.transaction() as session:
            executions_by_id = {
                execution.id: execution
                for execution in session.scalars(
                    select(ScheduleExecution).where(
                        ScheduleExecution.id.in_(unique_ids)
                    )
                ).all()
            }
            running_ids = {
                execution_id
                for execution_id, execution in executions_by_id.items()
                if execution.status == "running"
            }
            deleted_ids = [
                execution_id
                for execution_id in unique_ids
                if execution_id in executions_by_id and execution_id not in running_ids
            ]
            for execution_id in deleted_ids:
                session.delete(executions_by_id[execution_id])

        missing_ids = [
            execution_id
            for execution_id in unique_ids
            if execution_id not in executions_by_id
        ]
        running_in_request = [
            execution_id for execution_id in unique_ids if execution_id in running_ids
        ]
        return {
            "requested": len(unique_ids),
            "deleted": len(deleted_ids),
            "skipped": len(missing_ids) + len(running_in_request),
            "running": len(running_in_request),
            "missing": len(missing_ids),
            "runningIds": running_in_request,
            "missingIds": missing_ids,
        }
