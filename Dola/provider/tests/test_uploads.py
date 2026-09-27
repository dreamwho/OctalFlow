import base64

import pytest

from dola_api.uploads import _fetch_source_bytes, _prepare_upload, _sign_imagex_request


class FakePage:
    def __init__(self, result):
        self.result = result

    async def evaluate(self, *_args):
        return self.result


def test_imagex_signature_contains_only_expected_signed_headers() -> None:
    headers = _sign_imagex_request(
        method="GET",
        raw_url="https://imagex.example/?Action=ApplyImageUpload&ServiceId=svc&s=abc",
        credentials={"access_key_id": "ak", "secret_access_key": "secret", "session_token": "token"},
    )
    assert headers["Authorization"].startswith("AWS4-HMAC-SHA256 Credential=ak/")
    assert "x-amz-security-token" in headers["Authorization"]
    assert headers["x-amz-security-token"] == "token"


@pytest.mark.anyio
async def test_data_url_reference_is_decoded_without_network() -> None:
    payload = b"fake-image"
    content, mime, name = await _fetch_source_bytes(f"data:image/png;base64,{base64.b64encode(payload).decode()}", None)
    assert content == payload
    assert mime == "image/png"
    assert name == "reference.png"


@pytest.mark.anyio
async def test_reference_data_url_rejects_non_base64_payload() -> None:
    with pytest.raises(RuntimeError, match="reference_data_url_invalid"):
        await _fetch_source_bytes("data:image/png,not-base64", None)


@pytest.mark.anyio
async def test_prepare_upload_preserves_upstream_business_code() -> None:
    page = FakePage({"ok": True, "status": 200, "json": {"code": 710022003}})
    with pytest.raises(RuntimeError, match="prepare_upload_rejected_710022003"):
        await _prepare_upload(page)


@pytest.mark.anyio
async def test_prepare_upload_accepts_complete_config() -> None:
    config = {"service_id": "service", "upload_auth_token": {"access_key": "key"}}
    page = FakePage({"ok": True, "status": 200, "json": {"code": 0, "data": config}})
    assert await _prepare_upload(page) == config
