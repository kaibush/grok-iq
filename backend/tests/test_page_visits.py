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
        "linuxdo_cookie": "",
        "status_cookie": "",
        "request_host": "status.example.com",
    }
    payload.update(values)
    return service.record_visit(**payload)


class FakeLinuxdoOauth:
    def user_from_cookie(self, cookie: str):
        if cookie != "ok":
            return None
        return {
            "id": 1,
            "linuxdo_id": "42",
            "username": "alice",
            "name": "Alice",
            "avatar_url": "https://cdn.example/alice.png",
            "trust_level": 2,
        }

    def touch_seen(self, user_id: int) -> None:
        self.last_seen = user_id


class FakeStatusAccounts:
    def user_from_cookie(self, cookie: str):
        if cookie != "ok":
            return None
        return {
            "id": 9,
            "username": "bob",
            "enabled": True,
        }

    def touch_seen(self, account_id: int) -> None:
        self.last_seen = account_id


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
    assert "ips" not in payload
    assert "clientIp" not in str(payload)
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
    assert payload["recent"][0]["clientIp"] == "203.0.113.10"
    assert payload["recent"][0]["visitorId"] == VISITOR_A
    assert payload["recent"][0]["browser"] == "Chrome"
    assert payload["recent"][0]["os"] == "Windows"
    assert "visitor_id" not in payload["recent"][0]
    assert "ips" in payload
    assert payload["ips"][0]["ip"] == "203.0.113.10"
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



def test_visit_ledger_paginates_newest_first(tmp_path: Path, monkeypatch):
    _repository, service = _build(tmp_path)
    current = utc_now()
    clock = {"value": current}

    def fake_now():
        return clock["value"]

    monkeypatch.setattr("app.services.page_visit_service.utc_now", fake_now)
    assert _record(service, visitor_cookie=VISITOR_A, path="/status")["recorded"] is True
    clock["value"] = current + timedelta(seconds=10)
    assert _record(service, visitor_cookie=VISITOR_B, path="/status/usage")["recorded"] is True
    clock["value"] = current + timedelta(seconds=20)
    assert _record(service, visitor_cookie=VISITOR_C, path="/status")["recorded"] is True

    first = service.visit_ledger(page=1, page_size=2)
    assert first["total"] == 3
    assert first["page"] == 1
    assert first["pageSize"] == 2
    assert [item["path"] for item in first["items"]] == ["/status", "/status/usage"]

    second = service.visit_ledger(page=2, page_size=2)
    assert [item["path"] for item in second["items"]] == ["/status"]


def test_visit_ledger_filters_admin_and_query(tmp_path: Path, monkeypatch):
    auth = MagicMock()
    auth.authenticate_authorization.return_value = {"sub": "admin"}
    _repository, service = _build(tmp_path, auth_service=auth)
    current = utc_now()
    clock = {"value": current}

    def fake_now():
        return clock["value"]

    monkeypatch.setattr("app.services.page_visit_service.utc_now", fake_now)
    assert _record(
        service,
        authorization="Bearer admin-token",
        path="/status",
        referrer="https://github.com/kaibush",
    )["recorded"] is True
    clock["value"] = current + timedelta(seconds=10)
    assert _record(
        service,
        authorization="",
        visitor_cookie=VISITOR_B,
        path="/status/usage",
        referrer="https://t.co/abc",
    )["recorded"] is True

    admin_only = service.visit_ledger(audience="admin")
    assert admin_only["total"] == 1
    assert admin_only["items"][0]["isAdmin"] is True

    queried = service.visit_ledger(q="github")
    assert queried["total"] == 1
    assert queried["items"][0]["referrerHost"] == "github.com"



def test_visit_ledger_includes_client_ip_and_search(tmp_path: Path, monkeypatch):
    _repository, service = _build(tmp_path)
    current = utc_now()
    clock = {"value": current}

    def fake_now():
        return clock["value"]

    monkeypatch.setattr("app.services.page_visit_service.utc_now", fake_now)
    assert _record(
        service,
        client_ip="198.51.100.24",
        country="US",
        language="en-US,en;q=0.9",
        user_agent=DESKTOP_UA,
    )["recorded"] is True
    clock["value"] = current + timedelta(seconds=10)
    assert _record(
        service,
        visitor_cookie=VISITOR_B,
        client_ip="203.0.113.10",
        country="CN",
        language="zh-CN",
        user_agent=MOBILE_UA,
    )["recorded"] is True

    overview = service.overview("24h")
    assert "198.51.100.24" not in str(overview)
    details = service.details("24h")
    assert {item["ip"] for item in details["ips"]} == {"198.51.100.24", "203.0.113.10"}

    matched = service.visit_ledger(q="198.51.100.24")
    assert matched["total"] == 1
    item = matched["items"][0]
    assert item["clientIp"] == "198.51.100.24"
    assert item["country"] == "US"
    assert item["language"] == "en-US"
    assert item["browser"] == "Chrome"
    assert item["os"] == "Windows"



def test_linuxdo_cookie_attaches_identity_to_visit_ledger(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = PageVisitRepository(database)
    oauth = FakeLinuxdoOauth()
    service = PageVisitService(repository, linuxdo_oauth=oauth)
    assert _record(service, linuxdo_cookie="ok")["recorded"] is True
    item = service.visit_ledger()["items"][0]
    assert item["linuxdoUserId"] == 1
    assert item["linuxdoUsername"] == "alice"
    assert item["linuxdoName"] == "Alice"
    assert item["linuxdoAvatarUrl"] == "https://cdn.example/alice.png"
    assert item["linuxdoTrustLevel"] == 2
    assert oauth.last_seen == 1
    matched = service.visit_ledger(q="alice")
    assert matched["total"] == 1

def test_status_account_cookie_attaches_identity_to_visit_ledger(tmp_path: Path):
    database = Database(tmp_path / "grokiq.db")
    database.initialize()
    repository = PageVisitRepository(database)
    accounts = FakeStatusAccounts()
    service = PageVisitService(repository, status_accounts=accounts)
    assert _record(service, status_cookie="ok")["recorded"] is True
    item = service.visit_ledger()["items"][0]
    assert item["statusAccountId"] == 9
    assert item["statusAccountUsername"] == "bob"
    assert accounts.last_seen == 9
    matched = service.visit_ledger(q="bob")
    assert matched["total"] == 1
    both = PageVisitService(
        repository,
        linuxdo_oauth=FakeLinuxdoOauth(),
        status_accounts=FakeStatusAccounts(),
    )
    assert _record(
        both,
        visitor_cookie=VISITOR_B,
        linuxdo_cookie="ok",
        status_cookie="ok",
    )["recorded"] is True
    both_item = both.visit_ledger(q="bob")["items"][0]
    assert both_item["linuxdoUsername"] == "alice"
    assert both_item["statusAccountUsername"] == "bob"

