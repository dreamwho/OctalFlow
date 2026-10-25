from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from aistudio_api.api.dependencies import get_account_service
from aistudio_api.api.routes_accounts import router as accounts_router
from aistudio_api.application import account_service as account_service_module
from aistudio_api.application.account_service import AccountService
from aistudio_api.infrastructure.account import account_health
from aistudio_api.infrastructure.account.account_store import AccountStore


class FakeBrowserSession:
    page_factory = None
    instances: list[FakeBrowserSession] = []

    def __init__(self, port: int):
        self.port = port
        self._auth_file: str | None = None
        self._profile_dir: str | None = None
        self.closed = False
        self.read_only: bool | None = None
        self.page = self.page_factory()
        self.hooks_installed = False
        self.instances.append(self)

    def _derive_profile_dir(self, auth_file: str | None) -> str | None:
        return f"{Path(auth_file).parent}/isolated-profile" if auth_file else None

    def _ensure_browser_sync(self, *, read_only: bool = False):
        self.read_only = read_only
        assert self._auth_file is not None
        assert Path(self._auth_file).is_file()
        assert self._profile_dir is not None
        self._hook_page = self.page

    async def _run_sync(self, callback, *args):
        return callback(*args)

    def _install_hooks_sync(self, page):
        self.hooks_installed = True

    async def close(self):
        self.closed = True


class FakePage:
    def __init__(self, url="https://aistudio.google.com/", title="AI Studio", *, ready=True, maker_suite_ready=True, goto_error=None):
        self.url = url
        self.destination_url = url
        self._title = title
        self.ready = ready
        self.maker_suite_ready = maker_suite_ready
        self.goto_error = goto_error
        self.actions: list[tuple] = []

    def goto(self, url, *, wait_until, timeout):
        self.actions.append(("goto", url, wait_until, timeout))
        self.url = self.destination_url
        if self.goto_error is not None:
            raise self.goto_error

    def wait_for_function(self, expression, *, timeout):
        self.actions.append(("wait_for_function", expression, timeout))
        if not self.ready:
            raise TimeoutError("not ready")

    def evaluate(self, expression):
        self.actions.append(("evaluate", expression))
        assert expression == "mw:!!window.default_MakerSuite"
        return self.maker_suite_ready

    def query_selector(self, selector):
        self.actions.append(("query_selector", selector))
        assert selector == "textarea"
        return object() if self.ready else None

    def title(self):
        return self._title


@pytest.fixture(autouse=True)
def fake_browser(monkeypatch):
    FakeBrowserSession.instances = []
    FakeBrowserSession.page_factory = FakePage
    monkeypatch.setattr(account_health, "BrowserSession", FakeBrowserSession)


def _storage_state(*, expiry: int | None = None) -> dict:
    cookie = {"name": "SID", "value": "secret-cookie", "domain": ".google.com"}
    if expiry is not None:
        cookie["expires"] = expiry
    return {"cookies": [cookie], "origins": []}


def test_check_success_uses_a_private_snapshot_and_does_not_switch_active_account(tmp_path):
    store = AccountStore(tmp_path / "accounts")
    active = store.save_account("active", "active@example.test", _storage_state())
    checked = store.save_account("checked", "checked@example.test", _storage_state())
    store.set_active_account(active.id)
    original_auth = store.get_auth_path(checked.id)
    original_auth_bytes = original_auth.read_bytes()

    result = asyncio.run(account_health.check_account_health(store, checked.id))

    assert result["status"] == "ready"
    assert result["message"] == "AI Studio 页面接口已就绪；本次未单独验证账号邮箱。"
    assert result["cookie_expires_at"] is None
    assert result["cookie_expiry_known"] is False
    assert store.get_active_account().id == active.id
    assert original_auth.read_bytes() == original_auth_bytes
    probe = FakeBrowserSession.instances[0]
    assert probe.closed
    assert probe.read_only is True
    assert probe.hooks_installed is True
    assert [action[0] for action in probe.page.actions] == ["goto", "wait_for_function", "evaluate", "query_selector"]
    assert "window.default_MakerSuite" not in probe.page.actions[1][1]
    assert all(action[0] not in {"click", "fill", "type", "press"} for action in probe.page.actions)
    assert not any("save" in action[0] for action in probe.page.actions)
    assert Path(probe._auth_file).parent != original_auth.parent
    assert not Path(probe._auth_file).exists()
    assert store.get_account(checked.id).health == result

    reloaded = AccountStore(tmp_path / "accounts")
    assert reloaded.list_accounts()[1].health == result


