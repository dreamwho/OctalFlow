"""Dola 登录态判定：HTTP 启动协议优先，真实页面只做对照与兜底。"""

import asyncio
from urllib.parse import parse_qs

from dola_api.contracts import AccountInspectRequest
from dola_api.query import _launch_query, parse_account_login_state
from dola_api.session import CamoufoxSessionPool, _account_fingerprint_preset, _apply_post_submit_login_probe, _goto_dola_page, _page_has_age_confirmation, _page_is_region_restricted, _page_looks_logged_out


def test_login_redirect_url_reports_logged_out():
    assert _page_looks_logged_out("https://www.dola.com/login?next=/chat", "dola", "") is True
    assert _page_looks_logged_out("https://www.dola.com/sign-in", "dola", "") is True


def test_login_button_text_reports_logged_out():
    assert _page_looks_logged_out("https://www.dola.com/chat/create-image", "dola", "登录 注册 浏览更多") is True
    assert _page_looks_logged_out("https://www.dola.com/chat/create-image", "log in to continue", "") is True


def test_normal_create_page_stays_ready():
    assert _page_looks_logged_out("https://www.dola.com/chat/create-image", "dola", "视频 45/100 credits") is False


def test_url_substring_does_not_false_positive():
    assert _page_looks_logged_out("https://www.dola.com/chat/authorize-detail", "", "") is False
    assert _page_looks_logged_out("https://www.dola.com/chat/create-image", "", "design in your browser") is False


def test_age_confirmation_is_separate_from_login_and_slider_states():
    body = "确认你的年龄\n请确认你已满18周岁。未能确认将会影响你继续体验。\n否\n确认"
    assert _page_has_age_confirmation("Dola", body) is True
    assert _page_has_age_confirmation("Dola", "当前服务访问频繁，请稍后重试") is False


def test_launch_payload_is_authoritative_for_login_state():
    assert parse_account_login_state({"code": 0, "data": {"extra": {"is_login": "1"}}}) == "ready"
    assert parse_account_login_state({"code": 0, "data": {"extra": {"is_login": "0"}}}) == "needs_login"
    assert parse_account_login_state({"code": 710010702, "data": {}}) == "unknown"
    assert parse_account_login_state({"code": 0, "data": {}}) == "unknown"


def test_launch_query_matches_browser_capture_without_signer_or_cookie_tokens():
    query = parse_qs(_launch_query("flow_user_country=TW; msToken=secret; s_v_web_id=secret-fp"))
    assert query["region"] == ["TW"]
    assert query["sys_region"] == ["TW"]
    assert query["use-olympus-account"] == ["1"]
    assert "a_bogus" not in query
    assert "msToken" not in query
    assert "fp" not in query


def test_inspect_short_circuits_invalid_cookie_without_browser(monkeypatch):
    import dola_api.session as session_module

    async def probe(*_args, **_kwargs):
        return {"state": "needs_login", "httpStatus": 200, "code": 0, "transport": "http-launch"}

    monkeypatch.setattr(session_module, "probe_account_login", probe)
    monkeypatch.setenv("DOLA_ENABLE_BROWSER", "0")
    result = asyncio.run(CamoufoxSessionPool().inspect(AccountInspectRequest(accountId="account-1", cookie="sid=expired")))

    assert result["status"] == "needs_login"
    assert result["loginProbe"]["transport"] == "http-launch"


def test_auth_only_inspect_accepts_logged_in_cookie_without_browser(monkeypatch):
    import dola_api.session as session_module

    async def probe(*_args, **_kwargs):
        return {"state": "ready", "httpStatus": 200, "code": 0, "transport": "http-launch"}

    monkeypatch.setattr(session_module, "probe_account_login", probe)
    monkeypatch.setenv("DOLA_ENABLE_BROWSER", "0")
    request = AccountInspectRequest(accountId="account-1", cookie="sid=valid", authOnly=True)
    result = asyncio.run(CamoufoxSessionPool().inspect(request))

    assert result["status"] == "ready"
    assert result["loginProbe"]["state"] == "ready"


def test_google_login_saves_only_dola_cookies_after_launch_confirms_login(monkeypatch):
    import camoufox.async_api as camoufox_api
    import dola_api.session as session_module

    class Response:
        url = "https://www.dola.com/alice/user/launch"

        async def json(self):
            return {"code": 0, "data": {"extra": {"is_login": "1"}}}

    class Page:
        url = "https://www.dola.com/chat/create-image"

        def on(self, name, callback):
            self.callback = callback

        async def goto(self, *_args, **_kwargs):
            self.callback(Response())
            await asyncio.sleep(0)

        async def title(self):
            return "Dola"

        def locator(self, *_args):
            return self

        async def inner_text(self):
            return "视频创作"

        async def evaluate(self, *_args):
            return {"email": ""}

    class Context:
        async def new_page(self):
            return Page()

        async def cookies(self, url):
            assert url == "https://www.dola.com/"
            return [{"name": "dola_session", "value": "test-session"}]

    class Browser:
        async def new_context(self, **_kwargs):
            return Context()

    class Camoufox:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return Browser()

        async def __aexit__(self, *_args):
            return None

    monkeypatch.setenv("DOLA_ENABLE_BROWSER", "1")
    monkeypatch.setattr(camoufox_api, "AsyncCamoufox", Camoufox)
    async def probe(cookie, _proxy):
        assert cookie == "dola_session=test-session"
        return {"state": "ready"}

    monkeypatch.setattr(session_module, "probe_account_login", probe)
    result = asyncio.run(CamoufoxSessionPool().start_google_login())
    assert result["status"] == "success"
    assert result["cookie"] == "dola_session=test-session"


