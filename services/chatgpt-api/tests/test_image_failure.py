from __future__ import annotations

import json

import pytest
from fastapi import HTTPException

from services.image_failure import (
    IMAGE_CONNECTION_FAILED_PUBLIC_MESSAGE,
    IMAGE_CONNECTION_TIMEOUT_PUBLIC_MESSAGE,
    IMAGE_TOOL_ERROR_PUBLIC_MESSAGE,
    ImageGenerationError,
    classify_task_failure,
    classify_image_exception,
    classify_upstream_http_error,
    classify_upstream_message,
    image_failure,
    public_image_error_message,
)
from utils.helper import UpstreamHTTPError


UPSTREAM_TOOL_ERROR = "The image generation tool encountered an error. Please try again."


def test_generic_image_tool_error_does_not_verify_or_switch_accounts() -> None:
    failure = classify_upstream_message({
        "type": "response.failed",
        "response": {"error": UPSTREAM_TOOL_ERROR},
    })

    assert failure is not None
    assert failure.code == "image_tool_error"
    assert failure.scope == "transient"
    assert failure.retryable is False
    assert failure.verify_account is False
    assert failure.switch_account is False
    assert public_image_error_message(failure) == IMAGE_TOOL_ERROR_PUBLIC_MESSAGE


def test_tool_system_error_and_image_gen_task_use_transient_tool_policy() -> None:
    message = {
        "author": {"role": "tool"},
        "content": {
            "content_type": "system_error",
            "parts": [UPSTREAM_TOOL_ERROR],
        },
    }

    direct_failure = classify_upstream_message(message)
    task_failure = classify_task_failure({"image_gen_message": message})

    for failure in (direct_failure, task_failure):
        assert failure is not None
        assert failure.code == "image_tool_error"
        assert failure.scope == "transient"
        assert failure.retryable is False
        assert failure.verify_account is False
        assert failure.switch_account is False


@pytest.mark.parametrize(
    "body",
    [
        UPSTREAM_TOOL_ERROR,
        {"error": {"message": UPSTREAM_TOOL_ERROR}},
    ],
)
def test_http_502_with_exact_generic_tool_text_uses_tool_policy(body: object) -> None:
    failure = classify_upstream_http_error(
        UpstreamHTTPError("image_generation", 502, body)
    )

    assert failure.code == "image_tool_error"
    assert failure.scope == "transient"
    assert failure.verify_account is False
    assert failure.switch_account is False


@pytest.mark.parametrize(
    "exc",
    [
        RuntimeError(f"provider returned: {UPSTREAM_TOOL_ERROR}"),
        HTTPException(status_code=502, detail={"message": UPSTREAM_TOOL_ERROR}),
        UpstreamHTTPError("image_generation", 502, UPSTREAM_TOOL_ERROR),
    ],
)
def test_unclassified_raw_generic_tool_text_uses_tool_policy(
    exc: BaseException,
) -> None:
    failure = classify_image_exception(exc)

    assert failure.code == "image_tool_error"
    assert failure.verify_account is False
    assert failure.switch_account is False


@pytest.mark.parametrize(
    "public_text",
    [
        IMAGE_CONNECTION_FAILED_PUBLIC_MESSAGE,
        IMAGE_TOOL_ERROR_PUBLIC_MESSAGE,
    ],
)
def test_existing_connection_failure_is_not_overridden_by_public_text(
    public_text: str,
) -> None:
    connection_failure = image_failure("upstream_connection_failed")
    exc = ImageGenerationError(
        public_text,
        failure=connection_failure,
        raw_upstream_message=public_text,
    )

    failure = classify_image_exception(exc)

    assert failure is connection_failure
    assert failure.code == "upstream_connection_failed"
    assert failure.retryable is True
    assert failure.verify_account is True
    assert failure.switch_account is True


def test_connection_failures_have_distinct_chinese_proxy_network_messages() -> None:
    assert "代理" in public_image_error_message(image_failure("upstream_connection_failed"))
    assert "网络" in public_image_error_message(image_failure("upstream_connection_failed"))
    assert "代理" in public_image_error_message(image_failure("upstream_connection_timeout"))
    assert "网络" in public_image_error_message(image_failure("upstream_connection_timeout"))
    assert IMAGE_CONNECTION_FAILED_PUBLIC_MESSAGE != IMAGE_TOOL_ERROR_PUBLIC_MESSAGE
    assert IMAGE_CONNECTION_TIMEOUT_PUBLIC_MESSAGE != IMAGE_TOOL_ERROR_PUBLIC_MESSAGE


