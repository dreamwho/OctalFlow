from __future__ import annotations

from fastapi.testclient import TestClient
import pytest

from api.app import create_app
from services.account_test_service import AccountTestService
from services.account_service import account_service

RUNTIME_KEY = "fixture-runtime-key-0123456789abcdef"
HEADERS = {
    "x-dreamyo-runtime-key": RUNTIME_KEY,
    "authorization": f"Bearer {RUNTIME_KEY}",
}
ACCOUNT = {
    "id": "selected-account",
    "email": "selected@example.test",
    "access_token": "fixture-secret-token",
    "quota": 8,
}


@pytest.fixture(autouse=True)
def isolated_account_test_logs(monkeypatch, tmp_path):
    from services.call_record_service import CallRecordService

    isolated = CallRecordService(database_url=f"sqlite:///{tmp_path / 'account-test-logs.db'}")
    monkeypatch.setattr("services.log_service.log_service", isolated)


def _client(monkeypatch, account=ACCOUNT):
    import api.accounts as accounts_api

    monkeypatch.setattr(accounts_api, "_get_account_by_id", lambda account_id: account if account_id == "selected-account" else None)
    monkeypatch.setattr(account_service, "get_account_by_id", lambda account_id: account if account_id == "selected-account" else None)
    return TestClient(create_app())


def _payload(**overrides):
    return {"mode": "chat", "model": "gpt-test", "prompt": "hello", **overrides}


def test_restricted_app_allows_admin_account_test_and_returns_call_id(monkeypatch):
    from services.account_test_service import account_test_service

    monkeypatch.setattr(account_test_service, "execute", lambda payload: {
        "status": "success", "status_label": "测试通过", "tone": "success",
        "account_id": payload["account_id"], "account_label": "selected@example.test",
        "mode": payload["mode"], "mode_label": "对话", "model": payload["model"],
        "duration_ms": 1, "content": "ok", "image_urls": [], "call_id": "fixture-call-id",
    })
    response = _client(monkeypatch).post("/api/accounts/selected-account/test", headers=HEADERS, json=_payload())
    assert response.status_code == 200
    assert response.json()["call_id"]
    assert response.json()["account_id"] == "selected-account"


def test_account_test_rejects_non_admin_and_missing_account(monkeypatch):
    from services.auth_service import auth_service

    client = _client(monkeypatch)
    user, user_key = auth_service.create_key(role="user", name="account-test auth fixture")
    try:
        user_headers = {**HEADERS, "authorization": f"Bearer {user_key}"}
        assert client.post("/api/accounts/selected-account/test", headers=user_headers, json=_payload()).status_code == 403
        assert client.post("/api/accounts/missing/test", headers=HEADERS, json=_payload()).status_code == 404
    finally:
        auth_service.delete_key(str(user["id"]), role="user")


def test_account_test_request_rejects_invalid_or_blank_fields(monkeypatch):
    client = _client(monkeypatch)
    for payload in (
        {"mode": "unknown", "model": "m", "prompt": "p"},
        {"mode": "chat", "model": " ", "prompt": "p"},
        {"mode": "image", "model": "m", "prompt": "  "},
    ):
        response = client.post("/api/accounts/selected-account/test", headers=HEADERS, json=payload)
        assert response.status_code == 422


def test_disabled_account_does_not_start_upstream(monkeypatch):
    account = {**ACCOUNT, "enabled": False}
    monkeypatch.setattr(account_service, "get_account_by_id", lambda _account_id: account)
    monkeypatch.setattr(account_service, "ensure_access_token", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("upstream path reached")))
    result = AccountTestService().execute({"account_id": "selected-account", "mode": "chat", "model": "gpt-test", "prompt": "hello", "_call_id": "call-1"})
    assert result["status"] == "failed"
    assert result["error_code"] == "account_disabled"
    assert result["call_id"] == "call-1"


def test_chat_test_rejects_empty_response_and_upstream_error_event(monkeypatch):
    import services.account_test_service as account_test_module

    monkeypatch.setattr(account_service, "get_account_by_id", lambda _account_id: ACCOUNT)
    monkeypatch.setattr(account_service, "ensure_access_token", lambda token, **_kwargs: token)
    monkeypatch.setattr(account_service, "mark_text_used", lambda _token: None)
    monkeypatch.setattr(account_test_module, "account_processing_slot", lambda: __import__("contextlib").nullcontext())
    monkeypatch.setattr(account_test_module, "OpenAIBackendAPI", lambda **_kwargs: type("Backend", (), {"close": lambda self: None})())
    monkeypatch.setattr(account_test_module, "conversation_events", lambda *_args, **_kwargs: iter(()))
    empty = AccountTestService().execute({"account_id": "selected-account", "mode": "chat", "model": "gpt-test", "prompt": "hello", "_call_id": "empty-call"})
    assert empty["status"] == "failed"
    assert empty["error_code"] == "empty_upstream_response"

    monkeypatch.setattr(account_test_module, "conversation_events", lambda *_args, **_kwargs: iter([{"type": "conversation.error", "error": {"code": "auth_invalid", "message": "credential=fixture-secret-token"}}]))
    failed = AccountTestService().execute({"account_id": "selected-account", "mode": "chat", "model": "gpt-test", "prompt": "hello", "_call_id": "error-call"})
    assert failed["status"] == "failed"
    assert failed["error_code"] == "auth_invalid"
    assert "fixture-secret-token" not in failed["error_message"]


