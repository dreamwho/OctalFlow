import base64
import asyncio
import binascii
import json
from urllib.parse import parse_qs

import httpx
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


@pytest.mark.anyio
async def test_data_url_reference_is_decoded_without_network() -> None:
    payload = b"fake-image"
    content, mime, name = await _fetch_source_bytes(f"data:image/png;base64,{base64.b64encode(payload).decode()}", None)
    assert content == payload
    assert mime == "image/png"
    assert name == "reference.png"


@pytest.mark.anyio
async def test_jpeg_data_url_uses_jpeg_extension() -> None:
    content, mime, name = await _fetch_source_bytes("data:image/jpeg;base64,dGVzdA==", None)
    assert (content, mime, name) == (b"test", "image/jpeg", "reference.jpg")


@pytest.mark.anyio
async def test_three_reference_uploads_and_final_submission_over_local_tcp(monkeypatch) -> None:
    import dola_api.uploads as uploads
    from dola_api.contracts import VideoRequest
    from dola_api.session import prepare_browser_submission

    payloads = [b"first-png", b"second-png", bytes(range(256)) * 26747]  # Original-sized 6.8 MB JPEG transport fixture.
    received = []
    applied = []

    async def serve(reader, writer):
        try:
            head = (await reader.readuntil(b"\r\n\r\n")).decode("ascii")
            method, target, _ = head.split("\r\n", 1)[0].split(" ", 2)
            headers = dict(line.lower().split(": ", 1) for line in head.split("\r\n")[1:] if ": " in line)
            body = await reader.readexactly(int(headers.get("content-length", 0)))
            query = parse_qs(target.partition("?")[2])
            if query.get("Action") == ["ApplyImageUpload"]:
                index = len(applied)
                applied.append(query)
                result = {"Result": {"UploadAddress": {"StoreInfos": [{"StoreUri": f"reference-{index}", "Auth": "fixture-upload-auth"}], "UploadHosts": ["upload.fixture"], "SessionKey": str(index)}}}
            elif target.startswith("/upload/v1/"):
                assert method == "POST"
                assert headers["authorization"] == "fixture-upload-auth"
                assert headers["content-crc32"] == f"{binascii.crc32(body) & 0xFFFFFFFF:08x}"
                received.append(body)
                result = {"code": 2000}
            else:
                assert query["Action"] == ["CommitImageUpload"]
                index = int(json.loads(body)["SessionKey"])
                result = {"Result": {"Results": [{"Uri": f"imagex://reference-{index}"}], "PluginResult": [{"ImageWidth": 1920, "ImageHeight": 1080}]}}
            encoded = json.dumps(result).encode()
            writer.write(f"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {len(encoded)}\r\nConnection: close\r\n\r\n".encode() + encoded)
            await writer.drain()
        finally:
            writer.close()

    server = await asyncio.start_server(serve, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]

    class FixtureTransport(httpx.AsyncHTTPTransport):
        async def handle_async_request(self, request):
            request.url = request.url.copy_with(scheme="http", host="127.0.0.1", port=port)
            return await super().handle_async_request(request)

    client_class = httpx.AsyncClient
    monkeypatch.setattr(uploads.httpx, "AsyncClient", lambda **options: client_class(transport=FixtureTransport(), **options))
    config = {"service_id": "fixture-service", "upload_host": "imagex.fixture", "upload_auth_token": {"access_key": "fixture-key", "secret_key": "fixture-secret", "session_token": "fixture-token"}}
    references = []
    try:
        for index, content in enumerate(payloads):
            mime = "image/jpeg" if index == 2 else "image/png"
            request = VideoRequest(model="dola-seedance-2-5", prompt="三张图参考", duration=5, references=[{"dataUrl": f"data:{mime};base64,{base64.b64encode(content).decode()}"}])
            prepared = await prepare_browser_submission(request, config)
            references.extend(prepared["resolvedReferences"])
        final = await prepare_browser_submission(VideoRequest(model="dola-seedance-2-5", prompt="三张图参考", duration=5, references=references), None)
        assert received == payloads
        assert [item["FileExtension"] for item in applied] == [[".png"], [".png"], [".jpg"]]
        assert [int(item["FileSize"][0]) for item in applied] == [len(item) for item in payloads]
        assert final["referenceCount"] == 3 and final["body"]["option"]["need_create_conversation"] is True
        assert all(item["uri"] in str(final["body"]) for item in references)
    finally:
        server.close()
        await server.wait_closed()


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
async def test_prepare_upload_accepts_config_from_current_browser() -> None:
    config = {"service_id": "service", "upload_auth_token": {"access_key": "key"}}
    assert await _prepare_upload(None, config) == config


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
    async def fail_on_second(_page, item, _proxy, _imagex_mode, _imagex_url, _client):
        if item["name"] == "second":
            raise RuntimeError("imagex_apply_ConnectError")
        return {"uri": "imagex://first"}

    monkeypatch.setattr("dola_api.uploads.upload_reference", fail_on_second)
    with pytest.raises(RuntimeError, match="reference_2_of_2: imagex_apply_ConnectError"):
        await resolve_references(None, [{"name": "first"}, {"name": "second"}], "http://127.0.0.1:1")


def test_imagex_upload_egress_can_be_selected_independently(monkeypatch) -> None:
    monkeypatch.setenv("DOLA_IMAGEX_UPLOAD_EGRESS", "proxy")
    assert _imagex_upload_proxy("http://account.test:8080", "direct") is None
    assert _imagex_upload_proxy("http://upload.test:8080", "managed") == "http://upload.test:8080"
    with pytest.raises(RuntimeError, match="imagex_upload_proxy_unavailable"):
        _imagex_upload_proxy(None, "managed")


@pytest.mark.anyio
async def test_nine_references_reuse_one_imagex_client_and_selected_upload_route(monkeypatch) -> None:
    import dola_api.uploads as uploads

    routes = []
    calls = []

    class Response:
        status_code = 200

        def __init__(self, body):
            self.body = body

        def json(self):
            return self.body

    class Client:
        def __init__(self, **options):
            routes.append(options.get("proxy"))

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
    result = await resolve_references(page, [{"dataUrl": "data:image/png;base64,dGVzdA=="} for _ in range(9)], "http://account.test:8080", "managed", "http://upload.test:8080")
    assert len(result) == 9 and all(item["uri"] == "imagex://stored" for item in result)
    assert routes == ["http://upload.test:8080"]
    assert len(calls) == 27
    assert calls[0].startswith("https://imagex.example/")
    assert calls[1] == "https://upload.example/upload/v1/image.png"
    assert calls[2].startswith("https://imagex.example/")
