from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from types import SimpleNamespace
import sys

import pytest

from aistudio_api.application import omni_video as omni
from aistudio_api.config import settings


@pytest.fixture
def service(tmp_path, monkeypatch):
    service = omni.OmniVideoService(omni.VideoTaskStore(tmp_path), None, lambda _: None)
    def pick_account(exclude=None):
        if exclude:
            raise omni.OmniVideoError("fixture has no further account")
        return "account-test", {}
    monkeypatch.setattr(service, "_pick_account", pick_account)
    return service


def test_signed_reference_uses_configured_app_origin_and_preserves_signature(monkeypatch):
    received = []
    contents = b"fixture-image" * 20

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            received.append(self.path)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(contents)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("GEMINIAI_REFERENCE_ASSET_ORIGIN", f"http://127.0.0.1:{server.server_port}")
    reference = "/api/reference.png?purpose=provider-read&signature=fixture"
    try:
        assert omni._fetch_reference_image(f"http://127.0.0.1:1{reference}") == contents
        assert received == [reference]
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_reference_download_failure_is_terminal_and_does_not_start_browser(service, monkeypatch):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_error(503, "fixture unavailable")

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    started = []
    monkeypatch.setattr(omni.OmniVideoRunner, "run", lambda *args: started.append(args))
    try:
        task = service.tasks.create("gemini-omni-1.1-flash", "fixture", 10, "1080p", "9:16", [f"http://127.0.0.1:{server.server_port}/reference.png"])
        service._execute(task.id)
        assert task.status == "failed"
        assert "reference image download failed" in task.error
        assert task.finished_at is not None
        assert started == []
        assert service._cooldown == {}
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_worker_survives_unexpected_task_failure_and_drains_queue(service, monkeypatch):
    tasks = [service.tasks.create("gemini-omni-1.1-flash", "fixture", 5, "720p", "16:9") for _ in range(2)]
    service._queue = [task.id for task in tasks]
    executed = []

    def execute(task_id):
        executed.append(task_id)
        if task_id == tasks[0].id:
            raise RuntimeError("fixture worker failure")

    monkeypatch.setattr(service, "_execute", execute)
    service._work_loop()
    assert executed == [task.id for task in tasks]
    assert tasks[0].status == "failed"
    assert tasks[0].error == "fixture worker failure"
    assert service._worker is None


def test_execution_uses_current_runtime_proxy(service, monkeypatch):
    task = service.tasks.create("gemini-omni-1.1-flash", "fixture", 5, "720p", "16:9")
    captured = []

    class Runner:
        def __init__(self, state, proxy, logger, progress):
            captured.append(proxy)

        def run(self, *args):
            captured.append(args[-1])
            args[4].write_bytes(b"fixture-video")
            return {"bytes": 13}

    monkeypatch.setattr(settings, "proxy_url", "http://127.0.0.1:7890")
    monkeypatch.setattr(omni, "OmniVideoRunner", Runner)
    service._execute(task.id)
    assert captured == [settings.proxy_url, "16:9"]
    assert task.status == "succeeded"


def test_runner_uses_browser_proxy_contract(monkeypatch, tmp_path):
    captured = []

    @contextmanager
    def browser(**kwargs):
        captured.append(kwargs)
        raise RuntimeError("stop before browser access")
        yield

    monkeypatch.setitem(sys.modules, "camoufox.sync_api", SimpleNamespace(Camoufox=browser))
    runner = omni.OmniVideoRunner({}, "http://fixture-user:fixture-pass@127.0.0.1:7890", lambda _: None)
    with pytest.raises(RuntimeError, match="stop before browser access"):
        runner.run("gemini-omni-1.1-flash", "fixture", 5, "720p", tmp_path / "out.mp4")
    assert captured[0]["proxy"] == {"server": "http://127.0.0.1:7890", "username": "fixture-user", "password": "fixture-pass"}


