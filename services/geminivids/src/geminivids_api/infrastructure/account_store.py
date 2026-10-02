"""账号存储层：与 geminiai sidecar 完全同构（registry.json + acc_*/auth.json）。"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import threading
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_ACCOUNT_ID_PATTERN = re.compile(r"acc_[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")


class InvalidAccountIdError(ValueError):
    pass


def is_safe_account_id(account_id: object) -> bool:
    return isinstance(account_id, str) and bool(_ACCOUNT_ID_PATTERN.fullmatch(account_id))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def _write_private_json(path: Path, payload: Any) -> None:
    _ensure_private_directory(path.parent)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            fd = -1
            json.dump(payload, file, ensure_ascii=False, indent=2)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
    finally:
        if fd >= 0:
            os.close(fd)


def _reject_symlinked_dir(path: Path) -> None:
    if path.is_symlink():
        raise InvalidAccountIdError("account directory must not be a symlink")


@dataclass
class AccountMeta:
    id: str
    name: str
    email: str | None = None
    created_at: str = ""
    last_used: str | None = None
    # GeminiVids 专属：该账号的 Vids 工作文档 ID（生成请求的 doc 上下文）
    vids_doc_id: str | None = None
    status: str = "active"  # active | invalid
    last_error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AccountMeta:
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in data.items() if k in known})


class AccountStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self._lock = threading.RLock()
        self._ensure_layout()

    def _ensure_layout(self) -> None:
        _ensure_private_directory(self.root)
        if not (self.root / "registry.json").exists():
            _write_private_json(self.root / "registry.json",
                                {"accounts": {}, "active_account_id": None})

    # ---- registry helpers ----
    def _registry_path(self) -> Path:
        return self.root / "registry.json"

    def _read_registry(self) -> dict[str, Any]:
        try:
            data = json.loads(self._registry_path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"accounts": {}, "active_account_id": None}
        data.setdefault("accounts", {})
        data.setdefault("active_account_id", None)
        return data

    def _write_registry(self, registry: dict[str, Any]) -> None:
        _write_private_json(self._registry_path(), registry)

    def _account_dir(self, account_id: str) -> Path:
        if not is_safe_account_id(account_id):
            raise InvalidAccountIdError(account_id)
        return self.root / account_id

    # ---- public API ----
    def list_accounts(self) -> list[AccountMeta]:
        with self._lock:
            registry = self._read_registry()
            return [AccountMeta.from_dict(v) for v in registry["accounts"].values()]

    def get_account(self, account_id: str) -> AccountMeta | None:
        with self._lock:
            registry = self._read_registry()
            data = registry["accounts"].get(account_id)
            return AccountMeta.from_dict(data) if data else None

    def get_active_account(self) -> AccountMeta | None:
        with self._lock:
            registry = self._read_registry()
            active = registry.get("active_account_id")
            data = registry["accounts"].get(active) if active else None
            return AccountMeta.from_dict(data) if data else None

    def set_active_account(self, account_id: str) -> AccountMeta:
        with self._lock:
            registry = self._read_registry()
            if account_id not in registry["accounts"]:
                raise KeyError(account_id)
            registry["active_account_id"] = account_id
            self._write_registry(registry)
        return self.get_account(account_id)  # type: ignore[return-value]

    def save_account(
        self,
        name: str,
        storage_state: dict[str, Any],
        email: str | None = None,
        account_id: str | None = None,
        vids_doc_id: str | None = None,
    ) -> AccountMeta:
        if account_id is None:
            account_id = f"acc_{secrets.token_hex(4)}"
        if not is_safe_account_id(account_id):
            raise InvalidAccountIdError(account_id)
        with self._lock:
            registry = self._read_registry()
            # 按 email 去重（沿用 geminiai 语义）
            if email:
                for aid, meta in registry["accounts"].items():
                    if meta.get("email") == email and aid != account_id:
                        account_id = aid
                        break
            acc_dir = self._account_dir(account_id)
            _reject_symlinked_dir(acc_dir)
            _ensure_private_directory(acc_dir)
            _write_private_json(acc_dir / "auth.json", storage_state)
            existing = registry["accounts"].get(account_id, {})
            meta = AccountMeta(
                id=account_id,
                name=name or existing.get("name") or email or account_id,
                email=email or existing.get("email"),
                created_at=existing.get("created_at") or _now_iso(),
                last_used=existing.get("last_used"),
                vids_doc_id=vids_doc_id or existing.get("vids_doc_id"),
                status=existing.get("status", "active"),
                last_error=existing.get("last_error"),
            )
            registry["accounts"][account_id] = meta.to_dict()
            if not registry.get("active_account_id"):
                registry["active_account_id"] = account_id
            self._write_registry(registry)
            return meta

    def update_account(self, account_id: str, *, name: str | None = None,
                       vids_doc_id: str | None = None, status: str | None = None,
                       last_error: str | None = None, mark_used: bool = False) -> AccountMeta:
        with self._lock:
            registry = self._read_registry()
            data = registry["accounts"].get(account_id)
            if not data:
                raise KeyError(account_id)
            if name is not None:
                data["name"] = name
            if vids_doc_id is not None:
                data["vids_doc_id"] = vids_doc_id
            if status is not None:
                data["status"] = status
            if last_error is not None:
                data["last_error"] = last_error[:500]
            if mark_used:
                data["last_used"] = _now_iso()
            registry["accounts"][account_id] = data
            self._write_registry(registry)
            return AccountMeta.from_dict(data)

    def delete_account(self, account_id: str) -> bool:
        with self._lock:
            registry = self._read_registry()
            if account_id not in registry["accounts"]:
                return False
            del registry["accounts"][account_id]
            if registry.get("active_account_id") == account_id:
                remaining = next(iter(registry["accounts"]), None)
                registry["active_account_id"] = remaining
            self._write_registry(registry)
        acc_dir = self._account_dir(account_id)
        if acc_dir.is_dir() and not acc_dir.is_symlink():
            shutil.rmtree(acc_dir, ignore_errors=True)
        return True

    def load_storage_state(self, account_id: str) -> dict[str, Any]:
        acc_dir = self._account_dir(account_id)
        _reject_symlinked_dir(acc_dir)
        auth = acc_dir / "auth.json"
        try:
            return json.loads(auth.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise KeyError(f"auth state unavailable for {account_id}: {exc}") from exc


def parse_cookie_string_to_storage_state(raw: str) -> dict[str, Any]:
    """把 `k=v; k2=v2` Cookie 字符串转成 .google.com 域的 storage_state。

    与 geminiai 的 cookie_parser 语义对齐：核心认证 Cookie 全部挂到
    .google.com，SAPISID 相关保持可读以便协议侧计算 SAPISIDHASH。
    """
    cookies: list[dict[str, Any]] = []
    for part in raw.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, _, value = part.partition("=")
        name, value = name.strip(), value.strip()
        if not name or not value:
            continue
        cookies.append({
            "name": name,
            "value": value,
            "domain": ".google.com",
            "path": "/",
            "expires": -1,
            "httpOnly": False,
            "secure": True,
            "sameSite": "None",
        })
    if not cookies:
        raise ValueError("no parsable cookies")
    has_auth = any(c["name"] in ("SID", "SAPISID") for c in cookies)
    if not has_auth:
        raise ValueError("cookie string lacks SID/SAPISID auth cookies")
    return {"cookies": cookies, "origins": []}
