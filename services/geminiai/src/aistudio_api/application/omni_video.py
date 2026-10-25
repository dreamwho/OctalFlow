"""Gemini Omni（AI Studio）视频生成：任务存储 + 页面自动化。

流程与 2026-10-02 真机验证脚本一致：
Cookie 会话 → Cookie 同意 → 关闭浮层 → warmup（离开 Temporary chat 并触发
Drive 授权）→ Enable Google Drive（OAuth 弹窗选账号）→ 选择 Video 分类的
Omni 模型 → 设置时长/分辨率 → 输入提示词 Control+Enter 提交 → 轮询 Download
→ expect_download 保存成片。成片无水印。
"""

from __future__ import annotations

from contextlib import contextmanager
import json
import os
import re
import secrets
import threading
import time
import traceback
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from aistudio_api.config import build_camoufox_proxy, settings

SUPPORTED_MODELS = {"gemini-omni-1.1-flash", "gemini-omni-flash-preview"}
DURATION_RANGE = (3, 10)
RESOLUTIONS = {"360p", "720p", "1080p", "4k"}
ASPECTS = {"auto", "16:9", "9:16"}

# 触发账号冷却的页面错误文案（当日配额/限流）
_QUOTA_RE = re.compile(r"quota for the day|rate limit|account video quota exhausted", re.I)


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
    execution_stage: str = "queued"
    stage_updated_at: float = field(default_factory=time.time)
    account_email: str | None = None
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
                    task.execution_stage = "failed"
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


_OVERLAYS = 'dialog:visible, .cdk-overlay-container .cdk-overlay-pane:visible, .cdk-overlay-container .cdk-overlay-backdrop.cdk-overlay-backdrop-showing:visible'
_CLOSE_BUTTONS = 'button[aria-label="Close"]:visible, button[aria-label="Close guided tour"]:visible'


def _dismiss_overlays(page, *, require_clear=False) -> int:
    hit = 0
    while True:
        _check_account_terms(page)
        overlays = page.locator(_OVERLAYS)
        if not overlays.count():
            return hit
        overlay = overlays.last
        close = overlay.locator(_CLOSE_BUTTONS).last
        if not close.count():
            if require_clear:
                raise OmniVideoError("AI Studio dialog blocks submission; open the authorized account in AI Studio and complete or dismiss the dialog manually")
            return hit
        # Keep the actual element: a live .last locator can switch to the next stacked dialog.
        element = close.element_handle()
        close.click()
        element.wait_for_element_state("hidden")
        hit += 1


def _click_if(page, texts, wait=4):
    for text in texts:
        locator = page.locator("button").filter(has_text=text)
        if locator.count():
            try:
                locator.first.click(timeout=5000)
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


def _check_account_terms(page) -> None:
    if page.get_by_role("button", name="Accept terms of service", exact=True).filter(visible=True).count():
        raise OmniVideoError("account requires AI Studio terms acceptance; complete account setup manually")


@contextmanager
def _submission_overlays(page):
    guard = page.locator("body")
    # Model/settings pickers are intentional overlays outside prompt fill/submission.
    page.add_locator_handler(guard, lambda _: _dismiss_overlays(page, require_clear=True), no_wait_after=True)
    try:
        yield
    finally:
        page.remove_locator_handler(guard)


def _submit_prompt(page) -> None:
    _check_account_terms(page)
    try:
        # Reuse the real submit-control contract used by the text gateway; labels vary by locale.
        button = page.locator("button.ctrl-enter-submits")
        with _submission_overlays(page):
            if button.count():
                button.click()
            else:
                _dismiss_overlays(page, require_clear=True)
                platform = page.evaluate("navigator.platform || ''")
                page.locator("textarea:visible").first.press("Meta+Enter" if "Mac" in platform else "Control+Enter")
    except Exception:
        _check_account_terms(page)
        raise


