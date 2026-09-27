"""远程 Google 授权会话的验证与浏览器资源回收。"""

import asyncio

from dola_api.contracts import VerificationLease
from dola_api.session import CamoufoxSessionPool


def test_remote_google_login_replaces_previous_browser_and_closes_after_use(monkeypatch):
    import camoufox.async_api as camoufox_api
    import dola_api.session as session_module

    closed = []
    modes = []
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
        second = await pool.start_google_login_session("admin-1")
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
        assert (await pool.finalize_google_login_session(second_id, lease))["cookie"] == "dola_session=authorized"
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
