from __future__ import annotations

import hashlib
import json
import secrets
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .config import DATA_DIR, ensure_dirs


TEMP_TOKEN_COUNT = 20
TEMP_TOKEN_LIMIT = 100
TEMP_TOKENS_PATH = DATA_DIR / "temp_tokens.json"
_LOCK = threading.Lock()


class QuotaExceeded(Exception):
    pass


@dataclass(frozen=True)
class AccessContext:
    token_hash: str
    is_admin: bool
    is_temp: bool
    limit: int = 0
    used: int = 0
    remaining: int = 0


def hash_token(token: str) -> str:
    return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_data() -> dict[str, Any]:
    ensure_dirs()
    if not TEMP_TOKENS_PATH.exists():
        return {"tokens": {}}
    try:
        loaded = json.loads(TEMP_TOKENS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"tokens": {}}
    if not isinstance(loaded, dict):
        return {"tokens": {}}
    tokens = loaded.get("tokens")
    if not isinstance(tokens, dict):
        tokens = {}
    return {"tokens": tokens}


def _write_data(data: dict[str, Any]) -> None:
    TEMP_TOKENS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = TEMP_TOKENS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(TEMP_TOKENS_PATH)


def _public_token(token_hash: str, entry: dict[str, Any]) -> dict[str, Any]:
    limit = max(0, int(entry.get("limit") or TEMP_TOKEN_LIMIT))
    used = max(0, int(entry.get("used") or 0))
    return {
        "id": token_hash,
        "token": str(entry.get("token") or ""),
        "limit": limit,
        "used": used,
        "remaining": max(0, limit - used),
        "created_at": str(entry.get("created_at") or ""),
        "updated_at": str(entry.get("updated_at") or ""),
    }


def list_temp_tokens() -> list[dict[str, Any]]:
    data = _read_data()
    items = [_public_token(token_hash, entry) for token_hash, entry in data["tokens"].items() if isinstance(entry, dict)]
    return sorted(items, key=lambda item: item.get("created_at") or "")


def create_temp_tokens(count: int, limit: int = TEMP_TOKEN_LIMIT) -> list[dict[str, Any]]:
    count = max(1, min(200, int(count)))
    limit = max(1, min(100000, int(limit)))
    created: list[dict[str, Any]] = []
    with _LOCK:
        data = _read_data()
        tokens = data["tokens"]
        while len(created) < count:
            token = f"tmp_{secrets.token_urlsafe(24)}"
            token_hash = hash_token(token)
            if token_hash in tokens:
                continue
            entry = {
                "token": token,
                "limit": limit,
                "used": 0,
                "created_at": _now(),
            }
            tokens[token_hash] = entry
            created.append(_public_token(token_hash, entry))
        _write_data(data)
    return created


def ensure_temp_tokens(count: int = TEMP_TOKEN_COUNT, limit: int = TEMP_TOKEN_LIMIT) -> list[str]:
    data = _read_data()
    current = len(data["tokens"])
    if current < count:
        create_temp_tokens(count - current, limit)
        data = _read_data()
    ordered = sorted(data["tokens"].values(), key=lambda item: str(item.get("created_at") or ""))
    return [str(item.get("token") or "") for item in ordered if item.get("token")]


def update_temp_token(token_hash: str, *, limit: int) -> dict[str, Any]:
    token_hash = str(token_hash or "").strip().lower()
    limit = max(1, min(100000, int(limit)))
    with _LOCK:
        data = _read_data()
        entry = data["tokens"].get(token_hash)
        if not isinstance(entry, dict):
            raise KeyError("token not found")
        entry["limit"] = limit
        entry["updated_at"] = _now()
        _write_data(data)
        return _public_token(token_hash, entry)


def delete_temp_token(token_hash: str) -> bool:
    token_hash = str(token_hash or "").strip().lower()
    with _LOCK:
        data = _read_data()
        existed = token_hash in data["tokens"]
        data["tokens"].pop(token_hash, None)
        _write_data(data)
        return existed


def get_temp_context(token: str) -> AccessContext | None:
    if not token:
        return None
    token_hash = hash_token(token)
    data = _read_data()
    entry = data["tokens"].get(token_hash)
    if not isinstance(entry, dict):
        return None
    limit = max(0, int(entry.get("limit") or TEMP_TOKEN_LIMIT))
    used = max(0, int(entry.get("used") or 0))
    return AccessContext(
        token_hash=token_hash,
        is_admin=False,
        is_temp=True,
        limit=limit,
        used=used,
        remaining=max(0, limit - used),
    )


def reserve_temp_quota(access: AccessContext) -> AccessContext:
    if not access.is_temp:
        return access
    with _LOCK:
        data = _read_data()
        entry = data["tokens"].get(access.token_hash)
        if not isinstance(entry, dict):
            raise QuotaExceeded("temporary token is invalid")
        limit = max(0, int(entry.get("limit") or TEMP_TOKEN_LIMIT))
        used = max(0, int(entry.get("used") or 0))
        if used >= limit:
            raise QuotaExceeded("temporary token quota exhausted")
        used += 1
        entry["used"] = used
        entry["updated_at"] = _now()
        _write_data(data)
        return AccessContext(
            token_hash=access.token_hash,
            is_admin=False,
            is_temp=True,
            limit=limit,
            used=used,
            remaining=max(0, limit - used),
        )


def refund_temp_quota(access: AccessContext) -> None:
    if not access.is_temp:
        return
    with _LOCK:
        data = _read_data()
        entry = data["tokens"].get(access.token_hash)
        if not isinstance(entry, dict):
            return
        used = max(0, int(entry.get("used") or 0))
        entry["used"] = max(0, used - 1)
        entry["updated_at"] = _now()
        _write_data(data)
