from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import replace
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import and_, case, delete, func, or_, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.analyzer import (
    SampleMetrics,
    Thresholds,
    active_anomaly_classifications,
    aggregate_rule_reasons,
    classify_sample,
    maximum_anomaly_streak,
    risk_rule_enabled,
    risk_status,
    rule_metadata,
)
from app.core.clock import app_isoformat, ensure_utc, parse_optional_datetime, utc_now
from app.core.disposition import (
    build_disposition,
    infer_disposition_source,
    public_disposition,
)
from app.reasoning_policy import canonical_reasoning_model

from .database import Database
from .models import (
    AccountAssessment,
    AccountCooldown,
    Alert,
    AppSetting,
    MetadataRow,
    ProbeProfile,
    ProbeRun,
    ProbeSample,
    RegisterWebhookEvent,
    model_dict,
)

ANOMALY_NAMES = active_anomaly_classifications()
HARD_ANOMALY_NAMES = {
    name
    for name in ANOMALY_NAMES
    if ((metadata := rule_metadata(name)) is not None and bool(metadata.hard))
}
PROMOTED_REASONING_ZERO_SEVERITY = 4
DASHBOARD_EXECUTING_STATUSES = ("running", "cancel_requested", "recovering")
DASHBOARD_STALE_HEARTBEAT = timedelta(minutes=2)
FIXED_EGRESS_RISK_MIGRATION_KEY = "fixed_egress_risk_formula_v1"
ALL_EGRESS_RISK_MIGRATION_KEY = "all_egress_risk_formula_v1"
MAX_OPERATOR_NOTES = 50
MAX_OPERATOR_NOTE_LENGTH = 2000
MISSING_THINKING_COOLDOWN_KIND = "missing_thinking_cooldown"
COOLING_STATUS = "cooling"
EXPIRED_STATUS = "expired"


