from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

from services.secret_crypto import (  # noqa: E402
    LEGACY_PREFIX,
    PREFIX,
    decrypt_configuration,
    decrypt_json,
    decrypt_text,
    encrypt_text,
)


ALLOWED_FILES = {
    "data/dola/accounts.json",
    "data/chatgpt-api/runtime.json",
    "data/geminiai/accounts.json",
    "private.env",
}
GEMINI_ACCOUNT_ID = re.compile(r"acc_[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
PRESERVED_DOLA_RUNTIME_FIELDS = (
    "requestCount",
    "successCount",
    "errorCount",
    "lastUsedAt",
)


def merge_accounts(target: list[dict[str, Any]], incoming: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int, int]:
    result = [copy.deepcopy(account) for account in target]
    by_token = {str(account.get("access_token") or ""): index for index, account in enumerate(result)}
    inserted = updated = 0
    seen: set[str] = set()
    for account in incoming:
        token = str(account.get("access_token") or "").strip()
        if not token or token in seen:
            raise ValueError("GPTAPI 账号身份无效或重复")
        seen.add(token)
        if token in by_token:
            result[by_token[token]] = copy.deepcopy(account)
            updated += 1
        else:
            by_token[token] = len(result)
            result.append(copy.deepcopy(account))
            inserted += 1
    return result, inserted, updated


def merge_dola_accounts(target: list[dict[str, Any]], incoming: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int, int]:
    result = [copy.deepcopy(account) for account in target]
    by_id = {str(account.get("id") or ""): index for index, account in enumerate(result)}
    by_fingerprint = {str(account.get("cookieFingerprint") or ""): index for index, account in enumerate(result)}
    seen_source: set[str] = set()
    seen_ids: set[str] = set()
    inserted = updated = 0
    for raw in incoming:
        account = copy.deepcopy(raw)
        account_id = str(account.get("id") or "").strip()
        fingerprint = str(account.get("cookieFingerprint") or "").strip()
        if not account_id or not fingerprint or fingerprint in seen_source or account_id in seen_ids:
            raise ValueError("Dola 账号快照身份无效或重复")
        seen_source.add(fingerprint)
        seen_ids.add(account_id)
        index = by_fingerprint.get(fingerprint)
        if index is None:
            index = by_id.get(account_id)
        if index is None:
            if account_id in by_id:
                account_id = f"dola-{uuid.uuid4()}"
                account["id"] = account_id
            index = len(result)
            result.append(account)
            inserted += 1
        else:
            previous = result[index]
            account["id"] = previous["id"]
            for field in PRESERVED_DOLA_RUNTIME_FIELDS:
                if field in previous:
                    account[field] = previous[field]
            account["activeAttempts"] = 0
            result[index] = account
            updated += 1
        by_id[str(result[index]["id"])] = index
        by_fingerprint[fingerprint] = index
    return result, inserted, updated


def verify_snapshot(directory: Path) -> tuple[dict[str, Any], str]:
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("私有同步目录无效")
    manifest_path = directory / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError("私有同步清单缺失")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("version") != 1 or not str(manifest.get("id", "")).startswith("private-settings-sync-"):
        raise ValueError("私有同步清单格式无效")
    seen: set[str] = set()
    for entry in manifest.get("files", []):
        relative = entry.get("path")
        if relative not in ALLOWED_FILES or relative in seen:
            raise ValueError("私有同步清单包含无效文件")
        seen.add(relative)
        path = directory / relative
        if path.is_symlink() or not path.is_file():
            raise ValueError("私有同步文件缺失")
        payload = path.read_bytes()
        if len(payload) != entry.get("size") or hashlib.sha256(payload).hexdigest() != entry.get("sha256"):
            raise ValueError("私有同步文件校验失败")
    if seen != ALLOWED_FILES:
        raise ValueError("私有同步清单不完整")
    private_env = (directory / "private.env").read_text(encoding="utf-8").strip()
    if not private_env.startswith("DREAMYO_ENCRYPTION_KEY=") or "\n" in private_env:
        raise ValueError("私有同步源密钥文件无效")
    source_key = private_env.split("=", 1)[1]
    if not source_key:
        raise ValueError("私有同步源密钥缺失")
    return manifest, source_key


def secret_value(value: str) -> str:
    if value.startswith((PREFIX, LEGACY_PREFIX)):
        return decrypt_text(value)
    return value


def sqlite_backup(database_path: Path, backup_path: Path) -> bool:
    if not database_path.exists():
        return False
    backup_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with sqlite3.connect(f"file:{database_path}?mode=ro", uri=True) as source, sqlite3.connect(backup_path) as destination:
        source.backup(destination)
    os.chmod(backup_path, 0o600)
    return True


def atomic_json_write(path: Path, value: object) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def sync_geminiai_accounts(accounts_dir: Path, incoming: dict[str, Any]) -> tuple[int, int]:
    source_accounts = incoming.get("accounts")
    if not isinstance(source_accounts, dict):
        raise ValueError("GeminiAIStudio 账号快照格式无效")
    for account_id, account in source_accounts.items():
        if not GEMINI_ACCOUNT_ID.fullmatch(account_id) or not isinstance(account, dict):
            raise ValueError("GeminiAIStudio 账号身份无效")
        meta, auth = account.get("meta"), account.get("auth")
        if not isinstance(meta, dict) or meta.get("id") != account_id or not isinstance(auth, dict) or not isinstance(auth.get("cookies"), list):
            raise ValueError("GeminiAIStudio 授权数据无效")
        if not isinstance(meta.get("name"), str) or not isinstance(meta.get("created_at"), str) or meta.get("email") is not None and not isinstance(meta.get("email"), str):
            raise ValueError("GeminiAIStudio 账号信息无效")
    if accounts_dir.is_symlink():
        raise ValueError("GeminiAIStudio 账号目录不能是符号链接")
    accounts_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    registry_path = accounts_dir / "registry.json"
    if registry_path.is_symlink():
        raise ValueError("GeminiAIStudio 注册表不能是符号链接")
    registry = json.loads(registry_path.read_text(encoding="utf-8")) if registry_path.exists() else {"accounts": {}, "active_account_id": None}
    target_accounts = registry.get("accounts")
    if not isinstance(target_accounts, dict) or any(not GEMINI_ACCOUNT_ID.fullmatch(key) or not isinstance(meta, dict) for key, meta in target_accounts.items()):
        raise ValueError("服务器 GeminiAIStudio 账号注册表无效")
    originals: dict[Path, bytes | None] = {}
    inserted = updated = 0
    id_map: dict[str, str] = {}
    try:
        for source_id, account in source_accounts.items():
            source_email = account["meta"].get("email")
            existing = target_accounts.get(source_id)
            matching_email = next((key for key, meta in target_accounts.items() if source_email and isinstance(meta, dict) and meta.get("email") == source_email), None)
            if matching_email:
                target_id = matching_email
            elif existing and existing.get("email") != source_email:
                target_id = f"acc_{uuid.uuid4().hex[:16]}"
            else:
                target_id = source_id
            id_map[source_id] = target_id
            account_dir = accounts_dir / target_id
            if account_dir.is_symlink():
                raise ValueError("GeminiAIStudio 账号目录不能是符号链接")
            for path, value in ((account_dir / "auth.json", account["auth"]), (account_dir / "meta.json", {**account["meta"], "id": target_id})):
                if path.is_symlink():
                    raise ValueError("GeminiAIStudio 授权文件不能是符号链接")
                originals[path] = path.read_bytes() if path.exists() else None
                atomic_json_write(path, value)
            if target_id in target_accounts:
                updated += 1
            else:
                inserted += 1
            target_accounts[target_id] = {**account["meta"], "id": target_id}
        active = registry.get("active_account_id")
        if active not in target_accounts:
            registry["active_account_id"] = id_map.get(incoming.get("active_account_id"))
        originals[registry_path] = registry_path.read_bytes() if registry_path.exists() else None
        atomic_json_write(registry_path, registry)
    except Exception:
        for path, original in reversed(list(originals.items())):
            if original is None:
                path.unlink(missing_ok=True)
            else:
                atomic_json_write(path, json.loads(original.decode("utf-8")))
        raise
    return inserted, updated


def sync_snapshot(directory: Path) -> dict[str, int]:
    manifest, source_key = verify_snapshot(directory)
    target_key = os.environ.get("DREAMYO_ENCRYPTION_KEY", "").strip()
    if not target_key:
        raise ValueError("服务器加密密钥未配置")
    data_directory = Path(os.environ.get("DREAMYO_DATA_DIR", "/app/web/.data")).resolve()
    chatgpt_directory = Path(os.environ.get("DREAMYO_CHATGPT_DATA_DIR", str(data_directory / "chatgpt-api"))).resolve()
    database_path = chatgpt_directory / "chatgpt2api.db"
    dola_path = data_directory / "dola/accounts.json"
    source_runtime = json.loads((directory / "data/chatgpt-api/runtime.json").read_text(encoding="utf-8"))
    source_dola = json.loads((directory / "data/dola/accounts.json").read_text(encoding="utf-8"))
    if source_runtime.get("version") != 1 or not isinstance(source_runtime.get("accounts"), list) or not isinstance(source_dola.get("accounts"), list):
        raise ValueError("私有同步快照数据格式无效")

    os.environ["DREAMYO_ENCRYPTION_KEY"] = source_key
    incoming_accounts = [decrypt_json(ciphertext) for ciphertext in source_runtime["accounts"]]
    incoming_proxy = source_runtime.get("proxyConfiguration")
    if not isinstance(incoming_proxy, dict) or not isinstance(incoming_proxy.get("data"), dict):
        raise ValueError("私有同步快照缺少通用代理配置")
    proxy_settings = decrypt_configuration(incoming_proxy["data"])
    dola_accounts = []
    for account in source_dola["accounts"]:
        if not isinstance(account, dict) or not isinstance(account.get("cookieCiphertext"), str):
            raise ValueError("Dola 账号快照格式无效")
        cookie = secret_value(account["cookieCiphertext"])
        if not cookie:
            raise ValueError("Dola 账号凭据为空")
        dola_accounts.append({**account, "cookieCiphertext": cookie})

    os.environ["DREAMYO_ENCRYPTION_KEY"] = target_key
    target_dola = {"accounts": []}
    if dola_path.exists():
        target_dola = json.loads(dola_path.read_text(encoding="utf-8"))
        if not isinstance(target_dola.get("accounts"), list):
            raise ValueError("服务器 Dola 账号数据格式无效")
    encrypted_dola = [{**account, "cookieCiphertext": encrypt_text(account["cookieCiphertext"])} for account in dola_accounts]
    merged_dola, dola_added, dola_updated = merge_dola_accounts(target_dola["accounts"], encrypted_dola)

    backup_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    backup_directory = data_directory / ".private-settings-sync-backups" / backup_id
    backup_directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    original_dola = dola_path.read_bytes() if dola_path.exists() else None
    dola_backup = backup_directory / "dola-accounts.json"
    if original_dola is not None:
        dola_backup.write_bytes(original_dola)
        os.chmod(dola_backup, 0o600)
    database_backup = backup_directory / "chatgpt2api.db"
    had_database_backup = sqlite_backup(database_path, database_backup)

    database_url = f"sqlite:///{database_path.as_posix()}"
    backend = None
    proxy_repository = None
    try:
        from services.storage.database_storage import DatabaseStorageBackend
        from services.storage.configuration_repository import ProxyConfigurationRepository

        backend = DatabaseStorageBackend(database_url)
        current = backend.load_accounts_snapshot()
        merged_accounts, accounts_added, accounts_updated = merge_accounts(current.items, incoming_accounts)
        backend.replace_accounts(merged_accounts, expected_revision=current.revision)
        proxy_repository = ProxyConfigurationRepository(database_url)
        proxy_repository.replace(proxy_settings)
        atomic_json_write(dola_path, {**target_dola, "accounts": merged_dola})
    except Exception:
        if original_dola is not None:
            atomic_json_write(dola_path, json.loads(original_dola.decode("utf-8")))
        elif dola_path.exists():
            dola_path.unlink()
        if backend is not None:
            backend.engine.dispose()
        if proxy_repository is not None:
            proxy_repository.engine.dispose()
        if had_database_backup:
            database_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            shutil.copy2(database_backup, database_path)
            for suffix in ("-wal", "-shm"):
                Path(str(database_path) + suffix).unlink(missing_ok=True)
        else:
            database_path.unlink(missing_ok=True)
        raise
    finally:
        if backend is not None:
            backend.engine.dispose()
        if proxy_repository is not None:
            proxy_repository.engine.dispose()
        os.environ["DREAMYO_ENCRYPTION_KEY"] = target_key

    return {
        "dolaAdded": dola_added,
        "dolaUpdated": dola_updated,
        "chatgptApiAdded": accounts_added,
        "chatgptApiUpdated": accounts_updated,
        "proxyConfigurationUpdated": 1,
    }


def sync_geminiai_snapshot(directory: Path, accounts_dir: Path) -> dict[str, int]:
    _, source_key = verify_snapshot(directory)
    source = json.loads((directory / "data/geminiai/accounts.json").read_text(encoding="utf-8"))
    if source.get("version") != 1 or not isinstance(source.get("ciphertext"), str):
        raise ValueError("GeminiAIStudio 快照格式无效")
    previous_key = os.environ.get("DREAMYO_ENCRYPTION_KEY")
    try:
        os.environ["DREAMYO_ENCRYPTION_KEY"] = source_key
        incoming = decrypt_json(source["ciphertext"])
    finally:
        if previous_key is None:
            os.environ.pop("DREAMYO_ENCRYPTION_KEY", None)
        else:
            os.environ["DREAMYO_ENCRYPTION_KEY"] = previous_key
    added, updated = sync_geminiai_accounts(accounts_dir, incoming)
    return {"geminiAiAdded": added, "geminiAiUpdated": updated}


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] not in ("--snapshot", "--gemini-snapshot"):
        raise SystemExit("用法：sync_private_settings.py --snapshot|--gemini-snapshot <私有同步目录>")
    try:
        snapshot = Path(sys.argv[2]).resolve()
        if sys.argv[1] == "--gemini-snapshot":
            gemini_dir = os.environ.get("DREAMYO_GEMINIAI_ACCOUNTS_DIR", "").strip()
            if not gemini_dir:
                raise ValueError("GeminiAIStudio 账号卷未挂载")
            result = sync_geminiai_snapshot(snapshot, Path(gemini_dir))
        else:
            result = sync_snapshot(snapshot)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    except PermissionError as error:
        filename = Path(error.filename).name if error.filename else "未知文件"
        print(f"私有账号与代理同步未完成：容器用户无权访问文件 {filename}；服务保持停止，请检查快照或数据目录权限。", file=sys.stderr)
        raise SystemExit(1)
    except Exception as error:
        print(f"私有账号与代理同步未完成（{type(error).__name__}）；服务保持停止，请检查快照完整性及服务器数据目录权限。", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
