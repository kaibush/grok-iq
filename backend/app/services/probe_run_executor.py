from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from app.analyzer import SampleMetrics, classify_sample
from app.core.clock import utc_now
from app.integrations.grok2api.client import (
    IntegrationError,
    is_model_account_bind_mismatch,
    model_account_bind_window_message,
)
from app.persistence.probe_repository import AccountSettingsSnapshot, RunExecutionContext
from app.services.probe_runtime import AccountRestoreError, WorkerRuntime

if TYPE_CHECKING:
    from app.services.probe_manager import ProbeManager

FAST_QUALITY_PROBE_EXPECTED = "探针校验通过"
FAST_QUALITY_PROBE_PROMPT = f"请只输出“{FAST_QUALITY_PROBE_EXPECTED}”，不要添加其他内容。"


@dataclass(slots=True)
class ProbeRunState:
    original_node_id: int | None = None
    original_mode: str = ""
    snapshot: AccountSettingsSnapshot | None = None
    route_id: str = ""
    public_model: str = ""
    client_key_id: str = ""
    api_key: str = ""
    account_bound: bool = True
    cancelled: bool = False
    fatal_error: str = ""
    cleanup_errors: list[str] = field(default_factory=list)


class ProbeRunExecutor:
    """Executes one claimed probe run while the manager owns pool lifecycle."""

    def __init__(self, manager: ProbeManager, logger: logging.Logger):
        self.manager = manager
        self.logger = logger

    async def execute(
        self,
        context: RunExecutionContext,
        runtime: WorkerRuntime,
    ) -> dict[str, Any]:
        manager = self.manager
        logger = self.logger
        run = context.run
        profile = context.profile
        run_id = str(run["id"])
        account_id = int(run["account_id"])
        state = ProbeRunState()

        try:
            await self._prepare(run, profile, state)
            await self._execute_steps(run, profile, runtime, state)
        except asyncio.CancelledError:
            state.cancelled = True
        except Exception as exc:
            state.fatal_error = str(exc)
            logger.exception("probe run %s failed", run_id)
        finally:
            cleanup_result = await manager._cleanup_upstream(
                run_id=run_id,
                account_id=account_id,
                snapshot=state.snapshot,
                legacy_original_node_id=state.original_node_id,
                legacy_original_mode=state.original_mode,
                route_id=state.route_id,
                client_key_id=state.client_key_id,
                restore_egress=manager._run_changes_egress(run),
                source="automatic",
            )
            state.cleanup_errors.extend(cleanup_result.errors)
            if not cleanup_result.resource_errors:
                manager.repository.clear_upstream_context(run_id)

        error = "; ".join(value for value in [state.fatal_error, *state.cleanup_errors] if value)
        if state.cancelled:
            status = "cancelled"
        elif state.fatal_error:
            status = "failed"
        elif state.cleanup_errors:
            status = "completed_with_errors"
        else:
            status = None
        finished = manager.repository.finish_run(run_id, status=status, error=error)
        await self._post_process(run, runtime, finished)
        logger.info(
            "run finished worker=%s run=%s account=%s status=%s completed_steps=%s/%s errors=%s",
            runtime.worker_id,
            run_id,
            account_id,
            finished.get("status"),
            finished.get("completed_steps"),
            finished.get("total_steps"),
            finished.get("error_count"),
        )
        return finished

    async def _prepare(
        self,
        run: dict[str, Any],
        profile: dict[str, Any],
        state: ProbeRunState,
    ) -> None:
        manager = self.manager
        run_id = str(run["id"])
        account_id = int(run["account_id"])
        account = await manager.client.get_account(account_id)
        manager._validate_account_for_targets(account, list(run["proxy_targets"]))
        state.original_node_id = int(account.get("egressNodeId") or 0) or None
        state.original_mode = str(account.get("egressAssignmentMode") or "")
        priority_value = account.get("priority")
        state.snapshot = manager.repository.ensure_account_settings_snapshot(
            run_id=run_id,
            enabled=bool(account.get("enabled")),
            priority=int(priority_value) if priority_value is not None else 1,
            max_concurrent=int(account.get("maxConcurrent") or 1),
            egress_node_id=state.original_node_id,
            egress_assignment_mode=state.original_mode,
            diagnostic_priority=manager.settings.probe_diagnostic_priority,
            diagnostic_max_concurrent=1,
        )
        try:
            state.route_id, state.public_model = await manager.client.create_probe_route(
                account_id=account_id,
                upstream_model=str(profile["model"]),
                allow_temporarily_unavailable=not state.snapshot.enabled,
                bind_account=True,
            )
        except IntegrationError as exc:
            if not is_model_account_bind_mismatch(exc):
                raise
            if not self._can_pin_with_quality_guard(run, state):
                raise IntegrationError(
                    model_account_bind_window_message(
                        account_id,
                        missing_egress=True,
                    ),
                    error_code="modelBindWindow",
                ) from exc
            self.logger.warning(
                "probe run %s account %s is outside grok2api model bind "
                "window; pinning via quality-guard",
                run_id,
                account_id,
            )
            state.account_bound = False
            manager.repository.set_upstream_context(
                run_id=run_id,
                original_node_id=state.original_node_id,
                original_mode=state.original_mode,
                route_id="",
                public_model="",
                client_key_id="",
            )
            return
        state.account_bound = True
        manager.repository.set_upstream_context(
            run_id=run_id,
            original_node_id=state.original_node_id,
            original_mode=state.original_mode,
            route_id=state.route_id,
            public_model=state.public_model,
            client_key_id="",
        )
        state.client_key_id, state.api_key = await manager.client.create_probe_client_key(
            state.route_id
        )
        manager.repository.set_upstream_context(
            run_id=run_id,
            original_node_id=state.original_node_id,
            original_mode=state.original_mode,
            route_id=state.route_id,
            public_model=state.public_model,
            client_key_id=state.client_key_id,
        )

    async def _execute_steps(
        self,
        run: dict[str, Any],
        profile: dict[str, Any],
        runtime: WorkerRuntime,
        state: ProbeRunState,
    ) -> None:
        manager = self.manager
        run_id = str(run["id"])
        completed = manager.repository.completed_step_keys(run_id)
        total_rounds = int(run["rounds"])
        targets = list(run["proxy_targets"])
        for round_number in range(1, total_rounds + 1):
            for target_index, target in enumerate(targets):
                target_key = manager._target_key(target)
                if (round_number, target_key) in completed:
                    continue
                if manager._stopping or manager.repository.is_cancel_requested(run_id):
                    state.cancelled = True
                    break
                await self._execute_step(
                    run=run,
                    profile=profile,
                    runtime=runtime,
                    state=state,
                    round_number=round_number,
                    total_rounds=total_rounds,
                    target_index=target_index,
                    targets=targets,
                    target=target,
                    target_key=target_key,
                )
                if state.cancelled:
                    break
                if manager.settings.probe_step_delay_seconds:
                    await asyncio.sleep(manager.settings.probe_step_delay_seconds)
            if state.cancelled:
                break

    async def _execute_step(
        self,
        *,
        run: dict[str, Any],
        profile: dict[str, Any],
        runtime: WorkerRuntime,
        state: ProbeRunState,
        round_number: int,
        total_rounds: int,
        target_index: int,
        targets: list[dict[str, Any]],
        target: dict[str, Any],
        target_key: str,
    ) -> None:
        manager = self.manager
        run_id = str(run["id"])
        account_id = int(run["account_id"])
        manager.repository.set_current_step(run_id, round_number, target_key)
        runtime.current_round = round_number
        runtime.current_target_key = target_key
        manager._set_worker_status(runtime, "running")
        self.logger.info(
            "step started worker=%s run=%s account=%s round=%s target=%s",
            runtime.worker_id,
            run_id,
            account_id,
            round_number,
            target_key,
        )
        try:
            factory = await self._probe_factory(run, profile, target, state)
            result = await manager._run_probe_call(
                run_id=run_id,
                account_id=account_id,
                snapshot=state.snapshot,
                factory=factory,
            )
            manager._verify_probe_egress(
                target=target,
                original_node_id=state.original_node_id,
                result=result,
            )
        except asyncio.CancelledError:
            state.cancelled = True
        except AccountRestoreError:
            raise
        except Exception as exc:
            await self._record_failure(
                run_id=run_id,
                account_id=account_id,
                runtime=runtime,
                state=state,
                round_number=round_number,
                total_rounds=total_rounds,
                target_index=target_index,
                targets=targets,
                target=target,
                target_key=target_key,
                error=exc,
            )
        else:
            self._record_success(
                run=run,
                profile=profile,
                run_id=run_id,
                account_id=account_id,
                runtime=runtime,
                state=state,
                round_number=round_number,
                target=target,
                target_key=target_key,
                result=result,
            )

    async def _probe_factory(
        self,
        run: dict[str, Any],
        profile: dict[str, Any],
        target: dict[str, Any],
        state: ProbeRunState,
    ) -> Callable[[], Awaitable[Any]]:
        manager = self.manager
        run_id = str(run["id"])
        account_id = int(run["account_id"])
        if str(run.get("execution_mode") or "chat") == "chat":
            if target.get("kind") == "current":
                await manager._wait_for_current_probe_slot(run_id)
                live_account = await manager.client.get_account(account_id)
                live_node_id = int(live_account.get("egressNodeId") or 0) or None
                if live_node_id != state.original_node_id:
                    raise IntegrationError(
                        f"账号出口在定检期间从节点 {state.original_node_id} 变为 "
                        f"{live_node_id or '未绑定'}，已停止该样本"
                    )
            elif state.account_bound or target.get("kind") != "direct":
                manager.repository.mark_account_mutation_pending(run_id)
                await manager.client.set_account_egress(account_id, target)
                await asyncio.sleep(0.15)
            if not state.account_bound:
                return self._quality_guard_factory(account_id, target, state)

            def chat_factory() -> Awaitable[Any]:
                return manager.client.chat_probe(
                    api_key=state.api_key,
                    public_model=state.public_model,
                    account_id=account_id,
                    system_prompt=str(profile["system_prompt"]),
                    prompt=str(profile["prompt"]),
                    expected=str(profile["expected_text"]),
                    max_output_tokens=int(profile["max_output_tokens"]),
                    temperature=profile["temperature"],
                    extra_body=dict(profile["extra_body"] or {}),
                )

            return chat_factory
        if not state.account_bound:
            return self._quality_guard_factory(account_id, target, state)
        egress_node_id = int(target.get("id") or 0)

        def quality_factory() -> Awaitable[Any]:
            return manager.client.quality_probe(
                client_key_id=state.client_key_id,
                public_model=state.public_model,
                account_id=account_id,
                egress_node_id=egress_node_id,
                # Keep quick mode independent of user profiles
                # while exposing a readable validation marker.
                prompt=FAST_QUALITY_PROBE_PROMPT,
                expected=FAST_QUALITY_PROBE_EXPECTED,
                max_output_tokens=0,
            )

        return quality_factory

    def _quality_guard_factory(
        self,
        account_id: int,
        target: dict[str, Any],
        state: ProbeRunState,
    ) -> Callable[[], Awaitable[Any]]:
        node_id = self._forced_egress_node_id(account_id, target, state)

        def factory() -> Awaitable[Any]:
            return self.manager.client.quality_guard_probe(
                account_id=account_id,
                egress_node_id=node_id,
            )

        return factory

    @staticmethod
    def _forced_egress_node_id(
        account_id: int,
        target: dict[str, Any],
        state: ProbeRunState,
    ) -> int:
        kind = str(target.get("kind") or "")
        if kind in {"current", "direct"}:
            node_id = int(state.original_node_id or 0)
        else:
            node_id = int(target.get("id") or 0)
        if node_id <= 0:
            raise IntegrationError(
                model_account_bind_window_message(
                    account_id,
                    missing_egress=True,
                ),
                error_code="modelBindWindow",
            )
        return node_id

    @staticmethod
    def _can_pin_with_quality_guard(
        run: dict[str, Any],
        state: ProbeRunState,
    ) -> bool:
        if int(state.original_node_id or 0) > 0:
            return True
        return any(
            str(target.get("kind") or "") == "egress"
            and int(target.get("id") or 0) > 0
            for target in run.get("proxy_targets") or []
        )

    async def _record_failure(
        self,
        *,
        run_id: str,
        account_id: int,
        runtime: WorkerRuntime,
        state: ProbeRunState,
        round_number: int,
        total_rounds: int,
        target_index: int,
        targets: list[dict[str, Any]],
        target: dict[str, Any],
        target_key: str,
        error: Exception,
    ) -> None:
        manager = self.manager
        manager.repository.add_sample(
            run_id,
            manager._error_sample(
                round_number,
                target,
                error,
                current_node_id=state.original_node_id,
            ),
        )
        self.logger.warning(
            "step failed worker=%s run=%s account=%s round=%s target=%s "
            "status=%s code=%s error=%s",
            runtime.worker_id,
            run_id,
            account_id,
            round_number,
            target_key,
            int(getattr(error, "status_code", 0) or 0),
            str(getattr(error, "error_code", "") or ""),
            str(error),
        )
        has_next_step = target_index + 1 < len(targets) or round_number < total_rounds
        if has_next_step and isinstance(error, IntegrationError) and error.transient:
            await manager._wait_for_account_cooldown(run_id, account_id, error)

    def _record_success(
        self,
        *,
        run: dict[str, Any],
        profile: dict[str, Any],
        run_id: str,
        account_id: int,
        runtime: WorkerRuntime,
        state: ProbeRunState,
        round_number: int,
        target: dict[str, Any],
        target_key: str,
        result: Any,
    ) -> None:
        manager = self.manager
        classified = classify_sample(
            SampleMetrics(
                status_code=result.status_code,
                output_tokens=result.output_tokens,
                reasoning_tokens=result.reasoning_tokens,
                first_token_ms=result.first_token_ms,
                duration_ms=result.duration_ms,
                egress_key=target_key,
                expected_matched=result.expected_matched,
                model_upstream_model=str(profile.get("model") or ""),
                model_public_id=state.public_model,
                operation=(
                    "chat"
                    if str(run.get("execution_mode") or "chat") == "chat"
                    and state.account_bound
                    else "quality_test"
                ),
                reasoning_tokens_reported=result.reasoning_tokens_reported,
                measured_tps=result.tps,
                has_reasoning_text=bool(str(result.reasoning_text or "").strip()),
            ),
            manager.thresholds,
        )
        manager.repository.add_sample(
            run_id,
            {
                "round_number": round_number,
                "target_key": target_key,
                "target_kind": str(target["kind"]),
                "egress_node_id": (
                    state.original_node_id if target.get("kind") == "current" else target.get("id")
                ),
                "egress_name": str(target.get("name") or ""),
                "request_id": result.request_id,
                "audit_id": result.audit_id,
                "verified_account_id": result.verified_account_id,
                "verified_egress_node_id": result.verified_egress_node_id,
                "status": "done",
                "status_code": result.status_code,
                "output_tokens": result.output_tokens,
                "reasoning_tokens": result.reasoning_tokens,
                "reasoning_tokens_reported": result.reasoning_tokens_reported,
                "visible_tokens": result.visible_tokens,
                "chunk_count": result.chunk_count,
                "first_token_ms": result.first_token_ms,
                "duration_ms": result.duration_ms,
                "generation_ms": result.generation_ms,
                "first_token_share": result.first_token_share,
                "tps": classified.tps,
                "upstream_tps": result.tps,
                "expected_matched": result.expected_matched,
                "response_sha256": result.response_sha256,
                "response_text": result.response_text,
                "reasoning_text": result.reasoning_text,
                "usage": result.usage,
                "classification": classified.name,
                "risk_rule_id": classified.rule_id,
                "risk_rule_ids": list(classified.rule_ids),
                "risk_reasons": list(classified.reasons),
                "severity": classified.severity,
                "error": "",
                "created_at": utc_now(),
            },
        )
        self.logger.info(
            "step completed worker=%s run=%s account=%s round=%s target=%s "
            "http=%s output_tokens=%s tps=%.2f duration_ms=%s classification=%s",
            runtime.worker_id,
            run_id,
            account_id,
            round_number,
            target_key,
            result.status_code,
            result.output_tokens,
            classified.tps,
            result.duration_ms,
            classified.name,
        )

    async def _post_process(
        self,
        run: dict[str, Any],
        runtime: WorkerRuntime,
        finished: dict[str, Any],
    ) -> None:
        manager = self.manager
        logger = self.logger
        run_id = str(run["id"])
        account_id = int(run["account_id"])
        try:
            previous_assessment = manager.accounts.get_assessment(account_id)
            assessment = manager.accounts.recalculate(
                account_id,
                manager.thresholds,
                manager.settings.analysis_window_hours,
            )
        except Exception:
            # Run evidence is already complete. Post-processing failure must be
            # visible in the rotating log, but it must not terminate a Worker.
            logger.exception(
                "run post-processing failed worker=%s run=%s account=%s",
                runtime.worker_id,
                run_id,
                account_id,
            )
        else:
            register_follow_up_id: str | None = None
            try:
                register_follow_up_id = await manager.maybe_switch_register_probe_egress(
                    run, finished
                )
            except Exception:
                logger.exception(
                    "register probe egress switch failed worker=%s run=%s account=%s",
                    runtime.worker_id,
                    run_id,
                    account_id,
                )
            if register_follow_up_id is None:
                try:
                    assessment = await manager._apply_auto_quarantine(
                        account_id, assessment
                    )
                except Exception:
                    # A failed automatic action must not suppress the risk message;
                    # send the recalculated high-risk assessment below.
                    logger.exception(
                        "auto quarantine failed worker=%s run=%s account=%s",
                        runtime.worker_id,
                        run_id,
                        account_id,
                    )
            if manager.notifications is not None:
                try:
                    trigger = str(run.get("trigger") or "probe")
                    force_notification = trigger in {"manual", "retry"} and str(
                        finished.get("status") or ""
                    ) in {"completed", "completed_with_errors"}
                    await manager.notifications.notify_account_transition(
                        account={
                            "id": account_id,
                            "name": str(run.get("account_name") or ""),
                            "email": str(run.get("account_email") or ""),
                        },
                        previous=previous_assessment,
                        current=assessment,
                        source=trigger,
                        force=force_notification,
                    )
                except Exception:
                    logger.exception(
                        "wechat notification failed worker=%s run=%s account=%s",
                        runtime.worker_id,
                        run["id"],
                        account_id,
                    )
        if str(run.get("trigger") or "") == "register":
            restore = getattr(manager, "maybe_restore_register_priority_hold", None)
            if restore is not None:
                try:
                    await restore(run)
                except Exception:
                    logger.exception(
                        "register priority hold restore failed worker=%s run=%s account=%s",
                        runtime.worker_id,
                        run_id,
                        account_id,
                    )