def test_task_view_exposes_execution_stage_without_echoing_prompt(service, monkeypatch):
    task = service.tasks.create("gemini-omni-1.1-flash", "private prompt", 5, "720p", "16:9")
    assert service.task_view(task.id)["execution_stage"] == "queued"
    assert "prompt" not in service.task_view(task.id)
    service._stage(task.id, "reference_download")
    restored = omni.VideoTaskStore(service.tasks.root).get(task.id)
    assert restored.status == "failed"  # a restart must terminate an interrupted task
    assert restored.execution_stage == "failed"


def test_missing_video_file_cannot_be_reported_as_success(service, monkeypatch):
    task = service.tasks.create("gemini-omni-1.1-flash", "fixture", 5, "720p", "16:9")

    class Runner:
        def __init__(self, *args):
            pass

        def run(self, *args):
            return {"bytes": 100}

    monkeypatch.setattr(omni, "OmniVideoRunner", Runner)
    service._execute(task.id)
    assert task.status == "failed"
    assert task.execution_stage == "failed"
    assert "video result file is missing" in task.error
    assert "video_url" not in service.task_view(task.id)


def test_dom_errors_do_not_cool_down_authorized_accounts(service):
    assert not service._mark_failure("account-test", 'Locator.click: Enter a prompt not found')
    assert service._cooldown == {}
    assert service._mark_failure("account-test", "account video quota exhausted (daily)")
    assert "account-test" in service._cooldown


def test_terminal_browser_error_retains_pointer_interception_details(service, monkeypatch):
    task = service.tasks.create("gemini-omni-1.1-flash", "fixture", 10, "1080p", "9:16")
    error = "warmup click call log " + "element is visible, enabled and stable\n" * 20 + "dialog-backdrop-blur-overlay intercepts pointer events"
    monkeypatch.setattr(omni.OmniVideoRunner, "run", lambda *args: (_ for _ in ()).throw(RuntimeError(error)))
    service._execute(task.id)
    assert task.status == "failed"
    assert task.error.endswith("dialog-backdrop-blur-overlay intercepts pointer events")
    assert service._cooldown == {}


def test_warmup_closes_blocking_dialog_with_aria_label_and_icon(monkeypatch):
    import os
    executable = os.getenv("DREAMYO_OMNI_TEST_BROWSER")
    if not executable:
        pytest.skip("Set DREAMYO_OMNI_TEST_BROWSER to the local fixture browser")
    monkeypatch.delitem(sys.modules, "playwright", raising=False)
    from playwright.sync_api import sync_playwright
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True)
        try:
            page = browser.new_page()
            page.set_content('''<textarea aria-label="Enter a prompt"></textarea>
                <button class="ctrl-enter-submits" onclick="window.submissions=(window.submissions||0)+1;
                    const result=document.createElement('div');result.textContent='Hello! How can I help you today?';document.body.append(result)">Run</button>
                <dialog><button aria-label="Close" onclick="this.closest('dialog').close()"><span>close</span></button></dialog>
                <script>document.querySelector('dialog').showModal()</script>''')
            assert page.locator("dialog").is_visible()
            assert page.locator("textarea").evaluate("el => {const r=el.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)!==el}")
            omni.OmniVideoRunner({}, None, lambda _: None)._warmup(page.context, page)
            assert not page.locator("dialog").is_visible()
            assert page.evaluate("window.submissions") == 1
            assert page.locator("textarea").input_value().startswith("Reply exactly:")
        finally:
            browser.close()


