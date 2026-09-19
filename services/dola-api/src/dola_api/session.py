from __future__ import annotations

import asyncio
import base64
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
from .page_scripts import MAIN_WORLD_SUBMIT_SCRIPT
from .protocol import PROFILES, canonical_ratio, validate_request
from .query import decode_main_url, extract_conversation_id, extract_image_urls, extract_video_url, fetch_generation_result, fetch_recent_conversation_id
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
    request: VideoRequest
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
        if os.getenv("DOLA_ENABLE_BROWSER", "0") != "1":
            raise RuntimeError("camoufox_runtime_disabled")
        try:
            from camoufox.async_api import AsyncCamoufox  # type: ignore
        except ImportError as error:
            raise RuntimeError("camoufox_not_installed") from error
        browser_options: dict[str, object] = {"headless": True}
        if proxy_url:
            browser_options["proxy"] = _camoufox_proxy_options(proxy_url)
        async with AsyncCamoufox(**browser_options) as browser:
            context = await browser.new_context(storage_state=None, locale="zh-CN", viewport={"width": 1365, "height": 900})
            await context.add_cookies(_cookie_header_to_playwright(request.cookie))
            page = await context.new_page()
            await page.goto(os.getenv("DOLA_WEB_URL", "https://www.dola.com/chat/create-image"), wait_until="domcontentloaded")
            title = (await page.title()).lower()
            body = (await page.locator("body").inner_text()).strip()
            if await page.locator("text=Verify you are human").count() or _page_has_verification_marker(title, body):
                return {"status": "verification_required", "quota": []}
            quota = await page.evaluate(
                """() => {
                  const text = document.body ? document.body.innerText : "";
                  const values = [];
                  const re = /(video|videos|视频|credits?|次数|额度)[^\\n]{0,40}?(\\d+)\\s*[/／]\\s*(\\d+)/ig;
                  let match;
                  while ((match = re.exec(text)) && values.length < 16) values.push({bucket: match[1], remaining: Number(match[2]), limit: Number(match[3]), unit: /credit|额度/i.test(match[1]) ? "credit" : "count", source: "upstream"});
                  return values;
                }"""
            )
            return {"status": "ready", "quota": quota if isinstance(quota, list) else []}

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
        references = await resolve_references(verification.page, verification.references, verification.page_session.proxy_url)
        verification.references = references
        try:
            await verification.page.wait_for_load_state("load", timeout=45_000)
        except Exception:
            pass
        result = await _execute_completion_submit(verification.page, verification.request, references)
        if result.get("verificationRequired"):
            verification.decision = _verification_decision(result.get("verificationDecision"))
            return await self._verification_snapshot(verification)
        if result.get("restricted"):
            raise RuntimeError("proxy_region_blocked")
        if result.get("serviceFrequent"):
            raise RuntimeError("rate_limited")
        if int(result.get("status") or 0) >= 400:
            raise RuntimeError("submission_unknown")
        cookies = await verification.context.cookies()
        cookie = "; ".join(f"{item['name']}={item['value']}" for item in cookies if item.get("name")) or verification.page_session.cookie
        identity = _identity_from_result(result)
        conversation_id = _result_conversation_id(result)
        video_url = _result_video_url(result)
        image_urls = _result_image_urls(result)
        if not conversation_id and result.get("ackReceived"):
            conversation_id = await fetch_recent_conversation_id(cookie, identity, verification.page_session.proxy_url or None)
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
        return {"verificationId": verification_id, "status": "completed" if completed else "accepted", "taskId": verification.task_id, **({"conversationId": conversation_id} if conversation_id else {}), **({"videoUrl": video_url} if video_url else {}), **({"imageUrls": image_urls} if image_urls else {})}

    async def close_verification(self, verification_id: str, lease: VerificationLease) -> dict[str, Any]:
        await self._ensure_loaded()
        verification = self._verifications.get(verification_id)
        if not verification:
            raise ValueError("verification_not_found")
        self._check_verification_lease(verification, lease.leaseToken)
        task = self._tasks.get(verification.task_id)
        if task:
            self._tasks[verification.task_id] = task.model_copy(update={"status": "failed", "error": "verification_closed"})
        await self._persist()
        await self._discard_verification(verification_id)
        return {"verificationId": verification_id, "status": "closed", "taskId": verification.task_id}

    async def _register_verification(self, task_id: str, request: VideoRequest, session: PageSession, browser: Any, context: Any, page: Any, references: list[dict[str, Any]], decision: Any) -> str:
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
            if not conversation_id and result.get("ackReceived") and cookie:
                conversation_id = await fetch_recent_conversation_id(cookie, identity, self._sessions[key].proxy_url or None)
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
            }
            self._sessions[key].identity = identity
            if result.get("cookie"):
                self._sessions[key].cookie = cookie
            if result.get("verificationRequired"):
                verification_id = str(result.get("verificationId") or f"dola-verification-{uuid.uuid4()}")
                update: dict[str, Any] = {"status": "needs_review", "error": "verification_required", "verificationId": verification_id}
                if conversation_id:
                    update["conversationId"] = conversation_id
                self._tasks[task_id] = self._tasks[task_id].model_copy(update=update)
                self._task_meta[task_id] = {
                    **self._task_meta.get(task_id, {}),
                    "verificationId": verification_id,
                    "verificationDecision": result.get("verificationDecision") if isinstance(result.get("verificationDecision"), dict) else {"type": "verify", "subtype": "unknown"},
                }
                await self._persist()
                return
            if int(result.get("status") or 0) >= 400:
                raise RuntimeError(f"dola_submit_http_{result.get('status')}")
            if result.get("restricted"):
                raise RuntimeError("proxy_region_blocked")
            if result.get("serviceFrequent"):
                raise RuntimeError("rate_limited")
            wants_video = _task_wants_video(request.model)
            if (wants_video and video_url) or (not wants_video and image_urls):
                update = {"status": "completed", "error": None}
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
                    self._tasks[task_id] = self._tasks[task_id].model_copy(update={"status": "accepted", "error": None})
                    await self._persist()
                    return
                raise RuntimeError("submission_unknown")
            self._tasks[task_id] = self._tasks[task_id].model_copy(update={"status": "accepted", "conversationId": conversation_id, "error": None})
            await self._persist()
        except Exception as error:  # noqa: BLE001
            reason = str(error)[:500]
            status = "needs_review" if reason in {"verification_required", "proxy_region_blocked", "submission_unknown"} else "failed"
            self._tasks[task_id] = self._tasks[task_id].model_copy(update={"status": status, "error": reason})
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
        browser_options: dict[str, object] = {"headless": True}
        if proxy_url:
            browser_options["proxy"] = _camoufox_proxy_options(proxy_url)
        browser_manager = AsyncCamoufox(**browser_options)
        browser = await browser_manager.__aenter__()
        keep_open = False
        try:
            # Keep the Camoufox (Firefox) fingerprint fully native: spoofing a
            # Chromium UA here produced contradictory navigator/sec-ch signals
            # that made the bdms signer reject the page.
            context = await browser.new_context(storage_state=None, locale="zh-CN", viewport={"width": 1365, "height": 900})
            await context.add_cookies(_cookie_header_to_playwright(session.cookie))
            page = await context.new_page()
            await page.goto(os.getenv("DOLA_WEB_URL", "https://www.dola.com/chat/create-image"), wait_until="domcontentloaded")
            # The main-world submit script below waits for the bdms signing hook
            # itself; the isolated-world controller cannot observe that patch.
            page_title = (await page.title()).lower()
            page_body = (await page.locator("body").inner_text()).strip()
            if await page.locator("text=Verify you are human").count() or _page_has_verification_marker(page_title, page_body):
                decision = {"type": "verify", "subtype": "unknown"}
                initial_references = [item for item in request.references if isinstance(item, dict) and (item.get("uri") or item.get("url") or item.get("dataUrl"))]
                verification_id = await self._register_verification(task_id, request, session, browser_manager, context, page, initial_references, decision)
                keep_open = True
                return {"status": 429, "verificationRequired": True, "verificationId": verification_id, "verificationDecision": decision}
            references = [item for item in request.references if isinstance(item, dict) and (item.get("uri") or item.get("url") or item.get("dataUrl"))]
            resolved_references = await resolve_references(page, references, proxy_url)
            # The bdms chunk lazy-loads with the fully interactive page; wait for
            # the load event so the signing hook is given its normal window.
            try:
                await page.wait_for_load_state("load", timeout=45_000)
            except Exception:
                pass
            result = await _execute_completion_submit(page, request, resolved_references)
            if result.get("unsigned"):
                # The signing chunk can fail to load on a given navigation; one
                # full reload re-triggers it before giving up.
                await page.reload(wait_until="domcontentloaded")
                try:
                    await page.wait_for_load_state("load", timeout=45_000)
                except Exception:
                    pass
                result = await _execute_completion_submit(page, request, resolved_references)
            if result.get("verificationRequired"):
                verification_id = await self._register_verification(task_id, request, session, browser_manager, context, page, resolved_references, result.get("verificationDecision"))
                result["verificationId"] = verification_id
                keep_open = True
            cookies = await context.cookies()
            cookie = "; ".join(f"{item['name']}={item['value']}" for item in cookies if item.get("name"))
            result["cookie"] = cookie or session.cookie
            result["identity"] = _identity_from_result(result)
            return result
        finally:
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
        if not conversation_id and meta.get("ackReceived") and cookie:
            conversation_id = await fetch_recent_conversation_id(cookie, dict(meta.get("identity") or {}), str(meta.get("proxyUrl") or "") or None) or ""
            if conversation_id:
                meta["conversationId"] = conversation_id
                self._tasks[task_id] = task.model_copy(update={"conversationId": conversation_id})
        if not conversation_id:
            return
        if not meta.get("conversationId"):
            meta["conversationId"] = conversation_id
        if not cookie:
            self._tasks[task_id] = task.model_copy(update={"status": "needs_review", "error": "task_state_cookie_unavailable"})
            await self._persist()
            return
        if str(meta.get("proxyMode") or "direct") == "managed" and not str(meta.get("proxyUrl") or ""):
            self._tasks[task_id] = task.model_copy(update={"status": "needs_review", "error": "task_state_proxy_unavailable"})
            await self._persist()
            return
        result = await fetch_generation_result(cookie, conversation_id, dict(meta.get("identity") or {}), str(meta.get("proxyUrl") or "") or None)
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


