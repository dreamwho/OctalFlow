"""Shared helpers for API service handlers."""

from __future__ import annotations

import base64
import logging
import mimetypes
import time
from contextlib import asynccontextmanager
from contextvars import ContextVar
from typing import Any

from fastapi import HTTPException

from aistudio_api.api.response_models import (
    HealthResponse,
    ImageGenerationResponse,
    ImageResponseData,
    ModelStatsResponse,
    StatsResponse,
    StatsTotalsResponse,
)
from aistudio_api.api.state import runtime_state
from aistudio_api.infrastructure.gateway.client import AIStudioClient
from aistudio_api.infrastructure.gateway.wire_types import AistudioPart

logger = logging.getLogger("aistudio.server")
MAX_RETRIES = 3
_current_request_account: ContextVar[tuple[str, str | None] | None] = ContextVar("aistudio_request_account", default=None)


def current_request_account() -> tuple[str, str | None] | None:
    return _current_request_account.get()


def _remember_request_account(account: Any) -> None:
    if account is not None and getattr(account, "id", None):
        _current_request_account.set((account.id, getattr(account, "email", None)))


def validate_image_request_options(*, size: str, n: int, aspect_ratio: str | None = None, image_size: str | None = None) -> None:
    if n != 1:
        raise HTTPException(
            400,
            detail={"message": "Only n=1 is currently supported", "type": "invalid_request_error"},
        )
    if AIStudioClient.resolve_image_size(size, aspect_ratio=aspect_ratio, image_size=image_size) is None:
        message = f"Unsupported image output '{aspect_ratio or ''}' / '{image_size or ''}'" if aspect_ratio is not None or image_size is not None else f"Unsupported image size '{size}'"
        raise HTTPException(
            400,
            detail={"message": message, "type": "invalid_request_error"},
        )


async def build_inline_image_parts(image_files: list) -> list[AistudioPart]:
    parts: list[AistudioPart] = []
    for image_file in image_files:
        mime = image_file.content_type or mimetypes.guess_type(image_file.filename or "")[0] or "image/png"
        content = await image_file.read()
        parts.append(AistudioPart(inline_data=(mime, base64.b64encode(content).decode("ascii"))))
    return parts


@asynccontextmanager
async def account_request_lock():
    """Serialize use of the shared browser while preserving admission limits.

    The sidecar has one BrowserSession, so switching its auth profile while a
    second request is capturing or replaying a request would attribute work to
    the wrong account.  Unit tests that call handlers without the app lifespan
    keep the lock unset and retain their lightweight mock behavior.
    """
    lock = runtime_state.account_request_lock
    if lock is None:
        yield
        return
    async with lock:
        yield


async def try_switch_account() -> bool:
    """尝试切换到下一个可用账号。返回是否成功切换。"""
    rotator = runtime_state.rotator
    if rotator is None:
        return False

    account_service = runtime_state.account_service
    current_account = account_service.get_active_account() if account_service else None
    next_account = await rotator.get_next_account(
        exclude_account_ids={current_account.id} if current_account else None,
    )
    if next_account is None:
        return False

    client = runtime_state.client
    if not all([account_service, client]):
        return False

    result = await account_service.activate_account(
        next_account.id,
        client._session,
        runtime_state.snapshot_cache,
        None,  # skip lock — caller already holds it
        keep_snapshot_cache=False,
    )
    if result is not None:
        _remember_request_account(result)
    return result is not None


def account_access_denied_detail(model: str) -> dict[str, str]:
    return {
        "message": (
            f"Google AI Studio 页面原生通道未能使用当前账号调用模型 {model}。"
            "这不代表 Cookie 已失效；请在对应授权 Profile 中确认该模型仍可运行后重试。"
        ),
        "type": "account_access_denied",
    }


def require_busy_lock():
    busy_lock = runtime_state.busy_lock
    if busy_lock is None:
        raise HTTPException(503, detail={"message": "Server not ready", "type": "service_unavailable"})
    # The semaphore is the provider concurrency contract.  Do not reject the
    # next admitted request merely because all permits are temporarily in use:
    # callers queue at `async with busy_lock` and retain their request identity.
    return busy_lock


async def ensure_active_account(attempt: int):
    """Select an account for the first attempt of every request.

    Retry attempts keep the account selected for that request unless the
    provider explicitly asks us to switch after a rate-limit/auth failure.
    """
    account_svc = runtime_state.account_service
    if account_svc is None:
        return None

    if attempt != 0:
        selected = account_svc.get_active_account()
        _remember_request_account(selected)
        return selected

    rotator = runtime_state.rotator
    client = runtime_state.client
    if rotator is None or client is None:
        selected = account_svc.get_active_account()
        _remember_request_account(selected)
        return selected

    next_account = await rotator.get_next_account()
    if next_account is None:
        selected = account_svc.get_active_account()
        _remember_request_account(selected)
        return selected

    current_account = account_svc.get_active_account()
    if current_account is not None and current_account.id == next_account.id:
        _remember_request_account(current_account)
        return current_account

    selected = await account_svc.activate_account(
        next_account.id,
        client._session,
        runtime_state.snapshot_cache,
        None,  # account_request_lock already protects this request
        keep_snapshot_cache=False,
    )
    selected = selected or account_svc.get_active_account()
    _remember_request_account(selected)
    return selected


def record_rotator_event(event: str, account_id: str | None = None) -> None:
    rotator = runtime_state.rotator
    account_service = runtime_state.account_service
    account = account_service.get_active_account() if account_service and account_id is None else None
    selected_id = account_id or (account.id if account else None)
    if not rotator or selected_id is None:
        return
    if event == "success":
        rotator.record_success(selected_id)
    elif event == "rate_limited":
        rotator.record_rate_limited(selected_id)
    elif event == "error":
        rotator.record_error(selected_id)


def image_response(output: Any) -> ImageGenerationResponse:
    data: list[ImageResponseData] = []
    for img in output.images:
        b64 = base64.b64encode(img.data).decode("ascii")
        data.append(ImageResponseData(b64_json=b64, revised_prompt=output.text or ""))
    return ImageGenerationResponse(created=int(time.time()), data=data)


def health_response() -> HealthResponse:
    busy_lock = runtime_state.busy_lock
    return HealthResponse(status="ok", busy=busy_lock.locked() if busy_lock else False)


def stats_response() -> StatsResponse:
    stats = dict(runtime_state.model_stats)
    totals = StatsTotalsResponse(
        requests=sum(s["requests"] for s in stats.values()),
        success=sum(s["success"] for s in stats.values()),
        rate_limited=sum(s["rate_limited"] for s in stats.values()),
        errors=sum(s["errors"] for s in stats.values()),
        prompt_tokens=sum(s["prompt_tokens"] for s in stats.values()),
        completion_tokens=sum(s["completion_tokens"] for s in stats.values()),
        total_tokens=sum(s["total_tokens"] for s in stats.values()),
    )
    models = {name: ModelStatsResponse(**values) for name, values in stats.items()}
    return StatsResponse(models=models, totals=totals)