@pytest.mark.parametrize(
    ("page", "expected_status", "expected_message", "wait_count", "hooks_installed"),
    [
        (
            FakePage(url="https://accounts.google.com/v3/signin/identifier"),
            "login_required",
            "登录状态无效或账号不匹配，请重新登录或导入该账号。",
            0,
            False,
        ),
        (
            FakePage(url="about:certerror?e=nssFailure", title="Warning: Security Risk"),
            "unavailable",
            "浏览器显示证书安全警告，未跳过安全验证。",
            0,
            False,
        ),
        (
            FakePage(ready=False),
            "error",
            "AI Studio 已打开，但页面尚未就绪或需要人工确认；本次未执行任何操作。",
            1,
            False,
        ),
        (
            FakePage(maker_suite_ready=False),
            "error",
            "AI Studio 已打开，但页面尚未就绪或需要人工确认；本次未执行任何操作。",
            1,
            False,
        ),
        (
            FakePage(url="about:neterror?e=netTimeout", title="Network Error", goto_error=TimeoutError()),
            "unavailable",
            "浏览器无法访问 AI Studio，请检查网络与代理配置。",
            0,
            False,
        ),
    ],
)
def test_check_classifies_failures_without_exposing_browser_error(
    tmp_path, monkeypatch, page, expected_status, expected_message, wait_count, hooks_installed
):
    FakeBrowserSession.page_factory = staticmethod(lambda: page)
    store = AccountStore(tmp_path / "accounts")
    account = store.save_account("checked", "user@example.test", _storage_state())

    result = asyncio.run(account_health.check_account_health(store, account.id))

    assert result["status"] == expected_status
    assert result["message"] == expected_message
    probe = FakeBrowserSession.instances[0]
    assert probe.closed
    assert probe.hooks_installed is hooks_installed
    assert sum(action[0] == "wait_for_function" for action in page.actions) == wait_count
    assert all(action[0] not in {"click", "fill", "type", "press"} for action in page.actions)
    assert not any("save" in action[0] for action in page.actions)


def test_cookie_expiry_is_unknown_for_legacy_imports_and_known_only_for_marked_browser_exports():
    plausible_fake_expiry = 1_800_000_000

    assert account_health._cookie_expiry(_storage_state(expiry=plausible_fake_expiry), False) == (None, False)

    iso = datetime.fromtimestamp(plausible_fake_expiry, timezone.utc).isoformat()
    assert account_health._cookie_expiry(
        _storage_state(expiry=plausible_fake_expiry), True
    ) == (iso, True)


def test_cookie_expiry_uses_google_auth_cookies_and_requires_all_auth_cookies_to_expire():
    state = _storage_state(expiry=1_900_000_000)
    state["cookies"].append({"name": "OTZ", "domain": "accounts.google.com", "expires": 1_000_000_000})
    assert account_health._cookie_expiry(state, True) == (
        datetime.fromtimestamp(1_900_000_000, timezone.utc).isoformat(),
        True,
    )

    state["cookies"].append({"name": "SSID", "domain": ".google.com", "expires": -1})
    assert account_health._cookie_expiry(state, True) == (None, False)


def test_cookie_expiry_provenance_is_persisted_separately_from_auth_json(tmp_path):
    store = AccountStore(tmp_path / "accounts")
    account = store.save_account(
        "browser-export",
        "user@example.test",
        _storage_state(expiry=1_800_000_000),
        cookie_expiry_known=True,
    )

    assert account.cookie_expiry_known is True
    assert AccountStore(tmp_path / "accounts").get_account(account.id).cookie_expiry_known is True


def test_check_endpoint_returns_and_persists_health_on_list_and_active(tmp_path, monkeypatch):
    store = AccountStore(tmp_path / "accounts")
    account = store.save_account("checked", "user@example.test", _storage_state())
    service = AccountService(store, login_service=None)
    app = FastAPI()
    app.include_router(accounts_router)
    app.dependency_overrides[get_account_service] = lambda: service
    monkeypatch.setattr(account_health, "BrowserSession", FakeBrowserSession)

    with TestClient(app) as client:
        checked = client.post(f"/accounts/{account.id}/check")
        listed = client.get("/accounts")
        active = client.get("/accounts/active")

    assert checked.status_code == 200
    expected_health = checked.json()["health"]
    assert expected_health["status"] == "ready"
    assert set(expected_health) == {
        "status", "checked_at", "message", "cookie_expires_at", "cookie_expiry_known"
    }
    assert listed.json()[0]["health"] == expected_health
    assert active.json()["health"] == expected_health


def test_same_account_health_checks_share_one_probe(tmp_path, monkeypatch):
    store = AccountStore(tmp_path / "accounts")
    account = store.save_account("checked", "user@example.test", _storage_state())
    service = AccountService(store, login_service=None)
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def fake_check(_store, _account_id):
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        health = {
            "status": "ready",
            "checked_at": "2026-10-16T00:00:00+00:00",
            "message": "ready",
            "cookie_expires_at": None,
            "cookie_expiry_known": False,
        }
        _store.save_health(_account_id, health)
        return health

    monkeypatch.setattr(account_service_module, "check_account_health", fake_check)

    async def run_checks():
        first = asyncio.create_task(service.check_account(account.id))
        await started.wait()
        second = asyncio.create_task(service.check_account(account.id))
        await asyncio.sleep(0)
        release.set()
        return await asyncio.gather(first, second)

    results = asyncio.run(run_checks())

    assert calls == 1
    assert results[0].health == results[1].health


def test_imported_cookie_builders_do_not_invent_expiration(monkeypatch):
    from aistudio_api.infrastructure.account.cookie_parser import parse_cookie_string
    from aistudio_api.infrastructure.account.cookie_refresher import load_cookies_from_string

    monkeypatch.setattr(
        "aistudio_api.infrastructure.account.cookie_refresher._refresh_session_cookies",
        lambda cookies: dict(cookies),
    )
    parsed = parse_cookie_string("SID=abc")
    assert "expires" not in parsed["cookies"][0]
    assert "cookie_expiry_known" not in parsed

    cookies = load_cookies_from_string("SID=abc")
    assert "expires" not in cookies[0]
