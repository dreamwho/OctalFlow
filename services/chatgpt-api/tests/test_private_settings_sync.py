from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "sync_private_settings.py"
sys.path.insert(0, str(SCRIPT.parent.parent))
spec = importlib.util.spec_from_file_location("private_settings_sync", SCRIPT)
assert spec and spec.loader
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


def _write_snapshot(directory: Path, source_key: str, dola: dict, accounts: list[str], proxy_configuration: dict, gemini_ciphertext: str) -> None:
    files = {
        "data/dola/accounts.json": json.dumps(dola, separators=(",", ":")),
        "data/chatgpt-api/runtime.json": json.dumps({
            "version": 1,
            "accounts": accounts,
            "proxyConfiguration": {"data": proxy_configuration, "updatedAt": "2026-09-22T00:00:00Z"},
        }, separators=(",", ":")),
        "data/geminiai/accounts.json": json.dumps({"version": 1, "ciphertext": gemini_ciphertext}),
        "private.env": f"DREAMYO_ENCRYPTION_KEY={source_key}\n",
    }
    for relative, value in files.items():
        path = directory / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value, encoding="utf-8")
    entries = []
    for relative in sorted(files):
        content = (directory / relative).read_bytes()
        entries.append({"path": relative, "size": len(content), "sha256": hashlib.sha256(content).hexdigest()})
    (directory / "manifest.json").write_text(json.dumps({"version": 1, "id": "private-settings-sync-12345678-1234-1234-1234-123456789abc", "files": entries}), encoding="utf-8")


def test_private_sync_reencrypts_and_merges_source_accounts_without_removing_server_only_data(tmp_path: Path, monkeypatch) -> None:
    source_key = "a" * 64
    target_key = "b" * 64
    data_directory = tmp_path / "data"
    chatgpt_directory = data_directory / "chatgpt-api"
    snapshot = tmp_path / "snapshot"
    chatgpt_directory.mkdir(parents=True)
    snapshot.mkdir()
    monkeypatch.setenv("DREAMYO_DATA_DIR", str(data_directory))
    monkeypatch.setenv("DREAMYO_CHATGPT_DATA_DIR", str(chatgpt_directory))
    monkeypatch.setenv("DREAMYO_ENCRYPTION_KEY", target_key)

    from services.secret_crypto import encrypt_configuration, encrypt_json, encrypt_text
    from services.storage.configuration_repository import ProxyConfigurationRepository
    from services.storage.database_storage import DatabaseStorageBackend

    database_url = f"sqlite:///{(chatgpt_directory / 'chatgpt2api.db').as_posix()}"
    target_backend = DatabaseStorageBackend(database_url)
    target_backend.replace_accounts([
        {"access_token": "server-only", "label": "server"},
        {"access_token": "shared-token", "label": "server-old"},
    ])
    target_proxy = ProxyConfigurationRepository(database_url)
    target_proxy.replace({"proxy_nodes": [{"id": "server-only-node"}], "serverOnly": True})
    target_dola = {
        "accounts": [
            {"id": "server-shared", "name": "旧名称", "status": "needs_login", "cookieCiphertext": encrypt_text("old-cookie"), "cookieFingerprint": "shared-fp", "requestCount": 12},
            {"id": "server-only", "name": "服务器独有", "cookieCiphertext": encrypt_text("server-cookie"), "cookieFingerprint": "server-fp"},
        ]
    }
    (data_directory / "dola").mkdir(parents=True, exist_ok=True)
    (data_directory / "dola/accounts.json").write_text(json.dumps(target_dola), encoding="utf-8")

    monkeypatch.setenv("DREAMYO_ENCRYPTION_KEY", source_key)
    source_account = encrypt_json({"access_token": "shared-token", "label": "local-wins"})
    source_proxy = encrypt_configuration({"proxy_nodes": [{"id": "local-node"}], "generic_proxy_bindings": {"dola": {"enabled": True}}})
    source_dola = {"accounts": [
        {"id": "local-shared", "name": "本地更新", "status": "ready", "cookieCiphertext": encrypt_text("new-cookie"), "cookieFingerprint": "shared-fp", "requestCount": 1, "activeAttempts": 5},
        {"id": "local-new", "name": "本地新增", "status": "unverified", "cookieCiphertext": encrypt_text("new-account-cookie"), "cookieFingerprint": "new-fp", "requestCount": 0},
    ]}
    source_gemini = encrypt_json({"accounts": {
        "acc_shared": {"meta": {"id": "acc_shared", "name": "本地 Google", "email": "shared@example.com", "created_at": "now"}, "auth": {"cookies": [{"name": "SID", "value": "local-cookie"}], "origins": []}},
        "acc_new": {"meta": {"id": "acc_new", "name": "新 Google", "email": "new@example.com", "created_at": "now"}, "auth": {"cookies": [{"name": "SID", "value": "new-cookie"}], "origins": []}},
    }, "active_account_id": "acc_new"})
    _write_snapshot(snapshot, source_key, source_dola, [source_account], source_proxy, source_gemini)
    monkeypatch.setenv("DREAMYO_ENCRYPTION_KEY", target_key)

    result = sync.sync_snapshot(snapshot)

    assert result == {"dolaAdded": 1, "dolaUpdated": 1, "chatgptApiAdded": 0, "chatgptApiUpdated": 1, "proxyConfigurationUpdated": 1}
    target_backend_after = DatabaseStorageBackend(database_url)
    accounts = {account["access_token"]: account for account in target_backend_after.load_accounts_snapshot().items}
    assert accounts["server-only"]["label"] == "server"
    assert accounts["shared-token"]["label"] == "local-wins"
    assert target_proxy.get() == {"proxy_nodes": [{"id": "local-node"}], "generic_proxy_bindings": {"dola": {"enabled": True}}}
    import services.secret_crypto as secret_crypto
    imported_dola = json.loads((data_directory / "dola/accounts.json").read_text(encoding="utf-8"))["accounts"]
    by_id = {account["id"]: account for account in imported_dola}
    assert len(imported_dola) == 3
    assert by_id["server-shared"]["requestCount"] == 12
    assert by_id["server-shared"]["name"] == "本地更新"
    assert secret_crypto.decrypt_text(by_id["server-shared"]["cookieCiphertext"]) == "new-cookie"
    assert secret_crypto.decrypt_text(by_id["server-only"]["cookieCiphertext"]) == "server-cookie"
    assert list((data_directory / ".private-settings-sync-backups").glob("*/chatgpt2api.db"))
    gemini_dir = tmp_path / "gemini-accounts"
    (gemini_dir / "acc_shared").mkdir(parents=True)
    (gemini_dir / "acc_server").mkdir()
    (gemini_dir / "registry.json").write_text(json.dumps({"accounts": {
        "acc_shared": {"id": "acc_shared", "name": "旧 Google", "email": "shared@example.com", "created_at": "earlier"},
        "acc_server": {"id": "acc_server", "name": "服务器独有", "email": "server@example.com", "created_at": "earlier"},
    }, "active_account_id": "acc_server"}), encoding="utf-8")
    (gemini_dir / "acc_shared/auth.json").write_text(json.dumps({"cookies": [{"value": "old-cookie"}]}), encoding="utf-8")
    gemini_result = sync.sync_geminiai_snapshot(snapshot, gemini_dir)
    assert gemini_result == {"geminiAiAdded": 1, "geminiAiUpdated": 1}
    gemini_registry = json.loads((gemini_dir / "registry.json").read_text(encoding="utf-8"))
    assert set(gemini_registry["accounts"]) == {"acc_shared", "acc_new", "acc_server"}
    assert gemini_registry["active_account_id"] == "acc_server"
    assert json.loads((gemini_dir / "acc_shared/auth.json").read_text(encoding="utf-8"))["cookies"][0]["value"] == "local-cookie"
    assert json.loads((gemini_dir / "acc_new/auth.json").read_text(encoding="utf-8"))["cookies"][0]["value"] == "new-cookie"
    target_backend.engine.dispose()
    target_backend_after.engine.dispose()
    target_proxy.engine.dispose()


