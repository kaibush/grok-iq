from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from unittest.mock import MagicMock

from app.core.clock import to_app_timezone, utc_now
from app.persistence.database import Database
from app.persistence.page_visit_repository import PageVisitRepository
from app.services.auth_service import AuthenticationError
from app.services.page_visit_service import PageVisitService

DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0"
MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148"
BOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
VISITOR_A = "a" * 32
VISITOR_B = "b" * 32
VISITOR_C = "c" * 32


def _build(
    tmp_path: Path, auth_service: MagicMock | None = None
) -> tuple[PageVisitRepository, PageVisitService]:
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = PageVisitRepository(database)
    return repository, PageVisitService(repository, auth_service=auth_service)


def _record(service: PageVisitService, **values):
    payload = {
        "path": "/status",
        "referrer": "",
        "user_agent": DESKTOP_UA,
        "client_ip": "203.0.113.10",
        "authorization": "",
        "visitor_cookie": VISITOR_A,
        "request_host": "status.example.com",
    }
    payload.update(values)
    return service.record_visit(**payload)


def test_same_visitor_two_visits_count_as_one_uv(tmp_path: Path, monkeypatch):
    repository, service = _build(tmp_path)
    current = utc_now()
    clock = {"value": current}

    def fake_now():
        return clock["value"]

    monkeypatch.setattr("app.services.page_visit_service.utc_now", fake_now)
    assert _record(service)["recorded"] is True
    clock["value"] = current + timedelta(seconds=10)
    assert _record(service)["recorded"] is True

    payload = service.overview("24h")
    assert payload["totals"]["pv"] == 2
    assert payload["totals"]["uv"] == 1
    assert "visitor_id" not in payload
    assert "paths" not in payload
    assert "audience" not in payload
    assert payload["comparison"]["previousPv"] == 0
    assert payload["comparison"]["pvDelta"] == 2


def test_two_visitors_count_as_two_uv(tmp_path: Path):
    _repository, service = _build(tmp_path)
    assert _record(service, visitor_cookie=VISITOR_A)["recorded"] is True
    assert _record(service, visitor_cookie=VISITOR_B)["recorded"] is True

    payload = service.overview("24h")
    assert payload["totals"]["pv"] == 2
    assert payload["totals"]["uv"] == 2


def test_debounce_within_five_seconds_does_not_increase_pv(tmp_path: Path):
    _repository, service = _build(tmp_path)
    assert _record(service)["recorded"] is True
    assert _record(service)["recorded"] is False

    payload = service.overview("24h")
    assert payload["totals"]["pv"] == 1
    assert payload["totals"]["uv"] == 1


def test_bots_are_not_stored(tmp_path: Path):
    repository, service = _build(tmp_path)
    result = _record(service, user_agent=BOT_UA)
    assert result["recorded"] is False
    assert repository.list_between(utc_now() - timedelta(hours=1), utc_now() + timedelta(hours=1)) == []
    assert service.overview("24h")["totals"]["pv"] == 0


def test_24h_series_has_hourly_buckets(tmp_path: Path):
    _repository, service = _build(tmp_path)
    assert _record(service)["recorded"] is True

    payload = service.overview("24h")
    assert len(payload["series"]) >= 24
    assert all(
        {"start", "end", "label", "pv", "uv"} <= set(item)
        for item in payload["series"]
    )
    assert all(item["label"].endswith(":00") for item in payload["series"])
    assert sum(item["pv"] for item in payload["series"]) == 1
    assert payload["devices"][0]["id"] == "desktop"
    assert payload["devices"][0]["label"] == "桌面"
    assert payload["peak"] is not None
    assert payload["peak"]["pv"] == 1


def test_details_empty_referrer_is_labeled_direct(tmp_path: Path):
    _repository, service = _build(tmp_path)
    assert _record(service, referrer="")["recorded"] is True

    payload = service.details("24h")
    assert payload["referrers"]
    assert payload["referrers"][0]["host"] == ""
    assert payload["referrers"][0]["label"] == "直接访问"
    assert payload["recent"][0]["path"] == "/status"
    assert payload["recent"][0]["referrerHost"] == ""
    assert payload["recent"][0]["isAdmin"] is False
    assert "visitor_id" not in payload["recent"][0]
    assert payload["audience"]["public"]["pv"] == 1
    assert payload["audience"]["admin"]["pv"] == 0