def test_warmup_dismisses_dialog_arriving_after_prompt_fill(monkeypatch):
    import os
    executable = os.getenv("DREAMYO_OMNI_TEST_BROWSER")
    if not executable:
        pytest.skip("Set DREAMYO_OMNI_TEST_BROWSER to the local fixture browser")
    monkeypatch.delitem(sys.modules, "playwright", raising=False)
    from playwright.sync_api import sync_playwright
    html = '''<textarea oninput="document.querySelector('dialog').showModal()"></textarea>
        <button class="ctrl-enter-submits" onclick="window.submissions=(window.submissions||0)+1;
            const result=document.createElement('div');result.textContent='Hello! How can I help you today?';document.body.append(result)">Run</button>
        <div class="cdk-overlay-container"><dialog><button aria-label="Close"
            onclick="this.closest('dialog').close()"><span>close</span></button></dialog></div>'''
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True)
        try:
            page = browser.new_page()
            page.route("**/*", lambda route: route.fulfill(content_type="text/html", body=html))
            runner = omni.OmniVideoRunner({}, None, lambda _: None)
            runner._open_studio(page)
            runner._warmup(page.context, page)
            assert page.evaluate("window.submissions") == 1
            assert not page.locator("dialog").is_visible()
        finally:
            browser.close()


@pytest.mark.parametrize("overlay", ["hidden-close", "stacked", "unknown", "terms-close", "orphan-backdrop"])
def test_warmup_handles_current_overlay_without_bypassing_account_setup(monkeypatch, overlay):
    import os
    executable = os.getenv("DREAMYO_OMNI_TEST_BROWSER")
    if not executable:
        pytest.skip("Set DREAMYO_OMNI_TEST_BROWSER to the local fixture browser")
    monkeypatch.delitem(sys.modules, "playwright", raising=False)
    from playwright.sync_api import sync_playwright

    close = '<button aria-label="Close" onclick="window.fixtureOverlayClosed=(window.fixtureOverlayClosed||0)+1;this.closest(\'.layer\').remove()">close</button>'
    content = close
    if overlay == "unknown":
        content = '<h2>Confirm account settings</h2><button onclick="window.accepted=true">Continue</button>'
    if overlay == "terms-close":
        content += '<button aria-label="Accept terms of service" onclick="window.accepted=true">Continue</button>'
    layer = f'''<div class="layer" style="display:none">
        <div class="cdk-overlay-backdrop cdk-overlay-backdrop-showing dialog-backdrop-blur-overlay"></div>
        <div class="cdk-overlay-pane" role="dialog">{content}</div></div>'''
    if overlay == "orphan-backdrop":
        layer = '<div class="layer" style="display:none"><div class="cdk-overlay-backdrop cdk-overlay-backdrop-showing dialog-backdrop-blur-overlay"></div></div>'
    html = f'''<style>.cdk-overlay-backdrop {{position:fixed;inset:0;background:#7778}}
        .cdk-overlay-pane {{position:fixed;top:100px;left:100px;background:white}}</style>
        <textarea oninput="document.querySelectorAll('.layer').forEach(el=>el.style.display='block')"></textarea>
        <button class="ctrl-enter-submits" onclick="window.submissions=(window.submissions||0)+1;
            const result=document.createElement('div');result.textContent='Hello! How can I help you today?';document.body.append(result)">Run</button>
        <div class="cdk-overlay-container">
            <div class="cdk-overlay-pane" style="display:none"><button aria-label="Close" onclick="window.hiddenClicked=true">Close</button></div>
            {layer}{layer if overlay == "stacked" else ''}
        </div>'''
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True)
        try:
            page = browser.new_page()
            # A short fixture action timeout exposes an unhandled overlay; production keeps its existing timeouts.
            page.set_default_timeout(1500)
            page.route("**/*", lambda route: route.fulfill(content_type="text/html", body=html))
            runner = omni.OmniVideoRunner({}, None, lambda _: None)
            runner._open_studio(page)
            if overlay in {"hidden-close", "stacked"}:
                runner._warmup(page.context, page)
                assert page.evaluate("window.submissions") == 1
                assert page.evaluate("window.fixtureOverlayClosed") == (2 if overlay == "stacked" else 1)
                assert page.locator(".cdk-overlay-backdrop:visible").count() == 0
            else:
                message = "account requires AI Studio terms acceptance" if overlay == "terms-close" else "AI Studio dialog blocks submission"
                with pytest.raises(omni.OmniVideoError, match=message):
                    runner._warmup(page.context, page)
                assert not page.evaluate("Boolean(window.accepted || window.submissions || window.fixtureOverlayClosed)")
                assert page.locator(".cdk-overlay-backdrop:visible").count() == 1
            assert not page.evaluate("Boolean(window.hiddenClicked)")
        finally:
            browser.close()


