from __future__ import annotations

import time
from typing import Literal, cast

from services.account_processing import account_processing_slot
from services.account_service import account_service
from services.image_failure import ImageGenerationError
from services.log_service import current_call_id
from services.openai_backend_api import OpenAIBackendAPI
from services.protocol.conversation import (
    ConversationRequest,
    collect_image_outputs,
    conversation_events,
    stream_codex_image_outputs,
    stream_image_outputs,
)
from utils.diagnostics import sanitize_diagnostic_text
from utils.helper import build_chat_image_markdown_content, is_codex_image_model


def _account_label(account: dict[str, object], account_id: str) -> str:
    return str(account.get("email") or account.get("name") or account_id).strip()


def _base_result(
    *,
    account_id: str,
    account_label: str,
    mode: Literal["chat", "image"],
    model: str,
    duration_ms: int,
) -> dict[str, object]:
    return {
        "account_id": account_id,
        "account_label": account_label,
        "mode": mode,
        "mode_label": "对话" if mode == "chat" else "画图",
        "model": model,
        "duration_ms": max(0, duration_ms),
    }


def _quota_label(account: dict[str, object]) -> str:
    if account_service.is_unlimited_image_quota_account(account):
        return "无限"
    if bool(account.get("image_quota_unknown")):
        return "未知"
    return str(max(0, int(account.get("quota") or 0)))


def _account_disabled(account: dict[str, object]) -> bool:
    status = str(account.get("status") or "").strip().lower()
    return (
        account_service._bool_value(account.get("auto_disabled"), False)
        or (
            account.get("enabled") is not None
            and not account_service._bool_value(account.get("enabled"), True)
        )
        or status in {"禁用", "disabled"}
    )


def _upstream_error_event(event: object) -> tuple[str, str] | None:
    if not isinstance(event, dict):
        return None
    candidates = [event, event.get("raw")]
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        error = candidate.get("error")
        raw_type = str(candidate.get("type") or "").strip().lower()
        if raw_type.endswith("error") or isinstance(error, dict):
            detail = error if isinstance(error, dict) else candidate
            code = str(detail.get("code") or detail.get("failure_code") or "upstream_error")
            message = str(detail.get("message") or "上游请求失败")
            return code, message
    return None


def _safe_error_message(error: object, account: dict[str, object]) -> str:
    return sanitize_diagnostic_text(
        error,
        sensitive_values=(
            account.get("access_token"),
            account.get("refresh_token"),
            account.get("id_token"),
        ),
        proxy_values=(account.get("proxy"),),
    ).strip() or "账号测试失败"


def _safe_error_code(error_code: object, account: dict[str, object]) -> str:
    return sanitize_diagnostic_text(
        error_code,
        sensitive_values=(
            account.get("access_token"),
            account.get("refresh_token"),
            account.get("id_token"),
        ),
        proxy_values=(account.get("proxy"),),
    ).strip() or "account_test_failed"


class AccountTestUpstreamError(RuntimeError):
    def __init__(self, error_code: str, message: str, conversation_id: str = "") -> None:
        super().__init__(message)
        self.error_code = error_code
        self.conversation_id = conversation_id


