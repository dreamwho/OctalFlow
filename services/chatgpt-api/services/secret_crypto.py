"""AES-256-GCM storage protection compatible with the parent secret format."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
from collections.abc import Mapping
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from services.internal_runtime import encryption_key_bytes


PREFIX = "dreamyo-secret:v1:"
CONFIGURATION_ENVELOPE_KEY = "_dreamyo_encrypted_v1"

# The local provider database predates the product rename.  Keep the legacy
# envelope readable long enough to migrate it in place; all new writes use the
# Dreamyo prefix above.
LEGACY_PREFIX = "octalaicanvas-secret:v1:"
LEGACY_CONFIGURATION_ENVELOPE_KEY = "_octalaicanvas_encrypted_v1"
LEGACY_ACCOUNT_INDEX_PREFIX = "octalaicanvas-account:v1:"
ACCOUNT_INDEX_PREFIX = "dreamyo-account:v1:"
_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")


class SecretCryptoError(RuntimeError):
    """The provider cannot safely read or write encrypted state."""


def _base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _base64url_decode(value: str) -> bytes:
    if not value or not _B64URL_RE.fullmatch(value):
        raise SecretCryptoError("invalid encrypted-secret encoding")
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (TypeError, ValueError) as exc:
        raise SecretCryptoError("invalid encrypted-secret encoding") from exc


def encrypt_text(value: str) -> str:
    if not isinstance(value, str):
        raise TypeError("encrypted values must be text")
    iv = os.urandom(12)
    encrypted_and_tag = AESGCM(encryption_key_bytes()).encrypt(
        iv, value.encode("utf-8"), None
    )
    ciphertext, tag = encrypted_and_tag[:-16], encrypted_and_tag[-16:]
    return (
        f"{PREFIX}{_base64url_encode(iv)}."
        f"{_base64url_encode(tag)}.{_base64url_encode(ciphertext)}"
    )


def decrypt_text(value: str) -> str:
    if not isinstance(value, str):
        raise SecretCryptoError("provider secret row is not encrypted")
    prefix = next(
        (candidate for candidate in (PREFIX, LEGACY_PREFIX) if value.startswith(candidate)),
        None,
    )
    if prefix is None:
        raise SecretCryptoError("provider secret row is not encrypted")
    payload = value.removeprefix(prefix)
    parts = payload.split(".")
    if len(parts) != 3:
        raise SecretCryptoError("invalid encrypted-secret payload")
    iv, tag, ciphertext = (_base64url_decode(part) for part in parts)
    if len(iv) != 12 or len(tag) != 16:
        raise SecretCryptoError("invalid encrypted-secret payload")
    try:
        plaintext = AESGCM(encryption_key_bytes()).decrypt(
            iv, ciphertext + tag, None
        )
        return plaintext.decode("utf-8")
    except Exception as exc:
        raise SecretCryptoError(
            "provider secret decryption failed; verify DREAMYO_ENCRYPTION_KEY"
        ) from exc


def encrypt_json(value: Mapping[str, Any]) -> str:
    return encrypt_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    )


def decrypt_json(value: str) -> dict[str, Any]:
    try:
        decoded = json.loads(decrypt_text(value))
    except json.JSONDecodeError as exc:
        raise SecretCryptoError("invalid encrypted JSON payload") from exc
    if not isinstance(decoded, dict):
        raise SecretCryptoError("encrypted JSON payload must decode to an object")
    return decoded


def encrypt_configuration(value: Mapping[str, object]) -> dict[str, str]:
    return {CONFIGURATION_ENVELOPE_KEY: encrypt_json(value)}


def decrypt_configuration(value: object | None) -> dict[str, object]:
    if not isinstance(value, Mapping):
        return {}
    envelope_key = next(
        (
            candidate
            for candidate in (CONFIGURATION_ENVELOPE_KEY, LEGACY_CONFIGURATION_ENVELOPE_KEY)
            if set(value) == {candidate}
        ),
        None,
    )
    if envelope_key is None:
        raise SecretCryptoError("provider configuration row is not encrypted")
    encrypted = value.get(envelope_key)
    if not isinstance(encrypted, str):
        raise SecretCryptoError("invalid provider configuration envelope")
    return dict(decrypt_json(encrypted))


def account_index_key(access_token: str) -> str:
    """A deterministic non-reversible index used only by the SQLite unique key."""
    if not isinstance(access_token, str) or not access_token:
        raise ValueError("account access token is required")
    digest = hmac.new(
        encryption_key_bytes(), access_token.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return f"{ACCOUNT_INDEX_PREFIX}{digest}"


def is_legacy_encrypted_text(value: object) -> bool:
    return isinstance(value, str) and value.startswith(LEGACY_PREFIX)


def migrate_encrypted_json(value: str) -> str:
    """Re-encrypt one legacy payload using the current product prefix/key."""
    if not is_legacy_encrypted_text(value):
        return value
    return encrypt_json(decrypt_json(value))


def is_legacy_configuration(value: object | None) -> bool:
    if not isinstance(value, Mapping):
        return False
    if set(value) == {LEGACY_CONFIGURATION_ENVELOPE_KEY}:
        return True
    if set(value) != {CONFIGURATION_ENVELOPE_KEY}:
        return False
    encrypted = value.get(CONFIGURATION_ENVELOPE_KEY)
    return is_legacy_encrypted_text(encrypted)


def migrate_configuration(value: object | None) -> dict[str, str] | object | None:
    """Re-encrypt a legacy configuration envelope without touching new rows."""
    if not is_legacy_configuration(value):
        return value
    return encrypt_configuration(decrypt_configuration(value))
