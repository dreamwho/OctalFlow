"""Octal Canvas-only runtime configuration.

This module is intentionally imported before any vendored ChatGPT2API module.
It prevents inherited process configuration from selecting a parent database or
an unrelated source auth key.
"""

from __future__ import annotations

import base64
import binascii
import os
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


DATA_DIR_ENV = "OCTALAICANVAS_CHATGPT_DATA_DIR"
RUNTIME_KEY_ENV = "OCTALAICANVAS_CHATGPT_API_KEY"
ENCRYPTION_KEY_ENV = "OCTALAICANVAS_ENCRYPTION_KEY"
PUBLIC_BASE_URL_ENV = "OCTALAICANVAS_CHATGPT_PUBLIC_BASE_URL"
SOURCE_AUTH_KEY_ENV = "CHATGPT2API_AUTH_KEY"
SOURCE_BASE_URL_ENV = "CHATGPT2API_BASE_URL"
_PLACEHOLDER_RE = re.compile(r"^(?:change-this|replace-with|your-|example-|test-)", re.I)
_HEX_KEY_RE = re.compile(r"^[a-f0-9]{64}$", re.I)
_BASE64_KEY_RE = re.compile(r"^[A-Za-z0-9+/]{43}=$")


@dataclass(frozen=True)
class RuntimeSettings:
    data_dir: Path
    public_base_url: str


def _configured_value(name: str) -> str:
    return str(os.getenv(name) or "").strip()


def _decode_encryption_key(raw: str) -> bytes:
    if not raw or _PLACEHOLDER_RE.match(raw):
        raise RuntimeError(
            "OCTALAICANVAS_ENCRYPTION_KEY is required and must not be a placeholder"
        )
    if _HEX_KEY_RE.fullmatch(raw):
        return bytes.fromhex(raw)
    if _BASE64_KEY_RE.fullmatch(raw):
        try:
            decoded = base64.b64decode(raw, validate=True)
        except binascii.Error as exc:
            raise RuntimeError(
                "OCTALAICANVAS_ENCRYPTION_KEY must be 64 hex characters or 32-byte Base64"
            ) from exc
        if len(decoded) == 32:
            return decoded
    raise RuntimeError(
        "OCTALAICANVAS_ENCRYPTION_KEY must be 64 hex characters or 32-byte Base64"
    )


def encryption_key_bytes() -> bytes:
    """Return the AES-256 key using the same accepted formats as the parent app."""
    return _decode_encryption_key(_configured_value(ENCRYPTION_KEY_ENV))


def runtime_key() -> str:
    value = _configured_value(RUNTIME_KEY_ENV)
    if len(value) < 32:
        raise RuntimeError(
            "OCTALAICANVAS_CHATGPT_API_KEY is required and must be at least 32 characters"
        )
    return value


def _normalize_public_base_url(value: str) -> str:
    if not value:
        return ""
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise RuntimeError(
            "OCTALAICANVAS_CHATGPT_PUBLIC_BASE_URL must be an absolute HTTP(S) URL"
        )
    if parsed.username is not None or parsed.password is not None:
        raise RuntimeError(
            "OCTALAICANVAS_CHATGPT_PUBLIC_BASE_URL cannot include a username or password"
        )
    if parsed.query or parsed.fragment:
        raise RuntimeError(
            "OCTALAICANVAS_CHATGPT_PUBLIC_BASE_URL cannot include a query or fragment"
        )
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def initialize_runtime_environment() -> RuntimeSettings:
    """Validate mandatory isolation settings and map only approved source settings."""
    key = runtime_key()
    encryption_key_bytes()

    raw_data_dir = _configured_value(DATA_DIR_ENV)
    if not raw_data_dir:
        raise RuntimeError("OCTALAICANVAS_CHATGPT_DATA_DIR is required")
    data_dir = Path(raw_data_dir).expanduser()
    if not data_dir.is_absolute():
        raise RuntimeError("OCTALAICANVAS_CHATGPT_DATA_DIR must be an absolute path")
    data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not data_dir.is_dir():
        raise RuntimeError("OCTALAICANVAS_CHATGPT_DATA_DIR is not a directory")
    try:
        data_dir.chmod(0o700)
    except OSError:
        pass

    inherited_source_key = _configured_value(SOURCE_AUTH_KEY_ENV)
    if inherited_source_key and inherited_source_key != key:
        raise RuntimeError(
            "CHATGPT2API_AUTH_KEY conflicts with OCTALAICANVAS_CHATGPT_API_KEY"
        )
    os.environ[SOURCE_AUTH_KEY_ENV] = key

    public_base_url = _normalize_public_base_url(_configured_value(PUBLIC_BASE_URL_ENV))
    inherited_base_url = _configured_value(SOURCE_BASE_URL_ENV)
    if inherited_base_url and not public_base_url:
        raise RuntimeError(
            "set OCTALAICANVAS_CHATGPT_PUBLIC_BASE_URL instead of CHATGPT2API_BASE_URL"
        )
    if public_base_url:
        os.environ[SOURCE_BASE_URL_ENV] = public_base_url
    else:
        os.environ.pop(SOURCE_BASE_URL_ENV, None)

    return RuntimeSettings(data_dir=data_dir.resolve(), public_base_url=public_base_url)
