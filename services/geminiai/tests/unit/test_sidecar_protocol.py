from fastapi import FastAPI
from fastapi.testclient import TestClient

from aistudio_api.api.app import app as sidecar_app
from aistudio_api.api.dependencies import get_account_service
from aistudio_api.api.routes_accounts import router as accounts_router
from aistudio_api.api.routes_openai import router as openai_router
from aistudio_api.api.routes_system import public_router
from aistudio_api.config import settings


class _AccountService:
    def __init__(self) -> None:
        self.started_with: tuple[str | None, bool, str | None] | None = None

    async def start_login(self, name, *, headless, ui_locale):
        self.started_with = (name, headless, ui_locale)
        return "login_test"


def test_login_start_exposes_headless_and_ui_locale_without_changing_legacy_name_only_calls():
    account_service = _AccountService()
    app = FastAPI()
    app.include_router(accounts_router)
    app.dependency_overrides[get_account_service] = lambda: account_service
    client = TestClient(app)

    response = client.post(
        "/accounts/login/start",
        json={"name": "Google account", "headless": True, "ui_locale": "zh-CN"},
    )

    assert response.status_code == 200
    assert response.json() == {"session_id": "login_test"}
    assert account_service.started_with == ("Google account", True, "zh-CN")


def test_sidecar_exposes_health_models_and_required_protocol_routes():
    app = FastAPI()
    app.include_router(public_router)
    app.include_router(openai_router)
    client = TestClient(app)

    health = client.get("/health")
    models = client.get("/v1/models")
    route_paths = set(sidecar_app.openapi()["paths"])

    assert health.status_code == 200
    assert health.json()["status"] == "ok"
    assert models.status_code == 200
    assert models.json()["object"] == "list"
    model_ids = {model["id"] for model in models.json()["data"]}
    assert {"gemini-3.1-flash-image", "gemini-3-pro-image"}.issubset(model_ids)
    assert "gemini-3.1-flash-lite-image" not in model_ids
    assert "gemini-3.1-flash-image-preview" not in model_ids
    assert {
        "/health",
        "/accounts",
        "/v1/chat/completions",
        "/v1/images/generations",
        "/v1/images/edits",
        "/v1beta/{model_path}:generateContent",
    }.issubset(route_paths)


def test_health_is_public_while_provider_models_require_the_internal_key(monkeypatch):
    monkeypatch.setattr(settings, "api_keys", frozenset({"test-sidecar-key"}))
    client = TestClient(sidecar_app)

    assert client.get("/health").status_code == 200
    assert client.get("/v1/models").status_code == 401
    assert client.get("/v1/models", headers={"Authorization": "Bearer test-sidecar-key"}).status_code == 200
