from __future__ import annotations

import json

from sqlalchemy import Engine, inspect

COMPATIBILITY_COLUMNS = {
    "account_assessments": [
        (
            "recovery_guarded",
            "ALTER TABLE account_assessments ADD COLUMN recovery_guarded BOOLEAN "
            "NOT NULL DEFAULT 0",
        ),
        (
            "reasoning_zero_count",
            "ALTER TABLE account_assessments ADD COLUMN reasoning_zero_count INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "operator_note",
            "ALTER TABLE account_assessments ADD COLUMN operator_note TEXT NOT NULL DEFAULT ''",
        ),
        (
            "operator_notes",
            "ALTER TABLE account_assessments ADD COLUMN operator_notes JSON NOT NULL DEFAULT '[]'",
        ),
        (
            "disposition",
            "ALTER TABLE account_assessments ADD COLUMN disposition JSON NOT NULL DEFAULT '{}'",
        ),
        (
            "avg_upstream_tps",
            "ALTER TABLE account_assessments ADD COLUMN avg_upstream_tps FLOAT NOT NULL DEFAULT 0",
        ),
        (
            "max_upstream_tps",
            "ALTER TABLE account_assessments ADD COLUMN max_upstream_tps FLOAT NOT NULL DEFAULT 0",
        ),
        (
            "latest_upstream_tps",
            "ALTER TABLE account_assessments ADD COLUMN latest_upstream_tps FLOAT NOT NULL DEFAULT 0",
        ),
    ],
    "probe_profiles": [
        (
            "expected_output",
            "ALTER TABLE probe_profiles ADD COLUMN expected_output TEXT NOT NULL DEFAULT ''",
        )
    ],
    "probe_plans": [
        (
            "profile_ids",
            "ALTER TABLE probe_plans ADD COLUMN profile_ids JSON NOT NULL DEFAULT '[]'",
        ),
        (
            "execution_mode",
            "ALTER TABLE probe_plans ADD COLUMN execution_mode VARCHAR(24) NOT NULL DEFAULT 'chat'",
        ),
        (
            "account_scope",
            "ALTER TABLE probe_plans ADD COLUMN account_scope VARCHAR(24) "
            "NOT NULL DEFAULT 'fixed'",
        ),
    ],
    "probe_runs": [
        (
            "source_event_id",
            "ALTER TABLE probe_runs ADD COLUMN source_event_id VARCHAR(120)",
        ),
        (
            "execution_mode",
            "ALTER TABLE probe_runs ADD COLUMN execution_mode VARCHAR(24) NOT NULL DEFAULT 'chat'",
        ),
        (
            "original_account_enabled",
            "ALTER TABLE probe_runs ADD COLUMN original_account_enabled BOOLEAN",
        ),
        (
            "original_account_priority",
            "ALTER TABLE probe_runs ADD COLUMN original_account_priority INTEGER",
        ),
        (
            "original_account_max_concurrent",
            "ALTER TABLE probe_runs ADD COLUMN original_account_max_concurrent INTEGER",
        ),
        (
            "account_settings_snapshot_at",
            "ALTER TABLE probe_runs ADD COLUMN account_settings_snapshot_at DATETIME",
        ),
        (
            "diagnostic_priority",
            "ALTER TABLE probe_runs ADD COLUMN diagnostic_priority INTEGER",
        ),
        (
            "diagnostic_max_concurrent",
            "ALTER TABLE probe_runs ADD COLUMN diagnostic_max_concurrent INTEGER",
        ),
        (
            "diagnostic_activation_active",
            "ALTER TABLE probe_runs ADD COLUMN diagnostic_activation_active BOOLEAN "
            "NOT NULL DEFAULT 0",
        ),
        (
            "account_restore_status",
            "ALTER TABLE probe_runs ADD COLUMN account_restore_status VARCHAR(32) "
            "NOT NULL DEFAULT 'not_recorded'",
        ),
        (
            "account_restore_source",
            "ALTER TABLE probe_runs ADD COLUMN account_restore_source VARCHAR(32) "
            "NOT NULL DEFAULT ''",
        ),
        (
            "account_restore_attempts",
            "ALTER TABLE probe_runs ADD COLUMN account_restore_attempts INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "account_restore_error",
            "ALTER TABLE probe_runs ADD COLUMN account_restore_error TEXT NOT NULL DEFAULT ''",
        ),
        (
            "account_restore_attempted_at",
            "ALTER TABLE probe_runs ADD COLUMN account_restore_attempted_at DATETIME",
        ),
        (
            "account_restored_at",
            "ALTER TABLE probe_runs ADD COLUMN account_restored_at DATETIME",
        ),
        (
            "account_created_at",
            "ALTER TABLE probe_runs ADD COLUMN account_created_at DATETIME",
        ),
    ],
    "probe_samples": [
        (
            "risk_rule_id",
            "ALTER TABLE probe_samples ADD COLUMN risk_rule_id VARCHAR(100) NOT NULL DEFAULT ''",
        ),
        (
            "risk_rule_ids",
            "ALTER TABLE probe_samples ADD COLUMN risk_rule_ids JSON NOT NULL DEFAULT '[]'",
        ),
        (
            "risk_reasons",
            "ALTER TABLE probe_samples ADD COLUMN risk_reasons JSON NOT NULL DEFAULT '[]'",
        ),
        (
            "error_code",
            "ALTER TABLE probe_samples ADD COLUMN error_code VARCHAR(100) NOT NULL DEFAULT ''",
        ),
        (
            "retry_count",
            "ALTER TABLE probe_samples ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "retry_after_seconds",
            "ALTER TABLE probe_samples ADD COLUMN retry_after_seconds FLOAT NOT NULL DEFAULT 0",
        ),
        (
            "reasoning_tokens_reported",
            "ALTER TABLE probe_samples ADD COLUMN reasoning_tokens_reported "
            "BOOLEAN NOT NULL DEFAULT 0",
        ),
        (
            "upstream_tps",
            "ALTER TABLE probe_samples ADD COLUMN upstream_tps FLOAT",
        ),
        (
            "reasoning_text",
            "ALTER TABLE probe_samples ADD COLUMN reasoning_text TEXT NOT NULL DEFAULT ''",
        ),
    ],
    "sso_reports": [
        (
            "completed_count",
            "ALTER TABLE sso_reports ADD COLUMN completed_count INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "proxy_used",
            "ALTER TABLE sso_reports ADD COLUMN proxy_used BOOLEAN NOT NULL DEFAULT 0",
        ),
        (
            "concurrency",
            "ALTER TABLE sso_reports ADD COLUMN concurrency INTEGER NOT NULL DEFAULT 8",
        ),
        (
            "request_timeout_seconds",
            "ALTER TABLE sso_reports ADD COLUMN request_timeout_seconds INTEGER "
            "NOT NULL DEFAULT 20",
        ),
        (
            "error",
            "ALTER TABLE sso_reports ADD COLUMN error TEXT NOT NULL DEFAULT ''",
        ),
        (
            "started_at",
            "ALTER TABLE sso_reports ADD COLUMN started_at DATETIME",
        ),
        (
            "completed_at",
            "ALTER TABLE sso_reports ADD COLUMN completed_at DATETIME",
        ),
    ],
    "register_webhook_events": [
        (
            "sso",
            "ALTER TABLE register_webhook_events ADD COLUMN sso TEXT NOT NULL DEFAULT ''",
        ),
        (
            "sso_received_at",
            "ALTER TABLE register_webhook_events ADD COLUMN sso_received_at DATETIME",
        ),
        (
            "original_priority",
            "ALTER TABLE register_webhook_events ADD COLUMN original_priority INTEGER",
        ),
        (
            "held_priority",
            "ALTER TABLE register_webhook_events ADD COLUMN held_priority INTEGER",
        ),
        (
            "priority_hold_status",
            "ALTER TABLE register_webhook_events ADD COLUMN priority_hold_status "
            "VARCHAR(24) NOT NULL DEFAULT 'none'",
        ),
        (
            "priority_hold_error",
            "ALTER TABLE register_webhook_events ADD COLUMN priority_hold_error "
            "TEXT NOT NULL DEFAULT ''",
        ),
        (
            "priority_held_at",
            "ALTER TABLE register_webhook_events ADD COLUMN priority_held_at DATETIME",
        ),
        (
            "priority_restored_at",
            "ALTER TABLE register_webhook_events ADD COLUMN priority_restored_at DATETIME",
        ),
    ],
    "request_audit_scan_states": [
        (
            "initial_cursor",
            "ALTER TABLE request_audit_scan_states ADD COLUMN initial_cursor "
            "TEXT NOT NULL DEFAULT ''",
        ),
    ],
    "request_audit_records": [
        (
            "media_input_images",
            "ALTER TABLE request_audit_records ADD COLUMN media_input_images "
            "INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "reasoning_tokens_reported",
            "ALTER TABLE request_audit_records ADD COLUMN reasoning_tokens_reported "
            "BOOLEAN NOT NULL DEFAULT 0",
        ),
        (
            "client_key_id",
            "ALTER TABLE request_audit_records ADD COLUMN client_key_id "
            "VARCHAR(64) NOT NULL DEFAULT ''",
        ),
        (
            "client_key_name",
            "ALTER TABLE request_audit_records ADD COLUMN client_key_name "
            "VARCHAR(160) NOT NULL DEFAULT ''",
        ),
        (
            "error_code",
            "ALTER TABLE request_audit_records ADD COLUMN error_code "
            "VARCHAR(120) NOT NULL DEFAULT ''",
        ),
    ],
    "request_audit_account_verifications": [
        (
            "egress_recommendation",
            "ALTER TABLE request_audit_account_verifications ADD COLUMN "
            "egress_recommendation JSON NOT NULL DEFAULT '{}'",
        ),
        (
            "previous_priority",
            "ALTER TABLE request_audit_account_verifications ADD COLUMN previous_priority INTEGER",
        ),
        (
            "applied_priority",
            "ALTER TABLE request_audit_account_verifications ADD COLUMN applied_priority INTEGER",
        ),
    ],
}
COMPATIBILITY_INDEXES = {
    "account_assessments": [
        (
            "ix_account_assessments_recovery_guarded",
            "CREATE INDEX IF NOT EXISTS ix_account_assessments_recovery_guarded "
            "ON account_assessments (recovery_guarded)",
        )
    ],
    "probe_runs": [
        (
            "ix_probe_runs_source_event_id",
            "CREATE INDEX IF NOT EXISTS ix_probe_runs_source_event_id "
            "ON probe_runs (source_event_id)",
        ),
        (
            "ix_probe_run_status_created",
            "CREATE INDEX IF NOT EXISTS ix_probe_run_status_created "
            "ON probe_runs (status, created_at)",
        ),
        (
            "ix_probe_run_created_at",
            "CREATE INDEX IF NOT EXISTS ix_probe_run_created_at ON probe_runs (created_at)",
        ),
    ],
    "probe_samples": [
        (
            "ix_probe_samples_risk_rule_id",
            "CREATE INDEX IF NOT EXISTS ix_probe_samples_risk_rule_id "
            "ON probe_samples (risk_rule_id)",
        )
    ],
    "register_webhook_events": [
        (
            "ix_register_webhook_resolved_sso_received",
            "CREATE INDEX IF NOT EXISTS ix_register_webhook_resolved_sso_received "
            "ON register_webhook_events (resolved_account_id, sso_received_at)",
        ),
        (
            "ix_register_webhook_upstream_sso_received",
            "CREATE INDEX IF NOT EXISTS ix_register_webhook_upstream_sso_received "
            "ON register_webhook_events (grok2api_account_id, sso_received_at)",
        ),
        (
            "ix_register_webhook_priority_hold",
            "CREATE INDEX IF NOT EXISTS ix_register_webhook_priority_hold "
            "ON register_webhook_events (priority_hold_status)",
        ),
    ],
}