def _prompt_submitted(page, prompt: str) -> bool:
    return page.evaluate(
        r"""(needle) => {
            const body = document.body.cloneNode(true);
            body.querySelectorAll('textarea,input').forEach(el => el.remove());
            return (body.textContent || '').replace(/\s/g, '').includes(needle.replace(/\s/g, ''));
        }""",
        prompt[:24],
    )


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

    def __init__(self, storage_state: dict, proxy: str | None, logger, progress=lambda _: None):
        self.storage_state = storage_state
        self.proxy = proxy
        self.log = logger
        self.progress = progress

    # -- page steps -----------------------------------------------------
    def _open_studio(self, page) -> None:
        page.goto(settings.studio_url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_function(r"""() => /accounts\.google\.com|\/signin/.test(location.href)
            || document.querySelector('textarea')
            || document.querySelector('button[aria-label="Accept terms of service"]')""", timeout=60000)
        if "/signin" in page.url or "accounts.google.com" in page.url:
            raise OmniVideoError("account cookies expired (redirected to Google sign-in)")
        _check_account_terms(page)
        _dismiss_overlays(page)
        page.locator("textarea:visible").first.wait_for(state="visible", timeout=60000)

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
        _dismiss_overlays(page)
        box = page.locator("textarea:visible").first
        with _submission_overlays(page):
            box.fill("Reply exactly: Hello! How can I help you today?")
        _submit_prompt(page)
        page.wait_for_function("""() => {
            const body = document.body.cloneNode(true);
            body.querySelectorAll('textarea,input,[contenteditable]').forEach(el => el.remove());
            const run = document.querySelector('button.ctrl-enter-submits');
            return (body.textContent || '').includes('Hello! How can I help you today?')
                && run && !/Stop/i.test(run.textContent || '');
        }""", timeout=settings.timeout_replay * 1000)
        self.log("omni: warmup conversation ready")
        if _click_if(page, ("Enable Google Drive",)):
            self._walk_oauth_popup(context, (self.storage_state.get("account_email") or "").strip())

    def _select_model(self, page, model: str) -> None:
        page.locator("ms-model-selector button.model-selector-card").click(timeout=20000)
        page.get_by_role("button", name="Video", exact=True).click(timeout=20000)
        page.get_by_text("Gemini Omni 1.1 Flash" if model == "gemini-omni-1.1-flash" else "Gemini Omni Flash Preview", exact=True).first.click(timeout=20000)
        _dismiss_overlays(page)
        page.get_by_role("spinbutton", name="Video duration in seconds", exact=True).wait_for(state="visible", timeout=20000)

    def _apply_settings(self, page, duration: int, resolution: str, aspect: str) -> None:
        duration_input = page.get_by_role("spinbutton", name="Video duration in seconds", exact=True)
        if duration_input.input_value() != str(duration):
            duration_input.fill(str(duration))
            duration_input.press("Tab")
        if duration_input.input_value() != str(duration):
            raise OmniVideoError("video duration setting was not applied")
        for label, value in (("Video Resolution", resolution), ("Aspect ratio", "Auto" if aspect == "auto" else aspect)):
            if value:
                control = page.get_by_role("combobox", name=label, exact=True)
                if control.inner_text().strip() != value:
                    control.click()
                    page.get_by_role("option", name=value, exact=True).click()
                    control.press("Escape")
                page.wait_for_function("""({label, value}) => {
                    const control = Array.from(document.querySelectorAll('[role="combobox"]'))
                        .find(el => el.getAttribute('aria-label') === label);
                    return control && control.getAttribute('aria-expanded') !== 'true'
                        && control.innerText.trim() === value;
                }""", arg={"label": label, "value": value}, timeout=settings.timeout_replay * 1000)
                self.log(f"omni: {label} applied: {value}")
        self.log(f"omni: duration applied: {duration}")

    def _attach_images(self, page, image_paths: list[Path]) -> None:
        """等待原生附件完成解码和 token 预处理。"""
        file_input = page.locator("input[type=file]").first
        file_input.wait_for(state="attached", timeout=settings.timeout_replay * 1000)
        file_input.set_input_files([str(p) for p in image_paths])
        self.log(f"omni: attached {len(image_paths)} reference image(s)")
        try:
            page.wait_for_function(r"""(names) => {
                const items = Array.from(document.querySelectorAll('ms-prompt-media'))
                    .filter(el => el.getClientRects().length);
                return items.length === names.length && names.every(name => items.some(el =>
                    el.querySelector('.name')?.textContent.trim() === name
                    && /[0-9]+\s+tokens?/.test(el.querySelector('ms-token-status')?.textContent || '')
                    && Array.from(el.querySelectorAll('img')).some(img => img.complete && img.naturalWidth > 0)
                ));
            }""", arg=[p.name for p in image_paths], timeout=settings.timeout_replay * 1000)
        except Exception as exc:
            states = page.locator("ms-prompt-media:visible").all_text_contents()
            raise OmniVideoError(f"reference image preprocessing did not complete: {states}") from exc
        _dismiss_overlays(page)
        self.log("omni: reference images ready")

    def _submit_and_wait(self, page, prompt: str, context) -> None:
        _dismiss_overlays(page)
        box = page.locator("textarea:visible").first
        with _submission_overlays(page):
            box.fill(prompt, timeout=20000)
        _submit_prompt(page)
        # A visible conversation message confirms submission. Do not retry a
        # click while its result is unknown: that can create a second video.
        page.wait_for_function(r"""(needle) => {
            const body = document.body.cloneNode(true);
            body.querySelectorAll('textarea,input').forEach(el => el.remove());
            return (body.textContent || '').replace(/\s/g, '').includes(needle.replace(/\s/g, ''))
                || Array.from(document.querySelectorAll('button')).some(b => /Enable Google Drive/.test(b.textContent) && b.getClientRects().length);
        }""", arg=prompt[:24], timeout=30000)
        if not _prompt_submitted(page, prompt):
            if _click_if(page, ("Enable Google Drive",)):
                self._walk_oauth_popup(context, (self.storage_state.get("account_email") or "").strip())
                _submit_prompt(page)
            page.wait_for_function(r"""(needle) => {
                const body = document.body.cloneNode(true);
                body.querySelectorAll('textarea,input').forEach(el => el.remove());
                return (body.textContent || '').replace(/\s/g, '').includes(needle.replace(/\s/g, ''));
            }""", arg=prompt[:24], timeout=30000)
        self.progress("generating")
        state = page.wait_for_function("""() => {
            if (/quota for the day|rate limit/i.test(document.body.innerText || '')) return 'quota';
            const buttons = document.querySelectorAll('[aria-label*="ownload"],button');
            return Array.from(buttons).some(b => b.getClientRects().length && !b.disabled
                && /download/i.test((b.getAttribute('aria-label') || '') + b.textContent)) ? 'ready' : false;
        }""", timeout=420000).json_value()
        if state == "quota":
            raise OmniVideoError("account video quota exhausted (daily)")

    def _download(self, page, target: Path) -> None:
        with page.expect_download(timeout=30000) as download_info:
            page.locator('[aria-label*="ownload"]:visible, button:has-text("Download"):visible').first.click(timeout=10000)
        download_info.value.save_as(str(target))

    # -- entry ----------------------------------------------------------
    def run(self, model: str, prompt: str, duration: int, resolution: str, target: Path, image_paths: list[Path] | None = None, aspect: str = "auto") -> dict:
        from camoufox.sync_api import Camoufox

        self.progress("browser_startup")
        with Camoufox(headless=True, window=(1680, 1050), locale="zh-CN", proxy=build_camoufox_proxy(self.proxy)) as browser:
            context = browser.new_context()
            context.add_cookies(self.storage_state.get("cookies", []))
            page = context.pages[0] if context.pages else context.new_page()
            self.progress("opening_studio")
            self._open_studio(page)
            self.progress("warmup")
            self._warmup(context, page)
            self.progress("model_selection")
            self._select_model(page, model)
            self._apply_settings(page, duration, resolution, aspect)
            if image_paths:
                self.progress("reference_upload")
                self._attach_images(page, image_paths)
            self.progress("submitting")
            self._submit_and_wait(page, prompt, context)
            self.progress("downloading")
            target.parent.mkdir(parents=True, exist_ok=True)
            self._download(page, target)
            size = target.stat().st_size
            if not size:
                raise OmniVideoError("downloaded video is empty")
            return {"bytes": size}


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
        self._notification_keys: dict[str, str] = {}

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

    def _mark_failure(self, account_id: str, message: str) -> bool:
        quota = bool(_QUOTA_RE.search(message))
        auth = "account cookies expired" in message
        if not quota and not auth:
            return False
        # Only confirmed account quota/auth failures justify account cooldown and rotation.
        self._cooldown[account_id] = time.time() + (6 * 3600 if quota else 3600)
        return True

    # -- public API ------------------------------------------------------
    def submit(self, model: str, prompt: str, duration: int, resolution: str, aspect: str, reference_images: list[str] | None = None, notification_key: str = "") -> dict:
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
            if notification_key:
                self._notification_keys[task.id] = notification_key
            self._queue.append(task.id)
            if not self._worker or not self._worker.is_alive():
                self._worker = threading.Thread(target=self._work_loop, daemon=True)
                self._worker.start()
        return self._view(task)

    def _work_loop(self) -> None:
        while True:
            with self._lock:
                if not self._queue:
                    self._worker = None
                    return
                task_id = self._queue.pop(0)
            try:
                self._execute(task_id)
            except Exception as exc:  # a task failure must not strand this or queued tasks
                traceback.print_exc()
                self._fail(task_id, str(exc))

    def _fail(self, task_id: str, error: str) -> None:
        def fail(task: VideoTask) -> None:
            task.status = "failed"
            task.execution_stage = "failed"
            task.stage_updated_at = time.time()
            task.error = error
            task.finished_at = time.time()
            task.elapsed_seconds = round(task.finished_at - task.created_at, 1)

        self.tasks.update(task_id, fail)
        self._notify_completion(task_id)

    def _stage(self, task_id: str, stage: str) -> None:
        def apply(task: VideoTask) -> None:
            task.execution_stage = stage
            task.stage_updated_at = time.time()
        self.tasks.update(task_id, apply)
        self.log(f"omni: {task_id} stage={stage}")

    def _execute(self, task_id: str) -> None:
        task = self.tasks.get(task_id)
        if not task:
            return
        target = self.tasks.media_dir / f"{task_id}.mp4"
        image_paths: list[Path] = []
        if task.reference_images:
            self._stage(task_id, "reference_download")
            try:
                image_paths = _download_reference_images(task.reference_images, self.tasks.media_dir / f"{task_id}-refs")
                self.log(f"omni: downloaded {len(image_paths)} reference image(s)")
            except Exception as exc:
                self._fail(task_id, str(exc))
                return
        tried: set[str] = set()
        last_error = ""
        while True:
            self._stage(task_id, "account_selection")
            try:
                account_id, state = self._pick_account(exclude=tried)
            except Exception as exc:  # noqa: BLE001 - worker must survive any account error
                self.log(f"omni: pick account failed: {exc}")
                self._fail(task_id, f"no usable account: {last_error or exc}")
                return
            tried.add(account_id)
            def assign_account(t: VideoTask) -> None:
                t.account_id = account_id
                t.account_email = state.get("account_email")
            self.tasks.update(task_id, assign_account)
            try:
                runner = OmniVideoRunner(state, settings.proxy_url, self.log, lambda stage: self._stage(task_id, stage))
                result = runner.run(task.model, task.prompt, task.duration_seconds, task.resolution, target, image_paths or None, task.aspect_ratio)
                if not target.is_file() or target.stat().st_size == 0:
                    raise OmniVideoError("video result file is missing or empty")

                def apply(t: VideoTask) -> None:
                    t.status = "succeeded"
                    t.execution_stage = "succeeded"
                    t.stage_updated_at = time.time()
                    t.finished_at = time.time()
                    t.media_path = str(target)
                    t.media_size = result.get("bytes")
                    t.elapsed_seconds = round(time.time() - t.created_at, 1)

                self.tasks.update(task_id, apply)
                self._notify_completion(task_id)
                return
            except Exception as exc:  # noqa: BLE001
                last_error = str(exc)
                traceback.print_exc()
                if not self._mark_failure(account_id, last_error):
                    self._fail(task_id, f"{task.execution_stage}: {last_error}")
                    return
                if len(tried) >= 3:
                    break

        self._fail(task_id, last_error)

    def _notify_completion(self, task_id: str) -> None:
        # Only the administrator-configured internal App origin is used. The
        # callback cannot accept an arbitrary URL from a video request.
        origin = os.getenv("GEMINIAI_REFERENCE_ASSET_ORIGIN", "").strip().rstrip("/")
        with self._lock:
            key = self._notification_keys.pop(task_id, "")
        if not origin or not key:
            return
        def send() -> None:
            import httpx
            try:
                with httpx.Client(timeout=settings.timeout_capture, trust_env=False) as client:
                    response = client.post(f"{origin}/api/maintenance/geminiai-videos/notify",
                        headers={"authorization": f"Bearer {key}"}, json={"upstreamTaskId": task_id})
                    response.raise_for_status()
                self.log(f"omni: {task_id} completion notification delivered")
            except Exception as exc:
                self.log(f"omni: {task_id} completion notification deferred ({type(exc).__name__}); polling remains active")
        threading.Thread(target=send, daemon=True).start()

    def _view(self, task: VideoTask) -> dict:
        view = {
            "id": task.id,
            "model": task.model,
            "duration_seconds": task.duration_seconds,
            "resolution": task.resolution,
            "aspect_ratio": task.aspect_ratio,
            "reference_images": len(task.reference_images),
            "status": task.status,
            "execution_stage": task.execution_stage,
            "stage_updated_at": task.stage_updated_at,
            "account_email": task.account_email,
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
