"""远程 Google 授权会话的验证与浏览器资源回收。"""

import asyncio

import pytest

from dola_api.contracts import AccountInspectRequest, VerificationLease
from dola_api.session import CamoufoxSessionPool


def test_remote_google_login_replaces_previous_browser_and_closes_after_use(monkeypatch):
    import camoufox.async_api as camoufox_api
    import dola_api.session as session_module

    closed = []
    modes = []
    browser_options = []
    native_closed = asyncio.Event()

    class Page:
        url = "https://www.dola.com/login"

        def __init__(self):
            self.closed = False
            self.listeners = {}

        def is_closed(self):
            return self.closed

        def on(self, name, callback):
            self.listeners[name] = callback

        def close(self):
            self.closed = True
            if callback := self.listeners.get("close"):
                callback()

        async def goto(self, *_args, **_kwargs):
            return None

        async def screenshot(self, **_kwargs):
            return b"png"

        async def evaluate(self, *_args):
            return {"width": 800, "height": 600}

    class Context:
        def __init__(self, index):
            self.index = index
            self.pages = []
            self.listeners = {}

        def on(self, name, callback):
            self.listeners[name] = callback

        async def new_page(self):
            page = Page()
            self.pages.append(page)
            if callback := self.listeners.get("page"):
                callback(page)
            return page

        async def cookies(self, _url):
            return [{"name": "dola_session", "value": "authorized"}]

        async def close(self):
            closed.append(("context", self.index))

    class Browser:
        def __init__(self, index):
            self.index = index

        async def new_context(self, **_kwargs):
            return Context(self.index)

    class Camoufox:
        next_index = 0

        def __init__(self, **options):
            modes.append(options["headless"])
            browser_options.append(options)
            Camoufox.next_index += 1
            self.index = Camoufox.next_index

        async def __aenter__(self):
            return Browser(self.index)

        async def __aexit__(self, *_args):
            closed.append(("browser", self.index))
            if self.index == 4:
                native_closed.set()

    async def probe(cookie, _proxy):
        assert cookie == "dola_session=authorized"
        return {"state": "ready"}

    monkeypatch.setenv("DOLA_ENABLE_BROWSER", "1")
    monkeypatch.setattr(camoufox_api, "AsyncCamoufox", Camoufox)
    monkeypatch.setattr(session_module, "probe_account_login", probe)

    async def scenario():
        pool = CamoufoxSessionPool()
        first = await pool.start_google_login_session("admin-1")
        first_id = first["verificationId"]
        first_snapshot = await pool.open_verification(first_id)
        assert first_snapshot["screenshotBase64"]
        with pytest.raises(RuntimeError, match="并发上限"):
            await pool.start_google_login_session("admin-2")
        with pytest.raises(RuntimeError, match="并发上限"):
            await pool.start_headed_test(AccountInspectRequest(accountId="account-2", cookie="sid=fixture"))
        assert list(pool._verifications) == [first_id]
        second = await pool.start_google_login_session("admin-1", proxy_mode="managed", proxy_source="chained", proxy_target="Taiwan", proxy_url="http://127.0.0.1:17893")
        second_id = second["verificationId"]
        assert ("browser", 1) in closed
        assert first_id not in pool._verifications
        snapshot = await pool.open_verification(second_id)
        popup = Page()
        popup.url = "https://accounts.google.com/signin"
        pool._verifications[second_id].context.pages.append(popup)
        assert (await pool.open_verification(second_id))["pageUrl"] == popup.url
        popup.is_closed = lambda: True
        assert (await pool.open_verification(second_id))["pageUrl"] == "https://www.dola.com/login"
        lease = VerificationLease(leaseToken=snapshot["leaseToken"])
        finalized = await pool.finalize_google_login_session(second_id, lease)
        assert finalized["cookie"] == "dola_session=authorized"
        assert finalized["proxySource"] == "chained"
        assert finalized["proxyTarget"] == "Taiwan"
        assert finalized["proxyUrl"] == "http://127.0.0.1:17893"
        assert browser_options[1]["proxy"]["server"] == "http://127.0.0.1:17893"
        assert ("browser", 2) not in closed
        await pool.close_verification(second_id, lease)
        assert (await pool.close_verification(second_id, lease))["status"] == "closed"
        assert ("context", 2) in closed and ("browser", 2) in closed
        assert not pool._verifications
        await pool.start_google_login_session("admin-2")
        await pool.close_all_verifications()
        assert ("context", 3) in closed and ("browser", 3) in closed
        native = await pool.start_google_login_session("admin-3", headless=False)
        assert native["leaseToken"]
        assert modes == [True, True, True, False]
        pool._verifications[native["verificationId"]].page.close()
        await asyncio.wait_for(native_closed.wait(), 1)
        assert native["verificationId"] not in pool._verifications

    asyncio.run(scenario())


def test_local_headed_account_test_uses_native_browser_and_returns_lease(monkeypatch):
    import camoufox.async_api as camoufox_api
    import dola_api.session as session_module

    modes = []
    closed = []

    class Page:
        url = "https://www.dola.com/chat/create-image"

        def on(self, *_args):
            pass

    class Context:
        pages = []

        async def add_cookies(self, _cookies):
            pass

        async def new_page(self):
            page = Page()
            self.pages = [page]
            return page

        async def close(self):
            closed.append("context")

    class Browser:
        async def new_context(self, **_kwargs):
            return Context()

    class Camoufox:
        def __init__(self, **options):
            modes.append(options["headless"])

        async def __aenter__(self):
            return Browser()

        async def __aexit__(self, *_args):
            closed.append("browser")

    async def navigate(_page, _url):
        return "ready"

    monkeypatch.setenv("DOLA_ENABLE_BROWSER", "1")
    monkeypatch.setattr(camoufox_api, "AsyncCamoufox", Camoufox)
    monkeypatch.setattr(session_module, "_goto_dola_page", navigate)

    async def scenario():
        pool = CamoufoxSessionPool()
        result = await pool.start_headed_test(AccountInspectRequest(accountId="account-native", cookie="sid=fixture", headless=False))
        assert modes == [False]
        assert len(result["leaseToken"]) >= 16
        assert pool.list_headed_tests()[0]["headless"] is False
        await pool.close_verification(result["verificationId"], VerificationLease(leaseToken=result["leaseToken"]))
        assert closed == ["context", "browser"]

    asyncio.run(scenario())


def test_remote_google_login_expiration_releases_browser(monkeypatch):
    import camoufox.async_api as camoufox_api

    closed = []
    closed_event = asyncio.Event()

    class Page:
        url = "https://www.dola.com/login"

        async def goto(self, *_args, **_kwargs):
            return None

    class Context:
        async def new_page(self):
            return Page()

        async def close(self):
            closed.append("context")

    class Browser:
        async def new_context(self, **_kwargs):
            return Context()

    class Camoufox:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return Browser()

        async def __aexit__(self, *_args):
            closed.append("browser")
            closed_event.set()

    monkeypatch.setenv("DOLA_ENABLE_BROWSER", "1")
    monkeypatch.setattr(camoufox_api, "AsyncCamoufox", Camoufox)

    async def scenario():
        pool = CamoufoxSessionPool()
        await pool.start_google_login_session("admin-1", timeout_seconds=0)
        await asyncio.wait_for(closed_event.wait(), 1)
        assert not pool._verifications
        assert closed == ["context", "browser"]

    asyncio.run(scenario())
