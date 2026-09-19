from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken


def task_state_path() -> Path:
    return Path(os.getenv("DOLA_TASK_STATE_PATH", "/data/dola/tasks.json"))


def _fernet() -> Fernet:
    secret = os.getenv("DOLA_TASK_ENCRYPTION_KEY", "").strip() or os.getenv("DOLA_PROVIDER_KEY", "").strip()
    if not secret:
        raise RuntimeError("task_state_encryption_key_missing")
    key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode("utf-8")).digest())
    return Fernet(key)


def encrypt_secret(value: str) -> str:
    return _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_secret(value: str) -> str:
    try:
        return _fernet().decrypt(value.encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeDecodeError, ValueError) as error:
        raise RuntimeError("task_state_cookie_unavailable") from error


def encrypt_cookie(cookie: str) -> str:
    return encrypt_secret(cookie)


def decrypt_cookie(value: str) -> str:
    return decrypt_secret(value)


def load_state() -> dict[str, Any]:
    path = task_state_path()
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {"tasks": [], "meta": {}}
    return value if isinstance(value, dict) else {"tasks": [], "meta": {}}


def save_state(tasks: list[dict[str, Any]], meta: dict[str, dict[str, Any]]) -> None:
    path = task_state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(json.dumps({"tasks": tasks, "meta": meta}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, path)
    try:
        path.chmod(0o600)
    except OSError:
        pass


__all__ = ["decrypt_cookie", "decrypt_secret", "encrypt_cookie", "encrypt_secret", "load_state", "save_state", "task_state_path"]