def test_generic_tool_text_does_not_override_explicit_auth_failure() -> None:
    exc = ImageGenerationError(
        "server_error",
        failure=image_failure("auth_invalid"),
        raw_upstream_message=UPSTREAM_TOOL_ERROR,
    )

    failure = classify_image_exception(exc)

    assert failure.code == "auth_invalid"
    assert failure.verify_account is True
    assert failure.switch_account is True


@pytest.mark.parametrize(
    ("code", "expected_code"),
    [
        ("token_invalid", "auth_invalid"),
        ("insufficient_quota", "image_quota_exhausted"),
    ],
)
def test_wrapped_generic_text_does_not_override_explicit_auth_or_quota_code(
    code: str,
    expected_code: str,
) -> None:
    exc = HTTPException(
        status_code=502,
        detail={"code": code, "message": UPSTREAM_TOOL_ERROR},
    )

    failure = classify_image_exception(exc)

    assert failure.code == expected_code
    assert failure.verify_account is True
    assert failure.switch_account is True


@pytest.mark.parametrize(
    ("code", "expected_code"),
    [
        ("token_invalid", "auth_invalid"),
        ("insufficient_quota", "image_quota_exhausted"),
    ],
)
def test_http_exception_explicit_auth_or_quota_detail_takes_precedence(
    code: str,
    expected_code: str,
) -> None:
    failure = classify_image_exception(HTTPException(
        status_code=502,
        detail={"code": code, "message": UPSTREAM_TOOL_ERROR},
    ))

    assert failure.code == expected_code
    assert failure.verify_account is True
    assert failure.switch_account is True


def test_unrelated_connection_failure_keeps_existing_retry_and_account_policy() -> None:
    failure = classify_image_exception(ConnectionError("proxy connection reset"))

    assert failure.code == "upstream_connection_failed"
    assert failure.retryable is True
    assert failure.verify_account is True
    assert failure.switch_account is True


@pytest.mark.parametrize(
    ("code", "expected_code"),
    [
        ("auth_invalid", "auth_invalid"),
        ("insufficient_quota", "image_quota_exhausted"),
    ],
)
def test_explicit_auth_or_quota_code_takes_precedence_over_wrapped_tool_text(
    code: str,
    expected_code: str,
) -> None:
    failure = classify_image_exception(
        RuntimeError(UPSTREAM_TOOL_ERROR),
        code=code,
    )

    assert failure.code == expected_code
    assert failure.verify_account is True
    assert failure.switch_account is True


def test_explicit_connection_code_takes_precedence_over_wrapped_tool_text() -> None:
    failure = classify_image_exception(
        RuntimeError(UPSTREAM_TOOL_ERROR),
        code="upstream_connection_failed",
    )

    assert failure.code == "upstream_connection_failed"
    assert failure.verify_account is True
    assert failure.switch_account is True


@pytest.mark.parametrize(
    ("code", "expected_code"),
    [
        ("token_invalid", "auth_invalid"),
        ("insufficient_quota", "image_quota_exhausted"),
    ],
)
def test_http_502_explicit_auth_or_quota_code_takes_precedence_over_generic_text(
    code: str,
    expected_code: str,
) -> None:
    failure = classify_upstream_http_error(UpstreamHTTPError(
        "image_generation",
        502,
        {"error": {"code": code, "message": UPSTREAM_TOOL_ERROR}},
    ))

    assert failure.code == expected_code
    assert failure.verify_account is True
    assert failure.switch_account is True

    serialized_failure = classify_upstream_http_error(UpstreamHTTPError(
        "image_generation",
        502,
        json.dumps({"error": {"code": code, "message": UPSTREAM_TOOL_ERROR}}),
    ))
    assert serialized_failure.code == expected_code
    assert serialized_failure.verify_account is True
    assert serialized_failure.switch_account is True


@pytest.mark.parametrize(
    ("code", "expected_code"),
    [
        ("token_invalid", "auth_invalid"),
        ("insufficient_quota", "image_quota_exhausted"),
    ],
)
def test_confirmed_auth_and_quota_failures_keep_account_verification_and_switch(
    code: str,
    expected_code: str,
) -> None:
    failure = classify_upstream_message({
        "type": "response.failed",
        "response": {"error": {"code": code}},
    })

    assert failure is not None
    assert failure.code == expected_code
    assert failure.scope == "account"
    assert failure.verify_account is True
    assert failure.switch_account is True
