"""OAuth refresh_token 终止错误的判定：这类错误必须立刻判死账号，避免反复重放已失效的 RT。"""
from services.account_service import AccountService


def test_refresh_token_reused_is_terminal():
    # 上游对「refresh_token 已被消费」返回 401 + refresh_token_reused，属确定不可恢复。
    assert AccountService._is_terminal_refresh_error(401, "refresh_token_reused", "") is True
    assert AccountService._is_terminal_refresh_error(
        401, "", "refresh_token_reused: Your refresh token has already been used to generate a new access token."
    ) is True


def test_existing_terminal_codes_still_hold():
    for code in ("invalid_grant", "invalid_refresh_token", "refresh_token_invalidated"):
        assert AccountService._is_terminal_refresh_error(400, code, "") is True


def test_transient_errors_stay_retryable():
    # 限流、超时与服务端错误都必须保持可重试，不能误判为终止。
    assert AccountService._is_terminal_refresh_error(429, "", "") is False
    assert AccountService._is_terminal_refresh_error(408, "", "") is False
    assert AccountService._is_terminal_refresh_error(503, "", "") is False
    assert AccountService._is_terminal_refresh_error(500, "server_error", "") is False
