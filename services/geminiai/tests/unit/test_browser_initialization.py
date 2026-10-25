from __future__ import annotations

import sys
import types

import pytest

from aistudio_api.infrastructure.gateway import session as session_module
from aistudio_api.infrastructure.gateway.session import BrowserSession


class _Page:
    def __init__(self) -> None:
        self.goto_calls = []

    def is_closed(self) -> bool:
        return False

    def goto(self, url: str, **kwargs) -> None:
        self.goto_calls.append((url, kwargs))


class _Context:
    def __init__(self) -> None:
        self.pages = [_Page()]
        self.closed = False

    def new_page(self):
        page = _Page()
        self.pages.append(page)
        return page

    def close(self) -> None:
        self.closed = True


class _CamoufoxManager:
    def __init__(self, context: _Context) -> None:
        self.context = context
        self.exited = False

    def __enter__(self):
        return self.context

    def __exit__(self, *_args) -> None:
        self.exited = True


class _Browser:
    def __init__(self, contexts: list[_Context]) -> None:
        self.closed = False
        self.contexts = contexts

    def new_context(self, **_kwargs):
        self.context = _Context()
        self.contexts.append(self.context)
        return self.context

    def close(self) -> None:
        self.closed = True


def _session() -> BrowserSession:
    session = BrowserSession.__new__(BrowserSession)
    session._profile_dir = None
    session._auth_file = None
    session._hook_page = None
    session._ctx = None
    session._browser = None
    session._cf = None
    session._playwright = None
    session._snap_key = None
    session._templates = {}
    return session


@pytest.fixture
def browser_factory(monkeypatch):
    contexts = []
    managers = []
    browsers = []
    engine = {"camoufox": True}
    monkeypatch.setattr(session_module, "is_camoufox_engine", lambda: engine["camoufox"])
    monkeypatch.setattr(session_module, "sync_maximize_page_window", lambda _page: None)

    def launch_camoufox(**_kwargs):
        context = _Context()
        manager = _CamoufoxManager(context)
        contexts.append(context)
        managers.append(manager)
        return manager

    camoufox_package = types.ModuleType("camoufox")
    camoufox_sync = types.ModuleType("camoufox.sync_api")
    camoufox_sync.Camoufox = launch_camoufox
    camoufox_package.sync_api = camoufox_sync
    monkeypatch.setitem(sys.modules, "camoufox", camoufox_package)
    monkeypatch.setitem(sys.modules, "camoufox.sync_api", camoufox_sync)

    def launch_chromium(*_args, **_kwargs):
        browser = _Browser(contexts)
        browsers.append(browser)
        return browser, None, None

    monkeypatch.setattr(session_module, "sync_launch_browser", launch_chromium)
    monkeypatch.setattr(session_module, "build_browser_context_options", lambda: {})
    return engine, contexts, managers, browsers


@pytest.mark.parametrize("camoufox", [True, False], ids=["camoufox", "chromium"])
@pytest.mark.parametrize("failure_stage", ["goto", "install"])
def test_failed_initialization_closes_state_and_next_call_uses_fresh_context(
    browser_factory, monkeypatch, camoufox: bool, failure_stage: str
) -> None:
    engine, contexts, managers, browsers = browser_factory
    engine["camoufox"] = camoufox
    session = _session()
    fail = {"enabled": True}
    navigation_calls = []
    hook_calls = []

    def goto(_page):
        navigation_calls.append(_page)
        if fail["enabled"] and failure_stage == "goto":
            raise RuntimeError("navigation failed")

    def install(_page):
        hook_calls.append(_page)
        if fail["enabled"] and failure_stage == "install":
            raise RuntimeError("hook installation failed")

    monkeypatch.setattr(session, "_apply_auth_file_sync", lambda: None)
    monkeypatch.setattr(session, "_goto_aistudio_sync", goto)
    monkeypatch.setattr(session, "_install_hooks_sync", install)

    with pytest.raises(RuntimeError, match="failed"):
        session._ensure_browser_sync()

    first_context = contexts[0]
    assert first_context.closed
    assert session._ctx is None
    assert session._hook_page is None
    assert session._browser is None
    assert session._cf is None
    assert session._playwright is None
    if camoufox:
        assert managers[0].exited
    else:
        assert browsers[0].closed

    fail["enabled"] = False
    second_context = session._ensure_browser_sync()
    assert second_context is contexts[1]
    assert second_context is not first_context
    assert navigation_calls
    assert hook_calls


@pytest.mark.parametrize("camoufox", [True, False], ids=["camoufox", "chromium"])
def test_successful_initialization_reuses_live_context(browser_factory, monkeypatch, camoufox: bool) -> None:
    engine, contexts, _managers, _browsers = browser_factory
    engine["camoufox"] = camoufox
    session = _session()
    navigation_calls = []
    hook_calls = []
    monkeypatch.setattr(session, "_apply_auth_file_sync", lambda: None)
    monkeypatch.setattr(session, "_goto_aistudio_sync", lambda page: navigation_calls.append(page))
    monkeypatch.setattr(session, "_install_hooks_sync", lambda page: hook_calls.append(page))

    context = session._ensure_browser_sync()
    assert session._ensure_browser_sync() is context
    assert len(contexts) == 1
    assert navigation_calls == [session._hook_page]
    assert hook_calls == [session._hook_page]


@pytest.mark.parametrize("camoufox", [True, False], ids=["camoufox", "chromium"])
def test_read_only_initialization_skips_navigation_and_hooks(browser_factory, monkeypatch, camoufox: bool) -> None:
    engine, contexts, _managers, _browsers = browser_factory
    engine["camoufox"] = camoufox
    session = _session()
    monkeypatch.setattr(session, "_apply_auth_file_sync", lambda: None)
    monkeypatch.setattr(session, "_goto_aistudio_sync", lambda _page: pytest.fail("read-only mode must not navigate"))
    monkeypatch.setattr(session, "_install_hooks_sync", lambda _page: pytest.fail("read-only mode must not install hooks"))

    assert session._ensure_browser_sync(read_only=True) is contexts[0]
    assert len(contexts) == 1
