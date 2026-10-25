import os
import sys
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from aistudio_api.api.dependencies import get_client
from aistudio_api.api.routes_openai import router
from aistudio_api.infrastructure.gateway.model_catalog import ModelDeclaration, find_model, list_catalog, save_declarations
from aistudio_api.infrastructure.gateway.model_defaults import resolve_model_defaults
from aistudio_api.infrastructure.gateway.model_discovery import discover_models, read_model_picker


@pytest.fixture(autouse=True)
def isolated_catalog(monkeypatch, tmp_path):
    monkeypatch.setenv("AISTUDIO_ACCOUNTS_DIR", str(tmp_path / "accounts"))


def test_manual_declaration_persists_and_drives_image_defaults(tmp_path):
    save_declarations([ModelDeclaration(id=" models/gemini-new-render ", name=" 新图片模型 ", capability="image")], origin="manual")
    assert find_model("gemini-new-render")["name"] == "新图片模型"
    assert find_model("gemini-new-render")["catalog_origin"] == "manual"
    assert resolve_model_defaults("gemini-new-render").is_image_model
    assert (tmp_path / "accounts" / "model-catalog.json").stat().st_mode & 0o777 == 0o600
    save_declarations([ModelDeclaration(id="gemini-new-render", capability="text")], origin="aistudio")
    assert find_model("gemini-new-render")["capability"] == "image"
    with pytest.raises(ValueError, match="模型已存在"):
        save_declarations([ModelDeclaration(id="gemini-new-render", capability="text")], origin="manual")
    assert find_model("gemini-new-render")["capability"] == "image"
    save_declarations([ModelDeclaration(id="gemini-image-description", capability="text")], origin="manual")
    assert not resolve_model_defaults("gemini-image-description").is_image_model


@pytest.mark.parametrize("model", ["../file", "gemini-live-new", "veo-4", "gemini-omni-new", "gemini-tts-new"])
def test_invalid_or_unsupported_ids_are_not_registered(model):
    with pytest.raises(ValidationError):
        ModelDeclaration(id=model, capability="image")
    assert find_model(model) is None


def test_sidecar_add_sync_get_and_failed_sync_preserve_registry():
    class Session:
        fail = False

        async def discover_models(self):
            if self.fail:
                raise RuntimeError("当前 Google 授权已失效，请重新授权后获取模型目录")
            return [{"id": "gemini-new-text", "capability": "text"}]

    session = Session()
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_client] = lambda: SimpleNamespace(_session=session)
    client = TestClient(app)
    added = client.post("/config/models", json={"id": "gemini-new-render", "capability": "image"})
    assert added.status_code == 200
    assert client.post("/config/models", json={"id": "gemini-new-render", "capability": "text"}).status_code == 409
    assert client.get("/v1/models/gemini-new-render").json()["capability"] == "image"
    assert client.post("/config/models/sync").status_code == 200
    assert client.get("/v1/models/gemini-new-text").json()["catalog_origin"] == "aistudio"
    snapshot = list_catalog()
    session.fail = True
    failed = client.post("/config/models/sync")
    assert failed.status_code == 502
    assert "授权已失效" in failed.json()["detail"]["message"]
    assert list_catalog() == snapshot


def test_discovery_requires_authorized_browser_and_always_closes_tab():
    with pytest.raises(RuntimeError, match="浏览器尚未就绪"):
        discover_models(None)
    page = SimpleNamespace(url="https://accounts.google.com/login", goto=lambda *args, **kwargs: None, close=lambda: closed.append(True))
    closed = []
    with pytest.raises(RuntimeError, match="授权已失效"):
        discover_models(SimpleNamespace(new_page=lambda: page))
    assert closed == [True]


def test_real_browser_native_catalog_scans_scroll_and_never_generates(monkeypatch):
    executable = os.getenv("DREAMYO_OMNI_TEST_BROWSER")
    if not executable:
        pytest.skip("Set DREAMYO_OMNI_TEST_BROWSER to the local fixture browser")
    monkeypatch.delitem(sys.modules, "playwright", raising=False)
    from playwright.sync_api import sync_playwright
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True)
        try:
            page = browser.new_page()
            page.set_content('''<ms-model-selector><button class="model-selector-card" onclick="document.querySelector('[role=dialog]').hidden=false">Models</button></ms-model-selector>
              <div role="dialog" hidden><button onclick="render('Gemini')">Gemini</button><button onclick="render('Gemma')">Gemma</button><button onclick="render('Images')">Images</button>
                <div id="items" style="height:80px;overflow-y:auto"></div><button onclick="window.generated=true">Generate</button></div>
              <script>function render(tab){const ids=tab==='Images'?['gemini-new-render','gemini-nano-banana-2.1']:tab==='Gemma'?['gemma-new-text']:['gemini-new-text','gemini-new-text-2','gemini-live-new']; document.querySelector('#items').innerHTML=ids.map(id=>'<div style="height:100px">'+id+'</div>').join('');document.querySelector('#items').scrollTop=0;}</script>''')
            models = {row["id"]: row["capability"] for row in read_model_picker(page)}
            assert models == {"gemini-new-text": "text", "gemini-new-text-2": "text", "gemma-new-text": "text", "gemini-new-render": "image", "gemini-nano-banana-2.1": "image"}
            assert not page.evaluate("Boolean(window.generated)")
        finally:
            browser.close()


def test_cold_catalog_launch_skips_prompt_capture_and_generation_navigation(monkeypatch, tmp_path):
    from aistudio_api.infrastructure.gateway import session as session_module
    from aistudio_api.infrastructure.gateway.session import BrowserSession
    context = SimpleNamespace(pages=[], new_page=lambda: SimpleNamespace())
    monkeypatch.setattr(session_module, "sync_launch_persistent_context", lambda *args, **kwargs: context)
    monkeypatch.setattr(session_module, "sync_maximize_page_window", lambda page: None)
    session = BrowserSession.__new__(BrowserSession)
    session._profile_dir = str(tmp_path / "profile")
    session._auth_file = None
    session._goto_aistudio_sync = lambda page: pytest.fail("Catalog discovery must not initialize generation or accept terms")
    session._install_hooks_sync = lambda page: pytest.fail("Catalog discovery must not install generation hooks")
    assert session._ensure_browser_chromium_sync(0, read_only=True) is context