def _task_wants_video(model: str) -> bool:
    profile = PROFILES.get(model)
    return not profile or profile.capability != "image"


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


def _cookie_header_to_playwright(header: str) -> list[dict[str, str]]:
    return [{"name": part.split("=", 1)[0].strip(), "value": part.split("=", 1)[1].strip(), "domain": ".dola.com", "path": "/"} for part in header.split(";") if "=" in part]


def _cookie_value(cookie: str, name: str) -> str:
    for part in cookie.split(";"):
        key, separator, value = part.strip().partition("=")
        if separator and key == name:
            return value.strip()
    return ""


async def _execute_completion_submit(page: Any, request: VideoRequest, references: list[dict[str, Any]], attempts: int = 3) -> dict[str, Any]:
    """Build the protocol request here and send it via the page's patched XHR.

    The page may still be attaching its signing hook when the first request
    goes out; such requests are rejected upstream without being accepted, so a
    bounded retry with fresh identity params is safe (no task is created).
    """
    profile = validate_request(request.model, request.duration, request.ratio)
    body = _build_request_body(profile, request, references)
    last: dict[str, Any] = {}
    for attempt in range(attempts):
        query, identity = _build_completion_query(request.cookie or "")
        url = f"{DOLA_WEB_ORIGIN}/chat/completion?{query}"
        config = json.dumps({"url": url, "body": json.dumps(body, ensure_ascii=False, separators=(",", ":")), "timeoutMs": 60_000, "hookDeadline": int(time.time() * 1000) + 40_000}, ensure_ascii=True).replace("</", "<\\/")
        script = f"(window.__DOLA_SUBMIT_CONFIG__ = {config});\n{MAIN_WORLD_SUBMIT_SCRIPT}"
        await page.add_script_tag(content=script)
        raw = ""
        deadline = time.monotonic() + 70.0
        while time.monotonic() < deadline:
            raw = await page.evaluate("() => { const el = document.getElementById('__dola_submit_result__'); return el ? el.value : ''; }")
            if raw:
                break
            await asyncio.sleep(0.5)
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
        if payload.get("fatal"):
            raise RuntimeError(f"submission_transport_{str(payload.get('fatal'))[:60]}")
        text = str(payload.get("text") or "")
        events = _parse_sse_text(text)
        event_names = [name for name, _ in events]
        conversation_id = extract_conversation_id(events) or ""
        decision = _sse_verification_decision(events, text)
        blocked_unsigned = bool(decision) and not conversation_id and "SSE_ACK" not in event_names
        last = {
            "status": int(payload.get("status") or 0),
            "contentType": str(payload.get("contentType") or ""),
            "responseBytes": int(payload.get("responseBytes") or 0),
            "conversationId": conversation_id,
            "videoUrl": decode_main_url(extract_video_url(events) or ""),
            "imageUrls": extract_image_urls(events),
            "ackReceived": "SSE_ACK" in event_names or bool(conversation_id),
            "restricted": "country restricted" in text or "region-restricted" in text,
            "serviceFrequent": any(code in text for code in ("710022002", "710022004")) or "服务访问频繁" in text,
            "verificationRequired": decision is not None,
            "verificationDecision": decision,
            "timedOut": not text and not payload.get("status"),
            **identity,
        }
        # A verify/slide decision without any acceptance marker means the
        # request went out before the signing hook covered it; retry with a
        # fresh request identity instead of surfacing risk control.
        if not blocked_unsigned or attempt == attempts - 1:
            return last
        await asyncio.sleep(1.0)
    return last