def _sort_operator_notes(notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(notes, key=lambda item: str(item.get("created_at") or ""), reverse=True)


def _normalized_operator_notes(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_notes = payload.get("operator_notes") or []
    notes: list[dict[str, Any]] = []
    if isinstance(raw_notes, list):
        for item in raw_notes:
            if not isinstance(item, dict):
                continue
            content = str(item.get("content") or "").strip()
            note_id = str(item.get("id") or "").strip()
            if not content or not note_id:
                continue
            updated_at = str(item.get("updated_at") or "").strip() or None
            notes.append(
                {
                    "id": note_id,
                    "content": content,
                    "created_at": str(item.get("created_at") or "").strip(),
                    "updated_at": updated_at,
                }
            )
    if notes:
        return _sort_operator_notes(notes)
    legacy = str(payload.get("operator_note") or "").strip()
    if not legacy:
        return []
    created = payload.get("updated_at") or payload.get("created_at")
    created_at = (
        app_isoformat(created) if isinstance(created, datetime) else str(created or "")
    )
    return [
        {
            "id": f"legacy-{payload.get('account_id')}",
            "content": legacy,
            "created_at": created_at or "",
            "updated_at": None,
        }
    ]


def _persistable_operator_notes(notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    persisted: list[dict[str, Any]] = []
    for note in notes:
        note_id = str(note.get("id") or "").strip()
        if not note_id or note_id.startswith("legacy-"):
            note_id = uuid.uuid4().hex
        persisted.append(
            {
                "id": note_id,
                "content": str(note.get("content") or "").strip(),
                "created_at": str(note.get("created_at") or "").strip()
                or app_isoformat(utc_now()),
                "updated_at": str(note.get("updated_at") or "").strip() or None,
            }
        )
    return _sort_operator_notes(persisted)


def _register_event_account_id(grok2api_account_id: Any, resolved_account_id: Any) -> int | None:
    for value in (grok2api_account_id, resolved_account_id):
        try:
            account_id = int(value or 0)
        except (TypeError, ValueError):
            account_id = 0
        if account_id > 0:
            return account_id
    return None


def _register_event_identity(
    *,
    event_id: str,
    email: str,
    grok2api_account_id: Any,
    resolved_account_id: Any,
) -> str:
    account_id = _register_event_account_id(grok2api_account_id, resolved_account_id)
    if account_id is not None:
        return f"account:{account_id}"
    normalized_email = str(email or "").strip().lower()
    if normalized_email:
        return f"email:{normalized_email}"
    return f"event:{event_id}"


def _dashboard_register_counts(rows: list[Any]) -> dict[str, int]:
    grouped: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        identity = _register_event_identity(
            event_id=str(getattr(row, "event_id", "") or ""),
            email=str(getattr(row, "email", "") or ""),
            grok2api_account_id=getattr(row, "grok2api_account_id", None),
            resolved_account_id=getattr(row, "resolved_account_id", None),
        )
        grouped[identity].add(str(getattr(row, "status", "") or ""))
    completed = 0
    failed = 0
    pending = 0
    for statuses in grouped.values():
        if "completed" in statuses:
            completed += 1
        elif statuses and statuses <= {"failed"}:
            failed += 1
        else:
            pending += 1
    return {
        "total": len(grouped),
        "completed": completed,
        "failed": failed,
        "pending": pending,
    }


def _dashboard_isolated_counts(
    rows: list[AccountAssessment], cutoff: datetime
) -> dict[str, int]:
    in_range = 0
    for row in rows:
        payload = row.disposition if isinstance(row.disposition, dict) else {}
        isolated_at = parse_optional_datetime(payload.get("at")) or ensure_utc(row.updated_at)
        if isolated_at is not None and isolated_at >= cutoff:
            in_range += 1
    return {"zoneTotal": len(rows), "inRange": in_range}


def _dashboard_probe_run_counts(status_counts: dict[str, int]) -> dict[str, Any]:
    completed = int(status_counts.get("completed") or 0)
    failed = int(status_counts.get("failed") or 0)
    completed_with_errors = int(status_counts.get("completed_with_errors") or 0)
    finished = completed + failed + completed_with_errors
    return {
        "completed": completed,
        "failed": failed,
        "completedWithErrors": completed_with_errors,
        "successRate": round(completed / finished, 4) if finished else 0.0,
    }


def _isolation_sort_key(item: dict[str, Any]) -> tuple[str, int]:
    disposition = item.get("disposition") if isinstance(item.get("disposition"), dict) else {}
    isolated_at = parse_optional_datetime(disposition.get("at")) or parse_optional_datetime(
        item.get("updated_at")
    )
    stamp = isolated_at.isoformat() if isolated_at is not None else ""
    return (stamp, int(item.get("account_id") or 0))


def _hydrated_disposition(payload: dict[str, Any]) -> dict[str, Any]:
    current = public_disposition(payload.get("disposition"))
    if current:
        return current
    if str(payload.get("monitor_status") or "") != "quarantined":
        return {}
    note = str(payload.get("manual_note") or "").strip()
    if not note:
        return {}
    return build_disposition(
        source=infer_disposition_source(note),
        action="isolate" if payload.get("quarantine_until") is None else "quarantine",
        reason=note,
        at=app_isoformat(payload.get("updated_at"))
        if not isinstance(payload.get("updated_at"), str)
        else str(payload.get("updated_at") or "") or None,
        evidence=payload.get("risk_reasons") or [],
    )


def _assessment_dict(value: AccountAssessment) -> dict[str, Any]:
    payload = model_dict(value)
    notes = _normalized_operator_notes(payload)
    payload["operator_notes"] = notes
    payload["operator_note"] = str(notes[0]["content"]) if notes else ""
    payload["disposition"] = _hydrated_disposition(payload)
    return payload


class AccountRepository:
    def __init__(self, database: Database):
        self.database = database

    def get_assessment(self, account_id: int) -> dict[str, Any] | None:
        with self.database.session() as session:
            value = session.get(AccountAssessment, account_id)
            return _assessment_dict(value) if value else None

    def get_assessments(self, account_ids: list[int]) -> dict[int, dict[str, Any]]:
        if not account_ids:
            return {}
        with self.database.session() as session:
            values = session.scalars(
                select(AccountAssessment).where(AccountAssessment.account_id.in_(account_ids))
            ).all()
            return {value.account_id: _assessment_dict(value) for value in values}

    def list_assessments(self, limit: int = 1000) -> list[dict[str, Any]]:
        with self.database.session() as session:
            values = session.scalars(
                select(AccountAssessment)
                .order_by(AccountAssessment.risk_score.desc(), AccountAssessment.updated_at.desc())
                .limit(limit)
            ).all()
            return [_assessment_dict(value) for value in values]

    def list_by_monitor_status(
        self,
        status: str,
        limit: int = 5000,
    ) -> list[dict[str, Any]]:
        normalized = str(status or "").strip()
        if not normalized:
            return []
        capped = min(max(int(limit), 1), 5000)
        with self.database.session() as session:
            values = session.scalars(
                select(AccountAssessment)
                .where(AccountAssessment.monitor_status == normalized)
                .order_by(
                    AccountAssessment.risk_score.desc(),
                    AccountAssessment.updated_at.desc(),
                )
                .limit(capped)
            ).all()
            return [_assessment_dict(value) for value in values]

    def list_isolation_zone(self) -> list[dict[str, Any]]:
        """Return permanent isolations: quarantined with no recovery deadline."""

        with self.database.session() as session:
            values = session.scalars(
                select(AccountAssessment).where(
                    AccountAssessment.monitor_status == "quarantined",
                    AccountAssessment.quarantine_until.is_(None),
                )
            ).all()
            items = [_assessment_dict(value) for value in values]
        items.sort(key=_isolation_sort_key, reverse=True)
        return items

    def migrate_fixed_egress_risk_formula(
        self,
        thresholds: Thresholds,
        window_hours: int,
    ) -> int:
        """Recalculate persisted verdicts once after replacing cross-egress scoring."""

        with self.database.session() as session:
            if session.get(MetadataRow, FIXED_EGRESS_RISK_MIGRATION_KEY) is not None:
                return 0
            account_ids = list(session.scalars(select(AccountAssessment.account_id)).all())

        for account_id in account_ids:
            self.recalculate(account_id, thresholds, window_hours)

        with self.database.transaction() as session:
            if session.get(MetadataRow, FIXED_EGRESS_RISK_MIGRATION_KEY) is None:
                session.add(
                    MetadataRow(
                        key=FIXED_EGRESS_RISK_MIGRATION_KEY,
                        value=utc_now().isoformat(),
                    )
                )
            legacy_cross_egress = session.get(AppSetting, "cross_egress_min")
            if legacy_cross_egress is not None:
                session.delete(legacy_cross_egress)
        return len(account_ids)

    def migrate_all_egress_risk_formula(
        self,
        thresholds: Thresholds,
        window_hours: int,
    ) -> int:
        """Recalculate persisted verdicts once after including diagnostic samples."""

        with self.database.session() as session:
            if session.get(MetadataRow, ALL_EGRESS_RISK_MIGRATION_KEY) is not None:
                return 0
            account_ids = set(session.scalars(select(AccountAssessment.account_id)).all())
            account_ids.update(
                session.scalars(select(ProbeSample.account_id).distinct()).all()
            )

        for account_id in account_ids:
            self.recalculate(account_id, thresholds, window_hours)

        with self.database.transaction() as session:
            if session.get(MetadataRow, ALL_EGRESS_RISK_MIGRATION_KEY) is None:
                session.add(
                    MetadataRow(
                        key=ALL_EGRESS_RISK_MIGRATION_KEY,
                        value=utc_now().isoformat(),
                    )
                )
        return len(account_ids)

    def recalculate_all(self, thresholds: Thresholds, window_hours: int) -> int:
        with self.database.session() as session:
            account_ids = set(
                session.scalars(select(AccountAssessment.account_id)).all()
            )
            account_ids.update(
                session.scalars(select(ProbeSample.account_id).distinct()).all()
            )
        for account_id in account_ids:
            self.recalculate(account_id, thresholds, window_hours)
        return len(account_ids)

    def risky_account_ids(self) -> set[int]:
        with self.database.session() as session:
            return set(
                session.scalars(
                    select(AccountAssessment.account_id).where(
                        AccountAssessment.monitor_status.in_(
                            {"watch", "suspect", "high_risk", "quarantined"}
                        )
                    )
                ).all()
            )

    def recalculate(self, account_id: int, thresholds: Thresholds, window_hours: int) -> dict[str, Any]:
        cutoff = utc_now() - timedelta(hours=window_hours)
        with self.database.transaction() as session:
            values = session.execute(
                select(ProbeSample, ProbeRun, ProbeProfile)
                .join(ProbeRun, ProbeSample.run_id == ProbeRun.id, isouter=True)
                .join(
                    ProbeProfile,
                    ProbeRun.profile_id == ProbeProfile.id,
                    isouter=True,
                )
                .where(
                    ProbeSample.account_id == account_id,
                    ProbeSample.created_at >= cutoff,
                )
                .order_by(ProbeSample.created_at.asc(), ProbeSample.id.asc())
            ).all()
            rows = [sample for sample, _run, _profile in values]
            classifications = []
            reasoning_zero_signals: list[bool] = []
            reasoning_streaks: dict[tuple[str, str], int] = defaultdict(int)
            reasoning_rule_active = risk_rule_enabled(
                "reasoning_zero",
                thresholds,
            )
            for sample, run, profile in values:
                upstream_model = str(getattr(profile, "model", "") or "")
                public_model = str(
                    getattr(run, "temporary_public_model", "") or ""
                )
                execution_mode = str(
                    getattr(run, "execution_mode", "chat") or "chat"
                )
                operation = "chat" if execution_mode == "chat" else "quality_test"
                classified = classify_sample(
                    SampleMetrics(
                        # A probe can fail local verification after receiving a
                        # successful upstream response (for example, audited
                        # account/node drift).  Preserve that operational error
                        # during risk recomputation instead of reclassifying the
                        # row as merely unmeasurable because timing is ignored
                        # for failed samples.
                        status_code=(
                            sample.status_code if sample.status == "done" else 0
                        ),
                        output_tokens=sample.output_tokens,
                        reasoning_tokens=sample.reasoning_tokens,
                        first_token_ms=(
                            sample.first_token_ms
                            if sample.status == "done"
                            else None
                        ),
                        duration_ms=sample.duration_ms,
                        egress_key=sample.target_key,
                        expected_matched=sample.expected_matched,
                        model_upstream_model=upstream_model,
                        model_public_id=public_model,
                        operation=operation,
                        reasoning_tokens_reported=bool(
                            sample.reasoning_tokens_reported
                        ),
                        measured_tps=(
                            sample.upstream_tps
                            if sample.upstream_tps is not None
                            else sample.tps
                        ),
                        has_reasoning_text=bool(
                            str(getattr(sample, "reasoning_text", "") or "").strip()
                        ),
                    ),
                    thresholds,
                )
                policy = thresholds.reasoning_policy(
                    model_upstream_model=upstream_model,
                    model_public_id=public_model,
                    operation=operation,
                )
                group_key = (
                    canonical_reasoning_model(
                        upstream_model or public_model
                    ),
                    operation.casefold(),
                )
                applicable = bool(
                    reasoning_rule_active
                    and classified.name
                    not in {"error", "unmeasurable", "insufficient"}
                    and policy.mode in {"required", "observe"}
                    and 200 <= int(sample.status_code or 0) < 300
                    and bool(sample.reasoning_tokens_reported)
                    and int(sample.output_tokens or 0)
                    >= policy.minimum_output_tokens
                )
                reasoning_zero_detected = bool(
                    applicable and int(sample.reasoning_tokens or 0) <= 0
                )
                reasoning_zero_signals.append(reasoning_zero_detected)
                if policy.mode != "required" or not applicable:
                    reasoning_streaks[group_key] = 0
                elif int(sample.reasoning_tokens or 0) > 0:
                    reasoning_streaks[group_key] = 0
                else:
                    reasoning_streaks[group_key] += 1
                    streak = reasoning_streaks[group_key]
                    if streak >= policy.min_count:
                        reason = (
                            "同账号、上游模型和探针请求类型的思考输出连续为 0 "
                            f"{streak} 次，达到 {policy.min_count} 次阈值"
                        )
                        rule_ids = tuple(
                            dict.fromkeys((*classified.rule_ids, "reasoning_zero"))
                        )
                        reasons = tuple(
                            dict.fromkeys((*classified.reasons, reason))
                        )
                        # Keep an already-strong primary diagnosis such as
                        # fast_risk. Otherwise expose reasoning_zero as the
                        # promoted primary classification and persist severity
                        # 4 so dashboard hard-signal trends can distinguish it
                        # from a single observation.
                        promoted_primary = classified.hard
                        classified = replace(
                            classified,
                            name=(
                                classified.name
                                if promoted_primary
                                else "reasoning_zero"
                            ),
                            severity=max(
                                classified.severity,
                                PROMOTED_REASONING_ZERO_SEVERITY,
                            ),
                            anomalous=True,
                            hard=True,
                            rule_id=(
                                classified.rule_id
                                if promoted_primary
                                else "reasoning_zero"
                            ),
                            rule_ids=rule_ids,
                            reasons=reasons,
                        )
                if reasoning_zero_detected:
                    reasoning_reason = (
                        classified.reasons[-1]
                        if classified.rule_id == "reasoning_zero"
                        and classified.reasons
                        else (
                            "模型策略要求思考输出，但本次思考 Token 为 0"
                            if policy.mode == "required"
                            else "当前模型与请求类型仅观察思考输出为 0"
                        )
                    )
                    if not classified.anomalous:
                        classified = replace(
                            classified,
                            name=(
                                "reasoning_zero"
                                if policy.mode == "required"
                                else "reasoning_zero_observe"
                            ),
                            severity=3 if policy.mode == "required" else 1,
                            anomalous=True,
                            rule_id="reasoning_zero",
                            rule_ids=("reasoning_zero",),
                            reasons=(reasoning_reason,),
                        )
                    else:
                        classified = replace(
                            classified,
                            rule_ids=tuple(
                                dict.fromkeys(
                                    (*classified.rule_ids, "reasoning_zero")
                                )
                            ),
                            reasons=tuple(
                                dict.fromkeys(
                                    (*classified.reasons, reasoning_reason)
                                )
                            ),
                        )
                sample.classification = classified.name
                if sample.upstream_tps is None:
                    sample.upstream_tps = sample.tps
                sample.tps = classified.tps
                sample.risk_rule_id = classified.rule_id
                sample.risk_rule_ids = list(classified.rule_ids)
                sample.risk_reasons = list(classified.reasons)
                sample.severity = classified.severity
                classifications.append(classified)
            anomaly_names = active_anomaly_classifications(thresholds)
            anomaly_pairs = [
                (row, classified)
                for row, classified in zip(rows, classifications, strict=True)
                if classified.anomalous and classified.name in anomaly_names
            ]
            anomalies = [row for row, _classified in anomaly_pairs]
            hard = [row for row, classified in anomaly_pairs if classified.hard]
            fast = [row for row, classified in anomaly_pairs if classified.name == "fast_risk"]
            marker = [
                row for row, classified in anomaly_pairs if classified.name == "marker_miss"
            ]
            reasoning_zero = [
                row
                for row, detected in zip(
                    rows,
                    reasoning_zero_signals,
                    strict=True,
                )
                if detected
            ]
            egress_count = len({self._observed_egress_key(row) for row in anomalies})
            streak = maximum_anomaly_streak(
                (classified.name for classified in classifications),
                anomaly_names,
            )
            measurable = [row for row in rows if row.status == "done" and row.tps > 0]
            status, score, reasons = risk_status(
                anomaly_count=len(anomalies),
                hard_count=len(hard),
                fast_count=len(fast),
                marker_miss_count=len(marker),
                reasoning_zero_count=len(reasoning_zero),
                anomaly_streak=streak,
                sample_count=len(measurable),
                thresholds=thresholds,
            )
            rule_counts: dict[str, int] = {}
            for _row, classified in anomaly_pairs:
                rule_counts[classified.name] = (
                    rule_counts.get(classified.name, 0) + 1
                )
            if reasoning_zero:
                # Reasoning is an independent aggregate signal and can share a
                # sample with a TPS/marker primary classification. Report the
                # complete count instead of only rows where it won precedence.
                rule_counts["reasoning_zero"] = len(reasoning_zero)
            generic_rule_reasons = aggregate_rule_reasons(rule_counts, thresholds)
            legacy_special_reasons = {
                "fast_risk": f"持续生成型高速样本 {len(fast)} 次",
                "marker_miss": f"预期标记缺失 {len(marker)} 次",
                "reasoning_zero": (
                    f"成功请求思考输出为 0 共 {len(reasoning_zero)} 次"
                ),
            }
            reasons = list(
                dict.fromkeys(
                    [
                        *[
                            reason
                            for reason in reasons
                            if reason not in legacy_special_reasons.values()
                        ],
                        *generic_rule_reasons,
                        *(
                            [f"强降智信号 {len(hard)} 次"]
                            if hard
                            else []
                        ),
                    ]
                )
            )
            assessment = session.get(AccountAssessment, account_id)
            if assessment is None:
                assessment = AccountAssessment(account_id=account_id)
                session.add(assessment)
            quarantine_until = ensure_utc(assessment.quarantine_until)
            if assessment.monitor_status == "quarantined" and (
                quarantine_until is None or quarantine_until > utc_now()
            ):
                status = "quarantined"
            elif str(assessment.manual_note or "").startswith("registration:"):
                # Registration risk is independent evidence supplied by the
                # linked registration service and must survive probe scoring.
                status = "high_risk"
                score = min(
                    thresholds.risk_score_cap,
                    max(score, thresholds.risk_high_floor, 85.0),
                )
                reasons = list(
                    dict.fromkeys(
                        [
                            *(assessment.risk_reasons or []),
                            *reasons,
                        ]
                    )
                )
            latest = rows[-1] if rows else None
            latest_measurable = measurable[-1] if measurable else None
            upstream_values = [
                float(row.upstream_tps if row.upstream_tps is not None else row.tps)
                for row in measurable
                if (row.upstream_tps if row.upstream_tps is not None else row.tps) > 0
            ]
            assessment.monitor_status = status
            assessment.risk_score = score
            assessment.sample_count = len(measurable)
            assessment.anomaly_count = len(anomalies)
            assessment.hard_anomaly_count = len(hard)
            assessment.fast_risk_count = len(fast)
            assessment.marker_miss_count = len(marker)
            assessment.reasoning_zero_count = len(reasoning_zero)
            assessment.distinct_egress_count = egress_count
            assessment.anomaly_streak = streak
            assessment.avg_tps = sum(row.tps for row in measurable) / len(measurable) if measurable else 0.0
            assessment.max_tps = max((row.tps for row in measurable), default=0.0)
            assessment.latest_tps = latest_measurable.tps if latest_measurable else 0.0
            assessment.avg_upstream_tps = (
                sum(upstream_values) / len(upstream_values) if upstream_values else 0.0
            )
            assessment.max_upstream_tps = max(upstream_values, default=0.0)
            assessment.latest_upstream_tps = (
                float(
                    latest_measurable.upstream_tps
                    if latest_measurable and latest_measurable.upstream_tps is not None
                    else latest_measurable.tps
                )
                if latest_measurable
                else 0.0
            )
            assessment.latest_classification = latest.classification if latest else ""
            assessment.latest_sample_at = latest.created_at if latest else None
            assessment.last_anomaly_at = anomalies[-1].created_at if anomalies else None
            assessment.risk_reasons = reasons
            assessment.updated_at = utc_now()
            session.flush()
            result = _assessment_dict(assessment)
        return result

    @staticmethod
    def _observed_egress_key(sample: ProbeSample) -> str:
        """Prefer the audited node over the requested routing strategy."""

        if sample.verified_egress_node_id is not None:
            return f"egress:{sample.verified_egress_node_id}"
        if sample.target_kind == "direct":
            return "direct"
        return sample.target_key

    def set_manual_status(
        self,
        *,
        account_id: int,
        status: str,
        note: str,
        quarantine_until=None,  # type: ignore[no-untyped-def]
        previous_upstream_enabled: bool | None = None,
        disabled_by_monitor: bool | None = None,
        recovery_guarded: bool | None = None,
        source: str | None = None,
        disposition_action: str | None = None,
        evidence: list[str] | None = None,
    ) -> dict[str, Any]:
        with self.database.transaction() as session:
            assessment = session.get(AccountAssessment, account_id)
            if assessment is None:
                assessment = AccountAssessment(account_id=account_id)
                session.add(assessment)
            assessment.monitor_status = status
            assessment.manual_note = note
            assessment.quarantine_until = quarantine_until
            if previous_upstream_enabled is not None:
                assessment.previous_upstream_enabled = previous_upstream_enabled
            if disabled_by_monitor is not None:
                assessment.disabled_by_monitor = disabled_by_monitor
            if recovery_guarded is not None:
                assessment.recovery_guarded = recovery_guarded
            if status == "quarantined":
                stored_evidence = [
                    str(item).strip()
                    for item in (
                        evidence
                        if evidence is not None
                        else (assessment.risk_reasons or [])
                    )
                    if str(item).strip()
                ]
                assessment.disposition = build_disposition(
                    source=source or infer_disposition_source(note),
                    action=disposition_action
                    or (
                        "isolate"
                        if quarantine_until is None
                        else "quarantine"
                    ),
                    reason=note,
                    evidence=stored_evidence,
                )
            else:
                assessment.disposition = {}
            assessment.updated_at = utc_now()
            session.flush()
            result = _assessment_dict(assessment)
        return result

    def _load_operator_notes(
        self,
        assessment: AccountAssessment,
    ) -> list[dict[str, Any]]:
        return _persistable_operator_notes(_normalized_operator_notes(model_dict(assessment)))

    def add_operator_note(self, account_id: int, content: str) -> dict[str, Any]:
        with self.database.transaction() as session:
            assessment = session.get(AccountAssessment, account_id)
            if assessment is None:
                assessment = AccountAssessment(account_id=account_id)
                session.add(assessment)
            notes = self._load_operator_notes(assessment)
            if len(notes) >= MAX_OPERATOR_NOTES:
                raise ValueError("备注最多 50 条")
            notes.insert(
                0,
                {
                    "id": uuid.uuid4().hex,
                    "content": content,
                    "created_at": app_isoformat(utc_now()),
                    "updated_at": None,
                },
            )
            notes = _sort_operator_notes(notes)
            assessment.operator_notes = notes
            assessment.operator_note = content
            session.flush()
            result = _assessment_dict(assessment)
        return result

    def update_operator_note(
        self,
        account_id: int,
        note_id: str,
        content: str,
    ) -> dict[str, Any]:
        with self.database.transaction() as session:
            assessment = session.get(AccountAssessment, account_id)
            if assessment is None:
                raise ValueError("备注不存在")
            current = _normalized_operator_notes(model_dict(assessment))
            updated_notes: list[dict[str, Any]] = []
            found = False
            for note in current:
                if str(note.get("id") or "") != note_id:
                    updated_notes.append(note)
                    continue
                found = True
                updated_notes.append(
                    {
                        **note,
                        "content": content,
                        "updated_at": app_isoformat(utc_now()),
                    }
                )
            if not found:
                raise ValueError("备注不存在")
            notes = _persistable_operator_notes(updated_notes)
            assessment.operator_notes = notes
            assessment.operator_note = str(notes[0]["content"]) if notes else ""
            session.flush()
            result = _assessment_dict(assessment)
        return result

    def delete_operator_note(self, account_id: int, note_id: str) -> dict[str, Any]:
        with self.database.transaction() as session:
            assessment = session.get(AccountAssessment, account_id)
            if assessment is None:
                raise ValueError("备注不存在")
            current = _normalized_operator_notes(model_dict(assessment))
            remaining = [
                note for note in current if str(note.get("id") or "") != note_id
            ]
            if len(remaining) == len(current):
                raise ValueError("备注不存在")
            notes = _persistable_operator_notes(remaining)
            assessment.operator_notes = notes
            assessment.operator_note = str(notes[0]["content"]) if notes else ""
            session.flush()
            result = _assessment_dict(assessment)
        return result

    def mark_registration_risk(
        self,
        *,
        account_id: int,
        bfs: int | str | None,
        registration_id: str,
        risk_score_cap: float = 100,
        risk_high_floor: float = 75,
    ) -> dict[str, Any]:
        with self.database.transaction() as session:
            assessment = session.get(AccountAssessment, account_id)
            if assessment is None:
                assessment = AccountAssessment(account_id=account_id)
                session.add(assessment)
            bfs_text = str(bfs or "").strip()
            reason = (
                f"grok-register 确认降智：bot_risk/bfs={bfs}"
                if bfs_text in {"1", "2"}
                else f"grok-register 报告 bot_risk/bfs={bfs}"
            )
            assessment.monitor_status = "high_risk"
            assessment.risk_score = min(
                risk_score_cap,
                max(
                    float(assessment.risk_score or 0),
                    risk_high_floor,
                    85.0,
                ),
            )
            assessment.risk_reasons = list(dict.fromkeys([*(assessment.risk_reasons or []), reason]))
            assessment.manual_note = f"registration:{registration_id}"
            assessment.updated_at = utc_now()
            session.flush()
            result = _assessment_dict(assessment)
        return result

    def due_quarantines(self) -> list[dict[str, Any]]:
        now = utc_now()
        with self.database.session() as session:
            values = session.scalars(
                select(AccountAssessment).where(
                    AccountAssessment.monitor_status == "quarantined",
                    AccountAssessment.disabled_by_monitor.is_(True),
                    AccountAssessment.quarantine_until.is_not(None),
                    AccountAssessment.quarantine_until <= now,
                )
            ).all()
            return [_assessment_dict(value) for value in values]

    def mark_restored(self, account_id: int, *, recovery_guarded: bool) -> None:
        with self.database.transaction() as session:
            assessment = session.get(AccountAssessment, account_id)
            if assessment is None:
                return
            assessment.monitor_status = "healthy"
            assessment.quarantine_until = None
            assessment.disabled_by_monitor = False
            assessment.previous_upstream_enabled = None
            assessment.recovery_guarded = recovery_guarded
            assessment.disposition = {}
            assessment.updated_at = utc_now()

    def delete_assessment(self, account_id: int) -> bool:
        return self.delete_assessments([account_id]) == 1

    def delete_assessments(self, account_ids: list[int]) -> int:
        unique_ids = list(
            dict.fromkeys(account_id for account_id in account_ids if account_id > 0)
        )
        if not unique_ids:
            return 0
        with self.database.transaction() as session:
            result = session.execute(
                delete(AccountAssessment).where(
                    AccountAssessment.account_id.in_(unique_ids)
                )
            )
            return int(result.rowcount or 0)

    def delete_alerts_for_account(self, account_id: int) -> int:
        with self.database.transaction() as session:
            result = session.execute(
                delete(Alert).where(Alert.account_id == account_id)
            )
            return int(result.rowcount or 0)

    def get_account_cooldown(
        self,
        account_id: int,
        *,
        kind: str = MISSING_THINKING_COOLDOWN_KIND,
    ) -> dict[str, Any] | None:
        with self.database.session() as session:
            value = session.scalar(
                select(AccountCooldown).where(
                    AccountCooldown.account_id == int(account_id),
                    AccountCooldown.kind == str(kind),
                )
            )
            return model_dict(value) if value is not None else None

    def upsert_missing_thinking_cooldown(
        self,
        *,
        account_id: int,
        cooled_at: datetime,
        cooldown_until: datetime | None,
        last_error: str = "",
        degrade_hits: int = 0,
        failure_count: int = 0,
        snapshot: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = utc_now()
        payload = {
            "account_id": int(account_id),
            "kind": MISSING_THINKING_COOLDOWN_KIND,
            "status": COOLING_STATUS,
            "cooled_at": cooled_at,
            "cooldown_until": cooldown_until,
            "expired_at": None,
            "released_manually": False,
            "last_error": str(last_error or "")[:120],
            "degrade_hits": max(0, int(degrade_hits)),
            "failure_count": max(0, int(failure_count)),
            "snapshot": snapshot or {},
            "updated_at": now,
        }
        with self.database.transaction() as session:
            existing = session.scalar(
                select(AccountCooldown).where(
                    AccountCooldown.account_id == int(account_id),
                    AccountCooldown.kind == MISSING_THINKING_COOLDOWN_KIND,
                )
            )
            if existing is not None and str(existing.status or "") == COOLING_STATUS:
                payload["cooled_at"] = existing.cooled_at or cooled_at
            payload["created_at"] = (
                existing.created_at if existing is not None else now
            )
            session.execute(
                sqlite_insert(AccountCooldown.__table__)
                .values(**payload)
                .on_conflict_do_update(
                    index_elements=["account_id", "kind"],
                    set_={
                        key: payload[key]
                        for key in payload
                        if key not in {"account_id", "kind", "created_at"}
                    },
                )
            )
            value = session.scalar(
                select(AccountCooldown).where(
                    AccountCooldown.account_id == int(account_id),
                    AccountCooldown.kind == MISSING_THINKING_COOLDOWN_KIND,
                )
            )
            if value is None:
                raise RuntimeError("降智冷却记录写入失败")
            return model_dict(value)

    def expire_missing_thinking_cooldowns(
        self,
        active_account_ids: set[int],
        *,
        now: datetime | None = None,
    ) -> int:
        current = now or utc_now()
        with self.database.transaction() as session:
            query = select(AccountCooldown).where(
                AccountCooldown.kind == MISSING_THINKING_COOLDOWN_KIND,
                AccountCooldown.status == COOLING_STATUS,
            )
            if active_account_ids:
                query = query.where(
                    AccountCooldown.account_id.notin_(sorted(active_account_ids))
                )
            rows = session.scalars(query).all()
            expired = 0
            for row in rows:
                row.status = EXPIRED_STATUS
                row.expired_at = current
                row.released_manually = False
                row.updated_at = current
                expired += 1
            return expired

    def expire_due_missing_thinking_cooldowns(
        self,
        *,
        now: datetime | None = None,
    ) -> int:
        current = now or utc_now()
        with self.database.transaction() as session:
            rows = session.scalars(
                select(AccountCooldown).where(
                    AccountCooldown.kind == MISSING_THINKING_COOLDOWN_KIND,
                    AccountCooldown.status == COOLING_STATUS,
                    AccountCooldown.cooldown_until.is_not(None),
                    AccountCooldown.cooldown_until <= current,
                )
            ).all()
            expired = 0
            for row in rows:
                row.status = EXPIRED_STATUS
                row.expired_at = current
                row.released_manually = False
                row.updated_at = current
                expired += 1
            return expired

    def mark_missing_thinking_cooldown_released(
        self,
        account_id: int,
        *,
        now: datetime | None = None,
    ) -> dict[str, Any] | None:
        current = now or utc_now()
        with self.database.transaction() as session:
            value = session.scalar(
                select(AccountCooldown).where(
                    AccountCooldown.account_id == int(account_id),
                    AccountCooldown.kind == MISSING_THINKING_COOLDOWN_KIND,
                )
            )
            if value is None:
                return None
            value.status = EXPIRED_STATUS
            value.expired_at = current
            value.released_manually = True
            value.updated_at = current
            session.flush()
            return model_dict(value)

    def list_missing_thinking_cooldowns(
        self,
        *,
        status: str = "",
        start: datetime | None = None,
        end: datetime | None = None,
    ) -> list[dict[str, Any]]:
        with self.database.session() as session:
            query = select(AccountCooldown).where(
                AccountCooldown.kind == MISSING_THINKING_COOLDOWN_KIND
            )
            requested = str(status or "").strip().lower()
            if requested in {COOLING_STATUS, EXPIRED_STATUS}:
                query = query.where(AccountCooldown.status == requested)
            if start is not None and end is not None:
                query = query.where(
                    func.coalesce(
                        AccountCooldown.expired_at,
                        AccountCooldown.cooled_at,
                    )
                    >= start,
                    func.coalesce(
                        AccountCooldown.expired_at,
                        AccountCooldown.cooled_at,
                    )
                    < end,
                )
            query = query.order_by(
                AccountCooldown.cooldown_until.asc(),
                AccountCooldown.updated_at.desc(),
                AccountCooldown.id.desc(),
            )
            return [model_dict(value) for value in session.scalars(query).all()]

    def create_alert(
        self,
        *,
        account_id: int,
        kind: str,
        severity: str,
        title: str,
        detail: dict[str, Any],
    ) -> str:
        alert_id = uuid.uuid4().hex
        with self.database.transaction() as session:
            session.add(
                Alert(
                    id=alert_id,
                    account_id=account_id,
                    kind=kind,
                    severity=severity,
                    title=title,
                    detail=detail,
                )
            )
        return alert_id

    def list_alerts(self, limit: int = 100) -> list[dict[str, Any]]:
        with self.database.session() as session:
            values = session.scalars(select(Alert).order_by(Alert.created_at.desc()).limit(limit)).all()
            return [model_dict(value) for value in values]

    def dashboard_metrics(self, hours: int) -> dict[str, Any]:
        now = utc_now()
        cutoff = now - timedelta(hours=hours)
        with self.database.session() as session:
            assessment_rows = session.execute(
                select(
                    func.count(AccountAssessment.account_id),
                    func.sum(
                        case(
                            (
                                AccountAssessment.monitor_status.in_(
                                    {"suspect", "high_risk", "quarantined"}
                                ),
                                1,
                            ),
                            else_=0,
                        )
                    ),
                    func.sum(
                        case(
                            (AccountAssessment.monitor_status == "quarantined", 1),
                            else_=0,
                        )
                    ),
                    func.avg(AccountAssessment.risk_score),
                )
            ).one()
            sample_rows = session.execute(
                select(
                    func.count(ProbeSample.id),
                    func.sum(
                        case(
                            (ProbeSample.classification.in_(ANOMALY_NAMES), 1),
                            else_=0,
                        )
                    ),
                    func.avg(ProbeSample.tps).filter(ProbeSample.tps > 0),
                    func.max(ProbeSample.tps),
                    func.avg(
                        case(
                            (ProbeSample.upstream_tps.is_not(None), ProbeSample.upstream_tps),
                            else_=ProbeSample.tps,
                        )
                    ),
                    func.max(
                        case(
                            (ProbeSample.upstream_tps.is_not(None), ProbeSample.upstream_tps),
                            else_=ProbeSample.tps,
                        )
                    ),
                ).where(ProbeSample.created_at >= cutoff)
            ).one()
            status_counts = dict(
                session.execute(
                    select(
                        AccountAssessment.monitor_status,
                        func.count(AccountAssessment.account_id),
                    ).group_by(AccountAssessment.monitor_status)
                ).all()
            )
            trend = [
                {
                    "day": row.day,
                    "samples": row.samples,
                    "avg_tps": round(row.avg_tps or 0, 1),
                    "max_tps": round(row.max_tps or 0, 1),
                    "avg_upstream_tps": round(row.avg_upstream_tps or 0, 1),
                    "max_upstream_tps": round(row.max_upstream_tps or 0, 1),
                    "hard": row.hard or 0,
                }
                for row in session.execute(
                    select(
                        func.date(ProbeSample.created_at).label("day"),
                        func.count(ProbeSample.id).label("samples"),
                        func.avg(ProbeSample.tps)
                        .filter(ProbeSample.tps > 0)
                        .label("avg_tps"),
                        func.max(ProbeSample.tps).label("max_tps"),
                        func.avg(
                            case(
                                (
                                    ProbeSample.upstream_tps.is_not(None),
                                    ProbeSample.upstream_tps,
                                ),
                                else_=ProbeSample.tps,
                            )
                        ).label("avg_upstream_tps"),
                        func.max(
                            case(
                                (
                                    ProbeSample.upstream_tps.is_not(None),
                                    ProbeSample.upstream_tps,
                                ),
                                else_=ProbeSample.tps,
                            )
                        ).label("max_upstream_tps"),
                        func.sum(
                            case(
                                (
                                    or_(
                                        ProbeSample.classification.in_(
                                            HARD_ANOMALY_NAMES
                                        ),
                                        and_(
                                            ProbeSample.classification
                                            == "reasoning_zero",
                                            ProbeSample.severity
                                            >= PROMOTED_REASONING_ZERO_SEVERITY,
                                        ),
                                    ),
                                    1,
                                ),
                                else_=0,
                            )
                        ).label("hard"),
                    )
                    .where(ProbeSample.created_at >= cutoff)
                    .group_by(func.date(ProbeSample.created_at))
                    .order_by(func.date(ProbeSample.created_at))
                )
            ]
            isolated_rows = session.scalars(
                select(AccountAssessment).where(
                    AccountAssessment.monitor_status == "quarantined",
                    AccountAssessment.quarantine_until.is_(None),
                )
            ).all()
            register_rows = session.execute(
                select(
                    RegisterWebhookEvent.event_id,
                    RegisterWebhookEvent.email,
                    RegisterWebhookEvent.grok2api_account_id,
                    RegisterWebhookEvent.resolved_account_id,
                    RegisterWebhookEvent.status,
                ).where(RegisterWebhookEvent.created_at >= cutoff)
            ).all()
            run_status_counts = {
                str(status): int(count)
                for status, count in session.execute(
                    select(ProbeRun.status, func.count(ProbeRun.id))
                    .where(ProbeRun.created_at >= cutoff)
                    .group_by(ProbeRun.status)
                ).all()
            }
            live_status_counts = {
                str(status): int(count)
                for status, count in session.execute(
                    select(ProbeRun.status, func.count(ProbeRun.id)).group_by(ProbeRun.status)
                ).all()
            }
            stale_cutoff = now - DASHBOARD_STALE_HEARTBEAT
            stale = int(
                session.scalar(
                    select(func.count(ProbeRun.id)).where(
                        ProbeRun.status.in_(DASHBOARD_EXECUTING_STATUSES),
                        or_(
                            ProbeRun.heartbeat_at.is_(None),
                            ProbeRun.heartbeat_at < stale_cutoff,
                        ),
                    )
                )
                or 0
            )
            oldest_queued_at = session.scalar(
                select(func.min(ProbeRun.queued_at)).where(ProbeRun.status == "queued")
            )
        oldest_wait = (
            max(0, int((now - ensure_utc(oldest_queued_at)).total_seconds()))
            if oldest_queued_at is not None
            else 0
        )
        queued = int(live_status_counts.get("queued") or 0)
        running = sum(
            int(live_status_counts.get(status) or 0) for status in DASHBOARD_EXECUTING_STATUSES
        )
        return {
            "window": {
                "hours": hours,
                "from": app_isoformat(cutoff),
                "to": app_isoformat(now),
            },
            "assessments": {
                "total": assessment_rows[0] or 0,
                "risky": assessment_rows[1] or 0,
                "quarantined": assessment_rows[2] or 0,
                "avgRisk": round(assessment_rows[3] or 0, 1),
            },
            "samples": {
                "total": sample_rows[0] or 0,
                "anomalies": sample_rows[1] or 0,
                "avgTps": round(sample_rows[2] or 0, 1),
                "maxTps": round(sample_rows[3] or 0, 1),
                "avgUpstreamTps": round(sample_rows[4] or 0, 1),
                "maxUpstreamTps": round(sample_rows[5] or 0, 1),
            },
            "registered": _dashboard_register_counts(register_rows),
            "isolated": _dashboard_isolated_counts(isolated_rows, cutoff),
            "probeRuns": _dashboard_probe_run_counts(run_status_counts),
            "workers": {
                "queued": queued,
                "running": running,
                "stale": stale,
                "oldestQueueWaitSeconds": oldest_wait,
            },
            "statusCounts": status_counts,
            "trend": trend,
        }
