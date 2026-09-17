from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from sqlalchemy import Integer, case, cast, func, or_, select
from sqlalchemy.orm import Session

from app.core.clock import to_app_timezone, utc_now

from .database import Database
from .models import (
    ProbeDurationEstimate,
    ProbePlan,
    ProbeProfile,
    ProbeRun,
    ProbeSample,
    model_dict,
)


class ProbeRunReader:
    """Reads probe task lists, details, history, and queue telemetry."""

    def __init__(
        self,
        database: Database,
        *,
        active_statuses: set[str],
        cancellable_statuses: set[str],
        executing_statuses: set[str],
        estimated_statuses: set[str],
        terminal_statuses: set[str],
        restore_statuses: set[str],
        degradation_classifications: frozenset[str],
        profile_dict: Any,
    ):
        self.database = database
        self.active_statuses = active_statuses
        self.cancellable_statuses = cancellable_statuses
        self.executing_statuses = executing_statuses
        self.estimated_statuses = estimated_statuses
        self.terminal_statuses = terminal_statuses
        self.restore_statuses = restore_statuses
        self.degradation_classifications = degradation_classifications
        self.profile_dict = profile_dict

    def select_run_ids(
        self,
        *,
        status: str = "",
        search: str = "",
        account_id: int | None = None,
        plan_id: str | None = None,
        created_from: Any = None,
        created_to: Any = None,
        has_anomalies: bool = False,
    ) -> dict[str, Any]:
        filters = self._run_list_filters(
            status=status,
            search=search,
            account_id=account_id,
            plan_id=plan_id,
            created_from=created_from,
            created_to=created_to,
            has_anomalies=has_anomalies,
        )
        with self.database.session() as session:
            values = session.execute(
                select(
                    ProbeRun.id,
                    ProbeRun.account_id,
                    ProbeRun.status,
                    ProbeRun.account_restore_status,
                    ProbeRun.diagnostic_activation_active,
                ).where(*filters)
            ).all()
        items: list[dict[str, Any]] = []
        for (
            run_id,
            account_id_value,
            run_status,
            restore_status,
            diagnostic_active,
        ) in values:
            restore_pending = restore_status in self.restore_statuses or bool(
                diagnostic_active
            )
            if run_status in self.cancellable_statuses:
                action = "cancel"
            elif run_status in self.terminal_statuses:
                action = "restore" if restore_pending else "delete"
            else:
                continue
            items.append(
                {
                    "id": run_id,
                    "accountId": int(account_id_value or 0),
                    "action": action,
                }
            )
        return {
            "items": items,
            "matched": len(values),
            "selectable": len(items),
            "excluded": len(values) - len(items),
        }

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
        has_anomalies: bool = False,
    ) -> dict[str, Any]:
        filters = self._run_list_filters(
            status=status,
            search=search,
            account_id=account_id,
            plan_id=plan_id,
            created_from=created_from,
            created_to=created_to,
            has_anomalies=has_anomalies,
        )
        with self.database.session() as session:
            total, active_count = session.execute(
                select(
                    func.count(ProbeRun.id),
                    func.count(ProbeRun.id).filter(
                        ProbeRun.status.in_(self.active_statuses)
                    ),
                ).where(*filters)
            ).one()
            values = session.scalars(
                select(ProbeRun)
                .where(*filters)
                .order_by(ProbeRun.created_at.desc())
                .offset((page - 1) * page_size)
                .limit(page_size)
            ).all()
            estimates = self._duration_estimates_for_runs(session, values)
            page_account_ids = {int(run.account_id) for run in values}
            executing_ids, restore_ids = self._blocked_account_ids(
                session, account_ids=page_account_ids
            )
            items = [
                self._run_list_item(value, estimates, executing_ids, restore_ids)
                for value in values
            ]
        return {
            "items": items,
            "total": total,
            "page": page,
            "pageSize": page_size,
            "activeCount": int(active_count or 0),
        }

    def latest_runs_by_account_ids(
        self,
        account_ids: Iterable[int],
    ) -> dict[int, dict[str, Any]]:
        unique_ids = sorted(
            {
                int(account_id)
                for account_id in account_ids
                if int(account_id or 0) > 0
            }
        )
        if not unique_ids:
            return {}
        ranked = (
            select(
                ProbeRun.id,
                func.row_number()
                .over(
                    partition_by=ProbeRun.account_id,
                    order_by=(ProbeRun.created_at.desc(), ProbeRun.id.desc()),
                )
                .label("rn"),
            )
            .where(ProbeRun.account_id.in_(unique_ids))
            .subquery()
        )
        with self.database.session() as session:
            values = session.scalars(
                select(ProbeRun)
                .join(ranked, ProbeRun.id == ranked.c.id)
                .where(ranked.c.rn == 1)
            ).all()
            return {int(value.account_id): model_dict(value) for value in values}

    def run_detail(self, run_id: str) -> dict[str, Any] | None:
        with self.database.session() as session:
            run = session.get(ProbeRun, run_id)
            if run is None:
                return None
            profile = session.get(ProbeProfile, run.profile_id)
            samples = session.scalars(
                select(ProbeSample)
                .where(ProbeSample.run_id == run_id)
                .order_by(ProbeSample.round_number.asc(), ProbeSample.target_key.asc())
            ).all()
            estimates = self._duration_estimates_for_runs(session, [run])
            run_value = model_dict(run)
            run_value["duration_estimate"] = self._run_duration_estimate(
                run,
                estimates.get((run.profile_id, run.execution_mode)),
            )
            return {
                "run": run_value,
                "profile": self.profile_dict(profile) if profile else None,
                "samples": [model_dict(value) for value in samples],
            }

    def preview_samples_for_runs(self, run_ids: Iterable[str]) -> list[dict[str, Any]]:
        normalized: list[str] = []
        seen: set[str] = set()
        for value in run_ids:
            run_id = str(value or "").strip()
            if not run_id or run_id in seen:
                continue
            seen.add(run_id)
            normalized.append(run_id)
            if len(normalized) >= 100:
                break
        if not normalized:
            return []
        with self.database.session() as session:
            rows = session.execute(
                select(
                    ProbeSample.id,
                    ProbeSample.run_id,
                    ProbeSample.round_number,
                    ProbeSample.egress_name,
                    ProbeSample.classification,
                    ProbeSample.created_at,
                )
                .where(
                    ProbeSample.run_id.in_(normalized),
                    func.trim(ProbeSample.response_text) != "",
                )
                .order_by(
                    ProbeSample.round_number.asc(),
                    ProbeSample.target_key.asc(),
                    ProbeSample.id.asc(),
                )
            ).all()
        grouped: dict[str, list[dict[str, Any]]] = {run_id: [] for run_id in normalized}
        for row in rows:
            bucket = grouped.get(row.run_id)
            if bucket is None:
                continue
            bucket.append(
                {
                    "id": row.id,
                    "run_id": row.run_id,
                    "round_number": row.round_number,
                    "egress_name": row.egress_name,
                    "classification": row.classification,
                    "created_at": to_app_timezone(row.created_at),
                }
            )
        return [item for run_id in normalized for item in grouped[run_id]]

    def samples_for_audits(
        self,
        *,
        request_ids: Iterable[str] = (),
        audit_ids: Iterable[int] = (),
        include_response: bool = False,
    ) -> list[dict[str, Any]]:
        """Join local probe evidence to upstream request-audit identifiers."""

        normalized_requests = {
            str(value).strip()
            for value in request_ids
            if value is not None and str(value).strip()
        }
        normalized_audits: set[int] = set()
        for value in audit_ids:
            try:
                parsed = int(value)
            except (TypeError, ValueError, OverflowError):
                continue
            if parsed > 0:
                normalized_audits.add(parsed)
        conditions = []
        if normalized_requests:
            conditions.append(ProbeSample.request_id.in_(normalized_requests))
        if normalized_audits:
            conditions.append(ProbeSample.audit_id.in_(normalized_audits))
        if not conditions:
            return []

        with self.database.session() as session:
            rows = session.execute(
                select(ProbeSample, ProbeRun, ProbeProfile, ProbePlan)
                .join(ProbeRun, ProbeRun.id == ProbeSample.run_id)
                .join(ProbeProfile, ProbeProfile.id == ProbeRun.profile_id)
                .outerjoin(ProbePlan, ProbePlan.id == ProbeRun.plan_id)
                .where(or_(*conditions))
                .order_by(ProbeSample.created_at.desc(), ProbeSample.id.desc())
            ).all()

        result: list[dict[str, Any]] = []
        for sample, run, profile, plan in rows:
            sample_value = model_dict(sample)
            response_text = str(sample_value.get("response_text") or "")
            reasoning_text = str(sample_value.get("reasoning_text") or "")
            if not include_response:
                sample_value.pop("response_text", None)
                sample_value.pop("reasoning_text", None)
            sample_value["responseLength"] = len(response_text)
            sample_value["reasoningLength"] = len(reasoning_text)
            sample_value["responsePreview"] = (
                " ".join(response_text.split())[:320] if response_text else ""
            )
            result.append(
                {
                    "sample": sample_value,
                    "run": {
                        "id": run.id,
                        "status": run.status,
                        "trigger": run.trigger,
                        "automatic": run.automatic,
                        "planId": run.plan_id,
                        "planName": plan.name if plan else "",
                        "profileId": run.profile_id,
                        "profileName": profile.name,
                        "executionMode": run.execution_mode,
                        "rounds": run.rounds,
                        "createdAt": run.created_at,
                        "startedAt": run.started_at,
                        "completedAt": run.completed_at,
                    },
                }
            )
        return result

    def account_history(self, account_id: int, limit: int = 200) -> dict[str, Any]:
        with self.database.session() as session:
            samples = session.scalars(
                select(ProbeSample)
                .where(ProbeSample.account_id == account_id)
                .order_by(ProbeSample.created_at.desc())
                .limit(limit)
            ).all()
            runs = session.scalars(
                select(ProbeRun)
                .where(ProbeRun.account_id == account_id)
                .order_by(ProbeRun.created_at.desc())
                .limit(50)
            ).all()
            grouped = session.execute(self._history_statement(account_id)).all()
        return {
            "samples": [model_dict(value) for value in samples],
            "runs": [model_dict(value) for value in runs],
            "byTarget": [
                {
                    **dict(row._mapping),
                    "samples": int(row.samples or 0),
                    "anomalies": int(row.anomalies or 0),
                }
                for row in grouped
            ],
        }

    def account_samples(
        self,
        account_id: int,
        *,
        page: int,
        page_size: int,
    ) -> dict[str, Any]:
        filters = (ProbeSample.account_id == account_id,)
        with self.database.session() as session:
            total = int(
                session.scalar(select(func.count(ProbeSample.id)).where(*filters)) or 0
            )
            samples = session.scalars(
                select(ProbeSample)
                .where(*filters)
                .order_by(ProbeSample.created_at.desc(), ProbeSample.id.desc())
                .offset((page - 1) * page_size)
                .limit(page_size)
            ).all()
        return {
            "items": [model_dict(value) for value in samples],
            "total": total,
            "page": page,
            "pageSize": page_size,
        }

    def queue_stats(self) -> dict[str, int]:
        with self.database.session() as session:
            return {
                status: int(count)
                for status, count in session.execute(
                    select(ProbeRun.status, func.count(ProbeRun.id)).group_by(
                        ProbeRun.status
                    )
                )
            }

    def worker_queue_stats(self) -> dict[str, int]:
        with self.database.session() as session:
            executing_accounts = (
                select(ProbeRun.account_id.label("account_id"))
                .where(ProbeRun.status.in_(self.executing_statuses))
                .distinct()
                .subquery()
            )
            restore_accounts = (
                select(ProbeRun.account_id.label("account_id"))
                .where(
                    ProbeRun.account_restore_status.in_(self.restore_statuses)
                    | ProbeRun.diagnostic_activation_active.is_(True)
                )
                .distinct()
                .subquery()
            )
            queued = self._status_count(session, {"queued"})
            blocked_same_account = self._queued_count(
                session,
                ProbeRun.account_id.in_(select(executing_accounts.c.account_id)),
            )
            blocked_restore = self._queued_count(
                session,
                ProbeRun.account_id.not_in(select(executing_accounts.c.account_id)),
                ProbeRun.account_id.in_(select(restore_accounts.c.account_id)),
            )
            running = self._status_count(session, self.executing_statuses)
            oldest_queued_at = session.scalar(
                select(func.min(ProbeRun.queued_at)).where(ProbeRun.status == "queued")
            )
        oldest_wait = (
            max(0, int((utc_now() - oldest_queued_at).total_seconds()))
            if oldest_queued_at is not None
            else 0
        )
        return {
            "queued": queued,
            "running": running,
            "eligible": max(0, queued - blocked_same_account - blocked_restore),
            "blockedSameAccount": blocked_same_account,
            "blockedRestore": blocked_restore,
            "oldestQueueWaitSeconds": oldest_wait,
        }

    def _run_list_filters(
        self,
        *,
        status: str,
        search: str,
        account_id: int | None,
        plan_id: str | None,
        created_from: Any,
        created_to: Any,
        has_anomalies: bool = False,
    ) -> list[Any]:
        filters: list[Any] = []
        if status:
            filters.append(ProbeRun.status == status)
        token = search.strip().lower()
        if token:
            account_filters = [
                func.lower(ProbeRun.account_name).contains(token),
                func.lower(ProbeRun.account_email).contains(token),
            ]
            if token.isdigit():
                account_filters.append(ProbeRun.account_id == int(token))
            filters.append(or_(*account_filters))
        if account_id is not None:
            filters.append(ProbeRun.account_id == account_id)
        if plan_id is not None:
            filters.append(ProbeRun.plan_id == plan_id)
        if created_from is not None:
            filters.append(ProbeRun.created_at >= created_from)
        if created_to is not None:
            filters.append(ProbeRun.created_at <= created_to)
        if has_anomalies:
            filters.append(
                cast(
                    func.coalesce(
                        func.json_extract(ProbeRun.summary, "$.anomaly_count"),
                        0,
                    ),
                    Integer,
                )
                > 0
            )
        return filters

    def _blocked_account_ids(
        self,
        session: Session,
        *,
        account_ids: set[int] | None = None,
    ) -> tuple[set[int], set[int]]:
        if account_ids is not None and not account_ids:
            return set(), set()
        account_filter = (
            ProbeRun.account_id.in_(account_ids) if account_ids is not None else None
        )
        scoped = (account_filter,) if account_filter is not None else ()
        executing_ids = set(
            session.scalars(
                select(ProbeRun.account_id)
                .where(ProbeRun.status.in_(self.executing_statuses), *scoped)
                .distinct()
            ).all()
        )
        restore_ids = set(
            session.scalars(
                select(ProbeRun.account_id)
                .where(
                    ProbeRun.account_restore_status.in_(self.restore_statuses)
                    | ProbeRun.diagnostic_activation_active.is_(True),
                    *scoped,
                )
                .distinct()
            ).all()
        )
        return executing_ids, restore_ids

    def _run_list_item(
        self,
        run: ProbeRun,
        estimates: dict[tuple[str, str], ProbeDurationEstimate],
        executing_ids: set[int],
        restore_ids: set[int],
    ) -> dict[str, Any]:
        item = model_dict(run)
        item["duration_estimate"] = self._run_duration_estimate(
            run, estimates.get((run.profile_id, run.execution_mode))
        )
        reason = ""
        if run.status == "queued":
            if run.account_id in executing_ids:
                reason = "same_account_running"
            elif run.account_id in restore_ids:
                reason = "account_restore_blocked"
            else:
                reason = "worker_capacity"
        item["queue_blocked_reason"] = reason
        return item

    def _duration_estimates_for_runs(
        self, session: Session, runs: list[ProbeRun]
    ) -> dict[tuple[str, str], ProbeDurationEstimate]:
        profile_ids = {
            run.profile_id for run in runs if run.status in self.estimated_statuses
        }
        if not profile_ids:
            return {}
        values = session.scalars(
            select(ProbeDurationEstimate).where(
                ProbeDurationEstimate.profile_id.in_(profile_ids)
            )
        ).all()
        return {(value.profile_id, value.execution_mode): value for value in values}

    def _run_duration_estimate(
        self, run: ProbeRun, estimate: ProbeDurationEstimate | None
    ) -> dict[str, Any] | None:
        if (
            run.status not in self.estimated_statuses
            or estimate is None
            or estimate.sample_count <= 0
            or estimate.total_duration_ms <= 0
        ):
            return None
        average_sample_ms = max(
            1, round(estimate.total_duration_ms / estimate.sample_count)
        )
        remaining_steps = max(run.total_steps - run.completed_steps, 0)
        return {
            "average_sample_ms": average_sample_ms,
            "estimated_total_ms": average_sample_ms * run.total_steps,
            "estimated_remaining_ms": average_sample_ms * remaining_steps,
            "sample_count": estimate.sample_count,
            "updated_at": model_dict(estimate)["updated_at"],
        }

    def _history_statement(self, account_id: int) -> Any:
        return (
            select(
                ProbeSample.target_key,
                ProbeSample.target_kind,
                ProbeSample.egress_node_id,
                ProbeSample.egress_name,
                func.count(ProbeSample.id).label("samples"),
                func.sum(
                    case(
                        (
                            ProbeSample.classification.in_(
                                self.degradation_classifications
                            ),
                            1,
                        ),
                        else_=0,
                    )
                ).label("anomalies"),
                func.avg(ProbeSample.tps).filter(ProbeSample.tps > 0).label("avg_tps"),
                func.max(ProbeSample.tps).label("max_tps"),
                func.avg(
                    case(
                        (ProbeSample.upstream_tps.is_not(None), ProbeSample.upstream_tps),
                        else_=ProbeSample.tps,
                    )
                ).label("avg_upstream_tps"),
                func.max(
                    case(
                        (ProbeSample.upstream_tps.is_not(None), ProbeSample.upstream_tps),
                        else_=ProbeSample.tps,
                    )
                ).label("max_upstream_tps"),
            )
            .where(ProbeSample.account_id == account_id)
            .group_by(
                ProbeSample.target_key,
                ProbeSample.target_kind,
                ProbeSample.egress_node_id,
                ProbeSample.egress_name,
            )
            .order_by(func.max(ProbeSample.tps).desc())
        )

    @staticmethod
    def _status_count(session: Session, statuses: set[str]) -> int:
        return int(
            session.scalar(
                select(func.count(ProbeRun.id)).where(ProbeRun.status.in_(statuses))
            )
            or 0
        )

    @staticmethod
    def _queued_count(session: Session, *filters: Any) -> int:
        return int(
            session.scalar(
                select(func.count(ProbeRun.id)).where(
                    ProbeRun.status == "queued", *filters
                )
            )
            or 0
        )
