import json

from aistudio_api.infrastructure.gateway.session import BrowserSession


class _Button:
    def __init__(self) -> None:
        self.clicked = False

    def click(self) -> None:
        self.clicked = True


class _Keyboard:
    def press(self, shortcut: str) -> None:
        raise AssertionError(f"keyboard fallback should not run: {shortcut}")


class _Page:
    def __init__(self, button: _Button) -> None:
        self.button = button
        self.keyboard = _Keyboard()

    def query_selector(self, selector: str):
        return self.button if selector == "button.ctrl-enter-submits" else None


def test_submit_prefers_the_real_ai_studio_run_button() -> None:
    button = _Button()
    session = BrowserSession.__new__(BrowserSession)

    assert session._click_run_button_sync(_Page(button)) is True
    assert button.clicked is True


class _ModelPage:
    def __init__(self, model: str) -> None:
        self.preferences = {"promptModel": model, "isAdvancedOpen": True}
        self.visited: list[str] = []

    def evaluate(self, script: str, argument=None):
        if "getItem" in script:
            return json.dumps(self.preferences)
        if "setItem" in script:
            self.preferences = json.loads(argument)
            return None
        raise AssertionError(script)

    def goto(self, url: str, **_kwargs) -> None:
        self.visited.append(url)

    def wait_for_selector(self, _selector: str, **_kwargs) -> None:
        return None


def test_template_capture_selects_the_requested_model_before_submit(monkeypatch) -> None:
    page = _ModelPage("models/gemma-4-31b-it")
    session = BrowserSession.__new__(BrowserSession)
    session._bootstrap_template = {"body": '["models/gemma-4-31b-it"]'}
    monkeypatch.setattr(session, "_install_hooks_sync", lambda _page: None)

    session._select_model_sync(page, "gemini-3-pro-image")

    assert page.preferences["promptModel"] == "models/gemini-3-pro-image"
    assert page.preferences["isAdvancedOpen"] is True
    assert page.visited
    assert session._bootstrap_template is None


def test_bootstrap_template_is_reused_only_for_the_same_model() -> None:
    template = {"body": '["models/gemini-3-pro-image"]'}

    assert BrowserSession._template_matches_model(template, "gemini-3-pro-image") is True
    assert BrowserSession._template_matches_model(template, "gemma-4-31b-it") is False


def test_apply_auth_origins_restores_only_aistudio_local_storage() -> None:
    class FakePage:
        def __init__(self):
            self.visited = []
            self.applied = []

        def goto(self, url, **kwargs):
            self.visited.append((url, kwargs))

        def evaluate(self, _script, entries):
            self.applied.append(entries)

    page = FakePage()
    BrowserSession._apply_auth_origins_sync(
        page,
        [
            {"origin": "https://example.com", "localStorage": [{"name": "ignored", "value": "secret"}]},
            {
                "origin": "https://aistudio.google.com",
                "localStorage": [
                    {"name": "aiStudioUserPreference", "value": "{}"},
                    {"name": None, "value": "ignored"},
                ],
            },
        ],
    )

    assert [url for url, _ in page.visited] == ["https://aistudio.google.com"]
    assert page.applied == [[{"name": "aiStudioUserPreference", "value": "{}"}]]


