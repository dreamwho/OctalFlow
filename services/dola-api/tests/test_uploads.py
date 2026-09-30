import base64
import asyncio

import pytest

from dola_api.uploads import _fetch_source_bytes, _imagex_upload_proxy, _prepare_upload, _reference_fetch_route, _sign_imagex_request, resolve_references, upload_reference


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


def test_invalid_imagex_egress_is_rejected(monkeypatch) -> None:
    monkeypatch.setenv("DOLA_IMAGEX_UPLOAD_EGRESS", "unknown")
    with pytest.raises(RuntimeError, match="imagex_upload_egress_invalid"):
        _imagex_upload_proxy("http://127.0.0.1:17893")


def test_explicit_imagex_egress_overrides_browser_and_legacy_default(monkeypatch) -> None:
    monkeypatch.setenv("DOLA_IMAGEX_UPLOAD_EGRESS", "proxy")
    assert _imagex_upload_proxy("http://127.0.0.1:17893", "direct") is None
    assert _imagex_upload_proxy("http://127.0.0.1:17894", "managed") == "http://127.0.0.1:17894"
    with pytest.raises(RuntimeError, match="imagex_upload_proxy_unavailable"):
        _imagex_upload_proxy(None, "managed")


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


@pytest.mark.anyio
async def test_signed_reference_reads_internal_origin_without_paid_proxy(monkeypatch) -> None:
    async def serve(_reader, writer):
        await _reader.read(4096)
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 4\r\n\r\ntest")
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(serve, "127.0.0.1", 0)
    try:
        port = server.sockets[0].getsockname()[1]
        monkeypatch.setenv("DOLA_REFERENCE_ASSET_ORIGIN", f"http://127.0.0.1:{port}")
        source = "https://site.example/api/reference-assets/permanent/image.png?purpose=provider-read&expires=1234567890&signature=test"
        content, mime, name = await _fetch_source_bytes(source, "http://127.0.0.1:1")
        assert (content, mime, name) == (b"test", "image/png", "image.png")
        assert _reference_fetch_route("https://cdn.example/image.png", "http://127.0.0.1:1") == ("https://cdn.example/image.png", "http://127.0.0.1:1")
    finally:
        server.close()
        await server.wait_closed()


@pytest.mark.anyio
async def test_reference_failure_identifies_image_position(monkeypatch) -> None:
    async def fail_on_second(_page, item, _proxy, _imagex_mode, _imagex_url):
        if item["name"] == "second":
            raise RuntimeError("imagex_apply_ConnectError")
        return {"uri": "imagex://first"}

    monkeypatch.setattr("dola_api.uploads.upload_reference", fail_on_second)
    with pytest.raises(RuntimeError, match="reference_2_of_2: imagex_apply_ConnectError"):
        await resolve_references(None, [{"name": "first"}, {"name": "second"}], "http://127.0.0.1:1")


@pytest.mark.anyio
@pytest.mark.parametrize("egress,mode,upload_proxy,expected_proxy", [
    ("direct", None, None, None),
    ("proxy", None, None, "http://127.0.0.1:17893"),
    ("proxy", "direct", None, None),
    ("direct", "managed", "http://127.0.0.1:17894", "http://127.0.0.1:17894"),
    ("direct", "managed", "http://generic.test:8080", "http://generic.test:8080"),
])
async def test_imagex_transfer_egress_is_independent_of_browser_proxy(monkeypatch, egress, mode, upload_proxy, expected_proxy) -> None:
    import dola_api.uploads as uploads

    monkeypatch.setenv("DOLA_IMAGEX_UPLOAD_EGRESS", egress)
    clients = []
    calls = []

    class Response:
        status_code = 200

        def __init__(self, body):
            self.body = body

        def json(self):
            return self.body

    class Client:
        def __init__(self, **options):
            clients.append(options)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, **_options):
            calls.append(url)
            return Response({"Result": {"UploadAddress": {"StoreInfos": [{"StoreUri": "image.png", "Auth": "upload-auth"}], "UploadHosts": ["upload.example"], "SessionKey": "session-key"}}})

        async def post(self, url, **_options):
            calls.append(url)
            return Response({"code": 2000} if "upload/v1" in url else {"Result": {"Results": [{"Uri": "imagex://stored"}]}})

    monkeypatch.setattr(uploads.httpx, "AsyncClient", Client)
    page = FakePage({"ok": True, "status": 200, "json": {"code": 0, "data": {"service_id": "svc", "upload_host": "imagex.example", "upload_auth_token": {"access_key": "ak", "secret_key": "secret", "session_token": "token"}}}})
    result = await upload_reference(page, {"dataUrl": "data:image/png;base64,dGVzdA=="}, "http://127.0.0.1:17893", mode, upload_proxy)
    assert result["uri"] == "imagex://stored"
    assert len(clients) == 1
    assert clients[0].get("proxy") == expected_proxy
    assert clients[0]["trust_env"] is False
    assert len(calls) == 3
    assert calls[0].startswith("https://imagex.example/")
    assert calls[1] == "https://upload.example/upload/v1/image.png"
    assert calls[2].startswith("https://imagex.example/")