@pytest.mark.parametrize("late", [False, True])
def test_account_terms_are_reported_and_never_accepted(monkeypatch, late):
    import os
    executable = os.getenv("DREAMYO_OMNI_TEST_BROWSER")
    if not executable:
        pytest.skip("Set DREAMYO_OMNI_TEST_BROWSER to the local fixture browser")
    monkeypatch.delitem(sys.modules, "playwright", raising=False)
    from playwright.sync_api import sync_playwright
    html = '''<textarea oninput="document.querySelector('dialog').showModal()"></textarea>
        <button class="ctrl-enter-submits" onclick="window.submissions=(window.submissions||0)+1">Run</button>
        <dialog><p>Welcome to AI Studio. Terms of service apply.</p>
            <button aria-label="Accept terms of service" onclick="window.accepted=true">Continue</button></dialog>'''
    if not late:
        html += "<script>document.querySelector('dialog').showModal()</script>"
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True)
        try:
            page = browser.new_page()
            page.route("**/*", lambda route: route.fulfill(content_type="text/html", body=html))
            runner = omni.OmniVideoRunner({}, None, lambda _: None)
            with pytest.raises(omni.OmniVideoError, match="account requires AI Studio terms acceptance"):
                runner._open_studio(page)
                runner._warmup(page.context, page)
            assert not page.evaluate("Boolean(window.accepted || window.submissions)")
        finally:
            browser.close()


def test_overlay_guard_does_not_close_intentionally_opened_model_picker(monkeypatch):
    import os
    executable = os.getenv("DREAMYO_OMNI_TEST_BROWSER")
    if not executable:
        pytest.skip("Set DREAMYO_OMNI_TEST_BROWSER to the local fixture browser")
    monkeypatch.delitem(sys.modules, "playwright", raising=False)
    from playwright.sync_api import sync_playwright
    html = '''<textarea></textarea>
        <ms-model-selector><button class="model-selector-card" onclick="document.querySelector('dialog').showModal()">Models</button></ms-model-selector>
        <div class="cdk-overlay-container"><dialog>
            <button aria-label="Close" onclick="window.closedPicker=true;this.closest('dialog').close()">Close</button>
            <button>Video</button><button onclick="window.selected=true;this.closest('dialog').close()">Gemini Omni 1.1 Flash</button>
        </dialog></div><input type="number" aria-label="Video duration in seconds">'''
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True)
        try:
            page = browser.new_page()
            page.route("**/*", lambda route: route.fulfill(content_type="text/html", body=html))
            runner = omni.OmniVideoRunner({}, None, lambda _: None)
            runner._open_studio(page)
            runner._select_model(page, "gemini-omni-1.1-flash")
            assert page.evaluate("window.selected")
            assert not page.evaluate("Boolean(window.closedPicker)")
        finally:
            browser.close()


