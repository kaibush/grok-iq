from __future__ import annotations

import csv
import io
import json
from typing import Any

from fastapi.responses import Response

from app.core.clock import app_isoformat, app_now
from app.core.disposition import public_disposition
from app.persistence.account_repository import AccountRepository
from app.persistence.models import ProbeSample
from app.persistence.probe_repository import ProbeRepository
from app.services.account_service import AccountService
from app.services.request_audit_service import RequestAuditService

MAX_EXPORT_ROWS = 5000
EXPORT_FORMATS = {"csv", "json"}

ACCOUNT_COLUMNS = [
    ("account_id", "账号 ID"),
    ("email", "邮箱"),
    ("name", "名称"),
    ("monitor_status", "监控判定"),
    ("risk_score", "风险分"),
    ("enabled", "上游启用"),
    ("isolated_at", "隔离/更新时间"),
    ("disposition_source", "来源"),
    ("reason", "原因"),
]
AUDIT_COLUMNS = [
    ("request_id", "请求 ID"),
    ("account_id", "账号 ID"),
    ("account_name", "账号名称"),
    ("risk_level", "风险"),
    ("tps", "TPS"),
    ("status_code", "HTTP"),
    ("duration_ms", "耗时 ms"),
    ("client_key_name", "客户端 Key"),
    ("created_at", "时间"),
]
SAMPLE_COLUMNS = [
    ("sample_id", "样本 ID"),
    ("run_id", "任务 ID"),
    ("account_id", "账号 ID"),
    ("classification", "分类"),
    ("tps", "TPS"),
    ("upstream_tps", "上游 TPS"),
    ("first_token_ms", "首字 ms"),
    ("duration_ms", "耗时 ms"),
    ("reasoning_tokens", "推理 Token"),
    ("created_at", "时间"),
]


class ExportService:
    def __init__(
        self,
        *,
        accounts: AccountRepository,
        probes: ProbeRepository,
        account_service: AccountService | None = None,
        request_audits: RequestAuditService | None = None,
    ) -> None:
        self.accounts = accounts
        self.probes = probes
        self.account_service = account_service
        self.request_audits = request_audits

    async def render(
        self,
        kind: str,
        fmt: str,
        **filters: Any,
    ) -> Response:
        normalized = _normalize_format(fmt)
        if kind == "quarantine":
            rows = await self.quarantine_rows()
            columns = ACCOUNT_COLUMNS
        elif kind == "high-risk":
            rows = await self.high_risk_rows()
            columns = ACCOUNT_COLUMNS
        elif kind == "request-audits":
            rows = await self.request_audit_rows(**filters)
            columns = AUDIT_COLUMNS
        elif kind == "probe-samples":
            rows = self.probe_sample_rows(
                account_id=_optional_int(filters.get("account_id"))
            )
            columns = SAMPLE_COLUMNS
        else:
            raise ValueError("导出类型无效")
        filename = _export_filename(kind, normalized)
        if normalized == "csv":
            payload = _csv_bytes(columns, rows)
            media_type = "text/csv; charset=utf-8"
        else:
            payload = json.dumps(
                {"filename": filename, "items": rows},
                ensure_ascii=False,
                default=str,
            ).encode("utf-8")
            media_type = "application/json"
        return Response(
            content=payload,
            media_type=media_type,
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"'
            },
        )

    async def quarantine_rows(self) -> list[dict[str, Any]]:
        if self.account_service is not None:
            items = await _collect_pages(
                lambda page: self.account_service.list_isolation_zone(
                    page=page,
                    page_size=200,
                )
            )
            return [_account_row(item) for item in items]
        return [
            _account_row(item)
            for item in self.accounts.list_isolation_zone()[:MAX_EXPORT_ROWS]
        ]

    async def high_risk_rows(self) -> list[dict[str, Any]]:
        assessments = self.accounts.list_by_monitor_status(
            "high_risk",
            limit=MAX_EXPORT_ROWS,
        )
        labels = await self._upstream_labels(
            [int(item["account_id"]) for item in assessments]
        )
        rows: list[dict[str, Any]] = []
        for assessment in assessments:
            account_id = int(assessment["account_id"])
            item = dict(labels.get(account_id) or {})
            item["assessment"] = assessment
            item.setdefault("id", account_id)
            rows.append(_account_row(item))
        return rows

    async def _upstream_labels(
        self,
        account_ids: list[int],
    ) -> dict[int, dict[str, Any]]:
        if self.account_service is None or not account_ids:
            return {}
        try:
            upstream = await self.account_service.client.get_accounts_by_ids(
                set(account_ids)
            )
        except Exception:
            return {}
        return {int(item.get("id") or 0): item for item in upstream if item.get("id")}

    async def request_audit_rows(self, **filters: Any) -> list[dict[str, Any]]:
        if self.request_audits is None:
            raise ValueError("请求审计未启用")
        items = await _collect_pages(
            lambda page: self.request_audits.list_page(
                page=page,
                page_size=200,
                account=str(filters.get("account") or ""),
                account_id=filters.get("account_id"),
                risk=str(filters.get("risk") or ""),
                client_key=str(filters.get("client_key") or ""),
                egress_node_id=filters.get("egress_node_id"),
                window_preset=str(filters.get("window_preset") or "today"),
                start_at=filters.get("start_at"),
                end_at=filters.get("end_at"),
            )
        )
        return [_audit_row(item) for item in items]

    def probe_sample_rows(self, account_id: int | None = None) -> list[dict[str, Any]]:
        return [
            _sample_row(sample)
            for sample in self.probes.list_samples_for_export(
                account_id=account_id,
                limit=MAX_EXPORT_ROWS,
            )
        ]


