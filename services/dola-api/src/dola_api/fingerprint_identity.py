"""Per-account randomized HTTP/browser identity for the Dola provider.

Every account gets one identity (OS, Chromium major, locale, accept-language,
window size) generated on first use and persisted forever next to its Camoufox
fingerprint preset. Protocol-path headers and Camoufox launch options both
derive from the same record, so a polling request and a browser request for one
account stay coherent, while different accounts no longer share the single
hard-coded Chrome/Windows signature.

The module must never make the provider unavailable: any filesystem or data
problem degrades to ``None`` so callers fall back to the legacy fixed headers.
"""

from __future__ import annotations

import json
import os
import re
import secrets
from pathlib import Path
from typing import Any

IDENTITY_VERSION = 1

# OS profile pools: UA platform token, Sec-CH-UA platform, navigator platform,
# plausible desktop window sizes. macOS keeps Apple-only GPUs implicitly
# because the Camoufox preset already filters for the Apple WebGL vendor.
_OS_PROFILES: dict[str, dict[str, Any]] = {
    "windows": {
        "osToken": "Windows NT 10.0; Win64; x64",
        "secCHUAPlatform": '"Windows"',
        "windows": [(1920, 1040), (1536, 824), (2560, 1400), (1366, 728)],
    },
    "macos": {
        "osToken": "Macintosh; Intel Mac OS X 10_15_7",
        "secCHUAPlatform": '"macOS"',
        "windows": [(1440, 860), (1680, 1010), (1512, 944), (1728, 1008)],
    },
    "linux": {
        "osToken": "X11; Linux x86_64",
        "secCHUAPlatform": '"Linux"',
        "windows": [(1920, 1040), (1536, 824), (1366, 728)],
    },
}

# Chromium majors stay inside the range already used by the fixed legacy UA so
# Sec-CH-UA and the a_bogus signing context remain plausible.
_CHROME_MAJORS = ["143", "144", "145", "146"]

# locale pairs with matching Accept-Language value; zh-CN weighted heavier.
_LOCALE_PROFILES = [
    ("zh-CN", "zh-CN,zh;q=0.9,en;q=0.8"),
    ("zh-CN", "zh-CN,zh;q=0.9,en;q=0.8"),
    ("en-US", "en-US,en;q=0.9"),
    ("en-GB", "en-GB,en;q=0.9"),
    ("zh-HK", "zh-HK,zh;q=0.9,en;q=0.8"),
    ("ja-JP", "ja-JP,ja;q=0.9,en;q=0.8"),
]


def _profile_root(account_id: str) -> Path:
    normalized = re.sub(r"[^a-zA-Z0-9._-]+", "-", account_id).strip("-.")[:120]
    if not normalized:
        raise ValueError("empty account id")
    return Path(os.getenv("DOLA_PROFILE_DIR", "/data/dola/profiles")) / normalized


def _random_identity() -> dict[str, Any]:
    os_name = secrets.choice(list(_OS_PROFILES))
    profile = _OS_PROFILES[os_name]
    locale, accept_language = secrets.choice(_LOCALE_PROFILES)
    width, height = secrets.choice(profile["windows"])
    chrome_major = secrets.choice(_CHROME_MAJORS)
    return {
        "os": os_name,
        "chromeMajor": chrome_major,
        "locale": locale,
        "acceptLanguage": accept_language,
        "window": [width, height],
    }


def _valid(identity: Any) -> bool:
    if not isinstance(identity, dict):
        return False
    if identity.get("os") not in _OS_PROFILES or str(identity.get("chromeMajor", "")) not in _CHROME_MAJORS:
        return False
    window = identity.get("window")
    return (
        isinstance(identity.get("locale"), str)
        and bool(identity.get("acceptLanguage"))
        and isinstance(window, list)
        and len(window) == 2
        and all(isinstance(value, int) and value > 0 for value in window)
    )


def load_or_create_http_identity(account_id: str) -> dict[str, Any] | None:
    """Return the persisted identity for one account, creating it on first use."""
    if not account_id:
        return None
    try:
        root = _profile_root(account_id)
        path = root / "http-identity.json"
        if path.exists():
            stored = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(stored, dict) and stored.get("version") == IDENTITY_VERSION and _valid(stored.get("identity")):
                return stored["identity"]
        identity = _random_identity()
        # Reuse the OS already chosen by the Camoufox preset so the browser
        # fingerprint and the protocol UA never disagree for one account.
        preset_path = root / "fingerprint-preset.json"
        if preset_path.exists():
            try:
                preset_os = json.loads(preset_path.read_text(encoding="utf-8")).get("targetOs")
                if preset_os in _OS_PROFILES and preset_os != identity["os"]:
                    identity = {**identity, "os": preset_os, "window": list(secrets.choice(_OS_PROFILES[preset_os]["windows"]))}
            except (ValueError, OSError):
                pass
        root.mkdir(parents=True, exist_ok=True)
        temp_path = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        temp_path.write_text(json.dumps({"version": IDENTITY_VERSION, "identity": identity}, ensure_ascii=False), encoding="utf-8")
        os.replace(temp_path, path)
        return identity
    except Exception:
        return None


def remember_egress_ip(identity: dict[str, Any], account_id: str, proxy_url: str | None, egress_ip: str) -> dict[str, Any]:
    """Freeze the resolved egress IP per proxy so geoip values stay stable.

    Same proxy -> same stored IP: Camoufox geoip alignment (timezone, locale,
    WebRTC) stops drifting when the proxy provider rotates exit nodes. A new
    proxy refreshes the record.
    """
    if not identity or not account_id or not egress_ip:
        return identity
    try:
        path = _profile_root(account_id) / "http-identity.json"
        stored = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        if not isinstance(stored, dict) or stored.get("identity") != identity:
            return identity
        egress = {"proxyUrl": proxy_url or "", "ip": egress_ip}
        if stored.get("egress") == egress:
            return identity
        stored["egress"] = egress
        temp_path = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        temp_path.write_text(json.dumps(stored, ensure_ascii=False), encoding="utf-8")
        os.replace(temp_path, path)
    except Exception:
        pass
    return identity


def stored_egress_ip(account_id: str) -> tuple[str | None, str | None]:
    """Return (egress_ip, proxy_url) previously frozen for this account."""
    if not account_id:
        return (None, None)
    try:
        path = _profile_root(account_id) / "http-identity.json"
        if not path.exists():
            return (None, None)
        stored = json.loads(path.read_text(encoding="utf-8"))
        egress = stored.get("egress") if isinstance(stored, dict) else None
        if not isinstance(egress, dict) or not egress.get("ip"):
            return (None, None)
        return (str(egress["ip"]), egress.get("proxyUrl") if isinstance(egress.get("proxyUrl"), str) else None)
    except Exception:
        return (None, None)


def http_headers(identity: dict[str, Any] | None) -> dict[str, str]:
    """Per-account UA / Accept-Language / Sec-CH-UA overrides for protocol requests."""
    if not _valid(identity):
        return {}
    profile = _OS_PROFILES[identity["os"]]
    major = str(identity["chromeMajor"])
    return {
        "userAgent": f"Mozilla/5.0 ({profile['osToken']}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36",
        "secCHUA": f'"Not-A.Brand";v="24", "Chromium";v="{major}"',
        "secCHUAPlatform": profile["secCHUAPlatform"],
        "acceptLanguage": str(identity["acceptLanguage"]),
    }