class AccountTestService:
    """Execute one upstream capability test against one selected account."""

    def execute(
        self,
        payload: dict[str, object],
    ) -> dict[str, object]:
        account_id = str(payload.get("account_id") or "").strip()
        mode = cast(
            Literal["chat", "image"],
            str(payload.get("mode") or "chat").strip(),
        )
        model = str(payload.get("model") or "").strip()
        prompt = str(payload.get("prompt") or "").strip()
        call_id = str(payload.get("_call_id") or current_call_id() or "").strip()
        trace_image_perf = bool(payload.get("_trace_image_perf"))
        started = time.perf_counter()
        account = account_service.get_account_by_id(account_id)
        if account is None:
            raise LookupError("account not found")

        if _account_disabled(account):
            return self._failed_result(
                account_id=account_id,
                account_label=_account_label(account, account_id),
                mode=mode,
                model=model,
                started=started,
                call_id=call_id,
                quota_label=_quota_label(account),
                error_code="account_disabled",
                error_message="账号已禁用",
            )

        label = _account_label(account, account_id)
        quota_before_label = _quota_label(account)
        quota_after_label = quota_before_label
        quota_deducted = False
        conversation_id = ""
        try:
            if mode == "image":
                images, updated_account, conversation_id = self._execute_image(
                    account,
                    model=model,
                    prompt=prompt,
                    call_id=call_id,
                    trace_image_perf=trace_image_perf,
                )
                content = build_chat_image_markdown_content({
                    "data": [{"url": image} for image in images],
                })
                quota_after_label = _quota_label(updated_account)
                quota_deducted = (
                    quota_before_label.isdigit()
                    and quota_after_label.isdigit()
                    and int(quota_after_label) < int(quota_before_label)
                )
            else:
                content, conversation_id = self._execute_chat(account, model=model, prompt=prompt)
                images = []
        except Exception as exc:
            duration_ms = int((time.perf_counter() - started) * 1000)
            message = _safe_error_message(exc, account)
            structured_failure = getattr(exc, "failure", None)
            if isinstance(exc, ImageGenerationError) and structured_failure is not None:
                error_code = _safe_error_code(structured_failure.code, account)
            else:
                error_code = _safe_error_code(getattr(exc, "error_code", ""), account)
            return {
                **_base_result(
                    account_id=account_id,
                    account_label=label,
                    mode=mode,
                    model=model,
                    duration_ms=duration_ms,
                ),
                "status": "failed",
                "status_label": "测试失败",
                "tone": "danger",
                "content": "",
                "image_urls": [],
                "call_id": call_id,
                "quota_before_label": quota_before_label,
                "quota_after_label": quota_before_label,
                "quota_deducted": False,
                "error_code": error_code,
                "error_message": message,
                "_call_status": "failed",
                "_call_error": message,
                "_account_email": label,
                "_conversation_id": str(getattr(exc, "conversation_id", "") or ""),
            }

        duration_ms = int((time.perf_counter() - started) * 1000)
        return {
            **_base_result(
                account_id=account_id,
                account_label=label,
                mode=mode,
                model=model,
                duration_ms=duration_ms,
            ),
            "status": "success",
            "status_label": "测试通过",
            "tone": "success",
            "content": content,
            "image_urls": images,
            "call_id": call_id,
            "quota_before_label": quota_before_label,
            "quota_after_label": quota_after_label,
            "quota_deducted": quota_deducted,
            "error_code": "",
            "error_message": "",
            "_account_email": label,
            "_conversation_id": conversation_id,
        }

    @staticmethod
    def _failed_result(
        *, account_id: str, account_label: str, mode: Literal["chat", "image"],
        model: str, started: float, call_id: str, quota_label: str,
        error_code: str, error_message: str,
    ) -> dict[str, object]:
        return {
            **_base_result(
                account_id=account_id,
                account_label=account_label,
                mode=mode,
                model=model,
                duration_ms=int((time.perf_counter() - started) * 1000),
            ),
            "status": "failed",
            "status_label": "测试失败",
            "tone": "danger",
            "content": "",
            "image_urls": [],
            "call_id": call_id,
            "quota_before_label": quota_label,
            "quota_after_label": quota_label,
            "quota_deducted": False,
            "error_code": error_code,
            "error_message": _safe_error_message(error_message, {}),
            "_call_status": "failed",
            "_call_error": _safe_error_message(error_message, {}),
            "_account_email": account_label,
        }

    @staticmethod
    def _execute_chat(account: dict[str, object], *, model: str, prompt: str) -> tuple[str, str]:
        access_token = str(account.get("access_token") or "").strip()
        active_token = account_service.ensure_access_token(
            access_token,
            event="account_test_chat",
            raise_on_error=True,
        )
        backend: OpenAIBackendAPI | None = None
        with account_processing_slot():
            try:
                backend = OpenAIBackendAPI(access_token=active_token)
                parts: list[str] = []
                conversation_id = ""
                for event in conversation_events(
                    backend,
                    model=model,
                    prompt=prompt,
                ):
                    conversation_id = str(event.get("conversation_id") or conversation_id)
                    upstream_error = _upstream_error_event(event)
                    if upstream_error is not None:
                        code, message = upstream_error
                        raise AccountTestUpstreamError(code, message, conversation_id)
                    if event.get("type") == "conversation.delta":
                        parts.append(str(event.get("delta") or ""))
                text = "".join(parts).strip()
            finally:
                if backend is not None:
                    backend.close()
        account_service.mark_text_used(active_token)
        if not text:
            raise AccountTestUpstreamError(
                "empty_upstream_response", "上游未返回文本内容", conversation_id
            )
        return text, conversation_id

    @staticmethod
    def _execute_image(
        account: dict[str, object],
        *,
        model: str,
        prompt: str,
        call_id: str,
        trace_image_perf: bool,
    ) -> tuple[list[str], dict[str, object], str]:
        access_token = str(account.get("access_token") or "").strip()
        active_token = account_service.ensure_access_token(
            access_token,
            event="account_test_image",
            raise_on_error=True,
            image_scope=True,
        )
        backend: OpenAIBackendAPI | None = None
        with account_processing_slot():
            try:
                backend = OpenAIBackendAPI(access_token=active_token, reserve_image_egress=True)
                request = ConversationRequest(
                    model=model,
                    prompt=prompt,
                    response_format="b64_json",
                    call_id=call_id,
                    trace_image_perf=trace_image_perf,
                )
                stream = (
                    stream_codex_image_outputs
                    if is_codex_image_model(model)
                    else stream_image_outputs
                )
                result = collect_image_outputs(stream(backend, request))
            finally:
                if backend is not None:
                    backend.close()

        images = [
            str(item).strip()
            for item in result.get("_image_urls", [])
            if str(item).strip()
        ]
        if not images:
            for item in result.get("data", []):
                if not isinstance(item, dict):
                    continue
                url = str(item.get("url") or "").strip()
                if url:
                    images.append(url)
                    continue
                encoded = str(item.get("b64_json") or "").strip()
                if encoded:
                    images.append(f"data:image/png;base64,{encoded}")
        if not images:
            raise RuntimeError("上游没有返回图片")

        updated = account_service.mark_image_result(active_token, True)
        if updated is None:
            raise RuntimeError("图片已生成，但账号额度更新失败")
        return list(dict.fromkeys(images)), updated, str(result.get("conversation_id") or "")


account_test_service = AccountTestService()