def test_cli_reports_permission_error_without_leaking_exception_details(monkeypatch, capsys) -> None:
    def fail_with_permission_error(_snapshot: Path) -> None:
        raise PermissionError(13, "credential=must-not-be-printed", "/private-settings-sync/private.env")

    monkeypatch.setattr(sync, "sync_snapshot", fail_with_permission_error)
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), "--snapshot", "/private-settings-sync"])
    with pytest.raises(SystemExit) as error:
        sync.main()

    output = capsys.readouterr().err
    assert error.value.code == 1
    assert "容器用户无权访问文件 private.env" in output
    assert "must-not-be-printed" not in output


def test_geminiai_sync_restores_existing_authorization_when_registry_write_fails(tmp_path: Path, monkeypatch) -> None:
    accounts_dir = tmp_path / "accounts"
    account_dir = accounts_dir / "acc_shared"
    account_dir.mkdir(parents=True)
    registry = {"accounts": {"acc_shared": {"id": "acc_shared", "name": "服务器账号", "email": None, "created_at": "old"}}, "active_account_id": "acc_shared"}
    (accounts_dir / "registry.json").write_text(json.dumps(registry), encoding="utf-8")
    original_auth = {"cookies": [{"value": "server-cookie"}]}
    (account_dir / "auth.json").write_text(json.dumps(original_auth), encoding="utf-8")
    original_write = sync.atomic_json_write
    failed = False

    def fail_registry(path: Path, value: object) -> None:
        nonlocal failed
        if path.name == "registry.json" and not failed:
            failed = True
            raise OSError("simulated registry failure")
        original_write(path, value)

    monkeypatch.setattr(sync, "atomic_json_write", fail_registry)
    with pytest.raises(OSError, match="simulated registry failure"):
        sync.sync_geminiai_accounts(accounts_dir, {"accounts": {"acc_shared": {
            "meta": {"id": "acc_shared", "name": "本地账号", "email": None, "created_at": "new"},
            "auth": {"cookies": [{"value": "local-cookie"}]},
        }}})
    assert json.loads((account_dir / "auth.json").read_text(encoding="utf-8")) == original_auth
    assert json.loads((accounts_dir / "registry.json").read_text(encoding="utf-8")) == registry
