"""PerUserQuota 模板 URL 归一化测试：AI Studio 灰度变体必须重写为网关认定的标准方法名。"""

from __future__ import annotations

from aistudio_api.infrastructure.gateway.session import _normalize_generate_method_url


def test_stream_per_user_quota_variant_is_rewritten_to_standard_method():
    url = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse&ops=StreamGenerateContentPerUserQuota"
    normalized = _normalize_generate_method_url(url)
    assert "PerUserQuota" not in normalized
    assert normalized == "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse&ops=StreamGenerateContent"


def test_non_stream_per_user_quota_variant_is_rewritten():
    url = "https://example.test/GenerativeService.GenerateContentPerUserQuota"
    assert _normalize_generate_method_url(url) == "https://example.test/GenerativeService.GenerateContent"


def test_standard_urls_are_kept_unchanged():
    url = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
    assert _normalize_generate_method_url(url) == url