def test_google_login_keeps_browser_open_until_exported_cookie_is_valid(monkeypatch):
    import camoufox.async_api as camoufox_api
    import dola_api.session as session_module

    observed = []

    class Response:
        url = "https://www.dola.com/alice/user/launch"

        async def json(self):
            return {"code": 0, "data": {"extra": {"is_login": "1"}}}

    class Page:
        url = "https://www.dola.com/chat/create-image"

        def on(self, _name, callback):
            self.callback = callback

        async def goto(self, *_args, **_kwargs):
            self.callback(Response())
            await asyncio.sleep(0)

        async def title(self):
            return "Dola"

        def locator(self, *_args):
            return self

        async def inner_text(self):
            return "视频创作"

        async def evaluate(self, *_args):
            return {"email": ""}

    class Context:
        def __init__(self):
            self.reads = 0

        async def new_page(self):
            return Page()

        async def cookies(self, _url):
            self.reads += 1
            value = "early-session" if self.reads == 1 else "valid-session"
            return [{"name": "dola_session", "value": value}]

    class Browser:
        async def new_context(self, **_kwargs):
            return Context()

    class Camoufox:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            observed.append("opened")
            return Browser()

        async def __aexit__(self, *_args):
            observed.append("closed")

    async def probe(cookie, _proxy):
        assert observed[0] == "opened" and "closed" not in observed
        observed.append(cookie)
        return {"state": "ready" if cookie.endswith("valid-session") else "needs_login"}

    original_sleep = asyncio.sleep

    async def no_delay(_seconds):
        await original_sleep(0)

    monkeypatch.setenv("DOLA_ENABLE_BROWSER", "1")
    monkeypatch.setattr(camoufox_api, "AsyncCamoufox", Camoufox)
    monkeypatch.setattr(session_module, "probe_account_login", probe)
    monkeypatch.setattr(session_module.asyncio, "sleep", no_delay)
    result = asyncio.run(CamoufoxSessionPool().start_google_login())
    assert result["cookie"] == "dola_session=valid-session"
    assert observed == ["opened", "dola_session=early-session", "dola_session=valid-session", "closed"]


def test_macos_account_fingerprint_replaces_legacy_unsupported_webgl(monkeypatch, tmp_path):
    import json
    import camoufox.fingerprints as fingerprints

    profile = tmp_path / "account-1"
    profile.mkdir()
    (profile / "fingerprint-preset.json").write_text(json.dumps({
        "version": 1,
        "targetOs": "macos",
        "preset": {"webgl": {"unmaskedVendor": "ATI Technologies Inc.", "unmaskedRenderer": "Radeon HD 3200 Graphics, or similar"}},
    }))
    candidates = iter([
        {"webgl": {"unmaskedVendor": "ATI Technologies Inc.", "unmaskedRenderer": "Radeon R9 200 Series, or similar"}},
        {"webgl": {"unmaskedVendor": "Apple", "unmaskedRenderer": "Apple M1, or similar"}},
    ])
    monkeypatch.setenv("DOLA_PROFILE_DIR", str(tmp_path))
    monkeypatch.setattr(fingerprints, "get_random_preset", lambda **_kwargs: next(candidates))

    preset = _account_fingerprint_preset("account-1", "macos")

    assert preset["webgl"]["unmaskedVendor"] == "Apple"
    assert json.loads((profile / "fingerprint-preset.json").read_text())["version"] == 2


def test_navigation_abort_waits_for_spa_page_readiness():
    class Locator:
        async def inner_text(self):
            return "AI 创作"

    class Page:
        url = "https://www.dola.com/chat/create-image"

        def on(self, event, callback):
            assert event == "response"
            self.response_callback = callback

        def remove_listener(self, *_args):
            return None

        async def goto(self, *_args, **kwargs):
            assert kwargs["wait_until"] == "commit"
            class Response:
                url = "https://www.dola.com/alice/user/launch"

                async def json(self):
                    return {"data": {"extra": {"is_login": "1"}}}

            self.response_callback(Response())
            raise RuntimeError("Page.goto: NS_ERROR_ABORT")

        async def wait_for_function(self, expression, timeout):
            assert "document.readyState" in expression
            assert timeout == 45_000

        async def title(self):
            return "Dola"

        def locator(self, selector):
            assert selector == "body"
            return Locator()

        async def evaluate(self, *_args):
            return 5

    assert asyncio.run(_goto_dola_page(Page(), "https://www.dola.com/chat/create-image")) == "ready"


def test_710022002_records_login_probe_without_forcing_cookie_expiry():
    logged_out = {"serviceFrequent": True, "diagnostics": {"codes": ["710022002"]}}
    _apply_post_submit_login_probe(logged_out, {"state": "needs_login", "code": 0})
    assert "needsLogin" not in logged_out
    assert logged_out["diagnostics"]["postSubmitLoginState"] == "needs_login"

    still_ready = {"serviceFrequent": True, "diagnostics": {"codes": ["710022002"]}}
    _apply_post_submit_login_probe(still_ready, {"state": "ready", "code": 0})
    assert "needsLogin" not in still_ready
    assert still_ready["diagnostics"]["postSubmitLoginState"] == "ready"
    assert still_ready["diagnostics"]["nativeFrontendAction"] == "GET /passport/web/logout/"


def test_region_restriction_is_not_a_login_failure():
    assert _page_is_region_restricted(
        "https://www.dola.com/security/region-restricted?source=2",
        "Dola",
        "受区域限制，无法使用 Dola",
    ) is True
    assert _page_is_region_restricted("https://www.dola.com/chat/create-image", "Dola", "AI 创作") is False