def test_chat_success_and_image_success_are_projected_without_internal_metadata(monkeypatch):
    import services.account_test_service as account_test_module

    monkeypatch.setattr(account_service, "get_account_by_id", lambda _account_id: ACCOUNT)
    tokens_used = []
    monkeypatch.setattr(account_service, "ensure_access_token", lambda token, **_kwargs: tokens_used.append(token) or token)
    monkeypatch.setattr(account_service, "mark_text_used", lambda _token: None)
    monkeypatch.setattr(account_service, "mark_image_result", lambda _token, _success: {**ACCOUNT, "quota": 7})
    monkeypatch.setattr(account_test_module, "account_processing_slot", lambda: __import__("contextlib").nullcontext())
    monkeypatch.setattr(account_test_module, "OpenAIBackendAPI", lambda **_kwargs: type("Backend", (), {"close": lambda self: None})())
    monkeypatch.setattr(account_test_module, "conversation_events", lambda *_args, **_kwargs: iter([{"type": "conversation.delta", "delta": "reply"}]))
    chat = AccountTestService().execute({"account_id": "selected-account", "mode": "chat", "model": "gpt-test", "prompt": "hello", "_call_id": "chat-call"})
    assert chat["status"] == "success" and chat["content"] == "reply"
    assert chat["call_id"] == "chat-call"
    assert tokens_used == ["fixture-secret-token"]

    monkeypatch.setattr(AccountTestService, "_execute_image", staticmethod(lambda *_args, **_kwargs: (["https://images.example.test/actual.png"], {**ACCOUNT, "quota": 7}, "conversation-image")))
    image = AccountTestService().execute({"account_id": "selected-account", "mode": "image", "model": "gpt-image-test", "prompt": "draw", "_call_id": "image-call"})
    assert image["status"] == "success"
    assert image["image_urls"] == ["https://images.example.test/actual.png"]
    assert image["call_id"] == "image-call"
    assert "fixture-secret-token" not in str(image)


def test_structured_image_failure_code_is_preserved(monkeypatch):
    import services.account_test_service as account_test_module
    from services.image_failure import ImageGenerationError, image_failure

    monkeypatch.setattr(account_service, "get_account_by_id", lambda _account_id: ACCOUNT)
    failure = image_failure("image_tool_error", raw_detail="upstream rejected image request")
    error = ImageGenerationError("upstream rejected image request", failure=failure)
    monkeypatch.setattr(AccountTestService, "_execute_image", staticmethod(lambda *_args, **_kwargs: (_ for _ in ()).throw(error)))
    result = AccountTestService().execute({"account_id": "selected-account", "mode": "image", "model": "gpt-image-test", "prompt": "draw", "_call_id": "failed-image-call"})
    assert result["status"] == "failed"
    assert result["error_code"] == "image_tool_error"
    assert result["image_urls"] == []
    assert result["call_id"] == "failed-image-call"


def test_image_test_rejects_empty_upstream_results(monkeypatch):
    import services.account_test_service as account_test_module

    monkeypatch.setattr(account_service, "get_account_by_id", lambda _account_id: ACCOUNT)
    monkeypatch.setattr(account_service, "ensure_access_token", lambda token, **_kwargs: token)
    monkeypatch.setattr(account_test_module, "account_processing_slot", lambda: __import__("contextlib").nullcontext())
    monkeypatch.setattr(account_test_module, "OpenAIBackendAPI", lambda **_kwargs: type("Backend", (), {"close": lambda self: None})())
    monkeypatch.setattr(account_test_module, "stream_image_outputs", lambda *_args, **_kwargs: iter(()))
    result = AccountTestService().execute({"account_id": "selected-account", "mode": "image", "model": "gpt-image-test", "prompt": "draw", "_call_id": "empty-image-call"})
    assert result["status"] == "failed"
    assert result["error_code"] == "account_test_failed"
    assert result["image_urls"] == []
