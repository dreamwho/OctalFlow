"""换号预算（rotation budget）与换号计数上下文的单元测试。"""

import pytest

from aistudio_api.application.api_service_common import (
    MAX_RETRIES,
    effective_retry_attempts,
    note_rotation,
    rotations_count,
    set_request_rotation_limit,
)


@pytest.fixture(autouse=True)
def _reset_context():
    set_request_rotation_limit(None)
    yield
    set_request_rotation_limit(None)


def test_default_budget_without_header():
    assert set_request_rotation_limit.__name__ == "set_request_rotation_limit"
    assert effective_retry_attempts() == MAX_RETRIES
    assert rotations_count() == 0


def test_budget_header_caps_attempts():
    set_request_rotation_limit("1")
    assert effective_retry_attempts() == 1

    set_request_rotation_limit("2")
    assert effective_retry_attempts() == 2

    set_request_rotation_limit("0")
    # 0/1 语义一致：只用当前账号，不切换
    assert effective_retry_attempts() == 1


def test_budget_header_cannot_exceed_hard_limit():
    set_request_rotation_limit("99")
    assert effective_retry_attempts() == MAX_RETRIES


def test_invalid_header_falls_back_to_default():
    set_request_rotation_limit("abc")
    assert effective_retry_attempts() == MAX_RETRIES


def test_rotations_counter_increments_per_switch():
    set_request_rotation_limit("3")
    note_rotation()
    note_rotation()
    assert rotations_count() == 2
    set_request_rotation_limit("2")
    assert rotations_count() == 0