def test_chinese_composer_and_real_run_button_submit_without_english_labels(monkeypatch):
    import os
    executable = os.getenv("DREAMYO_OMNI_TEST_BROWSER")
    if not executable:
        pytest.skip("Set DREAMYO_OMNI_TEST_BROWSER to the local fixture browser")
    # Login unit tests install a process-wide fake package at collection time.
    # Restore it after this isolated real-browser fixture finishes.
    monkeypatch.delitem(sys.modules, "playwright", raising=False)
    from playwright.sync_api import sync_playwright
    monkeypatch.setattr(omni.time, "sleep", lambda _: None)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True)
        try:
            page = browser.new_page()
            page.set_content('''<button aria-label="Download" style="display:none"
                    onclick="window.hiddenDownloadClicked = true">Download</button>
                <textarea aria-label="输入提示词"></textarea>
                <button class="ctrl-enter-submits" onclick="
                    window.submissions = (window.submissions || 0) + 1;
                    const text = document.querySelector('textarea').value;
                    const result = document.createElement('div');
                    if (!text.startsWith('Reply exactly:')) result.setAttribute('contenteditable','false');
                    result.textContent = text.startsWith('Reply exactly:') ? 'Hello! How can I help you today?' : text.replace(/\\n/g,'') + text;
                    document.body.append(result);
                    if (text.startsWith('Reply exactly:')) {
                        this.textContent = 'Stop';
                        setTimeout(() => { this.textContent = 'Run'; window.warmupSettled = true; }, 10);
                    }
                    if (!text.startsWith('Reply exactly:')) {
                        const button = document.createElement('button');
                        button.textContent = 'Download'; document.body.append(button);
                    }
                ">运行</button>''')
            page.locator("textarea").fill("中文视频\n提示词")
            assert not omni._prompt_submitted(page, "中文视频\n提示词")
            stages = []
            runner = omni.OmniVideoRunner({}, None, lambda _: None, stages.append)
            runner._warmup(page.context, page)
            assert page.evaluate("window.warmupSettled")
            runner._submit_and_wait(page, "中文视频\n提示词", page.context)
            assert page.evaluate("window.submissions") == 2
            assert page.locator("textarea").input_value() == "中文视频\n提示词"
            assert stages == ["generating"]
            assert not page.evaluate("Boolean(window.hiddenDownloadClicked)")
        finally:
            browser.close()


def test_download_uses_visible_control_when_hidden_download_comes_first(monkeypatch, tmp_path):
    import os
    executable = os.getenv("DREAMYO_OMNI_TEST_BROWSER")
    if not executable:
        pytest.skip("Set DREAMYO_OMNI_TEST_BROWSER to the local fixture browser")
    monkeypatch.delitem(sys.modules, "playwright", raising=False)
    from playwright.sync_api import sync_playwright

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            if self.path == "/video.mp4":
                self.send_header("Content-Disposition", 'attachment; filename="video.mp4"')
                contents = b"fixture-video"
            else:
                contents = b'''<button aria-label="Download" style="display:none">Download</button>
                    <button aria-label="Download" onclick="location.href='/video.mp4'">Download</button>'''
            self.end_headers()
            self.wfile.write(contents)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=executable, headless=True)
            try:
                page = browser.new_page()
                page.goto(f"http://127.0.0.1:{server.server_port}")
                target = tmp_path / "video.mp4"
                omni.OmniVideoRunner({}, None, lambda _: None)._download(page, target)
                assert target.read_bytes() == b"fixture-video"
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.parametrize("duration,disabled", [(5, False), (10, True)])
def test_video_settings_apply_requested_duration_resolution_and_aspect(monkeypatch, duration, disabled):
    import os
    executable = os.getenv("DREAMYO_OMNI_TEST_BROWSER")
    if not executable:
        pytest.skip("Set DREAMYO_OMNI_TEST_BROWSER to the local fixture browser")
    monkeypatch.delitem(sys.modules, "playwright", raising=False)
    from playwright.sync_api import sync_playwright
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True)
        try:
            page = browser.new_page()
            page.set_content('''<input type="number" aria-label="Video duration in seconds" value="10">
                <button role="combobox" aria-label="Video Resolution" id="resolution"
                    onclick="document.querySelector('#res-options').hidden=false">360p</button>
                <div id="res-options" hidden><button role="option"
                    onclick="document.querySelector('#resolution').textContent='1080p'; this.parentElement.hidden=true">1080p</button></div>
                <button role="combobox" aria-label="Aspect ratio" id="aspect"
                    onclick="document.querySelector('#aspect-options').hidden=false">Auto</button>
                <div id="aspect-options" hidden><button role="option"
                    onclick="document.querySelector('#aspect').textContent='9:16'; this.parentElement.hidden=true">9:16</button></div>''')
            if disabled:
                page.get_by_role("spinbutton").evaluate("input => input.disabled = true")
            omni.OmniVideoRunner({}, None, lambda _: None)._apply_settings(page, duration, "1080p", "9:16")
            assert page.get_by_role("spinbutton").input_value() == str(duration)
            assert page.get_by_role("combobox", name="Video Resolution").inner_text() == "1080p"
            assert page.get_by_role("combobox", name="Aspect ratio").inner_text() == "9:16"
        finally:
            browser.close()