def test_path_is_normalized_and_query_string_stripped(tmp_path: Path):
    _repository, service = _build(tmp_path)
    assert _record(service, path="/status?utm=1#hero")["recorded"] is True
    assert _record(service, path="https://evil.example/status", visitor_cookie=VISITOR_B)[
        "recorded"
    ] is True

    payload = service.details("24h")
    paths = {item["path"]: item["pv"] for item in payload["paths"]}
    assert paths == {"/status": 2}


def test_same_host_referrer_is_treated_as_direct(tmp_path: Path):
    _repository, service = _build(tmp_path)
    assert _record(
        service,
        referrer="https://status.example.com/home",
        request_host="status.example.com",
    )["recorded"] is True

    payload = service.details("24h")
    assert payload["referrers"][0]["host"] == ""
    assert payload["referrers"][0]["label"] == "直接访问"


def test_admin_visits_are_excluded_from_public_overview(tmp_path: Path):
    auth = MagicMock()
    auth.authenticate_authorization.return_value = {"sub": "admin"}
    _repository, service = _build(tmp_path, auth_service=auth)
    assert _record(service, authorization="Bearer admin-token")["recorded"] is True
    assert _record(
        service,
        authorization="",
        visitor_cookie=VISITOR_B,
        user_agent=MOBILE_UA,
    )["recorded"] is True

    overview = service.overview("24h")
    assert overview["totals"]["pv"] == 1
    assert overview["totals"]["uv"] == 1
    assert overview["devices"][0]["id"] == "mobile"
    assert sum(item["pv"] for item in overview["series"]) == 1

    details = service.details("24h")
    assert details["audience"]["public"]["pv"] == 1
    assert details["audience"]["admin"]["pv"] == 1
    assert details["totals"]["pv"] == 1
    admin_hits = [row for row in details["recent"] if row["isAdmin"]]
    public_hits = [row for row in details["recent"] if not row["isAdmin"]]
    assert len(admin_hits) == 1
    assert len(public_hits) == 1


def test_invalid_admin_token_counts_as_public(tmp_path: Path):
    auth = MagicMock()
    auth.authenticate_authorization.side_effect = AuthenticationError("请先登录")
    _repository, service = _build(tmp_path, auth_service=auth)
    assert _record(service, authorization="Bearer expired")["recorded"] is True
    assert service.overview("24h")["totals"]["pv"] == 1
    assert service.details("24h")["recent"][0]["isAdmin"] is False


def test_comparison_uses_the_previous_window(tmp_path: Path, monkeypatch):
    _repository, service = _build(tmp_path)
    current = utc_now()
    clock = {"value": current - timedelta(hours=25)}

    def fake_now():
        return clock["value"]

    monkeypatch.setattr("app.services.page_visit_service.utc_now", fake_now)
    assert _record(service, visitor_cookie=VISITOR_A)["recorded"] is True
    clock["value"] = current
    assert _record(service, visitor_cookie=VISITOR_B)["recorded"] is True

    payload = service.overview("24h")
    assert payload["totals"]["pv"] == 1
    assert payload["comparison"]["previousPv"] == 1
    assert payload["comparison"]["pvDelta"] == 0
    assert payload["comparison"]["previousUv"] == 1
    assert payload["comparison"]["uvDelta"] == 0


def test_yesterday_uv_uses_previous_local_day(tmp_path: Path, monkeypatch):
    _repository, service = _build(tmp_path)
    current = utc_now()
    local_now = to_app_timezone(current)
    assert local_now is not None
    yesterday = local_now.replace(hour=15, minute=0, second=0, microsecond=0) - timedelta(days=1)
    clock = {"value": yesterday.astimezone(current.tzinfo)}

    def fake_now():
        return clock["value"]

    monkeypatch.setattr("app.services.page_visit_service.utc_now", fake_now)
    assert _record(service, visitor_cookie=VISITOR_A)["recorded"] is True
    clock["value"] = current
    assert _record(service, visitor_cookie=VISITOR_C)["recorded"] is True

    payload = service.overview("24h")
    assert payload["totals"]["todayUv"] >= 1
    assert payload["totals"]["yesterdayUv"] == 1


def test_invalid_period_falls_back_to_24h(tmp_path: Path):
    _repository, service = _build(tmp_path)
    assert _record(service)["recorded"] is True
    payload = service.overview("nope")
    assert payload["period"] == "24h"
    assert len(payload["series"]) >= 24
