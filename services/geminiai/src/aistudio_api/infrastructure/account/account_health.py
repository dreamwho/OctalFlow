"""Isolated, read-only browser health checks for stored AI Studio accounts."""

from __future__ import annotations

import json
import math
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from aistudio_api.config import settings
from aistudio_api.infrastructure.account.account_store import AccountStore
from aistudio_api.infrastructure.gateway.session import BrowserSession


_AUTH_COOKIE_NAMES = {
    "SID",
    "SSID",
    "HSID",
    "APISID",
    "SAPISID",
    "__Secure-1PAPISID",
    "__Secure-3PAPISID",
    "__Secure-1PSID",
    "__Secure-3PSID",
    "__Secure-1PSIDTS",
    "__Secure-3PSIDTS",
    "LSID",
    "OSID",
    "__Secure-OSID",
}


def _cookie_expiry(state: dict[str, Any], expiry_metadata_known: bool) -> tuple[str | None, bool]:
    if not expiry_metadata_known:
        return None, False
    auth_cookies = [
        cookie
        for cookie in state.get("cookies", [])
        if isinstance(cookie, dict)
        and cookie.get("name") in _AUTH_COOKIE_NAMES
        and isinstance(cookie.get("domain"), str)
        and (
            cookie["domain"].lstrip(".").lower() == "google.com"
            or cookie["domain"].lstrip(".").lower().endswith(".google.com")
        )
    ]
    if not auth_cookies:
        return None, False
    expiries = []
    for cookie in auth_cookies:
        expiry = cookie.get("expires")
        if (
            not isinstance(expiry, (int, float))
            or not math.isfinite(expiry)
            or expiry <= 0
        ):
            # Mixed session/persistent authentication cookies do not have one
            # defensible account expiry date.
            return None, False
        expiries.append(float(expiry))
    try:
        return datetime.fromtimestamp(min(expiries), timezone.utc).isoformat(), True
    except (OverflowError, OSError, ValueError):
        return None, False


def _page_status(page) -> tuple[str | None, str | None]:
    """Classify only explicit browser destinations; never infer from UI copy alone."""
    url = page.url or ""
    parsed = urlsplit(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme == "about" and parsed.path.lower() == "certerror":
        return "unavailable", "浏览器显示证书安全警告，未跳过安全验证。"
    if parsed.scheme == "about" and parsed.path.lower() == "neterror":
        return "unavailable", "浏览器无法访问 AI Studio，请检查网络与代理配置。"
    if host == "accounts.google.com":
        return "login_required", "登录状态无效或账号不匹配，请重新登录或导入该账号。"
    if host and host != "aistudio.google.com":
        return "unavailable", "浏览器未能到达 AI Studio，请检查网络与代理配置。"
    return None, None


def _passive_browser_check_sync(session: BrowserSession) -> tuple[str, str]:
    """Navigate and inspect the page without accepting dialogs or submitting data."""
    session._ensure_browser_sync(read_only=True)
    page = session._hook_page
    if page is None:
        return "unavailable", "浏览器未能启动，请检查浏览器运行状态。"

    try:
        page.goto(
            settings.studio_url,
            wait_until="domcontentloaded",
            timeout=settings.timeout_capture * 1000,
        )
    except Exception:
        status, message = _page_status(page)
        if status is not None:
            return status, message
        return "unavailable", "暂时无法访问 AI Studio，请检查网络与代理配置。"

    status, message = _page_status(page)
    if status is not None:
        return status, message

    # Camoufox documents `mw:` only for page.evaluate, not wait_for_function.
    # Wait on DOM-visible readiness here, then inspect the AI Studio main-world
    # object explicitly below before installing hooks.
    ready_condition = """() => {
        const host = location.hostname.toLowerCase();
        return host === 'accounts.google.com'
            || (host === 'aistudio.google.com' && !!document.querySelector('textarea'));
    }"""
    try:
        page.wait_for_function(ready_condition, timeout=settings.timeout_capture * 1000)
    except Exception:
        status, message = _page_status(page)
        if status is not None:
            return status, message
        return "error", "AI Studio 已打开，但页面尚未就绪或需要人工确认；本次未执行任何操作。"

    status, message = _page_status(page)
    if status is not None:
        return status, message

    try:
        has_maker_suite = bool(page.evaluate("mw:!!window.default_MakerSuite"))
    except Exception:
        has_maker_suite = False
    has_textarea = page.query_selector("textarea") is not None
    if not has_maker_suite or not has_textarea:
        return "error", "AI Studio 已打开，但页面尚未就绪或需要人工确认；本次未执行任何操作。"

    try:
        session._install_hooks_sync(page)
    except Exception:
        status, message = _page_status(page)
        if status is not None:
            return status, message
        return "error", "AI Studio 页面已打开，但页面接口初始化失败。"
    return "ready", "AI Studio 页面接口已就绪；本次未单独验证账号邮箱。"


async def check_account_health(store: AccountStore, account_id: str) -> dict[str, Any] | None:
    """Probe a private snapshot of auth.json without switching the active account.

    The hot persistent profile is intentionally not copied: copying a live
    browser profile is unsafe. The probe uses the saved storage-state snapshot
    and a fresh temporary profile with the same configured engine and proxy.
    The probe starts in read-only mode and navigates explicitly, so account-page
    consent dialogs and cookies are never accepted or saved by this check.
    """
    account = store.get_account(account_id)
    if account is None:
        return None

    checked_at = datetime.now(timezone.utc).isoformat()
    auth_path = store.get_auth_path_optional(account_id, require_exists=True)
    state = store.load_storage_state(account_id) if auth_path else None
    if not isinstance(state, dict):
        health = {
            "status": "login_required",
            "checked_at": checked_at,
            "message": "未找到该账号的本地登录凭据，请重新登录或导入账号。",
            "cookie_expires_at": None,
            "cookie_expiry_known": False,
        }
        store.save_health(account_id, health)
        return health

    cookie_expires_at, expiry_known = _cookie_expiry(state, account.cookie_expiry_known)
    session: BrowserSession | None = None
    try:
        with tempfile.TemporaryDirectory(prefix="aistudio-account-check-") as temporary_root:
            os.chmod(temporary_root, 0o700)
            account_dir = Path(temporary_root) / account_id
            account_dir.mkdir(mode=0o700)
            temporary_auth = account_dir / "auth.json"
            fd = os.open(temporary_auth, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                json.dump(state, file, ensure_ascii=False)
                file.write("\n")

            session = BrowserSession(settings.browser_port)
            session._auth_file = str(temporary_auth)
            session._profile_dir = session._derive_profile_dir(str(temporary_auth))
            try:
                status, message = await session._run_sync(_passive_browser_check_sync, session)
            except Exception as error:
                status, message = "unavailable", "暂时无法访问 AI Studio，请检查网络与代理配置。"
            finally:
                try:
                    await session.close()
                except Exception:
                    # Browser close errors must not expose exception text or prevent
                    # the already determined health result from being persisted.
                    pass
                session = None
    except Exception:
        status, message = "unavailable", "暂时无法访问 AI Studio，请检查网络与代理配置。"
    finally:
        if session is not None:
            try:
                await session.close()
            except Exception:
                # Best-effort cleanup if setup failed after starting the browser.
                pass

    health = {
        "status": status,
        "checked_at": checked_at,
        "message": message,
        "cookie_expires_at": cookie_expires_at,
        "cookie_expiry_known": expiry_known,
    }
    store.save_health(account_id, health)
    return health
