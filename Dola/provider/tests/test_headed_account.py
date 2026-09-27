"""The manual account browser is isolated and lives until an explicit close."""

import asyncio

from dola_api.contracts import AccountInspectRequest, VerificationInput, VerificationKeyboardInput, VerificationLease
from dola_api.session import CamoufoxSessionPool


def test_headed_account_uses_fresh_context_and_only_closes_on_request(monkeypatch):
    import camoufox.async_api as camoufox
    import dola_api.session as session_module

    events = []

    class Keyboard:
        async def insert_text(self, text):
            events.append(("text", text))

        async def press(self, text):
            events.append(("key", text))

    class Page:
        url = "https://www.dola.com/chat/create-image"
        keyboard = Keyboard()
        mouse = None

        async def screenshot(self, **_kwargs):
            return b"png"

        async def evaluate(self, _script):
            return {"width": 800, "height": 600}

    class Mouse:
        async def move(self, x, y):
            events.append(("mouse_move", (x, y)))

        async def wheel(self, x, y):
            events.append(("wheel", (x, y)))

    Page.mouse = Mouse()

    class Context:
        async def add_cookies(self, cookies):
            events.append(("cookies", cookies))

        async def new_page(self):
            events.append(("page", None))
            return Page()

        async def cookies(self, _urls):
            return [{"name": "sid", "value": "refreshed"}]

        async def close(self):
            events.append(("close_context", None))

    class Browser:
        async def new_context(self, **options):
            events.append(("context", options))
            return Context()

    class Manager:
        def __init__(self, **options):
            events.append(("browser", options))

        async def __aenter__(self):
            return Browser()

        async def __aexit__(self, *_args):
            events.append(("close_browser", None))

    async def navigate(_page, url):
        events.append(("navigate", url))

    async def probe(_cookie, _proxy_url):
        return {"state": "ready"}

    monkeypatch.setenv("DOLA_ENABLE_BROWSER", "1")
    monkeypatch.setattr(camoufox, "AsyncCamoufox", Manager)
    monkeypatch.setattr(session_module, "_goto_dola_page", navigate)
    monkeypatch.setattr(session_module, "probe_account_login", probe)
    pool = CamoufoxSessionPool()
    pool._loaded = True

    async def scenario():
        result = await pool.start_headed_test(AccountInspectRequest(accountId="fixture", cookie="sid=fixture", proxyMode="direct"))
        lease = (await pool.open_verification(result["verificationId"]))["leaseToken"]
        assert result["status"] == "headed_ready"
        assert next(value for kind, value in events if kind == "browser")["headless"] is False
        assert next(value for kind, value in events if kind == "context")["storage_state"] is None
        assert ("cookies", [{"name": "sid", "value": "fixture", "domain": ".dola.com", "path": "/"}]) in events
        assert pool.list_headed_tests()[0]["verificationId"] == result["verificationId"]
        await pool.verification_keyboard(result["verificationId"], VerificationKeyboardInput(leaseToken=lease, text="hello"))
        await pool.verification_keyboard(result["verificationId"], VerificationKeyboardInput(leaseToken=lease, text="Tab"))
        await pool.verification_input(result["verificationId"], VerificationInput(leaseToken=lease, action="wheel", x=400, y=300, deltaY=120))
        refreshed = await pool.finalize_headed_test(result["verificationId"], VerificationLease(leaseToken=lease))
        assert refreshed["status"] == "ready" and refreshed["cookie"] == "sid=refreshed"
        assert not any(kind.startswith("close_") for kind, _ in events)
        await pool.close_verification(result["verificationId"], VerificationLease(leaseToken=lease))
        assert pool.list_headed_tests() == []

        async def rejected(_cookie, _proxy_url):
            return {"state": "needs_login"}

        monkeypatch.setattr(session_module, "probe_account_login", rejected)
        second = await pool.start_headed_test(AccountInspectRequest(accountId="fixture", cookie="sid=expired"))
        second_lease = (await pool.open_verification(second["verificationId"]))["leaseToken"]
        rejected_result = await pool.finalize_headed_test(second["verificationId"], VerificationLease(leaseToken=second_lease))
        assert rejected_result["status"] == "needs_login" and "cookie" not in rejected_result
        assert pool.list_headed_tests()[0]["verificationId"] == second["verificationId"]
        await pool.close_verification(second["verificationId"], VerificationLease(leaseToken=second_lease))

    asyncio.run(scenario())
    assert ("text", "hello") in events and ("key", "Tab") in events
    assert ("wheel", (0, 120)) in events
    assert ("close_context", None) in events and ("close_browser", None) in events
