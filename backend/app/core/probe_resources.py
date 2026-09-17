from __future__ import annotations

PROBE_NAME_MARKER = "-"


def probe_resource_marker(prefix: str) -> str:
    value = str(prefix or "").strip()
    return f"{value}{PROBE_NAME_MARKER}" if value else ""


def is_probe_resource(name: str | None, prefix: str) -> bool:
    marker = probe_resource_marker(prefix)
    return bool(marker) and str(name or "").startswith(marker)