def _build_completion_query(cookie: str) -> tuple[str, dict[str, str]]:
    now_ms = int(time.time() * 1000)
    web_id = f"{now_ms}{secrets.randbelow(1000000)}"[:19]
    region = _cookie_value(cookie, "flow_user_country") or "JP"
    fp = _cookie_value(cookie, "s_v_web_id") or f"verify_{now_ms}"
    identity = {"device_id": web_id, "web_id": web_id, "tea_uuid": web_id, "region": region, "sys_region": region, "web_tab_id": str(uuid.uuid4())}
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
        "tz_name": "Asia/Tokyo",
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
        user_content = f"{request.prompt.strip()}，{ratio}" if ratio else request.prompt.strip()
        visible_text = f"生成视频：{user_content}"
        ability_param = {"ratio": ratio, "model": profile.upstream_model, "duration": int(request.duration), "camera_movement": "fixed", "input_box_content": {"user_input_content": user_content, "reply_message_format": "生成视频：%s"}}
        chat_ability = {"ability_type": 17, "ability_param": json.dumps(ability_param, ensure_ascii=False, separators=(",", ":"))}
    body: dict[str, Any] = {
        "client_meta": {
            "local_conversation_id": f"local_{now_ms}",
            "conversation_id": "",
            "bot_id": DOLA_BOT_ID,
            "last_section_id": "",
            "last_message_index": None,
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
            "related_deleted_message_ids": {},
            "connector_info_list": [],
            "model_config": {"model_item_key": "", "model_extra_params": {}},
            "aggregate_params": {"conversation_mode": "", "mode_id": "", "model_item_key": "", "agent_mode": "", "reasoning_effort": "", "provider_id": ""},
        },
        "chat_ability": chat_ability,
        "user_context": [],
        "ext": {
            "answer_with_suggest": "0",
            "fp": "",
            "sub_conv_firstmet_type": "1",
            "collection_id": "",
            "conversation_init_option": json.dumps({"need_ack_conversation": True}),
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


def _sse_verification_decision(events: list[tuple[str, Any]], text: str) -> dict[str, Any] | None:
    marker = re.compile(r'"(?:type|sub_type|subtype)"\s*:\s*"(?:verify|verification|slide)"')
    for _, data in events:
        blob = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
        if not marker.search(blob):
            continue
        type_match = re.search(r'"type"\s*:\s*"(verify|verification)"', blob)
        subtype_match = re.search(r'"(?:sub_type|subtype)"\s*:\s*"([a-z_-]+)"', blob)
        code_match = re.search(r'"code"\s*:\s*"?(\d{3,})"?', blob)
        return {
            "type": type_match.group(1) if type_match else "verify",
            "subtype": subtype_match.group(1) if subtype_match else ("slide" if "slide" in blob else "unknown"),
            **({"code": code_match.group(1)[:32]} if code_match else {}),
        }
    if re.search(r"captcha|verification_required|人机验证|验证码|滑块|安全验证", text):
        return {"type": "verify", "subtype": "unknown"}
    return None


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
    result: dict[str, Any] = {"type": "verify", "subtype": "unknown"}
    if isinstance(value.get("type"), str) and value["type"] in {"verify", "verification"}:
        result["type"] = value["type"]
    if isinstance(value.get("subtype"), str) and value["subtype"] in {"slide", "unknown"}:
        result["subtype"] = value["subtype"]
    if isinstance(value.get("code"), str) and value["code"].isdigit():
        result["code"] = value["code"][:32]
    return result


def _page_has_verification_marker(title: str, body: str) -> bool:
    text = f"{title}\n{body}".lower()
    return bool(re.search(r"(?:verify\s+you\s+are\s+human|captcha|security\s+(?:check|verification)|risk\s+control|slide(?:r)?\s+(?:captcha|verification)|人机验证|验证码|滑块(?:验证)?|安全验证)", text, re.IGNORECASE))


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