@pytest.mark.parametrize("state", ["ready", "loading", "decode_failed", "missing"])
def test_real_browser_attachment_requires_each_original_image_and_tokens(monkeypatch, tmp_path, state):
    import os
    executable = os.getenv("DREAMYO_OMNI_TEST_BROWSER")
    if not executable:
        pytest.skip("Set DREAMYO_OMNI_TEST_BROWSER to the local fixture browser")
    monkeypatch.delitem(sys.modules, "playwright", raising=False)
    from playwright.sync_api import sync_playwright
    files = [tmp_path / f"ref-{index}.png" for index in range(3)]
    for file in files:
        file.write_bytes(b"fixture-image")
    monkeypatch.setattr(settings, "timeout_replay", 1)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True)
        try:
            page = browser.new_page()
            page.set_content('''<div aria-busy="true">unrelated busy component</div>
                <input type="file" multiple onchange="for (const file of this.files) {
                    const item=document.createElement('ms-prompt-media');
                    item.innerHTML='<span class=name></span><ms-token-status>Loading...</ms-token-status>';
                    item.querySelector('.name').textContent=file.name;document.body.append(item);
                    requestAnimationFrame(()=>{
                        const image=document.createElement('img');
                        image.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                        item.append(image);item.querySelector('ms-token-status').textContent='259 tokens';
                    });
                }">''')
            if state != "ready":
                page.locator("input").evaluate("(el, state) => el.addEventListener('change', () => requestAnimationFrame(() => { const items=[...document.querySelectorAll('ms-prompt-media')]; if(state==='missing') items[2].remove(); else if(state==='loading') items[2].querySelector('ms-token-status').textContent='Loading...'; else items[2].querySelector('img').src='data:image/png;base64,AA=='; }))", state)
            logs = []
            runner = omni.OmniVideoRunner({}, "", logs.append)
            if state == "ready":
                runner._attach_images(page, files)
                assert logs[-1] == "omni: reference images ready"
            else:
                with pytest.raises(omni.OmniVideoError, match="reference image preprocessing did not complete"):
                    runner._attach_images(page, files)
                assert "omni: reference images ready" not in logs
        finally:
            browser.close()


