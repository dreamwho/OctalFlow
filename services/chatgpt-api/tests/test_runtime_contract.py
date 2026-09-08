from __future__ import annotations

import json
import os
import sqlite3
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


RUNTIME_KEY = "fixture-runtime-key-0123456789abcdef"
ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
ACCOUNT_TOKEN = "fixture-access-token-never-network"
SECOND_ACCOUNT_TOKEN = "fixture-second-access-token-never-network"
PROXY_PASSWORD = "fixture-proxy-password-never-network"
MANUAL_PROXY_PASSWORD = "fixture-manual-proxy-password-never-network"
GROUP_PROXY_PASSWORD = "fixture-group-proxy-password-never-network"


def test_restricted_runtime_contract_and_encrypted_storage(runtime_data_dir, monkeypatch):
    data_dir = Path(os.environ["OCTALAICANVAS_CHATGPT_DATA_DIR"])
    assert data_dir == runtime_data_dir
    monkeypatch.setenv("DATABASE_URL", "postgresql://must-not-be-used.invalid/parent")
    monkeypatch.delenv("CHATGPT2API_AUTH_KEY", raising=False)
    monkeypatch.delenv("CHATGPT2API_BASE_URL", raising=False)

    from api.app import create_app
    from api import integration
    from services.account_service import account_service
    from services.application_database import resolve_database_url
    from services.ipwo_proxy_service import ipwo_proxy_service
    from services.log_service import LoggedCall, log_service
    from services.protocol import conversation
    from services.proxy_service import ProxyReferenceUnavailableError, proxy_settings

    app = create_app()
    client = TestClient(app)
    transport = {"x-octal-runtime-key": RUNTIME_KEY}
    admin = {**transport, "authorization": f"Bearer {RUNTIME_KEY}"}

    assert client.get("/integration/health").status_code == 401
    health = client.get("/integration/health", headers=transport)
    assert health.status_code == 200
    assert health.json() == {
        "status": "ok",
        "gateway": {"enabled": False},
        "storage": {"encrypted": True, "backend": "sqlite"},
    }
    assert RUNTIME_KEY not in health.text
    assert ENCRYPTION_KEY not in health.text
    ipwo_view = client.get("/integration/ipwo", headers=admin)
    assert ipwo_view.status_code == 200
    assert ipwo_view.json()["configured"] is False
    assert {
        thread.name
        for thread in threading.enumerate()
    }.isdisjoint({"account-lifecycle-watcher", "retention-cleanup-scheduler"})
    assert client.get("/v1/models", headers=admin).status_code == 503

    assert client.patch(
        "/integration/gateway", headers=admin, json={"enabled": True}
    ).json() == {"enabled": True}
    assert client.get("/integration/gateway", headers=admin).json() == {
        "enabled": True
    }

    created_key = client.post(
        "/api/auth/users", headers=admin, json={"name": "fixture user"}
    )
    assert created_key.status_code == 200
    user_key = created_key.json()["raw_key"]
    user_headers = {**transport, "authorization": f"Bearer {user_key}"}
    assert client.get("/integration/auth", headers=user_headers).json() == {
        "authenticated": True,
        "role": "user",
    }
    master_auth = client.get("/integration/auth", headers=admin)
    assert master_auth.status_code == 403
    assert master_auth.json() == {"authenticated": False, "role": "admin"}
    invalid_auth = client.get(
        "/integration/auth",
        headers={**transport, "authorization": "Bearer invalid-fixture-key"},
    )
    assert invalid_auth.status_code == 401
    assert invalid_auth.json() == {"authenticated": False, "role": None}

    models = client.get("/v1/models", headers=user_headers)
    assert models.status_code == 200
    assert client.patch(
        "/integration/gateway", headers=admin, json={"enabled": False}
    ).json() == {"enabled": False}
    assert client.get("/v1/models", headers=user_headers).status_code == 503
    assert client.get(
        "/v1/models", headers={"x-octal-internal-dispatch": "1"}
    ).status_code == 401
    assert client.get(
        "/v1/models",
        headers={**user_headers, "x-octal-internal-dispatch": "1"},
    ).status_code == 503
    internal_models = client.get(
        "/v1/models",
        headers={**admin, "x-octal-internal-dispatch": "1"},
    )
    assert internal_models.status_code == 200
    assert client.patch(
        "/integration/gateway", headers=admin, json={"enabled": True}
    ).json() == {"enabled": True}
    assert models.json()["object"] == "list"
    assert client.get("/api/model-catalog", headers=admin).status_code == 200
    assert client.get("/api/logs", headers=admin).status_code == 200

    settings = client.get("/api/settings", headers=admin)
    assert settings.status_code == 200
    assert settings.json()["settings"]["image_account_retry_enabled"] is False
    assert settings.json()["settings"]["auto_remove_invalid_accounts"] is False
    assert settings.json()["settings"]["auto_remove_rate_limited_accounts"] is False
    revision = settings.json()["revision"]
    assert client.patch(
        "/api/settings",
        headers=admin,
        json={"revision": revision, "log_levels": ["info"]},
    ).status_code == 200
    assert client.patch(
        "/api/settings",
        headers=admin,
        json={"revision": revision, "auto_remove_invalid_accounts": True},
    ).status_code == 422

    imported = client.post(
        "/api/accounts",
        headers=admin,
        json={
            "tokens": [ACCOUNT_TOKEN],
            "sync_after_import": False,
            "return_items": False,
        },
    )
    assert imported.status_code == 200
    assert imported.json()["added"] == 1
    assert imported.json()["skipped"] == 0
    assert imported.json()["errors"] == []
    assert "progress_id" not in imported.json()
    repeated = client.post("/api/accounts", headers=admin, json={
        "accounts": [{"access_token": ACCOUNT_TOKEN, "refresh_token": "fixture-refresh"}],
        "sync_after_import": False, "return_items": False,
    })
    assert repeated.status_code == 200
    assert repeated.json()["added"] == 0
    assert repeated.json()["skipped"] == 1
    assert "progress_id" not in repeated.json()
    listed = client.get("/api/accounts", headers=admin)
    assert listed.status_code == 200
    assert ACCOUNT_TOKEN not in listed.text
    assert client.post(
        "/api/accounts/batch-update", headers=admin, json={}
    ).status_code == 400

    generation_call = LoggedCall(
        {"id": "fixture", "name": "fixture", "role": "admin"},
        "/v1/chat/completions",
        "fixture-generation",
        "fixture generation",
    )
    generation_call.log("完成", status="success")
    quota_call = LoggedCall(
        {"id": "fixture", "name": "fixture", "role": "admin"},
        "/api/accounts/refresh",
        "quota_refresh",
        "账号额度刷新",
    )
    quota_call.log("开始", status="running")
    quota_call.log("完成", status="success")
    for time_range in ("24h", "7d", "30d"):
        statistics = client.get(
            "/integration/statistics",
            headers=admin,
            params={"time_range": time_range},
        )
        assert statistics.status_code == 200
        assert set(statistics.json()) == {
            "time_range", "window", "totals", "switching", "buckets", "trend", "runtime"
        }
        assert statistics.json()["time_range"] == time_range
        assert statistics.json()["totals"]["total"] == 1
        assert statistics.json()["totals"]["success"] == 1
        runtime = statistics.json()["runtime"]
        assert runtime["runtime_mode"] in ("native", "docker")
        assert runtime["cpu_capacity"] > 0
        assert runtime["service_uptime_seconds"] >= 0
        assert runtime["python_version"]

    manual_proxy = f"http://manual-user:{MANUAL_PROXY_PASSWORD}@127.0.0.1:8081"
    defaults = client.post(
        "/api/proxy/defaults",
        headers=admin,
        json={
            "default_reference": {"mode": "custom", "url": manual_proxy},
            "fallback_reference": {"mode": "custom", "url": manual_proxy},
        },
    )
    assert defaults.status_code == 200
    assert defaults.json()["default_reference"] == {"mode": "custom", "group_id": "", "url": ""}
    assert MANUAL_PROXY_PASSWORD not in defaults.text
    selection = client.get("/integration/proxy-selection", headers=admin)
    assert selection.status_code == 200
    assert selection.json() == {
        "enabled": False,
        "mode": "native",
        "native_source": "manual",
        "magicConfigured": False,
        "ipwoConfigured": False,
    }
    assert proxy_settings.get_profile().proxy_url == ""

    proxy_view = client.get("/api/proxy/view", headers=admin)
    assert proxy_view.status_code == 200
    assert proxy_view.json()["default_reference"] == {"mode": "custom", "group_id": "", "url": ""}
    assert MANUAL_PROXY_PASSWORD not in proxy_view.text
    preserved_defaults = client.post(
        "/api/proxy/defaults",
        headers=admin,
        json={
            "default_reference": proxy_view.json()["default_reference"],
            "fallback_reference": proxy_view.json()["fallback_reference"],
        },
    )
    assert preserved_defaults.status_code == 200
    assert proxy_settings.get_profile().proxy_url == ""

    monkeypatch.setenv("HTTP_PROXY", "http://environment-proxy.invalid:8080")
    monkeypatch.setenv("HTTPS_PROXY", "http://environment-proxy.invalid:8443")
    off_profile = proxy_settings.get_profile(
        account={"proxy": manual_proxy},
        proxy=manual_proxy,
        resource=True,
        upstream=True,
    )
    assert off_profile.proxy_url == ""
    assert off_profile.proxy_source == "direct"
    assert not off_profile.clearance_enabled
    assert proxy_settings.get_fallback_profile(upstream=True) is None
    off_kwargs = proxy_settings.build_session_kwargs(
        account={"proxy": manual_proxy}, proxy=manual_proxy, resource=True, upstream=True
    )
    assert off_kwargs["trust_env"] is False
    assert "proxy" not in off_kwargs
    assert proxy_settings.build_session_kwargs_from_profile(off_profile)["trust_env"] is False

    missing_magic = client.patch(
        "/integration/proxy-selection",
        headers=admin,
        json={"enabled": True, "mode": "magic", "native_source": "manual"},
    )
    assert missing_magic.status_code == 409
    missing_ipwo = client.patch(
        "/integration/proxy-selection",
        headers=admin,
        json={"enabled": True, "mode": "native", "native_source": "ipwo"},
    )
    assert missing_ipwo.status_code == 409
    for invalid_selection in (
        None,
        {"enabled": True, "mode": "invalid", "native_source": "manual"},
        {"enabled": True, "mode": "native", "native_source": "manual", "extra": True},
    ):
        invalid = client.patch(
            "/integration/proxy-selection",
            headers=admin,
            json=invalid_selection,
        )
        assert invalid.status_code == 400

    native_selection = client.patch(
        "/integration/proxy-selection",
        headers=admin,
        json={"enabled": True, "mode": "native", "native_source": "manual"},
    )
    assert native_selection.status_code == 200
    assert native_selection.json()["enabled"] is True
    assert native_selection.json()["mode"] == "native"
    assert native_selection.json()["native_source"] == "manual"
    assert proxy_settings.get_profile().proxy_url == manual_proxy

    ipwo_calls: list[str] = []

    def fixture_ipwo_proxy() -> str:
        ipwo_calls.append("acquired")
        return "http://198.51.100.10:8080"

    monkeypatch.setattr(ipwo_proxy_service, "is_configured", lambda: True)
    monkeypatch.setattr(ipwo_proxy_service, "get_runtime_proxy", fixture_ipwo_proxy)
    ipwo_selection = client.patch(
        "/integration/proxy-selection",
        headers=admin,
        json={"enabled": True, "mode": "native", "native_source": "ipwo"},
    )
    assert ipwo_selection.status_code == 200
    assert ipwo_calls == []
    ipwo_profile = proxy_settings.get_profile(account={"proxy": manual_proxy}, upstream=True)
    assert ipwo_profile.proxy_url == "http://198.51.100.10:8080"
    assert ipwo_calls == ["acquired"]
    assert proxy_settings.build_session_kwargs_from_profile(ipwo_profile)["proxy"] == ipwo_profile.proxy_url
    assert proxy_settings.build_headers({"X-Fixture": "1"}, proxy_profile=ipwo_profile) == {"X-Fixture": "1"}
    assert proxy_settings.get_runtime_status()["proxy_source"] == "ipwo"
    assert ipwo_calls == ["acquired"]

    backend_profiles: list[object] = []

    class FixtureTextBackend:
        def __init__(self, access_token: str) -> None:
            self.access_token = access_token
            self.proxy_profile = proxy_settings.get_profile(upstream=True)
            backend_profiles.append(self.proxy_profile)
            self.closed = False

        def close(self) -> None:
            self.closed = True

    text_backend = FixtureTextBackend("fixture-text-token")

    class FixtureConversationAccounts:
        @staticmethod
        def get_account(_token: str) -> dict[str, object]:
            return {}

        @staticmethod
        def mark_text_used(_token: str) -> None:
            return None

    monkeypatch.setattr(conversation, "account_service", FixtureConversationAccounts())
    monkeypatch.setattr(
        conversation,
        "conversation_events",
        lambda *_args, **_kwargs: iter([{"type": "conversation.delta", "delta": "fixture"}]),
    )
    assert list(conversation.stream_text_deltas(
        text_backend,
        conversation.ConversationRequest(model="fixture", prompt="fixture"),
    )) == ["fixture"]
    assert len(backend_profiles) == 1
    assert ipwo_calls == ["acquired", "acquired"]
    assert text_backend.closed is True
    assert client.patch(
        "/integration/proxy-selection",
        headers=admin,
        json={"enabled": True, "mode": "native", "native_source": "manual"},
    ).status_code == 200

    proxy = client.patch(
        "/integration/proxy",
        headers=admin,
        json={"proxyUrl": f"http://fixture-user:{PROXY_PASSWORD}@127.0.0.1:8080"},
    )
    assert proxy.status_code == 200
    assert proxy.json() == {"configured": True}
    assert client.get("/integration/proxy-selection", headers=admin).json()["mode"] == "native"
    assert proxy_settings.get_profile(account={"proxy": "direct"}).proxy_url == ""
    assert PROXY_PASSWORD not in client.get("/api/proxy/view", headers=admin).text

    magic_selection = client.patch(
        "/integration/proxy-selection",
        headers=admin,
        json={"enabled": True, "mode": "magic", "native_source": "manual"},
    )
    assert magic_selection.status_code == 200
    assert proxy_settings.get_profile(account={"proxy": "direct"}).proxy_url == (
        f"http://fixture-user:{PROXY_PASSWORD}@127.0.0.1:8080"
    )
    assert client.post(
        "/integration/proxy", headers=admin, json={"proxyUrl": None}
    ).json() == {"configured": False}
    with pytest.raises(ProxyReferenceUnavailableError, match="魔法代理"):
        proxy_settings.get_profile()

    disabled_selection = client.patch(
        "/integration/proxy-selection",
        headers=admin,
        json={"enabled": False, "mode": "magic", "native_source": "ipwo"},
    )
    assert disabled_selection.status_code == 200
    assert client.patch(
        "/integration/proxy",
        headers=admin,
        json={"proxyUrl": f"http://fixture-user:{PROXY_PASSWORD}@127.0.0.1:8080"},
    ).json() == {"configured": True}
    preserved_off = client.get("/integration/proxy-selection", headers=admin).json()
    assert preserved_off["enabled"] is False
    assert preserved_off["mode"] == "magic"
    assert preserved_off["native_source"] == "ipwo"
    assert proxy_settings.get_profile(account={"proxy": manual_proxy}).proxy_url == ""

    assert client.patch(
        "/integration/proxy-selection",
        headers=admin,
        json={"enabled": True, "mode": "native", "native_source": "manual"},
    ).status_code == 200
    assert proxy_settings.get_profile().proxy_url == manual_proxy

    group_proxy = f"http://group-user:{GROUP_PROXY_PASSWORD}@127.0.0.1:8082"
    created_group = client.post(
        "/api/proxy/groups",
        headers=admin,
        json={
            "id": "fixture-group",
            "create_only": True,
            "name": "Fixture group",
            "enabled": True,
            "strategy": "round_robin",
            "rotation_interval_minutes": 0,
            "notes": "fixture",
            "nodes": [{
                "id": "fixture-node",
                "name": "Fixture node",
                "url": group_proxy,
                "enabled": True,
                "image_concurrency_limit": 4,
                "notes": "fixture",
            }],
        },
    )
    assert created_group.status_code == 200
    assert GROUP_PROXY_PASSWORD not in created_group.text
    assert integration.REDACTED_PROXY_AUTH in created_group.json()["group"]["nodes"][0]["url"]
    preserved_node = client.post(
        "/api/proxy/groups",
        headers=admin,
        json={
            "id": "fixture-group",
            "nodes": [{
                "id": "fixture-node",
                "name": "Fixture node",
                "url": "",
                "enabled": True,
                "image_concurrency_limit": 4,
                "notes": "preserved",
            }],
        },
    )
    assert preserved_node.status_code == 200
    assert GROUP_PROXY_PASSWORD not in preserved_node.text
    assert proxy_settings.get_profile(proxy="group:fixture-group").proxy_url == group_proxy

    import_proxy = f"http://import-user:fixture-import-password-never-network@127.0.0.1:8083"
    imported_nodes = client.post(
        "/api/proxy/nodes/import",
        headers=admin,
        json={"text": f"{import_proxy} 7\n{group_proxy} 3\nnot-a-proxy"},
    )
    assert imported_nodes.status_code == 200
    assert imported_nodes.json()["added_count"] == 1
    assert imported_nodes.json()["duplicate_count"] == 1
    assert imported_nodes.json()["invalid_count"] == 1
    assert imported_nodes.json()["nodes"] == [
        {"url": import_proxy, "image_concurrency_limit": 7}
    ]

    tested_urls: list[str] = []

    def fixture_test_proxy(url: str) -> dict[str, object]:
        tested_urls.append(url)
        return {
            "ok": True,
            "status": 204,
            "latency_ms": 7,
            "error": None,
            "proxy_source": "input",
            "has_proxy": True,
        }

    monkeypatch.setattr(integration, "test_proxy", fixture_test_proxy)
    group_test = client.post(
        "/api/proxy/groups/test",
        headers=admin,
        json={"id": "fixture-group", "node_id": "fixture-node"},
    )
    assert group_test.status_code == 200
    assert group_test.json()["summary"]["total"] == 1
    assert group_test.json()["results"][0]["node_id"] == "fixture-node"
    assert tested_urls == [group_proxy]

    second_import = client.post(
        "/api/accounts",
        headers=admin,
        json={
            "tokens": [SECOND_ACCOUNT_TOKEN],
            "sync_after_import": False,
            "return_items": False,
        },
    )
    assert second_import.status_code == 200
    assert second_import.json()["added"] == 1

    terminal_event = threading.Event()
    original_add = log_service.append_item

    def track_refresh_log(
        item: dict[str, object],
        **data: object,
    ) -> None:
        original_add(item, **data)
        event = item.get("detail", {})
        if (
            item.get("type") == "call"
            and event.get("endpoint") == "/api/accounts/refresh"
            and event.get("status") != "running"
        ):
            terminal_event.set()

    monkeypatch.setattr(log_service, "append_item", track_refresh_log)
    synced_tokens: list[list[str]] = []

    def fixture_sync(
        tokens: list[str],
        progress_id: str | None = None,
        *,
        finalize_progress: bool = True,
    ) -> dict[str, object]:
        synced_tokens.append(list(tokens))
        return {"synced": len(tokens), "errors": []}

    monkeypatch.setattr(account_service, "sync_accounts_and_quota", fixture_sync)
    refresh = client.post(
        "/api/accounts/refresh",
        headers=admin,
        json={"selection": {"mode": "all"}},
    )
    assert refresh.status_code == 200
    refresh_id = refresh.json()["progress_id"]
    assert len(refresh.json()["target_ids"]) == 2
    assert terminal_event.wait(timeout=3)
    assert len(synced_tokens) == 1
    assert set(synced_tokens[0]) == {ACCOUNT_TOKEN, SECOND_ACCOUNT_TOKEN}
    assert client.get(f"/api/accounts/operations/{refresh_id}", headers=admin).status_code == 200
    assert client.get(f"/api/accounts/operations/{refresh_id}", headers=admin).status_code == 200

    def refresh_logs(progress_id: str) -> list[dict[str, object]]:
        return [
            item
            for item in log_service.list(type="call", limit=200)
            if isinstance(item.get("detail"), dict)
            and item["detail"].get("progress_id") == progress_id
        ]

    success_logs = refresh_logs(refresh_id)
    assert len(success_logs) == 1
    assert {item["detail"]["status"] for item in success_logs} == {"success"}
    assert [event["status"] for event in success_logs[0]["detail"]["request_meta"]["lifecycle"]] == ["running", "success"]
    assert len({item["detail"]["call_id"] for item in success_logs}) == 1
    assert success_logs[0]["detail"]["selection_mode"] == "all"

    terminal_event.clear()
    single_refresh = client.post(
        "/api/accounts/refresh",
        headers=admin,
        json={"account_ids": [refresh.json()["target_ids"][0]]},
    )
    assert single_refresh.status_code == 200
    single_refresh_id = single_refresh.json()["progress_id"]
    assert terminal_event.wait(timeout=3)
    assert len(synced_tokens) == 2
    assert len(synced_tokens[1]) == 1
    single_logs = refresh_logs(single_refresh_id)
    assert len(single_logs) == 1
    assert single_logs[0]["detail"]["selection_mode"] == "ids"

    terminal_event.clear()

    def fixture_failed_sync(
        tokens: list[str],
        progress_id: str | None = None,
        *,
        finalize_progress: bool = True,
    ) -> dict[str, object]:
        raise RuntimeError("fixture quota failure")

    monkeypatch.setattr(account_service, "sync_accounts_and_quota", fixture_failed_sync)
    failed_refresh = client.post(
        "/api/accounts/refresh",
        headers=admin,
        json={"selection": {"mode": "all"}},
    )
    assert failed_refresh.status_code == 200
    failed_refresh_id = failed_refresh.json()["progress_id"]
    assert terminal_event.wait(timeout=3)
    assert client.get(
        f"/api/accounts/operations/{failed_refresh_id}", headers=admin
    ).status_code == 200
    assert client.get(
        f"/api/accounts/operations/{failed_refresh_id}", headers=admin
    ).status_code == 200
    failed_logs = refresh_logs(failed_refresh_id)
    assert len(failed_logs) == 1
    assert {item["detail"]["status"] for item in failed_logs} == {"failed"}

    # These paths are absent instead of merely hidden behind a source handler.
    for method, path in (
        ("get", "/api/accounts/unknown"),
        ("get", "/api/accounts/unknown/access-token"),
        ("post", "/api/accounts/export"),
        ("post", "/api/system/update"),
        ("post", "/api/proxy/test"),
        ("get", "/api/proxy/runtime"),
        ("post", "/api/proxy/clearance/test"),
        ("post", "/v1/messages"),
        ("get", "/openapi.json"),
    ):
        request_kwargs = {"headers": admin}
        if method == "post":
            request_kwargs["json"] = {}
        response = getattr(client, method)(path, **request_kwargs)
        assert response.status_code == 404

    database_path = data_dir / "chatgpt2api.db"
    assert database_path.is_file()
    assert resolve_database_url().endswith(f"{database_path.as_posix()}")
    database_bytes = database_path.read_bytes()
    assert ACCOUNT_TOKEN.encode() not in database_bytes
    assert SECOND_ACCOUNT_TOKEN.encode() not in database_bytes
    assert PROXY_PASSWORD.encode() not in database_bytes
    assert MANUAL_PROXY_PASSWORD.encode() not in database_bytes
    assert GROUP_PROXY_PASSWORD.encode() not in database_bytes
    assert user_key.encode() not in database_bytes

    with sqlite3.connect(database_path) as connection:
        access_token, encrypted_account = connection.execute(
            "SELECT access_token, data FROM accounts"
        ).fetchone()
        encrypted_user_key = connection.execute(
            "SELECT data FROM auth_keys"
        ).fetchone()[0]
        encrypted_proxy = connection.execute(
            "SELECT data FROM proxy_configuration"
        ).fetchone()[0]
    assert access_token.startswith("octalaicanvas-account:v1:")
    assert encrypted_account.startswith("octalaicanvas-secret:v1:")
    assert encrypted_user_key.startswith("octalaicanvas-secret:v1:")
    proxy_envelope = json.loads(encrypted_proxy)
    assert set(proxy_envelope) == {"_octalaicanvas_encrypted_v1"}
    assert proxy_envelope["_octalaicanvas_encrypted_v1"].startswith(
        "octalaicanvas-secret:v1:"
    )
    assert client.post(
        "/integration/proxy", headers=admin, json={"proxyUrl": None}
    ).json() == {"configured": False}


def test_runtime_key_and_public_base_url_validation(monkeypatch):
    monkeypatch.setenv("OCTALAICANVAS_CHATGPT_API_KEY", "too-short")

    from services.internal_runtime import _normalize_public_base_url, runtime_key

    with pytest.raises(RuntimeError, match="at least 32"):
        runtime_key()
    with pytest.raises(RuntimeError, match="username or password"):
        _normalize_public_base_url("https://user:password@media.example.test")
