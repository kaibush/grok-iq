from __future__ import annotations

from typing import Any

_BILLING_KINDS = {
    "uncached_input",
    "cached_input",
    "output",
    "input_image",
    "output_image",
    "output_second",
}
_BILLING_UNITS = {"token", "image", "second"}
_BILLING_SOURCES = {"upstream", "official"}
_BILLING_METHODS = {"upstream_reported", "official_rates", "stored_estimate"}
_BILLING_TIERS = {"standard", "long_context", "media"}
_USAGE_SOURCES = {"upstream", "estimated", "none"}
_ATTEMPT_SOURCES = {"upstream_http", "gateway_transport", "credential"}
_ATTEMPT_ENCODINGS = {"utf8", "base64"}

_GATEWAY_INT_KEYS = (
    "cachedInputTokens",
    "mediaOutputImages",
    "mediaOutputSeconds",
    "costInUsdTicks",
    "estimatedCostInUsdTicks",
    "numSourcesUsed",
    "numServerSideToolsUsed",
    "contextInputTokens",
    "contextOutputTokens",
    "attemptCount",
)


def _int_or_zero(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0


def _bounded_text(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def normalize_billing(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or not value:
        return {}
    source = str(value.get("source") or "").strip()
    method = str(value.get("method") or "").strip()
    if source not in _BILLING_SOURCES or method not in _BILLING_METHODS:
        return {}
    components: list[dict[str, Any]] = []
    raw_components = value.get("components")
    if isinstance(raw_components, list):
        for item in raw_components[:12]:
            if not isinstance(item, dict):
                continue
            kind = str(item.get("kind") or "").strip()
            unit = str(item.get("unit") or "").strip()
            if kind not in _BILLING_KINDS or unit not in _BILLING_UNITS:
                continue
            components.append(
                {
                    "kind": kind,
                    "unit": unit,
                    "quantity": _int_or_zero(item.get("quantity")),
                    "unitPriceInUsdTicks": _int_or_zero(item.get("unitPriceInUsdTicks")),
                    "subtotalInUsdTicks": _int_or_zero(item.get("subtotalInUsdTicks")),
                }
            )
    result: dict[str, Any] = {
        "source": source,
        "method": method,
        "components": components,
        "totalInUsdTicks": _int_or_zero(value.get("totalInUsdTicks")),
    }
    model = _bounded_text(value.get("model"), 120)
    if model:
        result["model"] = model
    version = _bounded_text(value.get("version"), 64)
    if version:
        result["version"] = version
    tier = str(value.get("tier") or "").strip()
    if tier in _BILLING_TIERS:
        result["tier"] = tier
    return result


def normalize_request_headers(value: Any) -> dict[str, list[str]]:
    if not isinstance(value, dict) or not value:
        return {}
    result: dict[str, list[str]] = {}
    for key, raw in value.items():
        name = _bounded_text(key, 80)
        if not name:
            continue
        if isinstance(raw, list):
            values = [_bounded_text(item, 2000) for item in raw[:20]]
        elif raw is None:
            values = []
        else:
            values = [_bounded_text(raw, 2000)]
        values = [item for item in values if item]
        if values:
            result[name] = values
        if len(result) >= 40:
            break
    return result


def normalize_gateway_snapshot(item: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(item, dict) or not item:
        return {}
    result: dict[str, Any] = {}
    client_ip = _bounded_text(item.get("clientIp"), 64)
    if client_ip:
        result["clientIp"] = client_ip
    model_route_id = _bounded_text(item.get("modelRouteId"), 64)
    if model_route_id and model_route_id != "0":
        result["modelRouteId"] = model_route_id
    usage_source = str(item.get("usageSource") or "").strip()
    if usage_source in _USAGE_SOURCES:
        result["usageSource"] = usage_source
    for key in _GATEWAY_INT_KEYS:
        if key not in item:
            continue
        result[key] = max(0, _int_or_zero(item.get(key)))
    pricing_model = _bounded_text(item.get("pricingModel"), 120)
    if pricing_model:
        result["pricingModel"] = pricing_model
    pricing_version = _bounded_text(item.get("pricingVersion"), 64)
    if pricing_version:
        result["pricingVersion"] = pricing_version
    request_method = _bounded_text(item.get("requestMethod"), 16).upper()
    if request_method:
        result["requestMethod"] = request_method
    request_path = _bounded_text(item.get("requestPath"), 512)
    if request_path:
        result["requestPath"] = request_path
    billing = normalize_billing(item.get("billing"))
    if billing:
        result["billing"] = billing
    return result if gateway_snapshot_has_content(result) else {}


def gateway_snapshot_has_content(value: dict[str, Any] | None) -> bool:
    if not isinstance(value, dict) or not value:
        return False
    return bool(
        value.get("clientIp")
        or value.get("modelRouteId")
        or value.get("usageSource")
        or value.get("requestMethod")
        or value.get("requestPath")
        or value.get("pricingModel")
        or value.get("pricingVersion")
        or value.get("billing")
        or any(_int_or_zero(value.get(key)) for key in _GATEWAY_INT_KEYS)
    )


def apply_gateway_to_payload(
    payload: dict[str, Any],
    gateway: dict[str, Any] | None,
    *,
    overwrite: bool = False,
) -> dict[str, Any]:
    data = gateway if isinstance(gateway, dict) else {}
    assignments: dict[str, Any] = {
        "clientIp": str(data.get("clientIp") or ""),
        "modelRouteId": str(data.get("modelRouteId") or ""),
        "usageSource": str(data.get("usageSource") or ""),
        "cachedInputTokens": max(0, _int_or_zero(data.get("cachedInputTokens"))),
        "mediaOutputImages": max(0, _int_or_zero(data.get("mediaOutputImages"))),
        "mediaOutputSeconds": max(0, _int_or_zero(data.get("mediaOutputSeconds"))),
        "costInUsdTicks": max(0, _int_or_zero(data.get("costInUsdTicks"))),
        "estimatedCostInUsdTicks": max(
            0, _int_or_zero(data.get("estimatedCostInUsdTicks"))
        ),
        "pricingModel": str(data.get("pricingModel") or ""),
        "pricingVersion": str(data.get("pricingVersion") or ""),
        "numSourcesUsed": max(0, _int_or_zero(data.get("numSourcesUsed"))),
        "numServerSideToolsUsed": max(
            0, _int_or_zero(data.get("numServerSideToolsUsed"))
        ),
        "contextInputTokens": max(0, _int_or_zero(data.get("contextInputTokens"))),
        "contextOutputTokens": max(0, _int_or_zero(data.get("contextOutputTokens"))),
        "requestMethod": str(data.get("requestMethod") or ""),
        "requestPath": str(data.get("requestPath") or ""),
        "attemptCount": max(0, _int_or_zero(data.get("attemptCount"))),
    }
    billing = data.get("billing")
    if isinstance(billing, dict) and billing:
        assignments["billing"] = billing
    for key, value in assignments.items():
        if overwrite or key not in payload or payload.get(key) in (None, "", 0, [], {}):
            payload[key] = value
        elif key in {
            "cachedInputTokens",
            "mediaOutputImages",
            "mediaOutputSeconds",
            "costInUsdTicks",
            "estimatedCostInUsdTicks",
            "numSourcesUsed",
            "numServerSideToolsUsed",
            "contextInputTokens",
            "contextOutputTokens",
            "attemptCount",
        } and not payload.get(key):
            payload[key] = value
    if overwrite and isinstance(billing, dict) and billing:
        payload["billing"] = billing
    elif "billing" not in payload and isinstance(billing, dict) and billing:
        payload["billing"] = billing
    payload.setdefault("clientIp", "")
    payload.setdefault("modelRouteId", "")
    payload.setdefault("usageSource", "")
    payload.setdefault("cachedInputTokens", 0)
    payload.setdefault("mediaOutputImages", 0)
    payload.setdefault("mediaOutputSeconds", 0)
    payload.setdefault("costInUsdTicks", 0)
    payload.setdefault("estimatedCostInUsdTicks", 0)
    payload.setdefault("pricingModel", "")
    payload.setdefault("pricingVersion", "")
    payload.setdefault("numSourcesUsed", 0)
    payload.setdefault("numServerSideToolsUsed", 0)
    payload.setdefault("contextInputTokens", 0)
    payload.setdefault("contextOutputTokens", 0)
    payload.setdefault("requestMethod", "")
    payload.setdefault("requestPath", "")
    payload.setdefault("attemptCount", 0)
    return payload


def normalize_attempt(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or not value:
        return None
    source = str(value.get("source") or "").strip()
    encoding = str(value.get("responseBodyEncoding") or "utf8").strip() or "utf8"
    headers = normalize_request_headers(value.get("responseHeaders"))
    error_chain: list[dict[str, str]] = []
    raw_chain = value.get("errorChain")
    if isinstance(raw_chain, list):
        for frame in raw_chain[:12]:
            if not isinstance(frame, dict):
                continue
            error_type = _bounded_text(frame.get("type"), 80)
            message = _bounded_text(frame.get("message"), 2000)
            if error_type or message:
                error_chain.append({"type": error_type, "message": message})
    result: dict[str, Any] = {
        "id": str(value.get("id") or ""),
        "number": max(0, _int_or_zero(value.get("number"))),
        "source": source if source in _ATTEMPT_SOURCES else source[:40],
        "stage": _bounded_text(value.get("stage"), 80),
        "accountName": _bounded_text(value.get("accountName"), 255),
        "method": _bounded_text(value.get("method"), 16).upper(),
        "requestPath": _bounded_text(value.get("requestPath"), 512),
        "upstreamUrl": _bounded_text(value.get("upstreamUrl"), 1000),
        "startedAt": str(value.get("startedAt") or ""),
        "durationMs": max(0, _int_or_zero(value.get("durationMs"))),
        "upstreamStatus": _bounded_text(value.get("upstreamStatus"), 80),
        "responseHeaders": headers,
        "responseBody": str(value.get("responseBody") or "")[:20000],
        "responseBodyEncoding": encoding
        if encoding in _ATTEMPT_ENCODINGS
        else "utf8",
        "responseBodyTruncated": bool(value.get("responseBodyTruncated")),
        "transportError": _bounded_text(value.get("transportError"), 2000),
        "errorChain": error_chain,
    }
    account_id = _int_or_zero(value.get("accountId"))
    if account_id > 0:
        result["accountId"] = account_id
    status_code = value.get("upstreamStatusCode")
    if status_code is not None:
        result["upstreamStatusCode"] = _int_or_zero(status_code)
    return result


def normalize_attempts(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    result: list[dict[str, Any]] = []
    for item in value[:20]:
        attempt = normalize_attempt(item)
        if attempt:
            result.append(attempt)
    result.sort(key=lambda item: item.get("number") or 0)
    return result
