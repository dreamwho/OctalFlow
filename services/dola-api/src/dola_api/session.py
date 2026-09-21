from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import math
import os
import re
import secrets
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from .contracts import AccountInspectRequest, VerificationInput, VerificationLease, VideoRequest, VideoTask
from .page_scripts import MAIN_WORLD_CREDIT_SCRIPT, MAIN_WORLD_JSON_REQUEST_SCRIPT, MAIN_WORLD_SUBMIT_SCRIPT
from .protocol import PROFILES, canonical_ratio, validate_request
from .query import decode_main_url, extract_conversation_id, extract_image_urls, extract_video_url, fetch_generation_result, generation_query_payloads, parse_generation_payloads, probe_account_login
from .task_store import decrypt_secret, decrypt_cookie, encrypt_secret, encrypt_cookie, load_state, save_state
from .uploads import resolve_references

DOLA_WEB_ORIGIN = "https://www.dola.com"
DOLA_BOT_ID = "7339470689562525703"
DOLA_AID = "495671"
DOLA_PC_VERSION = "3.36.11"
DOLA_VERSION_CODE = "20800"


@dataclass
class PageSession:
    account_id: str
    credential_version: int
    proxy_mode: str
    proxy_target: str
    proxy_url: str
    cookie: str
    identity: dict[str, str] | None = None


@dataclass
class VerificationSession:
    verification_id: str
    task_id: str
    request: VideoRequest | None
    page_session: PageSession
    browser: Any
    context: Any
    page: Any
    references: list[dict[str, Any]]
    decision: dict[str, Any]
    lease_token: str
    created_at: str
    pointer_down: bool = False