def _normalize_format(fmt: str) -> str:
    value = str(fmt or "csv").strip().lower()
    if value not in EXPORT_FORMATS:
        raise ValueError("导出格式仅支持 csv 或 json")
    return value


def _export_filename(kind: str, fmt: str) -> str:
    stamp = app_now().strftime("%Y%m%d-%H%M")
    return f"grokiq-{kind}-{stamp}.{fmt}"


def _csv_bytes(
    columns: list[tuple[str, str]],
    rows: list[dict[str, Any]],
) -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow([label for _, label in columns])
    for row in rows:
        writer.writerow([_csv_cell(row.get(key)) for key, _ in columns])
    return buffer.getvalue().encode("utf-8-sig")


def _csv_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "是" if value else "否"
    return str(value)


def _account_row(item: dict[str, Any]) -> dict[str, Any]:
    assessment = item.get("assessment") if isinstance(item.get("assessment"), dict) else item
    account_id = (
        item.get("id")
        or item.get("accountId")
        or (assessment or {}).get("account_id")
        or 0
    )
    disposition = public_disposition(
        (assessment or {}).get("disposition") or item.get("disposition")
    ) or {}
    return {
        "account_id": int(account_id or 0),
        "email": str(item.get("email") or ""),
        "name": str(item.get("name") or ""),
        "monitor_status": str((assessment or {}).get("monitor_status") or ""),
        "risk_score": (assessment or {}).get("risk_score"),
        "enabled": item.get("enabled"),
        "isolated_at": disposition.get("at")
        or _as_text((assessment or {}).get("updated_at")),
        "disposition_source": str(
            disposition.get("sourceLabel") or disposition.get("source") or ""
        ),
        "reason": str(
            disposition.get("reason")
            or (assessment or {}).get("manual_note")
            or ""
        ),
    }


def _audit_row(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "request_id": str(item.get("requestId") or item.get("request_id") or ""),
        "account_id": item.get("accountId") or item.get("account_id"),
        "account_name": str(item.get("accountName") or item.get("account_name") or ""),
        "risk_level": str(item.get("riskLevel") or item.get("risk_level") or ""),
        "tps": item.get("tps"),
        "status_code": item.get("statusCode") or item.get("status_code"),
        "error_code": str(item.get("errorCode") or item.get("error_code") or ""),
        "duration_ms": item.get("durationMs") or item.get("duration_ms"),
        "client_key_name": str(
            item.get("clientKeyName") or item.get("client_key_name") or ""
        ),
        "created_at": str(item.get("createdAt") or item.get("created_at") or ""),
    }


def _sample_row(sample: ProbeSample) -> dict[str, Any]:
    return {
        "sample_id": sample.id,
        "run_id": sample.run_id,
        "account_id": sample.account_id,
        "classification": sample.classification,
        "tps": sample.tps,
        "upstream_tps": sample.upstream_tps,
        "first_token_ms": sample.first_token_ms,
        "duration_ms": sample.duration_ms,
        "reasoning_tokens": sample.reasoning_tokens,
        "created_at": app_isoformat(sample.created_at),
    }


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        return app_isoformat(value) or ""
    return str(value)


def _optional_int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


async def _collect_pages(fetcher: Any) -> list[dict[str, Any]]:
    page = 1
    rows: list[dict[str, Any]] = []
    while len(rows) < MAX_EXPORT_ROWS:
        result = await fetcher(page)
        items = list(result.get("items") or [])
        rows.extend(items)
        total = int(result.get("total") or 0)
        if not items or len(rows) >= total or len(items) < 200:
            break
        page += 1
    return rows[:MAX_EXPORT_ROWS]
