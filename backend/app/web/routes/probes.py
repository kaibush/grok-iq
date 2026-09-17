from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Response

from app.core.clock import account_created_at, app_isoformat, ensure_utc
from app.core.config import Settings
from app.integrations.grok2api.client import Grok2APIClient
from app.persistence.account_repository import AccountRepository
from app.persistence.probe_repository import ProbeRepository
from app.services.probe_manager import ProbeManager
from app.services.scheduler import SchedulerService
from app.web.schemas import (
    BulkIdsInput,
    ProbePlanEnabledInput,
    ProbePlanInput,
    ProbeRunBatchCreate,
    ProbeRunCreate,
    ProfileInput,
)


def overlay_run_missing_upstream(
    runs: list[dict[str, Any]],
    assessments: dict[int, dict[str, Any]],
) -> list[dict[str, Any]]:
    for run in runs:
        account_id = int(run.get("account_id") or 0)
        assessment = assessments.get(account_id) or {}
        run["missingUpstream"] = bool(assessment.get("upstream_deleted_at"))
    return runs


class ProbesRouter:
    def __init__(
        self,
        *,
        settings: Settings,
        client: Grok2APIClient,
        accounts: AccountRepository,
        repository: ProbeRepository,
        manager: ProbeManager,
        scheduler: SchedulerService,
    ):
        self.settings = settings
        self.client = client
        self.accounts = accounts
        self.repository = repository
        self.manager = manager
        self.scheduler = scheduler
        self.router = APIRouter()
        self._register_profile_routes()
        self._register_plan_routes()
        self._register_run_routes()
        self._register_scheduler_routes()

    def _register_profile_routes(self) -> None:
        self.router.add_api_route(
            "/probe-profiles", self.list_profiles, methods=["GET"]
        )
        self.router.add_api_route(
            "/probe-profiles", self.create_profile, methods=["POST"], status_code=201
        )
        self.router.add_api_route(
            "/probe-profiles/{profile_id}", self.update_profile, methods=["PUT"]
        )
        self.router.add_api_route(
            "/probe-profiles/{profile_id}",
            self.delete_profile,
            methods=["DELETE"],
            status_code=204,
        )
        self.router.add_api_route(
            "/probe-profiles", self.delete_profiles, methods=["DELETE"]
        )

    def _register_plan_routes(self) -> None:
        self.router.add_api_route("/probe-plans", self.list_plans, methods=["GET"])
        self.router.add_api_route(
            "/probe-plans", self.create_plan, methods=["POST"], status_code=201
        )
        self.router.add_api_route(
            "/probe-plans/{plan_id}", self.update_plan, methods=["PUT"]
        )
        self.router.add_api_route(
            "/probe-plans/{plan_id}/enabled",
            self.set_plan_enabled,
            methods=["PUT"],
        )
        self.router.add_api_route(
            "/probe-plans/{plan_id}",
            self.delete_plan,
            methods=["DELETE"],
            status_code=204,
        )
        self.router.add_api_route(
            "/probe-plans", self.delete_plans, methods=["DELETE"]
        )
        self.router.add_api_route(
            "/probe-plans/batch/run", self.run_plans, methods=["POST"]
        )
        self.router.add_api_route(
            "/probe-plans/{plan_id}/run", self.run_plan, methods=["POST"]
        )

    def _register_run_routes(self) -> None:
        self.router.add_api_route(
            "/probe-runs", self.create_probe_run, methods=["POST"], status_code=201
        )
        self.router.add_api_route(
            "/probe-runs/batch",
            self.create_probe_runs_batch,
            methods=["POST"],
            status_code=201,
        )
        self.router.add_api_route(
            "/probe-runs", self.list_probe_runs, methods=["GET"]
        )
        self.router.add_api_route(
            "/probe-workers", self.probe_worker_status, methods=["GET"]
        )
        self.router.add_api_route(
            "/probe-workers/logs", self.probe_worker_logs, methods=["GET"]
        )
        self.router.add_api_route(
            "/probe-runs/batch/cancel", self.cancel_probe_runs, methods=["POST"]
        )
        self.router.add_api_route(
            "/probe-runs/batch/restore-account-settings",
            self.restore_probe_runs_account_settings,
            methods=["POST"],
        )
        self.router.add_api_route(
            "/probe-runs/selection", self.select_probe_runs, methods=["GET"]
        )
        self.router.add_api_route(
            "/probe-runs/preview-samples",
            self.preview_probe_samples,
            methods=["POST"],
        )
        self.router.add_api_route(
            "/probe-runs/{run_id}", self.probe_run_detail, methods=["GET"]
        )
        self.router.add_api_route(
            "/probe-runs/{run_id}/cancel", self.cancel_probe_run, methods=["POST"]
        )
        self.router.add_api_route(
            "/probe-runs/{run_id}/retry",
            self.retry_probe_run,
            methods=["POST"],
            status_code=201,
        )
        self.router.add_api_route(
            "/probe-runs/{run_id}/restore-account-settings",
            self.restore_probe_run_account_settings,
            methods=["POST"],
        )
        self.router.add_api_route(
            "/probe-runs/{run_id}",
            self.delete_probe_run,
            methods=["DELETE"],
            status_code=204,
        )
        self.router.add_api_route(
            "/probe-samples/{sample_id}",
            self.delete_probe_sample,
            methods=["DELETE"],
            status_code=204,
        )
        self.router.add_api_route(
            "/probe-runs", self.delete_probe_runs, methods=["DELETE"]
        )

    def _register_scheduler_routes(self) -> None:
        self.router.add_api_route("/scheduler", self.scheduler_status, methods=["GET"])
        self.router.add_api_route(
            "/scheduler/executions/{execution_id}",
            self.delete_scheduler_execution,
            methods=["DELETE"],
            status_code=204,
        )
        self.router.add_api_route(
            "/scheduler/executions",
            self.delete_scheduler_executions,
            methods=["DELETE"],
        )

    def list_profiles(self) -> list[dict[str, Any]]:
        return self.repository.list_profiles()

    def create_profile(self, payload: ProfileInput) -> dict[str, Any]:
        return {"id": self.repository.create_profile(payload.model_dump())}

    def update_profile(
        self,
        profile_id: str,
        payload: ProfileInput,
    ) -> dict[str, Any]:
        return self.repository.update_profile(profile_id, payload.model_dump())

    def delete_profile(self, profile_id: str) -> Response:
        self.repository.delete_profile(profile_id)
        return Response(status_code=204)

    def delete_profiles(self, payload: BulkIdsInput) -> dict[str, Any]:
        return self.repository.delete_profiles(payload.ids)

    def list_plans(self) -> list[dict[str, Any]]:
        return self.scheduler.status()["plans"]

    async def _plan_values(self, payload: ProbePlanInput) -> dict[str, Any]:
        self.scheduler.validate_cron(payload.cron_expression, payload.timezone)
        targets = await self.manager.validate_targets(
            [target.model_dump() for target in payload.proxy_targets],
            execution_mode=payload.execution_mode,
        )
        return payload.model_dump(exclude={"proxy_targets"}) | {
            "proxy_targets": targets
        }

    async def create_plan(self, payload: ProbePlanInput) -> dict[str, Any]:
        plan_id = self.repository.create_plan(await self._plan_values(payload))
        self.scheduler.reload()
        return {"id": plan_id}

    async def update_plan(
        self,
        plan_id: str,
        payload: ProbePlanInput,
    ) -> dict[str, Any]:
        result = self.repository.update_plan(plan_id, await self._plan_values(payload))
        self.scheduler.reload()
        return result

    def set_plan_enabled(
        self,
        plan_id: str,
        payload: ProbePlanEnabledInput,
    ) -> dict[str, Any]:
        result = self.repository.update_plan(plan_id, {"enabled": payload.enabled})
        self.scheduler.reload()
        return result

    def delete_plan(self, plan_id: str) -> Response:
        self.repository.delete_plan(plan_id)
        self.scheduler.reload()
        return Response(status_code=204)

    def delete_plans(self, payload: BulkIdsInput) -> dict[str, Any]:
        result = self.repository.delete_plans(payload.ids)
        self.scheduler.reload()
        return result

    async def run_plans(self, payload: BulkIdsInput) -> dict[str, Any]:
        return await self.scheduler.run_plans_now(payload.ids)

    async def run_plan(self, plan_id: str) -> dict[str, Any]:
        return await self.scheduler.run_plan_now(plan_id)

    async def create_probe_run(self, payload: ProbeRunCreate) -> dict[str, Any]:
        targets = [target.model_dump() for target in payload.proxy_targets]
        if len(payload.profile_ids) <= 1:
            run_id = await self.manager.enqueue_manual(
                account_id=payload.account_id,
                profile_id=payload.profile_id,
                execution_mode=payload.execution_mode,
                rounds=payload.rounds,
                proxy_targets=targets,
            )
            return {"id": run_id, "status": "queued"}
        result = await self.manager.enqueue_manual_batch(
            account_ids=[payload.account_id],
            profile_id=payload.profile_id,
            profile_ids=payload.profile_ids,
            execution_mode=payload.execution_mode,
            rounds=payload.rounds,
            proxy_targets=targets,
        )
        run_ids = list(result.get("runIds") or [])
        return {
            "id": run_ids[0] if run_ids else "",
            "ids": run_ids,
            "created": result.get("created", 0),
            "status": "queued" if run_ids else "skipped",
        }

    async def create_probe_runs_batch(
        self,
        payload: ProbeRunBatchCreate,
    ) -> dict[str, Any]:
        return await self.manager.enqueue_manual_batch(
            account_ids=payload.account_ids,
            profile_id=payload.profile_id,
            profile_ids=payload.profile_ids,
            execution_mode=payload.execution_mode,
            rounds=payload.rounds,
            proxy_targets=[target.model_dump() for target in payload.proxy_targets],
        )

    async def list_probe_runs(
        self,
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=30, ge=1, le=100, alias="pageSize"),
        status: str = "",
        search: str = "",
        account_id: int | None = Query(default=None, alias="accountId"),
        plan_id: str | None = Query(default=None, alias="planId"),
        created_from: Annotated[datetime | None, Query(alias="createdFrom")] = None,
        created_to: Annotated[datetime | None, Query(alias="createdTo")] = None,
        has_anomalies: bool = Query(default=False, alias="hasAnomalies"),
    ) -> dict[str, Any]:
        normalized_from = ensure_utc(created_from)
        normalized_to = ensure_utc(created_to)
        if (
            normalized_from is not None
            and normalized_to is not None
            and normalized_from > normalized_to
        ):
            raise ValueError("任务开始时间不能晚于结束时间")
        payload = self.repository.list_runs(
            page=page,
            page_size=page_size,
            status=status,
            search=search,
            account_id=account_id,
            plan_id=plan_id,
            created_from=normalized_from,
            created_to=normalized_to,
            has_anomalies=has_anomalies,
        )
        payload["items"] = await self._with_account_overlay(payload.get("items", []))
        return payload

    def probe_worker_status(self) -> dict[str, Any]:
        return self.manager.status()

    def probe_worker_logs(
        self,
        limit: int = Query(default=300, ge=1, le=1500),
    ) -> dict[str, Any]:
        return self.manager.logs(limit)

    async def cancel_probe_runs(self, payload: BulkIdsInput) -> dict[str, int]:
        return await self.manager.cancel_many(payload.ids)

    async def restore_probe_runs_account_settings(
        self,
        payload: BulkIdsInput,
    ) -> dict[str, Any]:
        return await self.manager.restore_many(payload.ids)

    def select_probe_runs(
        self,
        status: str = "",
        search: str = "",
        account_id: int | None = Query(default=None, alias="accountId"),
        plan_id: str | None = Query(default=None, alias="planId"),
        created_from: Annotated[datetime | None, Query(alias="createdFrom")] = None,
        created_to: Annotated[datetime | None, Query(alias="createdTo")] = None,
        has_anomalies: bool = Query(default=False, alias="hasAnomalies"),
    ) -> dict[str, Any]:
        normalized_from = ensure_utc(created_from)
        normalized_to = ensure_utc(created_to)
        if (
            normalized_from is not None
            and normalized_to is not None
            and normalized_from > normalized_to
        ):
            raise ValueError("任务开始时间不能晚于结束时间")
        return self.repository.select_run_ids(
            status=status,
            search=search,
            account_id=account_id,
            plan_id=plan_id,
            created_from=normalized_from,
            created_to=normalized_to,
            has_anomalies=has_anomalies,
        )

    def preview_probe_samples(self, payload: BulkIdsInput) -> dict[str, Any]:
        return {"items": self.repository.preview_samples_for_runs(payload.ids)}

    async def probe_run_detail(self, run_id: str) -> dict[str, Any]:
        value = self.repository.run_detail(run_id)
        if value is None:
            raise HTTPException(status_code=404, detail="探针任务不存在")
        runs = await self._with_account_overlay([value["run"]])
        value["run"] = runs[0]
        return value

    async def cancel_probe_run(self, run_id: str) -> dict[str, Any]:
        return {"id": run_id, "status": await self.manager.cancel(run_id)}

    async def retry_probe_run(self, run_id: str) -> dict[str, Any]:
        return {"id": await self.manager.retry(run_id), "status": "queued"}

    async def restore_probe_run_account_settings(
        self,
        run_id: str,
    ) -> dict[str, Any]:
        return await self.manager.restore_run_account_settings(run_id)

    def _recalculate(self, account_id: int) -> None:
        self.accounts.recalculate(
            account_id,
            self.manager.thresholds,
            self.settings.analysis_window_hours,
        )

    def delete_probe_run(self, run_id: str) -> Response:
        self._recalculate(self.repository.delete_run(run_id))
        return Response(status_code=204)

    def delete_probe_sample(self, sample_id: str) -> Response:
        self._recalculate(self.repository.delete_sample(sample_id))
        return Response(status_code=204)

    def delete_probe_runs(self, payload: BulkIdsInput) -> dict[str, Any]:
        deleted, account_ids, skipped = self.repository.delete_runs(payload.ids)
        for account_id in account_ids:
            self._recalculate(account_id)
        return {
            "requested": len(payload.ids),
            "deleted": deleted,
            "skippedRunIds": skipped,
        }

    def scheduler_status(self) -> dict[str, Any]:
        return self.scheduler.status()

    def delete_scheduler_execution(self, execution_id: str) -> Response:
        self.repository.delete_schedule_execution(execution_id)
        return Response(status_code=204)

    def delete_scheduler_executions(self, payload: BulkIdsInput) -> dict[str, Any]:
        return self.repository.delete_schedule_executions(payload.ids)

    async def _with_account_overlay(
        self, runs: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        account_ids = {
            int(run.get("account_id") or 0)
            for run in runs
            if int(run.get("account_id") or 0) > 0
        }
        missing_ids = {
            int(run.get("account_id") or 0)
            for run in runs
            if not run.get("account_created_at") and int(run.get("account_id") or 0) > 0
        }
        if missing_ids:
            try:
                accounts = await self.client.get_accounts_by_ids(missing_ids)
            except Exception:
                accounts = []
            created_at_by_id = {
                int(account.get("id") or 0): account_created_at(account)
                for account in accounts
            }
            live_ids = [
                account_id for account_id in created_at_by_id if account_id > 0
            ]
            if live_ids:
                self.accounts.clear_upstream_deleted(live_ids)
            self.repository.persist_account_created_at(created_at_by_id)
            for run in runs:
                account_id = int(run.get("account_id") or 0)
                created_at = created_at_by_id.get(account_id)
                if created_at is not None and not run.get("account_created_at"):
                    run["account_created_at"] = app_isoformat(created_at)
        assessments = (
            self.accounts.get_assessments(sorted(account_ids)) if account_ids else {}
        )
        return overlay_run_missing_upstream(runs, assessments)


def build_probes_router(
    *,
    settings: Settings,
    client: Grok2APIClient,
    accounts: AccountRepository,
    repository: ProbeRepository,
    manager: ProbeManager,
    scheduler: SchedulerService,
) -> APIRouter:
    return ProbesRouter(
        settings=settings,
        client=client,
        accounts=accounts,
        repository=repository,
        manager=manager,
        scheduler=scheduler,
    ).router
