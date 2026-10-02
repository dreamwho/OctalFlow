"""Gemini Omni（AI Studio）视频生成：任务存储 + 页面自动化。

流程与 2026-10-02 真机验证脚本一致：
Cookie 会话 → Cookie 同意 → 关闭浮层 → warmup（离开 Temporary chat 并触发
Drive 授权）→ Enable Google Drive（OAuth 弹窗选账号）→ 选择 Video 分类的
Omni 模型 → 设置时长/分辨率 → 输入提示词 Control+Enter 提交 → 轮询 Download
→ expect_download 保存成片。成片无水印。
"""

from __future__ import annotations

import json
import re
import secrets
import threading
import time
import traceback
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

SUPPORTED_MODELS = {"gemini-omni-1.1-flash", "gemini-omni-flash-preview"}
DURATION_RANGE = (3, 10)
RESOLUTIONS = {"360p", "720p", "1080p", "4k"}
ASPECTS = {"auto", "16:9", "9:16"}

# 触发账号冷却的页面错误文案（当日配额/限流）
_QUOTA_RE = re.compile(r"quota for the day|rate limit", re.I)


class OmniVideoError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


@dataclass
class VideoTask:
    id: str
    model: str
    prompt: str
    duration_seconds: int
    resolution: str
    aspect_ratio: str
    account_id: str | None = None
    status: str = "processing"  # processing | succeeded | failed
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    elapsed_seconds: float | None = None
    media_path: str | None = None
    media_size: int | None = None
    reference_images: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "VideoTask":
        known = set(cls.__dataclass_fields__)
        return cls(**{k: v for k, v in data.items() if k in known})


class VideoTaskStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.media_dir = self.root / "media"
        self.media_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._tasks: dict[str, VideoTask] = {}
        self._load_all()

    def _path(self, task_id: str) -> Path:
        return self.root / f"{task_id}.json"

    def _load_all(self) -> None:
        for path in self.root.glob("vt_*.json"):
            try:
                task = VideoTask.from_dict(json.loads(path.read_text(encoding="utf-8")))
                if task.status == "processing":
                    task.status = "failed"
                    task.error = "sidecar restarted during generation"
                    task.finished_at = time.time()
                    self._persist(task)
                self._tasks[task.id] = task
            except (OSError, ValueError, TypeError):
                continue

    def _persist(self, task: VideoTask) -> None:
        tmp = self._path(task.id).with_suffix(".tmp")
        tmp.write_text(json.dumps(task.to_dict(), ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self._path(task.id))

    def create(self, model: str, prompt: str, duration: int, resolution: str, aspect: str, reference_images: list[str] | None = None) -> VideoTask:
        task = VideoTask(
            id=f"vt_{secrets.token_hex(8)}",
            model=model,
            prompt=prompt,
            duration_seconds=duration,
            resolution=resolution,
            aspect_ratio=aspect,
            reference_images=reference_images or [],
        )
        with self._lock:
            self._tasks[task.id] = task
            self._persist(task)
        return task

    def get(self, task_id: str) -> VideoTask | None:
        with self._lock:
            return self._tasks.get(task_id)

    def update(self, task_id: str, mutate) -> VideoTask | None:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return None
            mutate(task)
            self._persist(task)
            return task

    def media_file(self, task_id: str) -> Path | None:
        task = self.get(task_id)
        if task and task.status == "succeeded" and task.media_path:
            path = Path(task.media_path)
            if path.is_file():
                return path
        return None

    def delete(self, task_id: str) -> bool:
        with self._lock:
            task = self._tasks.pop(task_id, None)
        if not task:
            return False
        self._path(task_id).unlink(missing_ok=True)
        if task.media_path:
            Path(task.media_path).unlink(missing_ok=True)
        return True


def _dismiss_overlays(page) -> int:
    return page.evaluate(
        """(() => { let hit = 0;
            for (const b of document.querySelectorAll('button,[aria-label]')) {
                const t = (b.getAttribute('aria-label') || '') + (b.textContent || '');
                if (/^close$/i.test(t.trim()) || /Close guided tour|Not now|Dismiss/i.test(t)) { b.click(); hit++; }
            }
            return hit; })()"""
    )


def _click_if(page, texts, wait=4):
    for text in texts:
        locator = page.locator("button").filter(has_text=text)
        if locator.count():
            try:
                locator.first.click(timeout=5000)
                time.sleep(wait)
                return text
            except Exception:
                continue
    return None


def _mouse_click(locator):
    box = locator.bounding_box()
    page = locator.page
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.down()
    time.sleep(0.05)
    page.mouse.up()


def _fetch_reference_image(source: str) -> bytes:
    """参考图下载：data URL 解码；http(s) 签名地址直连（不走代理），支持 origin 覆盖。"""
    import os as _os
    import urllib.request as _request
    from urllib.parse import parse_qs, urlsplit, urlunsplit

    source = (source or "").strip()
    if source.startswith("data:"):
        _, _, payload = source.partition(",")
        import base64
        try:
            data = base64.b64decode(payload, validate=True)
        except Exception as exc:
            raise OmniVideoError(f"reference image data URL invalid: {exc}") from exc
        if len(data) < 100:
            raise OmniVideoError("reference image too small")
        return data
    if source.startswith(("http://", "https://")):
        origin = _os.getenv("GEMINIAI_REFERENCE_ASSET_ORIGIN", "").strip()
        query = parse_qs(urlsplit(source).query)
        if origin and query.get("purpose") == ["provider-read"] and query.get("signature"):
            parsed = urlsplit(source)
            override = urlsplit(origin)
            if override.scheme not in {"http", "https"} or not override.netloc:
                raise OmniVideoError("GEMINIAI_REFERENCE_ASSET_ORIGIN invalid")
            source = urlunsplit((override.scheme, override.netloc, parsed.path, parsed.query, parsed.fragment))
        opener = _request.build_opener(_request.ProxyHandler({}))
        req = _request.Request(source, headers={"user-agent": "geminiai-sidecar/1.0"})
        try:
            with opener.open(req, timeout=120) as response:
                data = response.read()
        except Exception as exc:
            raise OmniVideoError(f"reference image download failed: {exc}") from exc
        if len(data) < 100:
            raise OmniVideoError(f"reference image download too small: {len(data)}")
        return data
    raise OmniVideoError("reference image must be a data: or http(s):// URL")


def _download_reference_images(sources: list[str], workdir: Path) -> list[Path]:
    workdir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for index, source in enumerate(sources, start=1):
        data = _fetch_reference_image(source)
        ext = ".png"
        if data[1:4] == b"PNG":
            ext = ".png"
        elif data[:3] == b"\xff\xd8\xff":
            ext = ".jpg"
        path = workdir / f"reference-{index}{ext}"
        path.write_bytes(data)
        paths.append(path)
    return paths



class OmniVideoRunner:
    """单个任务的页面自动化执行；同步 Camoufox，运行在 worker 线程。"""

    def __init__(self, storage_state: dict, proxy: str | None, logger):
        self.storage_state = storage_state
        self.proxy = proxy
        self.log = logger

    # -- page steps -----------------------------------------------------
    def _open_studio(self, page) -> None:
        page.goto("https://aistudio.google.com/prompts/new_chat", wait_until="domcontentloaded", timeout=60000)
        time.sleep(12)
        if "/signin" in page.url or "accounts.google.com" in page.url:
            raise OmniVideoError("account cookies expired (redirected to Google sign-in)")
        if page.evaluate("document.body.innerText.includes('Agree')"):
            try:
                page.get_by_role("button", name="Agree").click(timeout=6000)
                self.log("omni: cookies consent accepted")
                time.sleep(8)
            except Exception:
                pass
        page.evaluate(
            "Array.from(document.querySelectorAll('button,[aria-label]'))"
            ".find(b => (b.getAttribute('aria-label') || '') === 'close')?.click()"
        )
        time.sleep(3)
        _dismiss_overlays(page)
        time.sleep(1)

    def _walk_oauth_popup(self, context, email: str | None) -> None:
        for page in list(context.pages):
            try:
                for _ in range(15):
                    if "accounts.google.com" not in page.url:
                        break
                    for selector in (f'div[data-email="{email}"]', "[data-identifier]"):
                        locator = page.locator(selector)
                        if locator.count():
                            locator.first.click(timeout=5000)
                            self.log("omni: oauth account chosen")
                            time.sleep(4)
                            break
                    for text in ("Allow", "Continue", "I agree"):
                        button = page.locator("button,span").filter(has_text=text)
                        if button.count():
                            button.first.click(timeout=4000)
                            self.log(f"omni: oauth clicked {text}")
                            time.sleep(5)
                            break
                    time.sleep(2)
            except Exception:
                continue

    def _warmup(self, context, page) -> None:
        box = page.get_by_role("textbox", name="Enter a prompt")
        box.click()
        time.sleep(1)
        page.keyboard.type("hi", delay=30)
        time.sleep(1.2)
        for _ in range(3):
            page.keyboard.press("Control+Enter")
            time.sleep(5)
            if page.evaluate("document.body.innerText.includes('Hello! How can I help you today?')"):
                break
            try:
                _mouse_click(page.locator("button").filter(has_text="Run").filter(has_not_text="settings").first)
            except Exception:
                pass
            time.sleep(5)
        for _ in range(12):
            if page.evaluate("document.body.innerText.includes('Hello! How can I help you today?')"):
                self.log("omni: warmup delivered")
                break
            time.sleep(5)
        else:
            raise OmniVideoError("warmup message failed (no model reply)")

        # Drive 授权弹窗：Enable Google Drive → OAuth 账号选择
        if _click_if(page, ("Enable Google Drive",), wait=12):
            email = (self.storage_state.get("account_email") or "").strip()
            self._walk_oauth_popup(context, email)
            time.sleep(4)

    def _select_model(self, page, model: str) -> None:
        page.locator("button").filter(has_text="gemini-3-flash-preview").first.click(timeout=20000)
        time.sleep(5)
        page.evaluate(
            "Array.from(document.querySelectorAll('button'))"
            ".find(b => (b.textContent || '').trim() === 'Video')?.click()"
        )
        time.sleep(4)
        page.get_by_text("Gemini Omni 1.1 Flash" if model == "gemini-omni-1.1-flash" else "Gemini Omni Flash Preview").first.click()
        time.sleep(8)
        # 关闭可能重新出现的浮层，避免遮挡时长/分辨率控件
        _dismiss_overlays(page)
        time.sleep(1)

    def _apply_settings(self, page, duration: int, resolution: str) -> None:
        if DURATION_RANGE[0] <= duration <= DURATION_RANGE[1] and duration != 10:
            value = page.evaluate(
                """(seconds) => {
                    try {
                        const input = document.querySelector('input[aria-label="Video duration in seconds"]');
                        if (!input) return 'no-input';
                        const proto = window.HTMLInputElement ? window.HTMLInputElement.prototype
                            : window.wrappedJSObject.HTMLInputElement.prototype;
                        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                        setter.call(input, String(seconds));
                        input.dispatchEvent(new Event('input', {bubbles: true}));
                        input.dispatchEvent(new Event('change', {bubbles: true}));
                        return 'set:' + input.value;
                    } catch (error) { return 'err:' + error.message; }
                }""",
                duration,
            )
            self.log(f"omni: duration {duration} -> {value}")

    def _attach_images(self, page, image_paths: list[Path]) -> None:
        """通过 composer 的隐藏 file input 上传参考图；上传完成后继续。"""
        file_input = page.locator("input[type=file]").first
        try:
            file_input.wait_for(state="attached", timeout=10000)
        except Exception as exc:
            raise OmniVideoError("reference image upload failed: file input not found") from exc
        file_input.set_input_files([str(p) for p in image_paths])
        self.log(f"omni: attached {len(image_paths)} reference image(s)")
        # 首次上传会弹媒体权利确认对话框（Acknowledge），必须确认
        for text in ("Acknowledge", "I acknowledge", "Got it", "OK"):
            button = page.locator("button").filter(has_text=text)
            if button.count():
                try:
                    button.first.click(timeout=4000)
                    self.log(f"omni: media-rights dialog confirmed via {text!r}")
                    time.sleep(4)
                    break
                except Exception:
                    continue
        # 等待上传完成（页面内异步）；遮罩残留会挡住 composer，需清除
        deadline = time.time() + 60
        while time.time() < deadline:
            state = page.evaluate(
                "JSON.stringify({imgs: document.querySelectorAll('img[src^=\"blob:\"]').length,"
                "busy: !!document.querySelector('[aria-busy=\"true\"]'),"
                "overlay: !!document.querySelector('.cdk-overlay-backdrop:not([style*=\"display: none\"])')})"
            )
            data = json.loads(state)
            if data["imgs"] >= len(image_paths) and not data["busy"] and not data["overlay"]:
                break
            if data["overlay"]:
                page.evaluate(
                    "document.querySelectorAll('.cdk-overlay-backdrop').forEach(e => e.remove());"
                    "document.querySelectorAll('.cdk-overlay-container').forEach(e => { if (!e.children.length) e.remove(); })"
                )
            time.sleep(2)
        # 等待对话框关闭动画完成、遮罩彻底消失（Angular 会延迟移除）
        overlay_deadline = time.time() + 15
        while time.time() < overlay_deadline:
            remaining = page.evaluate("document.querySelectorAll('.cdk-overlay-backdrop').length")
            if not remaining:
                break
            page.evaluate("document.querySelectorAll('.cdk-overlay-backdrop').forEach(e => e.remove())")
            time.sleep(1)
        _dismiss_overlays(page)
        self.log("omni: reference images uploaded")
        time.sleep(2)

    def _submit_and_wait(self, page, prompt: str, context) -> None:
        for attempt in range(4):
            page.evaluate("document.querySelectorAll('.cdk-overlay-backdrop').forEach(e => e.remove())")
            time.sleep(0.5)
            try:
                box = page.get_by_role("textbox", name="Enter a prompt")
                box.click(timeout=5000)
                break
            except Exception:
                if attempt == 3:
                    raise OmniVideoError("composer not accessible after reference upload (overlay stuck)")
                time.sleep(2)
        time.sleep(0.8)
        page.keyboard.press("Control+a")
        page.keyboard.press("Backspace")
        time.sleep(0.4)
        page.keyboard.type(prompt, delay=12)
        time.sleep(1.5)
        page.keyboard.press("Control+Enter")
        time.sleep(10)

        # 提示词进入会话线程（输入框 + 消息各出现一次）
        submitted = page.evaluate(
            "(needle) => (document.body.innerText || '').split(needle).length >= 3",
            prompt[:24],
        )
        if not submitted:
            # Temporary chat / Drive 弹窗会在提交时出现：授权后重提交
            if _click_if(page, ("Enable Google Drive",), wait=15):
                email = (self.storage_state.get("account_email") or "").strip()
                self._walk_oauth_popup(context, email)
                box.click()
                time.sleep(1)
                page.keyboard.press("Control+Enter")
                time.sleep(12)

        deadline = time.time() + 420
        while time.time() < deadline:
            state = page.evaluate(
                "JSON.stringify({dl:/Download/i.test(document.body.innerText||''),"
                "quota:/quota for the day|rate limit/i.test(document.body.innerText||'')})"
            )
            data = json.loads(state)
            if data["dl"]:
                return
            if data["quota"]:
                raise OmniVideoError("account video quota exhausted (daily)")
            time.sleep(10)
        raise OmniVideoError("video generation timed out")

    def _download(self, page, target: Path) -> None:
        with page.expect_download(timeout=30000) as download_info:
            page.locator('[aria-label*="ownload"], button:has-text("Download")').first.click(timeout=10000)
        download_info.value.save_as(str(target))

    # -- entry ----------------------------------------------------------
    def run(self, model: str, prompt: str, duration: int, resolution: str, target: Path, image_paths: list[Path] | None = None) -> dict:
        from camoufox.sync_api import Camoufox

        proxies = None
        if self.proxy:
            proxies = {"http": self.proxy, "https": self.proxy}
        with Camoufox(headless=True, window=(1680, 1050), locale="zh-CN", proxy=proxies) as browser:
            context = browser.new_context()
            context.add_cookies(self.storage_state.get("cookies", []))
            page = context.pages[0] if context.pages else context.new_page()
            self._open_studio(page)
            self._warmup(context, page)
            self._select_model(page, model)
            self._apply_settings(page, duration, resolution)
            if image_paths:
                self._attach_images(page, image_paths)
            self._submit_and_wait(page, prompt, context)
            target.parent.mkdir(parents=True, exist_ok=True)
            self._download(page, target)
            return {"bytes": target.stat().st_size}


class OmniVideoService:
    """任务编排：顺序 worker + 账号冷却。"""

    def __init__(self, task_store: VideoTaskStore, accounts, logger):
        self.tasks = task_store
        self.accounts = accounts
        self.log = logger
        self._lock = threading.Lock()
        self._cooldown: dict[str, float] = {}
        self._queue: list[str] = []
        self._worker: threading.Thread | None = None

    # -- account selection ---------------------------------------------
    def _pick_account(self, exclude: set[str] | None = None) -> tuple[str, dict]:
        metas = self.accounts.list_accounts()
        now = time.time()
        skip = exclude or set()
        candidates = [meta for meta in metas if meta.id not in skip and self._cooldown.get(meta.id, 0) <= now]
        if not candidates:
            raise OmniVideoError("no usable geminiai account for video (quota/auth cooling)")
        active = self.accounts.get_active_account()
        chosen = next((m for m in candidates if active and m.id == active.id), candidates[0])
        auth_path = self.accounts._account_dir(chosen.id) / "auth.json"
        state = json.loads(auth_path.read_text(encoding="utf-8"))
        email = chosen.email or ""
        state.setdefault("account_email", email)
        return chosen.id, state

    def _mark_failure(self, account_id: str, message: str) -> None:
        # 失败账号先冷却（配额 6 小时，其他失败 1 小时），同任务内自动轮换下一账号
        self._cooldown[account_id] = time.time() + (6 * 3600 if _QUOTA_RE.search(message) else 3600)

    # -- public API ------------------------------------------------------
    def submit(self, model: str, prompt: str, duration: int, resolution: str, aspect: str, reference_images: list[str] | None = None) -> dict:
        if model not in SUPPORTED_MODELS:
            raise OmniVideoError(f"model not supported for AI Studio video: {model}", 400)
        if not prompt.strip():
            raise OmniVideoError("prompt is required", 400)
        duration = max(DURATION_RANGE[0], min(DURATION_RANGE[1], int(duration or 10)))
        resolution = resolution if resolution in RESOLUTIONS else ""
        aspect = aspect if aspect in ASPECTS else "auto"
        images = [str(item).strip() for item in (reference_images or []) if str(item).strip()][:4]
        for item in images:
            if not item.startswith(("data:", "http://", "https://")):
                raise OmniVideoError("reference image must be a data: or http(s):// URL", 400)
        task = self.tasks.create(model, prompt.strip(), duration, resolution, aspect, images)
        with self._lock:
            self._queue.append(task.id)
            if not self._worker or not self._worker.is_alive():
                self._worker = threading.Thread(target=self._work_loop, daemon=True)
                self._worker.start()
        return self._view(task)

    def _work_loop(self) -> None:
        while True:
            with self._lock:
                task_id = self._queue.pop(0) if self._queue else None
            if not task_id:
                return
            self._execute(task_id)

    def _execute(self, task_id: str) -> None:
        task = self.tasks.get(task_id)
        if not task:
            return
        target = self.tasks.media_dir / f"{task_id}.mp4"
        tried: set[str] = set()
        last_error = ""
        while True:
            try:
                account_id, state = self._pick_account(exclude=tried)
            except Exception as exc:  # noqa: BLE001 - worker must survive any account error
                self.log(f"omni: pick account failed: {exc}")
                self.tasks.update(task_id, lambda t: (setattr(t, "status", "failed"), setattr(t, "error", f"no usable account: {last_error or exc}"), setattr(t, "finished_at", time.time())))
                return
            tried.add(account_id)
            self.tasks.update(task_id, lambda t: setattr(t, "account_id", account_id))
            image_paths: list[Path] = []
            if task.reference_images:
                refs_dir = self.tasks.media_dir / f"{task_id}-refs"
                image_paths = _download_reference_images(task.reference_images, refs_dir)
                self.log(f"omni: downloaded {len(image_paths)} reference image(s)")
            try:
                runner = OmniVideoRunner(state, None, self.log)
                result = runner.run(task.model, task.prompt, task.duration_seconds, task.resolution, target, image_paths or None)

                def apply(t: VideoTask) -> None:
                    t.status = "succeeded"
                    t.finished_at = time.time()
                    t.media_path = str(target)
                    t.media_size = result.get("bytes")
                    t.elapsed_seconds = round(time.time() - t.created_at, 1)

                self.tasks.update(task_id, apply)
                return
            except Exception as exc:  # noqa: BLE001
                last_error = str(exc)[:500]
                traceback.print_exc()
                self._mark_failure(account_id, last_error)
                if len(tried) >= 3:
                    break

        def fail(t: VideoTask) -> None:
            t.status = "failed"
            t.error = last_error
            t.finished_at = time.time()
            t.elapsed_seconds = round(time.time() - t.created_at, 1)

        self.tasks.update(task_id, fail)

    def _view(self, task: VideoTask) -> dict:
        view = {
            "id": task.id,
            "model": task.model,
            "prompt": task.prompt,
            "duration_seconds": task.duration_seconds,
            "resolution": task.resolution,
            "aspect_ratio": task.aspect_ratio,
            "reference_images": len(task.reference_images),
            "status": task.status,
            "account_id": task.account_id,
            "created_at": task.created_at,
            "elapsed_seconds": task.elapsed_seconds,
        }
        if task.status == "succeeded":
            view["video_url"] = f"/v1/videos/{task.id}/content"
            view["file_size"] = task.media_size
        elif task.status == "failed":
            view["error"] = task.error
        return view

    def task_view(self, task_id: str) -> dict | None:
        task = self.tasks.get(task_id)
        return self._view(task) if task else None