def test_hooked_request_reads_large_response_body_immediately(monkeypatch) -> None:
    class FakeTextarea:
        def fill(self, _value):
            return None

    class FakeResponse:
        status = 200

        def __init__(self):
            self.available = True

        def body(self):
            if not self.available:
                raise RuntimeError("response body was evicted")
            self.available = False
            return b"large-4k-response"

    class FakeRoute:
        def __init__(self, response):
            self.response = response
            self.fulfilled = False

        def fetch(self, **_kwargs):
            return self.response

        def fulfill(self, **_kwargs):
            self.fulfilled = True

        def abort(self):
            raise AssertionError("route should not be aborted")

    class FakeRequest:
        url = "https://example.test/GenerateContent"

    class FakePage:
        def __init__(self):
            self.route_handler = None

        def route(self, _pattern, callback):
            self.route_handler = callback

        def unroute(self, _pattern, _callback):
            self.route_handler = None

        def query_selector(self, selector):
            return FakeTextarea() if selector == "textarea" else None

        def wait_for_timeout(self, _milliseconds):
            return None

    page = FakePage()
    response = FakeResponse()
    route = FakeRoute(response)
    session = BrowserSession.__new__(BrowserSession)
    monkeypatch.setattr(session, "_wait_until_idle_sync", lambda _page: None)
    monkeypatch.setattr(session, "_read_textarea_value_sync", lambda _textarea: "")
    monkeypatch.setattr(session, "_restore_textarea_value_sync", lambda _textarea, _value: None)

    def submit(_page):
        page.route_handler(route, FakeRequest())
        return True

    monkeypatch.setattr(session, "_click_run_button_sync", submit)

    assert session._submit_hooked_body_sync(page, "rewritten", 1_000) == (200, b"large-4k-response")
    assert route.fulfilled is True


class _StopPage:
    def __init__(self, stop_button) -> None:
        self._stop_button = stop_button

    def query_selector(self, selector: str):
        return self._stop_button if selector == "button:has-text('Stop')" else None


def test_stop_generation_clicks_ai_studio_stop_button() -> None:
    stop = _Button()
    session = BrowserSession.__new__(BrowserSession)

    assert session._stop_running_generation_sync(_StopPage(stop)) is True
    assert stop.clicked is True


def test_stop_generation_without_a_stop_button_is_a_noop() -> None:
    session = BrowserSession.__new__(BrowserSession)

    assert session._stop_running_generation_sync(_StopPage(None)) is False


def _bare_session(auth_file: str | None = None) -> BrowserSession:
    session = BrowserSession.__new__(BrowserSession)
    session._auth_file = auth_file
    session._profile_dir = None
    session._templates = {}
    session._account_template_stash = {}
    session._bootstrap_template = None
    session._close_sync = lambda: None
    return session


def test_switch_auth_stashes_and_restores_templates_per_account() -> None:
    session = _bare_session("/accounts/a.json")
    session._templates = {"gemini-3-pro-image": {"body": "a-template"}}

    session._switch_auth_sync("/accounts/b.json")
    assert session._templates == {}
    assert session._account_template_stash["/accounts/a.json"] == {"gemini-3-pro-image": {"body": "a-template"}}

    session._templates = {"gemini-3-pro-image": {"body": "b-template"}}
    session._switch_auth_sync("/accounts/a.json")
    assert session._templates == {"gemini-3-pro-image": {"body": "a-template"}}
    assert session._account_template_stash["/accounts/b.json"] == {"gemini-3-pro-image": {"body": "b-template"}}


def test_switch_auth_keeps_a_default_bucket_for_shared_sessions() -> None:
    session = _bare_session(None)
    session._templates = {"gemma-4-31b-it": {"body": "default-template"}}

    session._switch_auth_sync("/accounts/a.json")

    assert session._account_template_stash["default"] == {"gemma-4-31b-it": {"body": "default-template"}}


def test_invalidate_template_drops_active_and_stashed_copies() -> None:
    session = _bare_session("/accounts/a.json")
    session._templates = {"gemini-3-pro-image": {"body": "stale"}}
    session._account_template_stash["/accounts/a.json"] = {"gemini-3-pro-image": {"body": "stale"}}
    session._bootstrap_template = {"body": "stale"}

    session._invalidate_template_sync("gemini-3-pro-image")

    assert "gemini-3-pro-image" not in session._templates
    assert "gemini-3-pro-image" not in session._account_template_stash["/accounts/a.json"]
    assert session._bootstrap_template is None


def test_warmup_drives_full_cold_start_not_just_browser_context() -> None:
    import asyncio

    from aistudio_api.infrastructure.gateway.client import AIStudioClient

    calls: list[str] = []

    class _Session:
        async def ensure_botguard_service(self):
            calls.append("botguard")

        async def ensure_context(self):
            calls.append("context")

    client = AIStudioClient.__new__(AIStudioClient)
    client._session = _Session()

    asyncio.run(client.warmup())

    assert calls == ["botguard"]
