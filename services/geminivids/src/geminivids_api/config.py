"""Runtime settings for the GeminiVids sidecar (pure protocol, no browser)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _parse_keys(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [part.strip() for part in raw.replace("\n", ",").split(",") if part.strip()]


def _parse_int(raw: str | None, default: int) -> int:
    try:
        return int(raw) if raw not in (None, "") else default
    except (TypeError, ValueError):
        return default


@dataclass
class Settings:
    host: str = os.getenv("GVIDS_HOST", "127.0.0.1")
    port: int = _parse_int(os.getenv("GVIDS_PORT"), 8080)
    accounts_dir: str = os.getenv("GVIDS_ACCOUNTS_DIR", "")
    api_keys: list[str] = field(default_factory=lambda: _parse_keys(
        os.getenv("GVIDS_API_KEY") or os.getenv("GVIDS_API_KEYS")))
    proxy_url: str | None = os.getenv("GVIDS_PROXY") or None
    default_doc_id: str | None = os.getenv("GVIDS_DEFAULT_DOC_ID") or None
    generate_timeout_seconds: int = _parse_int(os.getenv("GVIDS_GENERATE_TIMEOUT"), 420)
    download_timeout_seconds: int = _parse_int(os.getenv("GVIDS_DOWNLOAD_TIMEOUT"), 300)
    cooldown_seconds: int = _parse_int(os.getenv("GVIDS_ACCOUNT_COOLDOWN_SECONDS"), 60)

    @property
    def auth_enabled(self) -> bool:
        return bool(self.api_keys)


settings = Settings()