class CamoufoxSessionPool:
    """Small in-process session pool; durable task state belongs to Next.js.

    Submission is protocol-level: the request body and query string are built
    here and sent through the page's bdms-patched main-world XMLHttpRequest,
    which appends the a_bogus signature that /chat/completion requires.
    """

    def __init__(self) -> None:
        self._sessions: dict[tuple[str, int, str], PageSession] = {}
        self._tasks: dict[str, VideoTask] = {}
        self._task_meta: dict[str, dict[str, Any]] = {}
        self._verifications: dict[str, VerificationSession] = {}
        self._lock = asyncio.Lock()
        self._persist_lock = asyncio.Lock()
        self._loaded = False

    async def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        async with self._lock:
            if self._loaded:
                return
            state = await asyncio.to_thread(load_state)
            for value in state.get("tasks", []) if isinstance(state.get("tasks"), list) else []:
                if not isinstance(value, dict):
                    continue
                try:
                    task = VideoTask.model_validate(value)
                except Exception:
                    continue
                self._tasks[task.id] = task
            raw_meta = state.get("meta") if isinstance(state.get("meta"), dict) else {}
            for task_id, value in raw_meta.items():
                if not isinstance(value, dict):
                    continue
                try:
                    cookie = decrypt_cookie(str(value.get("cookieCiphertext") or ""))
                except RuntimeError:
                    cookie = ""
                meta = {key: item for key, item in value.items() if key != "cookieCiphertext"}
                proxy_url = ""
                if value.get("proxyUrlCiphertext"):
                    try:
                        proxy_url = decrypt_secret(str(value.get("proxyUrlCiphertext") or ""))
                    except RuntimeError:
                        proxy_url = ""
                if cookie:
                    meta["cookie"] = cookie
                    account_id = str(meta.get("accountId") or "")
                    credential_version = int(meta.get("credentialVersion") or 1)
                    proxy_mode = str(meta.get("proxyMode") or "direct")
                    proxy_target = str(meta.get("proxyTarget") or "")
                    meta["proxyUrl"] = proxy_url
                    self._sessions.setdefault((account_id, credential_version, proxy_url), PageSession(account_id, credential_version, proxy_mode, proxy_target, proxy_url, cookie, meta.get("identity") or {}))
                self._task_meta[str(task_id)] = meta
            self._loaded = True

    async def _persist(self) -> None:
        async with self._persist_lock:
            meta: dict[str, dict[str, Any]] = {}
            for task_id, value in self._task_meta.items():
                item = dict(value)
                cookie = str(item.pop("cookie", "") or "")
                proxy_url = str(item.pop("proxyUrl", "") or "")
                if cookie:
                    try:
                        item["cookieCiphertext"] = encrypt_cookie(cookie)
                    except RuntimeError:
                        # Keep task identity durable in development, but never write
                        # a plaintext Dola Cookie when the provider key is missing.
                        pass
                if proxy_url:
                    try:
                        item["proxyUrlCiphertext"] = encrypt_secret(proxy_url)
                    except RuntimeError:
                        pass
                meta[task_id] = item
            await asyncio.to_thread(save_state, [task.model_dump(exclude_none=True) for task in self._tasks.values()], meta)

    async def submit(self, request: VideoRequest) -> VideoTask:
        await self._ensure_loaded()
        profile = validate_request(request.model, request.duration, request.ratio)
        account_id = request.accountId or "provider-selected"
        credential_version = request.credentialVersion or 1
        proxy_mode = request.proxyMode or "direct"
        proxy_target = (request.proxyTarget or "").strip()
        proxy_url = _proxy_url_for_request(proxy_mode, request.proxyUrl)
        if not request.cookie:
            raise ValueError("missing_cookie")
        key = (account_id, credential_version, proxy_url or "direct")
        async with self._lock:
            self._sessions.setdefault(key, PageSession(account_id, credential_version, proxy_mode, proxy_target, proxy_url or "", request.cookie))
            task_id = f"dola-{uuid.uuid4()}"
            task = VideoTask(id=task_id, model=profile.model, status="queued", accountId=account_id, credentialVersion=credential_version, proxyMode=proxy_mode, proxyTarget=proxy_target or None)
            self._task_meta[task_id] = {"accountId": account_id, "credentialVersion": credential_version, "proxyMode": proxy_mode, "proxyTarget": proxy_target, "proxyUrl": proxy_url or "", "cookie": request.cookie}
            self._tasks[task_id] = task
            await self._persist()
        asyncio.create_task(self._run_page_submit(task_id, request, key))
        return task

    async def inspect(self, request: AccountInspectRequest) -> dict[str, Any]:
        if not request.cookie:
            raise ValueError("missing_cookie")
        proxy_url = _proxy_url_for_request(request.proxyMode, request.proxyUrl)
        login_probe = await probe_account_login(request.cookie, proxy_url or None)
        if login_probe.get("state") == "needs_login":
            return {"status": "needs_login", "quota": [], "loginProbe": login_probe}
        if request.authOnly:
            return {"status": "ready" if login_probe.get("state") == "ready" else "unverified", "quota": [], "loginProbe": login_probe}
        if os.getenv("DOLA_ENABLE_BROWSER", "0") != "1":
            raise RuntimeError("camoufox_runtime_disabled")
        try:
            from camoufox.async_api import AsyncCamoufox  # type: ignore
        except ImportError as error:
            raise RuntimeError("camoufox_not_installed") from error
        is_headless = True if request.headless is None else bool(request.headless)
        browser_options = _camoufox_browser_options(is_headless, proxy_url, request.accountId)
        async with AsyncCamoufox(**browser_options) as browser:
            context = await browser.new_context(**_camoufox_context_options())
            await context.add_cookies(_cookie_header_to_playwright(request.cookie))
            page = await context.new_page()
            auth_state = await _goto_dola_page(page, os.getenv("DOLA_WEB_URL", "https://www.dola.com/chat/create-image"))
            try:
                await page.wait_for_load_state("load", timeout=45_000)
            except Exception:
                pass
            title = (await page.title()).lower()
            body = (await page.locator("body").inner_text()).strip()
            if _page_has_age_confirmation(title, body):
                return {
                    "status": "verification_required",
                    "quota": [],
                    "loginProbe": login_probe,
                    "verificationDecision": {"type": "verification", "subtype": "age_confirmation", "pageState": "age_confirmation_required"},
                }
            if await page.locator("text=Verify you are human").count() or _page_has_verification_marker(title, body):
                return {"status": "verification_required", "quota": [], "loginProbe": login_probe, "verificationDecision": {"type": "verification", "subtype": "unknown", "pageState": "verification_required"}}
            if auth_state == "needs_login" or _page_looks_logged_out(page.url, title, body):
                return {"status": "needs_login", "quota": [], "loginProbe": login_probe}
            protocol = await _probe_account_protocol(page)
            if not protocol["ready"]:
                return {"status": "unverified", "quota": [], "protocol": protocol, "loginProbe": login_probe}
            quota, quota_diagnostics = await _read_account_quota(page)
            return {"status": "ready", "quota": quota, "quotaDiagnostics": quota_diagnostics, "protocol": protocol, "loginProbe": login_probe}

    async def verify_account(self, request: AccountInspectRequest) -> dict[str, Any]:
        if not request.cookie:
            raise ValueError("missing_cookie")
        proxy_url = _proxy_url_for_request(request.proxyMode, request.proxyUrl)
        if os.getenv("DOLA_ENABLE_BROWSER", "0") != "1":
            raise RuntimeError("camoufox_runtime_disabled")
        try:
            from camoufox.async_api import AsyncCamoufox  # type: ignore
        except ImportError as error:
            raise RuntimeError("camoufox_not_installed") from error
        is_headless = True if request.headless is None else bool(request.headless)
        browser_options = _camoufox_browser_options(is_headless, proxy_url, request.accountId)
        browser_manager = AsyncCamoufox(**browser_options)
        browser = await browser_manager.__aenter__()
        keep_open = False
        try:
            context = await browser.new_context(**_camoufox_context_options())
            await context.add_cookies(_cookie_header_to_playwright(request.cookie))
            page = await context.new_page()
            auth_state = await _goto_dola_page(page, os.getenv("DOLA_WEB_URL", "https://www.dola.com/chat/create-image"))
            try:
                await page.wait_for_load_state("networkidle", timeout=3_000)
            except Exception:
                pass
            title = (await page.title()).lower()
            body = (await page.locator("body").inner_text()).strip()
            age_confirmation = _page_has_age_confirmation(title, body)
            has_challenge = bool(age_confirmation or await page.locator("text=Verify you are human").count() or _page_has_verification_marker(title, body))
            if not has_challenge:
                try:
                    await page.wait_for_selector("text=Verify you are human, iframe[src*='captcha'], div[class*='captcha']", timeout=2_000)
                    has_challenge = True
                except Exception:
                    pass
            if has_challenge:
                session = PageSession(
                    account_id=request.accountId,
                    credential_version=request.credentialVersion,
                    proxy_mode=request.proxyMode,
                    proxy_target=request.proxyTarget,
                    proxy_url=proxy_url,
                    cookie=request.cookie,
                )
                verification_id = await self._register_verification(
                    task_id="",
                    request=None,
                    session=session,
                    browser=browser_manager,
                    context=context,
                    page=page,
                    references=[],
                    decision={
                        "type": "verification",
                        "subtype": "age_confirmation" if age_confirmation else "slide",
                        "source": "page_age_confirmation" if age_confirmation else "page_challenge",
                        "pageState": "age_confirmation_required" if age_confirmation else "verification_required",
                    },
                )
                keep_open = True
                screenshot_base64 = ""
                try:
                    screenshot = await page.screenshot(type="png")
                    screenshot_base64 = base64.b64encode(screenshot).decode("ascii")
                except Exception:
                    pass
                return {
                    "status": "verification_required",
                    "verificationId": verification_id,
                    "accountId": request.accountId,
                    "screenshotBase64": screenshot_base64,
                }
            page_state = "needs_login" if auth_state == "needs_login" or _page_looks_logged_out(page.url, title, body) else "ready"
            protocol = {"ready": False, "login": page_state == "ready", "error": "login_required"}
            if page_state == "ready":
                protocol = await _probe_account_protocol(page)
                if not protocol["ready"]:
                    page_state = "protocol_unavailable"
            session = PageSession(
                account_id=request.accountId,
                credential_version=request.credentialVersion,
                proxy_mode=request.proxyMode,
                proxy_target=request.proxyTarget,
                proxy_url=proxy_url,
                cookie=request.cookie,
            )
            verification_id = await self._register_verification(
                task_id="",
                request=None,
                session=session,
                browser=browser_manager,
                context=context,
                page=page,
                references=[],
                decision={"type": "inspect", "subtype": "page", "source": "account_diagnostic", "pageState": page_state},
            )
            keep_open = True
            screenshot_base64 = ""
            try:
                screenshot_base64 = base64.b64encode(await page.screenshot(type="png")).decode("ascii")
            except Exception:
                pass
            return {
                "status": "diagnostic_ready",
                "pageState": page_state,
                "verificationId": verification_id,
                "accountId": request.accountId,
                "pageUrl": str(page.url)[:500],
                "pageTitle": title[:300],
                "screenshotBase64": screenshot_base64,
                "protocol": protocol,
            }
        finally:
            if not keep_open:
                try:
                    await context.close()
                except Exception:
                    pass
                try:
                    await browser_manager.__aexit__(None, None, None)
                except Exception:
                    pass

    async def get(self, task_id: str) -> VideoTask | None:
        await self._ensure_loaded()
        task = self._tasks.get(task_id)
        if not task:
            return None
        if task.status == "accepted":
            await self._refresh_task(task_id)
        return self._tasks.get(task_id)

    async def open_verification(self, verification_id: str) -> dict[str, Any]:
        await self._ensure_loaded()
        verification = self._verifications.get(verification_id)
        if not verification:
            raise ValueError("verification_not_found")
        return await self._verification_snapshot(verification, include_lease=True)

    async def verification_input(self, verification_id: str, input: VerificationInput) -> dict[str, Any]:
        await self._ensure_loaded()
        verification = self._verifications.get(verification_id)
        if not verification:
            raise ValueError("verification_not_found")
        self._check_verification_lease(verification, input.leaseToken)
        viewport = await self._verification_viewport(verification.page)
        if not math.isfinite(input.x) or not math.isfinite(input.y) or input.x < 0 or input.y < 0 or input.x > viewport["width"] or input.y > viewport["height"]:
            raise ValueError("verification_coordinate_invalid")
        if input.action == "down":
            if verification.pointer_down:
                raise ValueError("verification_pointer_already_down")
            await verification.page.mouse.move(input.x, input.y)
            await verification.page.mouse.down()
            verification.pointer_down = True
        elif input.action == "move":
            if not verification.pointer_down:
                raise ValueError("verification_pointer_not_down")
            await verification.page.mouse.move(input.x, input.y)
        else:
            if not verification.pointer_down:
                raise ValueError("verification_pointer_not_down")
            await verification.page.mouse.move(input.x, input.y)
            await verification.page.mouse.up()
            verification.pointer_down = False
        return await self._verification_snapshot(verification)

    async def resume_verification(self, verification_id: str, lease: VerificationLease) -> dict[str, Any]:
        await self._ensure_loaded()
        verification = self._verifications.get(verification_id)
        if not verification:
            raise ValueError("verification_not_found")
        self._check_verification_lease(verification, lease.leaseToken)
        if verification.pointer_down:
            raise ValueError("verification_active")

        # 账号验证挑战模式（无具体生图/生视频任务）
        if not verification.request:
            try:
                await verification.page.wait_for_load_state("networkidle", timeout=3_000)
            except Exception:
                pass
            title = (await verification.page.title()).lower()
            body = (await verification.page.locator("body").inner_text()).strip()
            age_confirmation = _page_has_age_confirmation(title, body)
            challenge_present = bool(
                age_confirmation
                or
                await verification.page.locator("text=Verify you are human").count()
                or _page_has_verification_marker(title, body)
            )
            if challenge_present:
                verification.decision = _verification_decision({
                    "type": "verification",
                    "subtype": "age_confirmation" if age_confirmation else verification.decision.get("subtype"),
                    "pageState": "age_confirmation_required" if age_confirmation else "verification_required",
                })
                return await self._verification_snapshot(verification)
            if _page_looks_logged_out(verification.page.url, title, body):
                snapshot = await self._verification_snapshot(verification)
                snapshot["status"] = "needs_login"
                snapshot["pageState"] = "needs_login"
                return snapshot
            protocol = await _probe_account_protocol(verification.page)
            if not protocol["ready"]:
                snapshot = await self._verification_snapshot(verification)
                snapshot["status"] = "diagnostic_ready"
                snapshot["pageState"] = "protocol_unavailable"
                snapshot["protocol"] = protocol
                return snapshot
            cookies = await verification.context.cookies()
            fresh_cookie = "; ".join(f"{item['name']}={item['value']}" for item in cookies if item.get("name")) or verification.page_session.cookie
            quota, quota_diagnostics = await _read_account_quota(verification.page)
            await self._discard_verification(verification_id)
            return {
                "verificationId": verification_id,
                "status": "accepted",
                "accountId": verification.page_session.account_id,
                "cookie": fresh_cookie,
                "quota": quota,
                "quotaDiagnostics": quota_diagnostics,
                "protocol": protocol,
            }

        references = await resolve_references(verification.page, verification.references, verification.page_session.proxy_url)
        verification.references = references
        try:
            await verification.page.wait_for_load_state("load", timeout=45_000)
        except Exception:
            pass
        result = await _execute_completion_submit(verification.page, verification.request, references, verification.page_session.cookie)
        if result.get("verificationRequired"):
            verification.decision = _verification_decision(result.get("verificationDecision"))
            return await self._verification_snapshot(verification)
        if result.get("restricted"):
            raise RuntimeError("proxy_region_blocked")
        if result.get("serviceFrequent"):
            raise RuntimeError("rate_limited")
        if result.get("signatureRejected"):
            raise RuntimeError("signature_rejected")
        if int(result.get("status") or 0) >= 400:
            raise RuntimeError("submission_unknown")
        cookies = await verification.context.cookies()
        cookie = "; ".join(f"{item['name']}={item['value']}" for item in cookies if item.get("name")) or verification.page_session.cookie
        identity = _identity_from_result(result)
        conversation_id = _result_conversation_id(result)
        video_url = _result_video_url(result)
        image_urls = _result_image_urls(result)
        if not conversation_id and not video_url and not image_urls:
            raise RuntimeError("submission_unknown")
        verification.page_session.identity = identity
        if cookie:
            verification.page_session.cookie = cookie
        self._task_meta[verification.task_id] = {
            **self._task_meta.get(verification.task_id, {}),
            **({"conversationId": conversation_id} if conversation_id else {}),
            "identity": identity,
            "cookie": cookie,
            "accountId": verification.page_session.account_id,
            "credentialVersion": verification.page_session.credential_version,
            "proxyMode": verification.page_session.proxy_mode,
            "proxyTarget": verification.page_session.proxy_target,
            "proxyUrl": verification.page_session.proxy_url,
        }
        task = self._tasks.get(verification.task_id)
        completed = bool(video_url or image_urls)
        if task:
            update: dict[str, Any] = {"status": "completed" if completed else "accepted", "error": None, "verificationId": None}
            if conversation_id:
                update["conversationId"] = conversation_id
            if video_url:
                update["videoUrl"] = video_url
            if image_urls:
                update["imageUrls"] = image_urls
            self._tasks[verification.task_id] = task.model_copy(update=update)
        await self._persist()
        await self._discard_verification(verification_id)
        return {
            "verificationId": verification_id,
            "status": "completed" if completed else "accepted",
            "taskId": verification.task_id,
            "accountId": verification.page_session.account_id,
            "cookie": cookie,
            **({"conversationId": conversation_id} if conversation_id else {}),
            **({"videoUrl": video_url} if video_url else {}),
            **({"imageUrls": image_urls} if image_urls else {}),
        }

    async def close_verification(self, verification_id: str, lease: VerificationLease) -> dict[str, Any]:
        await self._ensure_loaded()
        verification = self._verifications.get(verification_id)
        if not verification:
            raise ValueError("verification_not_found")
        self._check_verification_lease(verification, lease.leaseToken)
        task = self._tasks.get(verification.task_id) if verification.task_id else None
        if task:
            self._tasks[verification.task_id] = task.model_copy(update={"status": "failed", "error": "verification_closed"})
            await self._persist()
        await self._discard_verification(verification_id)
        return {"verificationId": verification_id, "status": "closed", "taskId": verification.task_id}

    async def start_google_login(self, proxy_mode: str = "direct", proxy_url: str | None = None, timeout_seconds: int = 180) -> dict[str, Any]:
        if os.getenv("DOLA_ENABLE_BROWSER", "0") != "1":
            raise RuntimeError("camoufox_runtime_disabled")
        try:
            from camoufox.async_api import AsyncCamoufox  # type: ignore
        except ImportError as error:
            raise RuntimeError("camoufox_not_installed") from error

        resolved_proxy = _proxy_url_for_request(proxy_mode, proxy_url)
        browser_options = _camoufox_browser_options(False, resolved_proxy)

        browser_manager = AsyncCamoufox(**browser_options)
        browser = await browser_manager.__aenter__()
        try:
            context = await browser.new_context(**_camoufox_context_options())
            page = await context.new_page()
            login_url = os.getenv("DOLA_LOGIN_URL", "https://www.dola.com/login")
            await page.goto(login_url, wait_until="domcontentloaded")

            deadline = asyncio.get_event_loop().time() + timeout_seconds
            logged_in_cookie = ""
            user_email = ""

            while asyncio.get_event_loop().time() < deadline:
                current_url = page.url.lower()
                cookies = await context.cookies()
                cookie_names = {c.get("name") for c in cookies}
                has_session_cookie = bool(cookie_names & {"sessionid", "session", "token", "auth_token", "uid", "user_id"})
                is_on_chat = "dola.com/chat" in current_url or "dola.com/create" in current_url or ("dola.com" in current_url and "/login" not in current_url and "/sign-in" not in current_url)

                if (has_session_cookie and is_on_chat) or (has_session_cookie and len(cookies) >= 3):
                    try:
                        title = (await page.title()).lower()
                        body = (await page.locator("body").inner_text()).strip()
                        if not _page_looks_logged_out(current_url, title, body):
                            cookie_pairs = [f"{item['name']}={item['value']}" for item in cookies if item.get("name")]
                            logged_in_cookie = "; ".join(cookie_pairs)
                            try:
                                user_info = await page.evaluate("""() => {
                                    const meta = document.querySelector('meta[name="user-email"]');
                                    const emailMatch = document.body ? document.body.innerText.match(/[a-zA-Z0-9._%+-]+@gmail\\.com/i) : null;
                                    return { email: meta ? meta.content : (emailMatch ? emailMatch[0] : '') };
                                }""")
                                if isinstance(user_info, dict) and user_info.get("email"):
                                    user_email = str(user_info.get("email"))
                            except Exception:
                                pass
                            break
                    except Exception:
                        pass
                await asyncio.sleep(2)

            if not logged_in_cookie:
                raise TimeoutError("google_login_timeout_or_cancelled")

            return {
                "status": "success",
                "cookie": logged_in_cookie,
                "email": user_email or None,
                "name": f"Google 账号 {user_email}" if user_email else None,
            }
        finally:
            try:
                await browser_manager.__aexit__(None, None, None)
            except Exception:
                pass

    async def _register_verification(self, task_id: str, request: VideoRequest | None, session: PageSession, browser: Any, context: Any, page: Any, references: list[dict[str, Any]], decision: Any) -> str:
        verification_id = f"dola-verification-{uuid.uuid4()}"
        verification = VerificationSession(
            verification_id=verification_id,
            task_id=task_id,
            request=request,
            page_session=session,
            browser=browser,
            context=context,
            page=page,
            references=references,
            decision=_verification_decision(decision),
            lease_token=secrets.token_urlsafe(32),
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        async with self._lock:
            self._verifications[verification_id] = verification
        return verification_id

    async def _discard_verification(self, verification_id: str) -> None:
        verification = self._verifications.pop(verification_id, None)
        if not verification:
            return
        try:
            await verification.context.close()
        except Exception:
            pass
        try:
            await verification.browser.__aexit__(None, None, None)
        except Exception:
            pass

    async def _verification_snapshot(self, verification: VerificationSession, include_lease: bool = False) -> dict[str, Any]:
        viewport = await self._verification_viewport(verification.page)
        try:
            screenshot = await verification.page.screenshot(type="png")
        except Exception:
            screenshot = b""
        snapshot: dict[str, Any] = {
            "verificationId": verification.verification_id,
            "taskId": verification.task_id,
            "status": "needs_review",
            "decision": verification.decision,
            "createdAt": verification.created_at,
            "viewport": viewport,
            "screenshotBase64": base64.b64encode(screenshot).decode("ascii"),
            "pageUrl": str(verification.page.url)[:500],
            "pageState": str(verification.decision.get("pageState") or "verification_required"),
        }
        if include_lease:
            snapshot["leaseToken"] = verification.lease_token
        return snapshot

    async def _verification_viewport(self, page: Any) -> dict[str, int]:
        try:
            value = await page.evaluate("() => ({ width: Math.max(1, innerWidth), height: Math.max(1, innerHeight) })")
            if isinstance(value, dict):
                return {"width": int(value.get("width") or 1365), "height": int(value.get("height") or 900)}
        except Exception:
            pass
        return {"width": 1365, "height": 900}

    @staticmethod
    def _check_verification_lease(verification: VerificationSession, lease_token: str) -> None:
        if not secrets.compare_digest(verification.lease_token, lease_token):
            raise PermissionError("verification_lease_invalid")

    async def _run_page_submit(self, task_id: str, request: VideoRequest, key: tuple[str, int, str]) -> None:
        self._tasks[task_id] = self._tasks[task_id].model_copy(update={"status": "running"})
        await self._persist()
        try:
            # The browser adapter is deliberately isolated behind this method.
            # It is enabled only in a Camoufox runtime; the protocol request is
            # built server-side and signed by the page's patched XHR pipeline.
            result = await self._submit_in_camoufox(task_id, request, self._sessions[key])
            identity = result.get("identity") if isinstance(result.get("identity"), dict) else {}
            cookie = str(result.get("cookie") or request.cookie or "")
            conversation_id = _result_conversation_id(result)
            video_url = _result_video_url(result)
            image_urls = _result_image_urls(result)
            diagnostics = result.get("diagnostics") if isinstance(result.get("diagnostics"), dict) else {}
            self._task_meta[task_id] = {
                **self._task_meta.get(task_id, {}),
                **({"conversationId": conversation_id} if conversation_id else {}),
                "identity": identity,
                "cookie": cookie,
                "accountId": self._sessions[key].account_id,
                "credentialVersion": self._sessions[key].credential_version,
                "proxyMode": self._sessions[key].proxy_mode,
                "proxyTarget": self._sessions[key].proxy_target,
                "proxyUrl": self._sessions[key].proxy_url,
                **({"ackReceived": True} if result.get("ackReceived") else {}),
                **({"diagnostics": diagnostics} if diagnostics else {}),
                **({"screenshotBase64": result.get("screenshotBase64")} if result.get("screenshotBase64") else {}),
            }
            self._sessions[key].identity = identity
            if result.get("cookie"):
                self._sessions[key].cookie = cookie
            if result.get("verificationRequired"):
                verification_id = str(result.get("verificationId") or f"dola-verification-{uuid.uuid4()}")
                update: dict[str, Any] = {"status": "needs_review", "error": "verification_required", "verificationId": verification_id, "diagnostics": diagnostics or None}
                if conversation_id:
                    update["conversationId"] = conversation_id
                if result.get("screenshotBase64"):
                    update["screenshotBase64"] = result.get("screenshotBase64")
                self._tasks[task_id] = self._tasks[task_id].model_copy(update=update)
                self._task_meta[task_id] = {
                    **self._task_meta.get(task_id, {}),
                    "verificationId": verification_id,
                    "verificationDecision": result.get("verificationDecision") if isinstance(result.get("verificationDecision"), dict) else {"type": "verify", "subtype": "unknown"},
                    **({"screenshotBase64": result.get("screenshotBase64")} if result.get("screenshotBase64") else {}),
                }
                await self._persist()
                return
            if result.get("restricted"):
                raise RuntimeError("proxy_region_blocked")
            if result.get("needsLogin"):
                raise RuntimeError("needs_login")
            if result.get("serviceFrequent"):
                raise RuntimeError("rate_limited")
            if result.get("signatureRejected"):
                raise RuntimeError("signature_rejected")
            if int(result.get("status") or 0) >= 400:
                raise RuntimeError(f"dola_submit_http_{result.get('status')}")
            wants_video = _task_wants_video(request.model)
            if (wants_video and video_url) or (not wants_video and image_urls):
                update = {"status": "completed", "error": None, "diagnostics": diagnostics or None}
                if wants_video:
                    update["videoUrl"] = video_url
                else:
                    update["imageUrls"] = image_urls
                if conversation_id:
                    update["conversationId"] = conversation_id
                self._tasks[task_id] = self._tasks[task_id].model_copy(update=update)
                await self._persist()
                return
            if not conversation_id:
                if result.get("ackReceived"):
                    # The submit stream carried SSE_ACK but no conversation id;
                    # keep the task accepted so the refresh path can recover it.
                    self._tasks[task_id] = self._tasks[task_id].model_copy(update={"status": "accepted", "error": None, "diagnostics": diagnostics or None})
                    await self._persist()
                    return
                raise RuntimeError("submission_unknown")
            self._tasks[task_id] = self._tasks[task_id].model_copy(update={"status": "accepted", "conversationId": conversation_id, "error": None, "diagnostics": diagnostics or None})
            await self._persist()
        except Exception as error:  # noqa: BLE001
            reason = str(error)[:500]
            status = "failed"
            meta = self._task_meta.get(task_id, {})
            meta_diagnostics = meta.get("diagnostics")
            self._tasks[task_id] = self._tasks[task_id].model_copy(update={"status": status, "error": reason, **({"diagnostics": meta_diagnostics} if isinstance(meta_diagnostics, dict) else {}), **({"screenshotBase64": meta.get("screenshotBase64")} if meta.get("screenshotBase64") else {})})
            await self._persist()

    async def _submit_in_camoufox(self, task_id: str, request: VideoRequest, session: PageSession) -> dict[str, Any]:
        if os.getenv("DOLA_ENABLE_BROWSER", "0") != "1":
            raise RuntimeError("camoufox_runtime_disabled")
        # Import lazily to keep the provider's protocol routes testable without
        # downloading a browser in CI. Production implementation owns the page
        # lifecycle in this boundary.
        try:
            from camoufox.async_api import AsyncCamoufox  # type: ignore
        except ImportError as error:
            raise RuntimeError("camoufox_not_installed") from error
        # The profile root is kept for deployments that persist page state; the
        # browser itself launches without a user data dir, so an unwritable
        # default (e.g. the macOS read-only root) must not block submission.
        try:
            profile_root = Path(os.getenv("DOLA_PROFILE_DIR", "/data/dola/profiles")) / session.account_id
            profile_root.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        proxy_url = session.proxy_url or None
        is_headless = True if request.headless is None else bool(request.headless)
        browser_options = _camoufox_browser_options(is_headless, proxy_url, session.account_id)
        browser_manager = AsyncCamoufox(**browser_options)
        browser = await browser_manager.__aenter__()
        keep_open = False
        try:
            # Keep the Camoufox (Firefox) fingerprint fully native: spoofing a
            # Chromium UA here produced contradictory navigator/sec-ch signals
            # that made the bdms signer reject the page.
            context = await browser.new_context(**_camoufox_context_options())
            await context.add_cookies(_cookie_header_to_playwright(session.cookie))
            page = await context.new_page()
            auth_state = await _goto_dola_page(page, os.getenv("DOLA_WEB_URL", "https://www.dola.com/chat/create-image"))
            try:
                await page.wait_for_load_state("load", timeout=45_000)
            except Exception:
                pass
            # The main-world submit script below waits for the bdms signing hook
            # itself; the isolated-world controller cannot observe that patch.
            page_title = (await page.title()).lower()
            page_body = (await page.locator("body").inner_text()).strip()
            if _page_is_region_restricted(page.url, page_title, page_body):
                screenshot_base64 = ""
                try:
                    screenshot_base64 = base64.b64encode(await page.screenshot(type="png")).decode("ascii")
                except Exception:
                    pass
                return {
                    "status": 451,
                    "restricted": True,
                    "screenshotBase64": screenshot_base64,
                    "diagnostics": {"pageState": "region_restricted", "pageUrl": str(page.url)[:500]},
                }
            age_confirmation = _page_has_age_confirmation(page_title, page_body)
            if age_confirmation or await page.locator("text=Verify you are human").count() or _page_has_verification_marker(page_title, page_body):
                decision = {
                    "type": "verification",
                    "subtype": "age_confirmation" if age_confirmation else "unknown",
                    "pageState": "age_confirmation_required" if age_confirmation else "verification_required",
                }
                initial_references = [item for item in request.references if isinstance(item, dict) and (item.get("uri") or item.get("url") or item.get("dataUrl"))]
                verification_id = await self._register_verification(task_id, request, session, browser_manager, context, page, initial_references, decision)
                keep_open = True
                screenshot_base64 = ""
                try:
                    screenshot = await page.screenshot(type="png")
                    screenshot_base64 = base64.b64encode(screenshot).decode("ascii")
                except Exception:
                    pass
                return {
                    "status": 429,
                    "verificationRequired": True,
                    "verificationId": verification_id,
                    "verificationDecision": decision,
                    "screenshotBase64": screenshot_base64,
                }
            if auth_state == "needs_login" or _page_looks_logged_out(page.url, page_title, page_body):
                screenshot_base64 = ""
                try:
                    screenshot_base64 = base64.b64encode(await page.screenshot(type="png")).decode("ascii")
                except Exception:
                    pass
                return {
                    "status": 401,
                    "needsLogin": True,
                    "screenshotBase64": screenshot_base64,
                    "diagnostics": {"pageState": "needs_login", "pageUrl": str(page.url)[:500]},
                }
            references = [item for item in request.references if isinstance(item, dict) and (item.get("uri") or item.get("url") or item.get("dataUrl"))]
            resolved_references = await resolve_references(page, references, proxy_url)
            result = await _execute_completion_submit(page, request, resolved_references, session.cookie)
            cookies = await context.cookies()
            cookie = "; ".join(f"{item['name']}={item['value']}" for item in cookies if item.get("name")) or session.cookie
            if result.get("serviceFrequent"):
                login_probe = await probe_account_login(cookie, proxy_url)
                _apply_post_submit_login_probe(result, login_probe)
                try:
                    auth_state = await _goto_dola_page(page, os.getenv("DOLA_WEB_URL", "https://www.dola.com/chat/create-image"))
                    page_title = (await page.title()).lower()
                    page_body = (await page.locator("body").inner_text()).strip()
                    region_restricted = _page_is_region_restricted(page.url, page_title, page_body)
                    if region_restricted:
                        result["restricted"] = True
                        result["needsLogin"] = False
                    elif auth_state == "needs_login" or _page_looks_logged_out(page.url, page_title, page_body):
                        result["needsLogin"] = True
                    diagnostics = result.get("diagnostics") if isinstance(result.get("diagnostics"), dict) else {}
                    result["diagnostics"] = {
                        **diagnostics,
                        "pageState": "region_restricted" if region_restricted else "needs_login" if result.get("needsLogin") else "ready",
                        "pageUrl": str(page.url)[:500],
                    }
                except Exception:
                    pass
                try:
                    result["screenshotBase64"] = base64.b64encode(await page.screenshot(type="png")).decode("ascii")
                except Exception:
                    pass
            elif (
                result.get("signatureRejected")
                or result.get("restricted")
                or (
                    not result.get("ackReceived")
                    and not result.get("conversationId")
                    and not result.get("videoUrl")
                    and not _result_image_urls(result)
                )
            ):
                # Preserve the actual page shown by the browser for protocol
                # failures such as submission_unknown.  The screenshot is
                # evidence only; it never changes the error classification.
                try:
                    diagnostics = result.get("diagnostics") if isinstance(result.get("diagnostics"), dict) else {}
                    result["diagnostics"] = {**diagnostics, "pageUrl": str(page.url)[:500]}
                    result["screenshotBase64"] = base64.b64encode(await page.screenshot(type="png")).decode("ascii")
                except Exception:
                    pass
            if result.get("verificationRequired"):
                verification_id = await self._register_verification(task_id, request, session, browser_manager, context, page, resolved_references, result.get("verificationDecision"))
                result["verificationId"] = verification_id
                keep_open = True
                try:
                    screenshot = await page.screenshot(type="png")
                    result["screenshotBase64"] = base64.b64encode(screenshot).decode("ascii")
                except Exception:
                    pass
            result["cookie"] = cookie or session.cookie
            result["identity"] = _identity_from_result(result)
            return result
        finally:
            if not is_headless and not keep_open:
                try:
                    # In headed local test mode, pause briefly so the developer can observe the page result
                    await asyncio.sleep(15)
                except Exception:
                    pass
            if not keep_open:
                try:
                    await browser_manager.__aexit__(None, None, None)
                except Exception:
                    pass

    async def _refresh_task(self, task_id: str) -> None:
        task = self._tasks.get(task_id)
        meta = self._task_meta.get(task_id)
        if not task or not meta or task.status != "accepted":
            return
        conversation_id = str(task.conversationId or meta.get("conversationId") or "")
        cookie = str(meta.get("cookie") or "")
        if not conversation_id:
            return
        if not meta.get("conversationId"):
            meta["conversationId"] = conversation_id
        if not cookie:
            self._tasks[task_id] = task.model_copy(update={"status": "failed", "error": "task_state_cookie_unavailable"})
            await self._persist()
            return
        if str(meta.get("proxyMode") or "direct") == "managed" and not str(meta.get("proxyUrl") or ""):
            self._tasks[task_id] = task.model_copy(update={"status": "failed", "error": "task_state_proxy_unavailable"})
            await self._persist()
            return
        result = await fetch_generation_result(cookie, conversation_id, dict(meta.get("identity") or {}), str(meta.get("proxyUrl") or "") or None)
        if not result:
            try:
                result = await self._fetch_generation_result_in_page(conversation_id, meta)
            except Exception as error:  # noqa: BLE001
                diagnostics = task.diagnostics if isinstance(task.diagnostics, dict) else {}
                self._tasks[task_id] = task.model_copy(update={"diagnostics": {**diagnostics, "resultQueryFallback": "failed", "resultQueryError": str(error)[:160]}})
                await self._persist()
                return
        wants_video = _task_wants_video(task.model)
        # Video conversations also expose cover thumbnails as images; only the
        # capability the task asked for may complete it.
        if result.get("error"):
            self._tasks[task_id] = task.model_copy(update={"status": "failed", "error": str(result.get("error"))[:120]})
            await self._persist()
            return
        video_url = str(result.get("url") or "") if wants_video else ""
        image_urls = list(result.get("imageUrls") or []) if not wants_video else []
        if video_url or image_urls:
            update: dict[str, Any] = {"status": "completed", "vodPayload": _sanitize_vod_payload(result.get("payload"))}
            if video_url:
                update["videoUrl"] = video_url
            if image_urls:
                update["imageUrls"] = image_urls
            self._tasks[task_id] = task.model_copy(update=update)
            await self._persist()

    async def _fetch_generation_result_in_page(self, conversation_id: str, meta: dict[str, Any]) -> dict[str, Any]:
        if os.getenv("DOLA_ENABLE_BROWSER", "0") != "1":
            raise RuntimeError("camoufox_runtime_disabled")
        try:
            from camoufox.async_api import AsyncCamoufox  # type: ignore
        except ImportError as error:
            raise RuntimeError("camoufox_not_installed") from error
        cookie = str(meta.get("cookie") or "")
        if not cookie:
            raise RuntimeError("task_state_cookie_unavailable")
        proxy_url = str(meta.get("proxyUrl") or "") or None
        browser_options = _camoufox_browser_options(True, proxy_url, str(meta.get("accountId") or ""))
        async with AsyncCamoufox(**browser_options) as browser:
            context = await browser.new_context(**_camoufox_context_options())
            await context.add_cookies(_cookie_header_to_playwright(cookie))
            page = await context.new_page()
            auth_state = await _goto_dola_page(page, os.getenv("DOLA_WEB_URL", "https://www.dola.com/chat/create-image"))
            title = (await page.title()).lower()
            body = (await page.locator("body").inner_text()).strip()
            if await page.locator("text=Verify you are human").count() or _page_has_verification_marker(title, body):
                raise RuntimeError("result_query_verification_required")
            if auth_state == "needs_login" or _page_looks_logged_out(page.url, title, body):
                raise RuntimeError("result_query_login_required")
            payloads: list[Any] = []
            for path, request_body in generation_query_payloads(conversation_id):
                transport = await _execute_signed_page_json(page, path, request_body)
                if not _json_transport_ready(transport):
                    continue
                try:
                    payloads.append(json.loads(str(transport.get("text") or "")))
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue
            return parse_generation_payloads(payloads)


def _task_wants_video(model: str) -> bool:
    profile = PROFILES.get(model)
    return not profile or profile.capability != "image"


def _apply_post_submit_login_probe(result: dict[str, Any], login_probe: dict[str, Any]) -> None:
    """Record the read-only login probe without guessing the final cause.

    STREAM_ERROR 710022002 may be followed by a login page, a regional block,
    or an ordinary busy-service page.  The browser destination is inspected
    afterwards and owns the final classification.
    """
    diagnostics = result.get("diagnostics") if isinstance(result.get("diagnostics"), dict) else {}
    state = str(login_probe.get("state") or "unknown")
    result["diagnostics"] = {
        **diagnostics,
        "postSubmitLoginState": state,
        "postSubmitLoginProtocolCode": login_probe.get("code"),
        "nativeFrontendAction": "GET /passport/web/logout/",
        "classificationSource": "native-page-network-trace",
    }


async def _goto_dola_page(page: Any, url: str) -> str:
    """Open Dola and return the login state reported by its launch endpoint."""
    loop = asyncio.get_running_loop()
    auth_state: asyncio.Future[str] = loop.create_future()

    async def read_launch_response(response: Any) -> None:
        try:
            from urllib.parse import urlsplit

            if urlsplit(str(response.url)).path != "/alice/user/launch":
                return
            value = await response.json()
            flag = value.get("data", {}).get("extra", {}).get("is_login") if isinstance(value, dict) and isinstance(value.get("data"), dict) else None
            normalized = str(flag).strip().lower()
            if normalized in {"0", "false"}:
                state = "needs_login"
            elif normalized in {"1", "true"}:
                state = "ready"
            else:
                return
            if not auth_state.done():
                auth_state.set_result(state)
        except Exception:
            return

    def observe_response(response: Any) -> None:
        asyncio.create_task(read_launch_response(response))

    try:
        page.on("response", observe_response)
    except Exception:
        pass
    try:
        # Dola may replace the initial document during its region/auth bootstrap.
        # Waiting for domcontentloaded makes Firefox surface that legitimate
        # document replacement as NS_ERROR_ABORT.  Commit establishes the
        # navigation first; the stateful readiness check below owns SPA load.
        await page.goto(url, wait_until="commit")
        try:
            await page.wait_for_function(
                "() => location.hostname.endsWith('dola.com') && document.readyState !== 'loading' && (document.title || document.body?.innerText || performance.getEntriesByType('resource').length)",
                timeout=45_000,
            )
        except Exception:
            pass
    except Exception as error:
        message = str(error)
        if "NS_ERROR_ABORT" not in message and "ERR_ABORTED" not in message:
            raise
        try:
            await page.wait_for_function(
                "() => location.hostname.endsWith('dola.com') && document.readyState !== 'loading' && (document.title || document.body?.innerText || performance.getEntriesByType('resource').length)",
                timeout=45_000,
            )
        except Exception:
            pass
        try:
            current_url = str(page.url or "")
            title = await page.title()
            body = (await page.locator("body").inner_text()).strip()
            resource_count = await page.evaluate("() => performance.getEntriesByType('resource').length")
        except Exception:
            raise RuntimeError("navigation_aborted_before_page_ready") from error
        if "dola.com" not in current_url or (not title and not body and not resource_count):
            raise RuntimeError("navigation_aborted_before_page_ready") from error
    try:
        return await asyncio.wait_for(asyncio.shield(auth_state), timeout=30)
    except TimeoutError:
        return "unknown"
    finally:
        try:
            page.remove_listener("response", observe_response)
        except Exception:
            pass


def _camoufox_proxy_options(proxy_url: str) -> dict[str, str]:
    """Firefox rejects credentials embedded in the proxy server URL."""
    from urllib.parse import urlsplit
    parts = urlsplit(proxy_url)
    if not parts.username and not parts.password:
        return {"server": proxy_url}
    host = parts.hostname or ""
    server = f"{parts.scheme}://{host}:{parts.port or 80}"
    options = {"server": server}
    if parts.username:
        options["username"] = parts.username
    if parts.password:
        options["password"] = parts.password
    return options


def _camoufox_target_os() -> str:
    configured = os.getenv("DOLA_CAMOUFOX_OS", "").strip().lower()
    if configured in {"macos", "windows", "linux"}:
        return configured
    return "macos"


def _stable_fingerprint_seed(account_id: str, label: str) -> int:
    digest = hashlib.sha256(f"{account_id}:{label}".encode()).digest()
    return int.from_bytes(digest[:4], "big") or 1


def _account_fingerprint_preset(account_id: str, target_os: str) -> dict[str, Any] | None:
    """Persist one real Camoufox preset per account instead of rotating OS/device every request."""
    normalized = re.sub(r"[^a-zA-Z0-9._-]+", "-", account_id).strip("-.")[:120]
    if not normalized:
        return None
    try:
        profile_root = Path(os.getenv("DOLA_PROFILE_DIR", "/data/dola/profiles")) / normalized
        profile_root.mkdir(parents=True, exist_ok=True)
        preset_path = profile_root / "fingerprint-preset.json"
        if preset_path.exists():
            stored = json.loads(preset_path.read_text(encoding="utf-8"))
            if isinstance(stored, dict) and stored.get("version") == 2 and stored.get("targetOs") == target_os and isinstance(stored.get("preset"), dict):
                return stored["preset"]
        from camoufox.fingerprints import get_random_preset  # type: ignore

        preset = None
        for _ in range(32):
            candidate = get_random_preset(os=target_os)
            if not isinstance(candidate, dict):
                continue
            vendor = str((candidate.get("webgl") or {}).get("unmaskedVendor") or "")
            if target_os != "macos" or vendor == "Apple":
                preset = candidate
                break
        if not isinstance(preset, dict):
            return None
        temp_path = preset_path.with_name(f".{preset_path.name}.{os.getpid()}.tmp")
        temp_path.write_text(json.dumps({"version": 2, "targetOs": target_os, "preset": preset}, ensure_ascii=False), encoding="utf-8")
        os.replace(temp_path, preset_path)
        return preset
    except Exception:
        # Fingerprint persistence improves consistency but must not make the
        # provider unavailable on a read-only deployment filesystem.
        return None


def _camoufox_browser_options(headless: bool, proxy_url: str | None = None, account_id: str = "") -> dict[str, object]:
    target_os = _camoufox_target_os()
    options: dict[str, object] = {
        "headless": headless,
        "enable_cache": False,
        "os": target_os,
        "locale": os.getenv("DOLA_CAMOUFOX_LOCALE", "zh-CN").strip() or "zh-CN",
    }
    if account_id:
        preset = _account_fingerprint_preset(account_id, target_os)
        if preset:
            options["fingerprint_preset"] = preset
        options["config"] = {
            "fonts:spacing_seed": _stable_fingerprint_seed(account_id, "fonts"),
            "audio:seed": _stable_fingerprint_seed(account_id, "audio"),
            "canvas:seed": _stable_fingerprint_seed(account_id, "canvas"),
        }
    selected = os.getenv("DOLA_CAMOUFOX_BROWSER", "").strip()
    if selected:
        options["browser"] = selected
        options["window"] = (1365, 900)
        match = re.search(r"(?:^|/)(\d{2,3})(?:\.|$)", selected)
        if match:
            # Camoufox 0.5.x resolves the binary after fingerprint generation;
            # declare the selected Firefox major so the fingerprint matches it.
            options["ff_version"] = int(match.group(1))
            options["i_know_what_im_doing"] = True
    if proxy_url:
        options["proxy"] = _camoufox_proxy_options(proxy_url)
        # Keep WebRTC, timezone and geolocation aligned with the actual managed
        # proxy egress.  Camoufox resolves these values through the proxy.
        options["geoip"] = True
    return options


def _camoufox_context_options() -> dict[str, object]:
    options: dict[str, object] = {"storage_state": None, "locale": "zh-CN"}
    if os.getenv("DOLA_CAMOUFOX_BROWSER", "").strip():
        # Older Camoufox Juggler schemas reject Playwright 1.62's implicit
        # viewport.isMobile field. The launch window above owns the geometry.
        options["no_viewport"] = True
    else:
        options["viewport"] = {"width": 1365, "height": 900}
    return options


def _cookie_header_to_playwright(header: str) -> list[dict[str, str]]:
    return [{"name": part.split("=", 1)[0].strip(), "value": part.split("=", 1)[1].strip(), "domain": ".dola.com", "path": "/"} for part in header.split(";") if "=" in part]


def _cookie_value(cookie: str, name: str) -> str:
    for part in cookie.split(";"):
        key, separator, value = part.strip().partition("=")
        if separator and key == name:
            return value.strip()
    return ""


_SIGNED_JSON_PATHS = {"/im/chain/recent_conv", "/im/conversation/info", "/im/chain/single"}


def _recent_conversation_payload() -> dict[str, Any]:
    return {
        "cmd": 3200,
        "uplink_body": {
            "pull_recent_conv_chain_uplink_body": {
                "limit": 10,
                "message_count_per_conv": 10,
                "api_version": 1,
                "conv_version": 0,
                "direction": 3,
                "option": {
                    "not_need_message": True,
                    "need_complete_conversation": True,
                    "need_coco_conversation": True,
                    "need_coco_bot": True,
                },
            }
        },
        "sequence_id": str(uuid.uuid4()),
        "channel": 2,
        "version": "1",
    }


async def _execute_signed_page_json(page: Any, path: str, body: dict[str, Any], timeout_ms: int = 30_000) -> dict[str, Any]:
    if path not in _SIGNED_JSON_PATHS:
        raise ValueError("unsupported_signed_page_path")
    result_id = f"__dola_json_request_{uuid.uuid4().hex}__"
    observed_urls: list[str] = []

    def observe_request(request: Any) -> None:
        try:
            from urllib.parse import urlsplit

            parsed = urlsplit(str(request.url))
            if parsed.netloc.endswith("dola.com") and parsed.path == path:
                observed_urls.append(str(request.url))
        except Exception:
            return

    try:
        page.on("request", observe_request)
    except Exception:
        pass
    config = json.dumps(
        {
            "resultId": result_id,
            "path": path,
            "method": "POST",
            "body": json.dumps(body, ensure_ascii=False, separators=(",", ":")),
            "timeoutMs": timeout_ms,
            "hookDeadline": int(time.time() * 1000) + timeout_ms,
        },
        ensure_ascii=True,
    ).replace("</", "<\\/")
    try:
        await page.add_script_tag(content=f"(window.__DOLA_JSON_REQUEST_CONFIG__ = {config});\n{MAIN_WORLD_JSON_REQUEST_SCRIPT}")
        raw = ""
        deadline = time.monotonic() + (timeout_ms / 1000) + 5
        while time.monotonic() < deadline:
            raw = await page.evaluate("(id) => { const el = document.getElementById(id); return el ? el.value : ''; }", result_id)
            if raw:
                break
            await asyncio.sleep(0.25)
    finally:
        try:
            page.remove_listener("request", observe_request)
        except Exception:
            pass
        try:
            await page.evaluate("(id) => { const el = document.getElementById(id); if (el) el.remove(); }", result_id)
        except Exception:
            pass
    payload: dict[str, Any] = {}
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                payload = parsed
        except ValueError:
            payload = {"fatal": "result_unparseable"}
    else:
        payload = {"fatal": "result_timeout"}
    observed_url = observed_urls[-1] if observed_urls else ""
    observed_signed = "a_bogus=" in observed_url
    payload["requestObserved"] = bool(observed_url)
    payload["requestSigned"] = observed_signed
    payload["signed"] = observed_signed or bool(payload.get("signed"))
    return payload


def _json_transport_ready(transport: dict[str, Any]) -> bool:
    status = int(transport.get("status") or 0)
    return not transport.get("fatal") and bool(transport.get("requestObserved")) and 200 <= status < 300


async def _page_recent_conversation_id(page: Any) -> tuple[str, dict[str, Any]]:
    transport = await _execute_signed_page_json(page, "/im/chain/recent_conv", _recent_conversation_payload())
    body: Any = None
    text = str(transport.get("text") or "")
    if text:
        try:
            body = json.loads(text)
        except ValueError:
            body = None
    return extract_conversation_id(body) if body is not None else "", transport


async def _probe_completion_signing(page: Any) -> dict[str, Any]:
    captured_urls: list[str] = []

    async def abort_completion(route: Any, request: Any) -> None:
        captured_urls.append(str(request.url))
        await route.abort()

    pattern = "**/chat/completion**"
    try:
        await page.route(pattern, abort_completion)
        config = json.dumps({"body": "{}", "timeoutMs": 5_000, "hookDeadline": int(time.time() * 1000) + 20_000}, ensure_ascii=True)
        await page.add_script_tag(content=f"(window.__DOLA_SUBMIT_CONFIG__ = {config});\n{MAIN_WORLD_SUBMIT_SCRIPT}")
        raw = ""
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            raw = await page.evaluate("() => { const el = document.getElementById('__dola_submit_result__'); return el ? el.value : ''; }")
            if raw or captured_urls:
                break
            await asyncio.sleep(0.25)
        payload: dict[str, Any] = {}
        if raw:
            try:
                value = json.loads(raw)
                if isinstance(value, dict):
                    payload = value
            except ValueError:
                payload = {"fatal": "result_unparseable"}
        elif not captured_urls:
            payload = {"fatal": "completion_probe_timeout"}
        captured_url = captured_urls[-1] if captured_urls else ""
        return {
            "requestObserved": bool(captured_url),
            "signed": "a_bogus=" in captured_url,
            "signerReady": not str(payload.get("fatal") or "").startswith("signing_hook_unavailable"),
            "identitySource": str(payload.get("identitySource") or "")[:200],
            "error": str(payload.get("fatal") or "")[:200],
        }
    finally:
        try:
            await page.unroute(pattern, abort_completion)
        except Exception:
            pass
        try:
            await page.evaluate("() => { const el = document.getElementById('__dola_submit_result__'); if (el) el.remove(); }")
        except Exception:
            pass


async def _probe_account_protocol(page: Any) -> dict[str, Any]:
    _, transport = await _page_recent_conversation_id(page)
    completion = await _probe_completion_signing(page) if _json_transport_ready(transport) else {"requestObserved": False, "signed": False, "signerReady": False, "identitySource": "", "error": "read_only_protocol_probe_failed"}
    ready = _json_transport_ready(transport) and bool(completion.get("requestObserved")) and bool(completion.get("signed"))
    read_only_status = int(transport.get("status") or 0)
    read_only_error = str(transport.get("fatal") or ("" if _json_transport_ready(transport) else f"read_only_protocol_http_{read_only_status}"))[:200]
    return {
        "ready": ready,
        "login": True,
        "signerReady": bool(completion.get("signerReady")),
        "requestObserved": bool(completion.get("requestObserved")),
        "signed": bool(completion.get("signed")),
        "httpStatus": int(transport.get("status") or 0),
        "identitySource": str(completion.get("identitySource") or transport.get("identitySource") or "")[:200],
        "readOnlyRequestObserved": bool(transport.get("requestObserved")),
        "readOnlySigned": bool(transport.get("signed")),
        "readOnlyError": read_only_error,
        "error": str(read_only_error or completion.get("error") or ("" if ready else "signed_protocol_probe_failed"))[:200],
    }


async def _read_account_quota(page: Any) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    config = json.dumps({"timeoutMs": 20_000, "hookDeadline": int(time.time() * 1000) + 20_000})
    await page.add_script_tag(content=f"(window.__DOLA_CREDIT_CONFIG__ = {config});\n{MAIN_WORLD_CREDIT_SCRIPT}")
    raw = ""
    deadline = time.monotonic() + 25.0
    while time.monotonic() < deadline:
        raw = await page.evaluate("() => { const el = document.getElementById('__dola_credit_result__'); return el ? el.value : ''; }")
        if raw:
            break
        await asyncio.sleep(0.25)
    try:
        await page.evaluate("() => { const el = document.getElementById('__dola_credit_result__'); if (el) el.remove(); }")
    except Exception:
        pass
    transport: dict[str, Any] = {}
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                transport = parsed
        except ValueError:
            transport = {"fatal": "result_unparseable"}
    else:
        transport = {"fatal": "result_timeout"}
    body: dict[str, Any] = {}
    text = str(transport.get("text") or "")
    if text:
        try:
            parsed_body = json.loads(text)
            if isinstance(parsed_body, dict):
                body = parsed_body
        except ValueError:
            pass
    credit_info: dict[str, Any] | None = None
    for node in _nested_values(body):
        if isinstance(node, dict) and isinstance(node.get("credit_info"), dict):
            credit_info = node["credit_info"]
            break
    remaining: int | None = None
    if credit_info:
        value = credit_info.get("total_credit_num")
        if isinstance(value, (int, float)) and value >= 0:
            remaining = int(value)
        elif isinstance(value, str) and value.isdigit():
            remaining = int(value)
    quota = (
        [{"bucket": "video-credit", "remaining": remaining, "limit": None, "unit": "credit", "source": "upstream"}]
        if remaining is not None
        else [{"bucket": "video-generation", "remaining": None, "limit": None, "unit": "unknown", "source": "unknown"}]
        if transport.get("fatal") == "upstream_quota_not_exposed"
        else []
    )
    diagnostics = {
        "status": int(transport.get("status") or 0),
        "contentType": str(transport.get("contentType") or "")[:120],
        "fatal": str(transport.get("fatal") or "")[:120],
        "responseBytes": len(text),
        "parsed": remaining is not None,
        "identitySource": str(transport.get("identitySource") or "")[:200],
        "signed": bool(transport.get("signed")),
        "observed": [
            {
                "url": str(value.get("url") or "")[:300],
                "method": str(value.get("method") or "")[:12],
                "status": int(value.get("status") or 0),
                "contentType": str(value.get("contentType") or "")[:120],
                "responseBytes": int(value.get("responseBytes") or 0),
            }
            for value in transport.get("observed", [])
            if isinstance(value, dict)
        ][:4],
        "errorKeys": [str(value)[:80] for value in transport.get("errorKeys", []) if isinstance(value, str)][:12],
    }
    return quota, diagnostics


async def _execute_completion_submit(page: Any, request: VideoRequest, references: list[dict[str, Any]], cookie: str = "") -> dict[str, Any]:
    """Send one signed request with the identity created by the loaded page.

    Retrying a submission with a fabricated device identity made an ordinary
    account look like several new devices and could also duplicate a request
    whose ACK was delayed. The main-world script now waits for both Dola's
    signer and a real page-generated identity before transmitting exactly once.
    """
    profile = validate_request(request.model, request.duration, request.ratio)
    body = _build_request_body(profile, request, references)
    observed_urls: list[str] = []

    def observe_request(browser_request: Any) -> None:
        try:
            from urllib.parse import urlsplit

            parsed = urlsplit(str(browser_request.url))
            if parsed.netloc.endswith("dola.com") and parsed.path == "/chat/completion":
                observed_urls.append(str(browser_request.url))
        except Exception:
            return

    try:
        page.on("request", observe_request)
    except Exception:
        pass
    fallback_query, _ = _build_completion_query(cookie)
    config = json.dumps({"body": json.dumps(body, ensure_ascii=False, separators=(",", ":")), "fallbackQuery": fallback_query, "timeoutMs": 60_000, "hookDeadline": int(time.time() * 1000) + 40_000}, ensure_ascii=True).replace("</", "<\\/")
    script = f"(window.__DOLA_SUBMIT_CONFIG__ = {config});\n{MAIN_WORLD_SUBMIT_SCRIPT}"
    raw = ""
    try:
        await page.add_script_tag(content=script)
        deadline = time.monotonic() + 70.0
        while time.monotonic() < deadline:
            raw = await page.evaluate("() => { const el = document.getElementById('__dola_submit_result__'); return el ? el.value : ''; }")
            if raw:
                break
            await asyncio.sleep(0.25)
    finally:
        try:
            page.remove_listener("request", observe_request)
        except Exception:
            pass
        try:
            await page.evaluate("() => { const el = document.getElementById('__dola_submit_result__'); if (el) el.remove(); }")
        except Exception:
            pass
    payload: dict[str, Any] = {}
    if raw:
        try:
            value = json.loads(raw)
            if isinstance(value, dict):
                payload = value
        except ValueError:
            payload = {"fatal": "result_unparseable"}
    if not raw:
        payload = {"fatal": "result_timeout"}
    observed_url = observed_urls[-1] if observed_urls else ""
    payload["requestObserved"] = bool(observed_url)
    payload["requestSigned"] = "a_bogus=" in observed_url
    payload["signed"] = bool(payload.get("signed")) or bool(payload["requestSigned"])
    if payload.get("fatal"):
        raise RuntimeError(f"submission_transport_{str(payload.get('fatal'))[:60]}")
    text = str(payload.get("text") or "")
    events = _parse_sse_text(text)
    event_names = [name.upper() for name, _ in events]
    conversation_id = extract_conversation_id(events) or ""
    decision = _sse_verification_decision(events)
    diagnostics = _submission_diagnostics(events, text, payload)
    identity = payload.get("identity") if isinstance(payload.get("identity"), dict) else {}
    return {
        "status": int(payload.get("status") or 0),
        "contentType": str(payload.get("contentType") or ""),
        "responseBytes": int(payload.get("responseBytes") or 0),
        "conversationId": conversation_id,
        "videoUrl": decode_main_url(extract_video_url(events) or ""),
        "imageUrls": extract_image_urls(events),
        "ackReceived": "SSE_ACK" in event_names or bool(conversation_id),
        "restricted": "country restricted" in text.lower() or "region-restricted" in text.lower(),
        "signatureRejected": "710022004" in text,
        "serviceFrequent": "710022002" in text or "当前需求量较大" in text or "服务访问频繁" in text or "high demand" in text.lower(),
        "verificationRequired": decision is not None,
        "verificationDecision": decision,
        "timedOut": not text and not payload.get("status"),
        "requestObserved": bool(payload.get("requestObserved")),
        "requestSigned": bool(payload.get("requestSigned")),
        "unsigned": bool(payload.get("requestObserved")) and not bool(payload.get("requestSigned")),
        "diagnostics": diagnostics,
        "identitySource": str(payload.get("identitySource") or "")[:200],
        **{key: str(identity.get(key) or "") for key in ("device_id", "web_id", "tea_uuid", "region", "sys_region", "web_tab_id", "tz_name")},
    }


def _build_completion_query(cookie: str) -> tuple[str, dict[str, str]]:
    now_ms = int(time.time() * 1000)
    web_id = f"{now_ms}{secrets.randbelow(1000000)}"[:19]
    region = _cookie_value(cookie, "flow_user_country") or "JP"
    fp = _cookie_value(cookie, "s_v_web_id") or f"verify_{now_ms}"
    identity = {"device_id": web_id, "web_id": web_id, "tea_uuid": web_id, "region": region, "sys_region": region, "web_tab_id": str(uuid.uuid4()), "tz_name": "Asia/Tokyo"}
    params: dict[str, str] = {
        "aid": DOLA_AID,
        "channel": "g",
        "device_id": web_id,
        "device_platform": "web",
        "doubao_device_platform": "web",
        "doubao_pc_version": DOLA_PC_VERSION,
        "fp": fp,
        "language": "zh",
        "pc_version": DOLA_PC_VERSION,
        "pkg_type": "release_version",
        "real_aid": DOLA_AID,
        "region": region,
        "samantha_web": "1",
        "sys_region": region,
        "tea_uuid": web_id,
        "tz_name": identity["tz_name"],
        "use-olympus-account": "1",
        "version_code": DOLA_VERSION_CODE,
        "web_id": web_id,
        "web_platform": "browser",
        "web_tab_id": identity["web_tab_id"],
    }
    ms_token = _cookie_value(cookie, "msToken")
    if ms_token:
        params["msToken"] = ms_token
    return urlencode(params), identity


def _ratio_from_size(size: str, ratios: tuple[str, ...]) -> str:
    match = re.match(r"^\s*(\d{2,5})\s*[xX×]\s*(\d{2,5})\s*$", size or "")
    if not match:
        return ""
    width, height = int(match.group(1)), int(match.group(2))
    if not width or not height:
        return ""
    target = width / height
    best, best_diff = "", 0.0
    for ratio in ratios:
        left, right = ratio.split(":", 1)
        diff = abs((int(left) / int(right)) - target)
        if not best or diff < best_diff:
            best, best_diff = ratio, diff
    return best


def _attachment_messages(references: list[dict[str, Any]]) -> list[dict[str, Any]]:
    items = [item for item in references if isinstance(item, dict) and (item.get("uri") or item.get("url") or item.get("dataUrl"))]
    if not items:
        return []
    return [{
        "local_message_id": str(uuid.uuid4()),
        "content_block": [{
            "block_type": 10052,
            "content": {
                "attachment_block": {
                    "attachments": [{
                        "type": 1,
                        "identifier": item.get("identifier") or str(uuid.uuid4()),
                        "image": {
                            "name": item.get("name") or "image.png",
                            "uri": item.get("uri") or item.get("url") or "",
                            "image_ori": {"url": "", "width": int(item.get("width") or 0), "height": int(item.get("height") or 0), "format": "", "url_formats": {}},
                        },
                        "parse_state": 0,
                        "review_state": 1,
                        "upload_status": 1,
                        "progress": 100,
                        "src": "",
                    } for item in items],
                },
                "pc_event_block": "",
            },
            "block_id": str(uuid.uuid4()),
            "parent_id": "",
            "meta_info": [],
            "append_fields": [],
        }],
        "message_status": 0,
    }]


def _build_request_body(profile: Any, request: VideoRequest, references: list[dict[str, Any]]) -> dict[str, Any]:
    now_ms = int(time.time() * 1000)
    ratio = canonical_ratio(request.ratio, profile.ratios) or "16:9"
    if profile.capability == "image" and not request.ratio:
        ratio = _ratio_from_size(request.size or "", profile.ratios) or ratio
    if profile.capability == "image":
        ratio = request.ratio if request.ratio else _ratio_from_size(request.size or "", profile.ratios)
        user_content = f"{request.prompt.strip()}，比例：{ratio}" if ratio else request.prompt.strip()
        visible_text = f"生成图片：{user_content}"
        ability_param = {"ability_param": {"model": profile.upstream_model, "input_box_content": {"user_input_content": user_content, "reply_message_format": "生成图片：%s"}}, "ability_type": 1}
        chat_ability = {"ability_type": 3, "ability_param": json.dumps(ability_param, ensure_ascii=False, separators=(",", ":"))}
    else:
        user_content = request.prompt.strip()
        visible_text = f"生成视频：{user_content}，{ratio}" if ratio else f"生成视频：{user_content}"
        ability_param = {"ratio": ratio, "model": profile.upstream_model, "duration": int(request.duration), "input_box_content": {"user_input_content": user_content, "reply_message_format": "生成视频：%s"}}
        chat_ability = {"ability_type": 17, "ability_param": json.dumps(ability_param, ensure_ascii=False, separators=(",", ":"))}
    body: dict[str, Any] = {
        "client_meta": {
            "local_conversation_id": f"local_{now_ms}",
            "conversation_id": "",
            "bot_id": DOLA_BOT_ID,
            "last_section_id": "",
            "last_message_index": None,
            "local_permissions": [
                {"permission_name": "ACCESS_COARSE_LOCATION", "status": 3},
                {"permission_name": "ACCESS_FINE_LOCATION", "status": 3},
                {"permission_name": "ACCESS_BACKGROUND_LOCATION", "status": 3},
            ],
        },
        "messages": [
            *_attachment_messages(references),
            {
                "local_message_id": str(uuid.uuid4()),
                "content_block": [{
                    "block_type": 10000,
                    "content": {"text_block": {"text": visible_text, "icon_url": "", "icon_url_dark": "", "summary": ""}, "pc_event_block": ""},
                    "block_id": str(uuid.uuid4()),
                    "parent_id": "",
                    "meta_info": [],
                    "append_fields": [],
                }],
                "message_status": 0,
            },
        ],
        "option": {
            "send_message_scene": "",
            "create_time_ms": now_ms,
            "collect_id": "",
            "is_audio": False,
            "answer_with_suggest": False,
            "tts_switch": False,
            "need_deep_think": 0,
            "click_clear_context": False,
            "from_suggest": False,
            "is_regen": False,
            "is_replace": False,
            "is_from_click_option": False,
            "is_from_click_softlink": False,
            "disable_sse_cache": False,
            "select_text_action": "",
            "is_select_text": False,
            "resend_for_regen": False,
            "scene_type": 0,
            "unique_key": str(uuid.uuid4()),
            "start_seq": 0,
            "need_create_conversation": True,
            "conversation_init_option": {"need_ack_conversation": True},
            "regen_query_id": [],
            "edit_query_id": [],
            "regen_instruction": "",
            "no_replace_for_regen": False,
            "message_from": 0,
            "shared_app_name": "",
            "shared_app_id": "",
            "sse_recv_event_options": {"support_chunk_delta": True},
            "is_ai_playground": False,
            "is_old_user": False,
            "recovery_option": {"is_recovery": False, "req_create_time_sec": now_ms // 1000, "append_sse_event_scene": 0},
            "message_storage_type": 0,
            "support_lazy_fetch_stream": True,
            "related_deleted_message_ids": {},
            "connector_info_list": [],
            "model_config": {"model_item_key": "", "model_extra_params": {}},
            "aggregate_params": {"conversation_mode": "", "mode_id": "", "model_item_key": "", "agent_mode": "", "reasoning_effort": "", "provider_id": "", "mention_ext": "[{}]", "mention_plugin_list": "[]", "mention_skill_list": "[]"},
        },
        "chat_ability": chat_ability,
        "user_context": [],
        "ext": {
            "answer_with_suggest": "0",
            "sub_conv_firstmet_type": "1",
            "collection_id": "",
            "conversation_init_option": json.dumps({"need_ack_conversation": True}, separators=(",", ":")),
            "commerce_credit_config_enable": "0",
            "is_finish": "1",
        },
    }
    return body


def _parse_sse_text(text: str) -> list[tuple[str, Any]]:
    events: list[tuple[str, Any]] = []
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    for block in re.split(r"\n\n+", normalized):
        if not block.strip():
            continue
        name = "message"
        data_lines: list[str] = []
        for line in block.split("\n"):
            if line.startswith("event:"):
                name = line[6:].strip() or "message"
            elif line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
        raw = "\n".join(data_lines)
        data: Any = raw
        if raw:
            try:
                data = json.loads(raw)
            except ValueError:
                pass
        events.append((name, data))
    return events


def _nested_values(value: Any, depth: int = 0):
    if depth > 24:
        return
    yield value
    if isinstance(value, dict):
        for item in value.values():
            yield from _nested_values(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            yield from _nested_values(item, depth + 1)
    elif isinstance(value, str) and value.lstrip()[:1] in "[{":
        try:
            yield from _nested_values(json.loads(value), depth + 1)
        except ValueError:
            pass


def _sse_verification_decision(events: list[tuple[str, Any]]) -> dict[str, Any] | None:
    """Accept only structured challenge data, never ordinary response copy."""
    if any(
        isinstance(node, dict) and str(node.get("code") or node.get("error_code") or node.get("errorCode") or "") == "710022004"
        for _, data in events
        for node in _nested_values(data)
    ):
        return None
    for _, data in events:
        for node in _nested_values(data):
            if not isinstance(node, dict):
                continue
            type_value = str(node.get("type") or node.get("decision_type") or "").lower()
            subtype = str(node.get("subtype") or node.get("sub_type") or "").lower()
            has_challenge_id = any(str(node.get(key) or "").strip() for key in ("verification_id", "verificationId", "captcha_id", "captchaId", "verify_token", "verifyToken"))
            if type_value not in {"verify", "verification", "captcha"} and subtype not in {"slide", "slider", "captcha"} and not has_challenge_id:
                continue
            code = str(node.get("code") or "")
            return {
                "type": "verification" if type_value == "verification" else "verify",
                "subtype": "slide" if subtype in {"slide", "slider"} else "unknown",
                **({"code": code[:32]} if code.isdigit() else {}),
            }
    return None


def _submission_diagnostics(events: list[tuple[str, Any]], text: str, transport: dict[str, Any]) -> dict[str, Any]:
    codes: list[str] = []
    messages: list[str] = []
    for _, data in events:
        for node in _nested_values(data):
            if not isinstance(node, dict):
                continue
            for key in ("code", "status_code", "statusCode", "error_code", "errorCode"):
                value = node.get(key)
                if isinstance(value, (str, int)) and str(value).strip() and str(value) not in codes:
                    codes.append(str(value).strip()[:64])
            for key in ("message", "msg", "error", "error_message", "errorMessage"):
                value = node.get(key)
                if isinstance(value, str) and value.strip() and value.strip() not in messages:
                    messages.append(value.strip()[:300])
    return {
        "httpStatus": int(transport.get("status") or 0),
        "contentType": str(transport.get("contentType") or "")[:120],
        "responseBytes": int(transport.get("responseBytes") or len(text)),
        "eventNames": list(dict.fromkeys(name for name, _ in events))[:32],
        "codes": codes[:16],
        "messages": messages[:12],
        "identitySource": str(transport.get("identitySource") or "")[:200],
        "signed": bool(transport.get("signed")),
        "requestObserved": bool(transport.get("requestObserved")),
        "requestSigned": bool(transport.get("requestSigned")),
    }


def _result_conversation_id(result: dict[str, Any]) -> str:
    value = result.get("conversationId")
    return str(value) if isinstance(value, str) else extract_conversation_id(result)


def _result_video_url(result: dict[str, Any]) -> str:
    value = result.get("videoUrl")
    if isinstance(value, str) and value:
        return value
    return decode_main_url(extract_video_url(result) or "")


def _result_image_urls(result: dict[str, Any]) -> list[str]:
    value = result.get("imageUrls")
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str) and item]
    return extract_image_urls(result)


def _proxy_url_for_request(mode: str, value: str | None) -> str | None:
    if mode == "direct":
        return None
    if mode != "managed":
        raise RuntimeError("unsupported_proxy_mode")
    proxy_url = (value or "").strip()
    if not proxy_url:
        raise RuntimeError("managed_proxy_unconfigured")
    if not proxy_url.lower().startswith(("http://", "https://", "socks5://", "socks5h://")):
        raise RuntimeError("managed_proxy_invalid")
    return proxy_url


def _verification_decision(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {"type": "verify", "subtype": "unknown"}
    diagnostic = value.get("type") == "inspect"
    result: dict[str, Any] = {"type": "inspect" if diagnostic else "verify", "subtype": "page" if diagnostic else "unknown"}
    if isinstance(value.get("type"), str) and value["type"] in {"verify", "verification", "inspect"}:
        result["type"] = value["type"]
    if isinstance(value.get("subtype"), str) and value["subtype"] in {"slide", "unknown", "page", "age_confirmation"}:
        result["subtype"] = value["subtype"]
    if isinstance(value.get("code"), str) and value["code"].isdigit():
        result["code"] = value["code"][:32]
    if value.get("pageState") in {"ready", "needs_login", "verification_required", "age_confirmation_required"}:
        result["pageState"] = value["pageState"]
    return result


def _page_has_verification_marker(title: str, body: str) -> bool:
    text = f"{title}\n{body}".lower()
    return bool(re.search(r"(?:verify\s+you\s+are\s+human|captcha|security\s+(?:check|verification)|risk\s+control|slide(?:r)?\s+(?:captcha|verification)|人机验证|验证码|滑块(?:验证)?|安全验证)", text, re.IGNORECASE))


def _page_has_age_confirmation(title: str, body: str) -> bool:
    """Detect Dola's factual 18+ attestation without misclassifying it as a slider."""
    text = f"{title}\n{body}".lower()
    has_title = "确认你的年龄" in text or bool(re.search(r"confirm\s+your\s+age", text, re.IGNORECASE))
    has_attestation = "已满18周岁" in text or "18周岁" in text or bool(re.search(r"(?:at\s+least|over)\s+18", text, re.IGNORECASE))
    return has_title and has_attestation


def _page_is_region_restricted(url: str, title: str, body: str) -> bool:
    text = f"{url}\n{title}\n{body}".lower()
    return "region-restricted" in text or "受区域限制" in text or "country restricted" in text


_LOGIN_URL_RE = re.compile(r"(?:^|/)(?:login|signin|sign-in|sign_in|auth)(?:[/?#]|$)", re.IGNORECASE)
_LOGIN_TEXT_RE = re.compile(r"\b(?:log\s?in|sign\s?in|sign\s?up)\b|登录|注册", re.IGNORECASE)


def _page_looks_logged_out(url: str, title: str, body: str) -> bool:
    """协议验收口径（docs/dola-api-plan/15）：跳转登录页或出现登录/注册按钮即视为未登录。"""
    if _LOGIN_URL_RE.search(url or ""):
        return True
    return bool(_LOGIN_TEXT_RE.search(f"{title}\n{body}"))


def _identity_from_result(result: dict[str, Any]) -> dict[str, str]:
    return {
        "device_id": str(result.get("device_id") or ""),
        "web_id": str(result.get("web_id") or ""),
        "tea_uuid": str(result.get("tea_uuid") or ""),
        "region": str(result.get("region") or "JP"),
        "sys_region": str(result.get("sys_region") or "JP"),
        "web_tab_id": str(result.get("web_tab_id") or ""),
    }


def _sanitize_vod_payload(value: Any, depth: int = 0) -> Any:
    if depth > 8:
        return None
    if isinstance(value, list):
        items = [_sanitize_vod_payload(item, depth + 1) for item in value[:64]]
        return [item for item in items if item is not None]
    if not isinstance(value, dict):
        if isinstance(value, str):
            return value[:2_000_000]
        return value if isinstance(value, (int, float, bool)) else None
    allowed = {"fallback_api", "key_seed", "video_list", "main_url", "play_url", "download_url", "video_url", "videoUrl", "vwidth", "vheight", "width", "height", "duration", "codec_type", "definition", "data", "video_info", "video_model", "video", "creation_block", "creations", "type", "status", "image", "image_ori", "image_raw", "url"}
    result: dict[str, Any] = {}
    for key, item in value.items():
        if key not in allowed:
            continue
        sanitized = _sanitize_vod_payload(item, depth + 1)
        if sanitized is not None:
            result[str(key)] = sanitized
    return result
