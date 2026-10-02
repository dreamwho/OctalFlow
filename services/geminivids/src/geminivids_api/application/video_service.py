"""视频生成编排：账号选择 + 后台执行 + 失败轮换。"""

from __future__ import annotations

import base64
import binascii
import threading
import time
import traceback
from typing import Any

from geminivids_api.config import settings
from geminivids_api.infrastructure.account_store import AccountStore
from geminivids_api.infrastructure.task_store import TaskStore
from geminivids_api.param_slots import build_param_slots
from geminivids_api.protocol import (
    VidsMaterial,
    VidsProtocolClient,
    VidsProtocolError,
    load_google_cookie_header,
)

# 会触发账号冷却/轮换的上游状态
_ROTATE_STATUSES = {401, 403, 429}


def _fetch_reference_image(source: str) -> bytes:
    """参考图来源：data URL 直接解码；http(s) URL 下载（站内签名地址，强制直连，不走上游代理）。"""
    import os
    import urllib.request
    from urllib.parse import parse_qs, urlsplit, urlunsplit

    source = (source or "").strip()
    if source.startswith("data:"):
        _, _, payload = source.partition(",")
        try:
            data = base64.b64decode(payload, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise VidsProtocolError(f"invalid reference image data URL: {exc}") from exc
        if len(data) < 100:
            raise VidsProtocolError("reference image data URL too small")
        return data
    if source.startswith(("http://", "https://")):
        origin = os.getenv("GEMINIVIDS_REFERENCE_ASSET_ORIGIN", "").strip()
        query = parse_qs(urlsplit(source).query)
        if origin and query.get("purpose") == ["provider-read"] and query.get("signature"):
            parsed = urlsplit(source)
            override = urlsplit(origin)
            if override.scheme not in {"http", "https"} or not override.netloc:
                raise VidsProtocolError("GEMINIVIDS_REFERENCE_ASSET_ORIGIN invalid")
            source = urlunsplit((override.scheme, override.netloc, parsed.path,
                                 parsed.query, parsed.fragment))
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        request = urllib.request.Request(source, headers={"user-agent": "geminivids-sidecar/1.0"})
        try:
            with opener.open(request, timeout=120) as response:
                data = response.read()
        except Exception as exc:
            raise VidsProtocolError(f"reference image download failed: {exc}") from exc
        if len(data) < 100:
            raise VidsProtocolError(f"reference image download returned len={len(data)}")
        return data
    raise VidsProtocolError("reference image must be a data: or http(s):// URL")


class VideoService:
    def __init__(self, accounts: AccountStore, tasks: TaskStore):
        self.accounts = accounts
        self.tasks = tasks
        self._cooldown: dict[str, float] = {}
        self._submit_lock = threading.Lock()

    # ---- account selection ----
    def _usable_accounts(self) -> list[str]:
        now = time.time()
        usable = []
        for meta in self.accounts.list_accounts():
            if meta.status != "active":
                continue
            if self._cooldown.get(meta.id, 0) > now:
                continue
            usable.append(meta.id)
        return usable

    def _pick_account(self, exclude: set[str] | None = None) -> tuple[str, str]:
        """返回 (account_id, doc_id)。doc id 服务端不校验，缺省时按账号生成稳定值。"""
        import secrets

        exclude = exclude or set()
        active = self.accounts.get_active_account()
        candidates = [m for m in self._usable_accounts() if m not in exclude]
        if not candidates:
            raise VidsProtocolError("no usable geminivids account (all cooling/invalid)")
        metas = {m.id: m for m in self.accounts.list_accounts()}
        if active and active.id in candidates:
            chosen = active.id
        else:
            chosen = sorted(candidates)[0]
        meta = metas[chosen]
        doc_id = meta.vids_doc_id or settings.default_doc_id
        if not doc_id:
            doc_id = "1" + secrets.token_hex(16)
            try:
                self.accounts.update_account(chosen, vids_doc_id=doc_id)
            except KeyError:
                pass
        return chosen, doc_id

    def _mark_failure(self, account_id: str, error: str, rotate: bool) -> None:
        try:
            if rotate:
                self._cooldown[account_id] = time.time() + settings.cooldown_seconds
            self.accounts.update_account(account_id, last_error=error[:500],
                                         status="invalid" if "auth" in error.lower() or "401" in error else None)
        except KeyError:
            pass

    # ---- task execution ----
    def submit(self, prompt: str, aspect_ratio: str, resolution: str,
               duration_seconds: int, reference_images: list[str] | None = None) -> dict[str, Any]:
        for source in reference_images or []:
            if not str(source).startswith(("data:", "http://", "https://")):
                raise VidsProtocolError("reference image must be a data: or http(s):// URL")
        slots = build_param_slots(aspect_ratio, resolution, duration_seconds)
        task = self.tasks.create(prompt, aspect_ratio, resolution,
                                 duration_seconds, param_slots=slots,
                                 reference_images=reference_images or None)
        thread = threading.Thread(target=self._execute, args=(task.id,), daemon=True)
        thread.start()
        return self._task_view(task)

    def _execute(self, task_id: str) -> None:
        task = self.tasks.get(task_id)
        if not task:
            return
        tried: set[str] = set()
        last_error = ""
        while True:
            try:
                account_id, doc_id = self._pick_account(exclude=tried)
            except VidsProtocolError as exc:
                self.tasks.update(task_id, lambda t: (
                    setattr(t, "status", "failed"),
                    setattr(t, "error", last_error or str(exc)),
                    setattr(t, "finished_at", time.time()),
                ))
                return
            tried.add(account_id)
            self.tasks.update(task_id, lambda t: setattr(t, "account_id", account_id))
            try:
                state = self.accounts.load_storage_state(account_id)
                client = VidsProtocolClient(
                    state, proxy=settings.proxy_url,
                    timeout=settings.generate_timeout_seconds)
                materials: list[VidsMaterial] | None = None
                if task.reference_images:
                    materials = []
                    for index, source in enumerate(task.reference_images, start=1):
                        blob = _fetch_reference_image(source)
                        token = client.upload_material(blob)
                        materials.append(VidsMaterial(token=token, name=f"图片 {index}"))
                self.tasks.update(task_id, lambda t: setattr(t, "started_at", time.time()))
                self.accounts.update_account(account_id, mark_used=True)
                result = client.generate(
                    doc_id, task.prompt,
                    duration_seconds=task.duration_seconds,
                    param_slots=task.param_slots or None,
                    materials=materials,
                )
                media = client.download(result.media_url,
                                        timeout=settings.download_timeout_seconds)
                media_path = self.tasks.new_media_path(task_id)
                media_path.write_bytes(media)

                def apply(t) -> None:
                    t.status = "succeeded"
                    t.result_width = result.width
                    t.result_height = result.height
                    t.result_duration = result.duration_seconds
                    t.storage_key = result.storage_key
                    t.upstream_url = result.media_url[:500]
                    t.media_path = str(media_path)
                    t.media_size = len(media)
                    t.finished_at = time.time()
                    t.elapsed_seconds = round(t.finished_at - t.created_at, 1)

                self.tasks.update(task_id, apply)
                return
            except VidsProtocolError as exc:
                last_error = str(exc)
                rotate = getattr(exc, "status", None) in _ROTATE_STATUSES
                self._mark_failure(account_id, last_error, rotate)
                if not rotate:
                    break
            except Exception as exc:  # noqa: BLE001 - worker must never die silently
                last_error = f"unexpected: {exc}"
                traceback.print_exc()
                break
        self.tasks.update(task_id, lambda t: (
            setattr(t, "status", "failed"),
            setattr(t, "error", last_error[:500]),
            setattr(t, "finished_at", time.time()),
            setattr(t, "elapsed_seconds", round(time.time() - t.created_at, 1)),
        ))

    # ---- views ----
    def _task_view(self, task) -> dict[str, Any]:
        view: dict[str, Any] = {
            "id": task.id,
            "prompt": task.prompt,
            "aspect_ratio": task.aspect_ratio,
            "resolution": task.resolution,
            "duration_seconds": task.duration_seconds,
            "status": task.status,
            "account_id": task.account_id,
            "created_at": task.created_at,
            "elapsed_seconds": task.elapsed_seconds,
            "reference_images": len(task.reference_images) if task.reference_images else 0,
        }
        if task.status == "succeeded":
            view.update({
                "video_url": f"/v1/videos/{task.id}/content",
                "width": task.result_width,
                "height": task.result_height,
                "duration": task.result_duration,
                "file_size": task.media_size,
            })
        elif task.status == "failed":
            view["error"] = task.error
        return view

    def task_view(self, task_id: str) -> dict[str, Any] | None:
        task = self.tasks.get(task_id)
        return self._task_view(task) if task else None