class DatabaseSchemaMigrator:
    """Applies compatibility DDL for databases created before Alembic."""

    def __init__(self, engine: Engine):
        self.engine = engine

    def migrate(self) -> None:
        inspector = inspect(self.engine)
        table_names = set(inspector.get_table_names())
        statements = self._missing_column_statements(inspector, table_names)
        statements.extend(self._missing_index_statements(inspector, table_names))
        if not statements and not {
            "probe_plans",
            "register_webhook_events",
            "sso_reports",
        } & table_names:
            return
        with self.engine.begin() as connection:
            for statement in statements:
                connection.exec_driver_sql(statement)
            self._backfill_probe_risk_rules(connection, table_names)
            self._backfill_media_input_counts(connection, table_names)
            self._backfill_reasoning_tokens_reported(connection, table_names)
            self._backfill_probe_reasoning_tokens_reported(connection, table_names)
            self._backfill_sso_reports(connection, table_names)
            self._backfill_plan_profiles(connection, table_names)
            self._backfill_register_sso_received_at(connection, table_names)
            self._backfill_request_audit_error_codes(connection, table_names)

    @staticmethod
    def _missing_column_statements(inspector, table_names: set[str]) -> list[str]:  # type: ignore[no-untyped-def]
        statements: list[str] = []
        for table, columns in COMPATIBILITY_COLUMNS.items():
            if table not in table_names:
                continue
            names = {value["name"] for value in inspector.get_columns(table)}
            statements.extend(statement for column, statement in columns if column not in names)
        return statements

    @staticmethod
    def _missing_index_statements(inspector, table_names: set[str]) -> list[str]:  # type: ignore[no-untyped-def]
        statements: list[str] = []
        for table, indexes in COMPATIBILITY_INDEXES.items():
            if table not in table_names:
                continue
            names = {value["name"] for value in inspector.get_indexes(table)}
            statements.extend(statement for name, statement in indexes if name not in names)
        return statements

    @staticmethod
    def _backfill_sso_reports(connection, table_names: set[str]) -> None:  # type: ignore[no-untyped-def]
        if "sso_reports" in table_names:
            connection.exec_driver_sql(
                "UPDATE sso_reports SET completed_count = total "
                "WHERE status = 'completed' AND completed_count = 0 AND total > 0"
            )

    @staticmethod
    def _backfill_probe_risk_rules(connection, table_names: set[str]) -> None:  # type: ignore[no-untyped-def]
        if "probe_samples" not in table_names:
            return
        connection.exec_driver_sql(
            "UPDATE probe_samples SET risk_rule_id = CASE classification "
            "WHEN 'elevated' THEN 'elevated_tps' "
            "WHEN 'buffered_soft' THEN 'buffered_soft' "
            "WHEN 'buffered_hard' THEN 'buffered_hard' "
            "WHEN 'fast_risk' THEN 'fast_risk' "
            "WHEN 'marker_miss' THEN 'marker_miss' "
            "WHEN 'reasoning_zero' THEN 'reasoning_zero' "
            "WHEN 'error' THEN 'http_error' "
            "ELSE risk_rule_id END "
            "WHERE risk_rule_id = ''"
        )

    @staticmethod
    def _backfill_request_audit_error_codes(  # type: ignore[no-untyped-def]
        connection, table_names: set[str]
    ) -> None:
        if "request_audit_records" not in table_names:
            return
        connection.exec_driver_sql(
            "UPDATE request_audit_records "
            "SET error_code = TRIM(CAST(json_extract(raw, '$.errorCode') AS TEXT)) "
            "WHERE error_code = '' "
            "AND json_valid(raw) "
            "AND COALESCE(TRIM(CAST(json_extract(raw, '$.errorCode') AS TEXT)), '') != ''"
        )

    @staticmethod
    def _backfill_media_input_counts(connection, table_names: set[str]) -> None:  # type: ignore[no-untyped-def]
        if "request_audit_records" not in table_names:
            return
        # Older local projections kept the complete upstream JSON in ``raw``
        # but did not project media counts. SQLite's JSON1 extension is present
        # in the supported runtime; the CASE also tolerates malformed legacy
        # payloads by leaving the existing value untouched.
        connection.exec_driver_sql(
            "UPDATE request_audit_records "
            "SET media_input_images = MAX(0, CAST(json_extract(raw, '$.mediaInputImages') AS INTEGER)) "
            "WHERE media_input_images = 0 "
            "AND json_valid(raw) "
            "AND COALESCE(json_extract(raw, '$.mediaInputImages'), 0) > 0"
        )

    @staticmethod
    def _backfill_reasoning_tokens_reported(  # type: ignore[no-untyped-def]
        connection, table_names: set[str]
    ) -> None:
        if "request_audit_records" not in table_names:
            return
        connection.exec_driver_sql(
            "UPDATE request_audit_records SET reasoning_tokens_reported = 1 "
            "WHERE reasoning_tokens_reported = 0 AND json_valid(raw) "
            "AND json_type(raw, '$.reasoningTokens') IS NOT NULL"
        )

    @staticmethod
    def _backfill_probe_reasoning_tokens_reported(  # type: ignore[no-untyped-def]
        connection, table_names: set[str]
    ) -> None:
        if "probe_samples" not in table_names:
            return
        # Probe responses persist normalized usage JSON. Older rows had the
        # numeric value but no presence bit, so recover the distinction before
        # model-capability rules start evaluating historical evidence.
        connection.exec_driver_sql(
            "UPDATE probe_samples SET reasoning_tokens_reported = 1 "
            "WHERE reasoning_tokens_reported = 0 AND ("
            "reasoning_tokens > 0 "
            "OR (json_valid(usage) AND ("
            "json_type(usage, '$.completion_tokens_details.reasoning_tokens') IS NOT NULL "
            "OR json_type(usage, '$.completionTokensDetails.reasoningTokens') IS NOT NULL"
            "))"
            ")"
        )

    @staticmethod
    def _backfill_plan_profiles(connection, table_names: set[str]) -> None:  # type: ignore[no-untyped-def]
        if "probe_plans" not in table_names:
            return
        rows = connection.exec_driver_sql(
            "SELECT id, profile_id, profile_ids FROM probe_plans"
        ).all()
        for plan_id, profile_id, profile_ids in rows:
            if profile_ids not in (None, "", "[]", "null"):
                continue
            connection.exec_driver_sql(
                "UPDATE probe_plans SET profile_ids = ? WHERE id = ?",
                (json.dumps([profile_id]), plan_id),
            )

    @staticmethod
    def _backfill_register_sso_received_at(  # type: ignore[no-untyped-def]
        connection, table_names: set[str]
    ) -> None:
        if "register_webhook_events" in table_names:
            connection.exec_driver_sql(
                "UPDATE register_webhook_events SET sso_received_at = updated_at "
                "WHERE sso != '' AND sso_received_at IS NULL"
            )