def test_completion_notification_uses_internal_origin_and_does_not_persist_key(service, monkeypatch):
    import json
    from threading import Event
    received = Event()
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            requests.append((self.path, self.headers.get("Authorization"), json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
            self.send_response(200)
            self.end_headers()
            received.set()
        def log_message(self, *_):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("GEMINIAI_REFERENCE_ASSET_ORIGIN", f"http://127.0.0.1:{server.server_port}")
    task = service.tasks.create("gemini-omni-1.1-flash", "fixture", 10, "1080p", "9:16")
    service._notification_keys[task.id] = "fixture-notification-key"
    try:
        service._fail(task.id, "fixture terminal failure")
        assert received.wait(settings.timeout_capture)
        assert requests == [("/api/maintenance/geminiai-videos/notify", "Bearer fixture-notification-key", {"upstreamTaskId": task.id})]
        assert task.status == "failed"
        assert "fixture-notification-key" not in service.tasks._path(task.id).read_text()
        assert task.id not in service._notification_keys
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.parametrize("initial_model", ["Gemma 4 31B IT", "Gemini Flash"])
def test_model_controls_are_waited_for_without_fixed_delays(monkeypatch, initial_model):
    import os
    executable = os.getenv("DREAMYO_OMNI_TEST_BROWSER")
    if not executable:
        pytest.skip("Set DREAMYO_OMNI_TEST_BROWSER to the local fixture browser")
    monkeypatch.delitem(sys.modules, "playwright", raising=False)
    from playwright.sync_api import sync_playwright
    monkeypatch.setattr(omni.time, "sleep", lambda _: pytest.fail("model selection must wait on DOM state"))
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True)
        try:
            page = browser.new_page()
            page.set_content('''<ms-model-selector><button class="model-selector-card" onclick="setTimeout(() => {
                const button=document.createElement('button');button.textContent='Video';
                button.onclick=()=>{const model=document.createElement('button');model.textContent='Gemini Omni 1.1 Flash';
                  model.onclick=()=>{const input=document.createElement('input'); input.type='number'; input.setAttribute('aria-label','Video duration in seconds');document.body.append(input)};
                  document.body.append(model)};document.body.append(button)},10)">initial model</button></ms-model-selector>''')
            page.locator("ms-model-selector button").evaluate("(button, name) => button.textContent = name", initial_model)
            omni.OmniVideoRunner({}, None, lambda _: None)._select_model(page, "gemini-omni-1.1-flash")
            assert page.get_by_role("spinbutton", name="Video duration in seconds").is_visible()
        finally:
            browser.close()


def test_settings_close_selected_popup_before_opening_next_control(monkeypatch):
    import os
    executable = os.getenv("DREAMYO_OMNI_TEST_BROWSER")
    if not executable:
        pytest.skip("Set DREAMYO_OMNI_TEST_BROWSER to the local fixture browser")
    monkeypatch.delitem(sys.modules, "playwright", raising=False)
    from playwright.sync_api import sync_playwright
    monkeypatch.setattr(omni.time, "sleep", lambda _: pytest.fail("settings must use popup state"))
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True)
        try:
            page = browser.new_page()
            page.set_content('''<input type="number" aria-label="Video duration in seconds" value="3">
                <button role="combobox" aria-label="Video Resolution" aria-expanded="false">360p</button>
                <button role="combobox" aria-label="Aspect ratio" aria-expanded="false">Auto</button>
                <script>
                window.opens=0;
                for (const control of document.querySelectorAll('[role=combobox]')) {
                    control.onclick=()=>{
                        window.opens++; control.setAttribute('aria-expanded','true');
                        const overlay=document.createElement('div');overlay.id='overlay';
                        overlay.style='position:fixed;inset:0;background:#0001;z-index:100';
                        const option=document.createElement('button');option.setAttribute('role','option');
                        option.textContent=control.getAttribute('aria-label')==='Video Resolution'?'1080p':'9:16';
                        option.onclick=e=>{e.stopPropagation();control.dataset.selected=option.textContent;control.setAttribute('aria-expanded','false')};
                        overlay.append(option);control.append(overlay);
                    };
                    control.onkeydown=e=>{if(e.key==='Escape')requestAnimationFrame(()=>{
                        document.getElementById('overlay')?.remove();control.textContent=control.dataset.selected;
                    })};
                }
                </script>''')
            runner = omni.OmniVideoRunner({}, None, lambda _: None)
            runner._apply_settings(page, 10, "1080p", "9:16")
            assert page.get_by_role("spinbutton").input_value() == "10"
            assert page.get_by_role("combobox", name="Video Resolution").inner_text() == "1080p"
            assert page.get_by_role("combobox", name="Aspect ratio").inner_text() == "9:16"
            assert page.locator("#overlay").count() == 0
            runner._apply_settings(page, 10, "1080p", "9:16")
            assert page.evaluate("window.opens") == 2
        finally:
            browser.close()
