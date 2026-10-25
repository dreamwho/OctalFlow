from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient


RUNTIME_KEY = "fixture-runtime-key-0123456789abcdef"
UPSTREAM_TOKEN = "catalog-upstream-token-secret"


def test_authenticated_backend_catalog_method_uses_verified_route_and_token(monkeypatch):
    from services.openai_backend_api import OpenAIBackendAPI

    received: dict[str, object] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            received["path"] = self.path
            received["authorization"] = self.headers.get("Authorization")
            body = json.dumps({"models": [{"slug": "gpt-5-test"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(OpenAIBackendAPI, "_bootstrap", lambda self: None)
    try:
        with OpenAIBackendAPI(UPSTREAM_TOKEN) as backend:
            backend.base_url = f"http://127.0.0.1:{server.server_port}"
            payload = backend.fetch_authenticated_model_catalog()
        assert payload == {"models": [{"slug": "gpt-5-test"}]}
        assert received == {
            "path": "/backend-api/models?history_and_training_disabled=false",
            "authorization": f"Bearer {UPSTREAM_TOKEN}",
        }
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_admin_refresh_persists_authenticated_snapshot_and_failed_refresh_keeps_it(
    runtime_data_dir, monkeypatch
):
    from api.app import create_app
    from services.account_service import account_service
    from services.config import config
    from services.model_catalog_service import ModelCatalogService
    from services.openai_backend_api import OpenAIBackendAPI
    from services.storage.configuration_repository import SystemSettingsModel

    app = create_app()
    client = TestClient(app)
    transport = {"x-dreamyo-runtime-key": RUNTIME_KEY}
    admin = {**transport, "authorization": f"Bearer {RUNTIME_KEY}"}
    user_result = client.post(
        "/api/auth/users", headers=admin, json={"name": "catalog reader"}
    )
    user_headers = {**transport, "authorization": f"Bearer {user_result.json()['raw_key']}"}

    accounts = [
        {"status": "限流", "access_token": "limited-token", "management_id": "limited"},
        {"status": "禁用", "access_token": "disabled-token", "management_id": "disabled"},
        {
            "status": "正常",
            "access_token": "normal-token",
            "management_id": "public-0007",
            "email": "safe-label@example.test",
        },
        {"status": "正常", "access_token": "must-not-be-selected", "management_id": "other"},
    ]
    selected_tokens: list[str] = []
    monkeypatch.setattr(account_service, "list_accounts", lambda: accounts)
    monkeypatch.setattr(
        account_service,
        "ensure_access_token",
        lambda token, **_kwargs: selected_tokens.append(token) or token,
    )

    class Backend:
        def __init__(self, token):
            selected_tokens.append(f"backend:{token}")

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def fetch_authenticated_model_catalog(self):
            return {
                "models": [
                    {"slug": "gpt-5-catalog"},
                    {"slug": "gpt-image-2.7"},
                    {"slug": "vision-only-input", "input_modalities": ["image"]},
                    {"slug": "tool-only", "tools": ["image_generation"]},
                    {"slug": "explicit-image-output", "output_modalities": ["text", "image"]},
                ]
            }

    monkeypatch.setattr("services.openai_backend_api.OpenAIBackendAPI", Backend)
    # Keep the imported symbol patch coherent with the service's lazy import.
    assert client.post("/api/model-catalog/refresh", headers=user_headers).status_code == 403
    assert client.get("/api/model-catalog", headers=user_headers).status_code == 403
    assert client.post("/api/model-catalog/refresh", headers=admin).status_code == 200
    view = client.get("/api/model-catalog", headers=admin)
    assert view.status_code == 200
    payload = view.json()
    assert payload["chat_models"] == ["gpt-5-catalog", "vision-only-input", "tool-only"]
    assert payload["image_models"] == ["gpt-image-2.7", "explicit-image-output"]
    assert payload["source"] == {"chat": "upstream", "image": "upstream"}
    assert payload["discovery"]["account_id"] == "public-0007"
    assert payload["discovery"]["account_label"] == "safe-label@example.test"
    assert selected_tokens == ["normal-token", "backend:normal-token"]
    assert "normal-token" not in view.text and "must-not-be-selected" not in view.text
    persisted = config._settings_repository.get()["model_catalog_snapshot"]
    assert persisted["chat_models"] == payload["chat_models"]
    assert "token" not in json.dumps(persisted).casefold()
    session = config._settings_repository.Session()
    try:
        encrypted_row = session.get(SystemSettingsModel, 1)
        assert encrypted_row is not None
        encrypted_json = json.dumps(encrypted_row.data)
        assert "normal-token" not in encrypted_json
        assert "catalog-upstream-token-secret" not in encrypted_json
    finally:
        session.close()

    config._last_repository_refresh_at = 0
    config.reload_if_changed()
    reloaded_view = ModelCatalogService().view().model_dump(mode="json")
    assert reloaded_view == payload

    class FailingBackend(Backend):
        def fetch_authenticated_model_catalog(self):
            raise RuntimeError("upstream unavailable")

    monkeypatch.setattr("services.openai_backend_api.OpenAIBackendAPI", FailingBackend)
    failed = client.post("/api/model-catalog/refresh", headers=admin)
    assert failed.status_code == 502
    assert "上游模型目录请求失败" in failed.text
    assert client.get("/api/model-catalog", headers=admin).json() == payload

    class TextOnlyBackend(Backend):
        def fetch_authenticated_model_catalog(self):
            return {"models": [{"slug": "gpt-6"}]}

    monkeypatch.setattr("services.openai_backend_api.OpenAIBackendAPI", TextOnlyBackend)
    refreshed = client.post("/api/model-catalog/refresh", headers=admin)
    assert refreshed.status_code == 200
    restored = refreshed.json()
    assert restored["chat_models"] == ["gpt-6"]
    assert "gpt-image-2.5-flare" in restored["image_models"]
    assert "gpt-image-2.5-sunburst" in restored["image_models"]
    assert restored["source"] == {"chat": "upstream", "image": "accounts"}
    assert restored["warnings"]
    assert config._settings_repository.get()["model_catalog_snapshot"]["image_models"] == []
    config._last_repository_refresh_at = 0
    config.reload_if_changed()
    assert client.get("/api/model-catalog", headers=admin).json() == restored


@pytest.mark.parametrize("payload", [None, {}, {"models": []}, {"models": [{"name": "no-slug"}]}])
def test_catalog_parser_rejects_missing_or_empty_upstream_payload(payload):
    from services.model_catalog_service import ModelCatalogService

    with pytest.raises(ValueError):
        ModelCatalogService._parse_upstream_payload(payload)


@pytest.mark.parametrize("normal_account", [False, True])
def test_text_only_discovery_keeps_previous_image_catalog_without_fabricating_upstream_models(monkeypatch, normal_account):
    from services.account_service import account_service
    from services.config import config
    from services.model_catalog_service import FALLBACK_IMAGE_MODELS, ModelCatalogService

    settings = {
        "model_catalog_snapshot": {
            "source": "upstream",
            "chat_models": ["gpt-5-catalog"],
            "image_models": [],
            "fetched_at": "2026-10-21T00:00:00Z",
            "account_id": "public-0007",
            "account_label": "safe-label@example.test",
            "endpoint": "/backend-api/models?history_and_training_disabled=false",
        }
    }
    monkeypatch.setattr(config, "get", lambda: settings)
    monkeypatch.setattr(account_service, "list_accounts", lambda: [
        {"access_token": "normal-token", "status": "正常", "source_type": "web", "type": "Free", "quota": 10},
    ] if normal_account else [])
    view = ModelCatalogService().view()
    assert view.chat_models == ("gpt-5-catalog",)
    assert view.image_models == tuple(FALLBACK_IMAGE_MODELS)
    assert view.defaults.image_model == "gpt-image-2"
    assert view.source.image == ("accounts" if normal_account else "fallback")
    assert "旧版兼容目录" in view.warnings[0]
    assert "Flare、Sunburst、exact" in view.warnings[0]
    assert "自动分配" in view.warnings[0]
    assert view.discovery.account_id == "public-0007"
    assert settings["model_catalog_snapshot"]["image_models"] == []
    assert set(view.all_models) == set(view.chat_models + view.image_models)
    from utils.helper import is_discovered_image_model
    assert not is_discovered_image_model("gpt-image-2.5-flare")


def test_text_only_discovery_preserves_configured_image_catalog(monkeypatch):
    from services.account_service import account_service
    from services.config import config
    from services.model_catalog_service import ModelCatalogService

    monkeypatch.setattr(config, "get", lambda: {
        "model_catalog_snapshot": {
            "source": "upstream", "chat_models": ["gpt-6"], "image_models": [],
            "account_id": "public-0007", "fetched_at": "2026-10-21T00:00:00Z",
        },
        "image_generation": {"model_options": ["gpt-image-2.5-flare", "gpt-image-2", "gpt-image-2.5-flare"]},
    })
    monkeypatch.setattr(account_service, "list_accounts", lambda: pytest.fail("configured catalog must not read accounts"))
    view = ModelCatalogService().view()
    assert view.image_models == ("gpt-image-2.5-flare", "gpt-image-2")
    assert view.defaults.image_model == "gpt-image-2"
    assert view.source.image == "config"


def test_real_upstream_image_catalog_takes_priority_over_compatibility_catalog(monkeypatch):
    from services.account_service import account_service
    from services.config import config
    from services.model_catalog_service import ModelCatalogService

    monkeypatch.setattr(config, "get", lambda: {
        "model_catalog_snapshot": {
            "source": "upstream", "chat_models": [], "image_models": ["gpt-image-new"],
            "account_id": "public-0007", "fetched_at": "2026-10-21T00:00:00Z",
        },
        "image_generation": {"model_options": ["gpt-image-2.5-flare"]},
    })
    monkeypatch.setattr(account_service, "list_accounts", lambda: pytest.fail("real upstream catalog must not read accounts"))
    view = ModelCatalogService().view()
    assert view.image_models == ("gpt-image-new",)
    assert view.defaults.chat_model is None
    assert view.defaults.image_model == "gpt-image-new"
    assert view.source.image == "upstream"
    assert not view.warnings

