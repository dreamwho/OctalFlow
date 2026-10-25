import asyncio
import base64
import binascii
import json
from urllib.parse import urlsplit, parse_qs

import httpx
import pytest

from dola_api.uploads import _prepare_upload_body, _reference_kind, _upload_media_reference
from dola_api.contracts import VideoRequest
from dola_api.protocol import PROFILES
from dola_api.session import _build_request_body, _normalize_request_references


@pytest.mark.anyio
@pytest.mark.parametrize('kind', ['audio', 'video'])
async def test_vod_tcp_upload_retains_actual_media_type(kind):
    content = b'fixed-synthetic-media-fixture'
    requests = []

    async def serve(reader, writer):
        raw = await reader.readuntil(b'\r\n\r\n')
        lines = raw.decode().split('\r\n')
        method, target, _ = lines[0].split(' ', 2)
        headers = dict(line.split(': ', 1) for line in lines[1:] if ': ' in line)
        body = await reader.readexactly(int(headers.get('Content-Length', '0')))
        requests.append((method, target, headers, body))
        action = parse_qs(urlsplit(target).query).get('Action', [''])[0]
        if action == 'ApplyUploadInner':
            assert parse_qs(urlsplit(target).query)['FileType'] == ['video']
            assert '/us-east-1/vod/aws4_request' in headers['Authorization']
            result = {'Result': {'InnerUploadAddress': {'UploadNodes': [{'StoreInfos': [{'StoreUri': 'fixture-media', 'Auth': 'fixed-upload-auth', 'UploadID': 'upload-id'}], 'UploadHost': 'upload.fixture', 'SessionKey': 'session-key'}]}}}
        elif action == 'CommitUploadInner':
            assert json.loads(body) == {'SessionKey': 'session-key', 'Functions': []}
            result = {'Result': {'Results': [{'Vid': 'fixture-vid', 'VideoMeta': {'FileType': kind, 'Duration': 2, 'Size': len(content)}}]}}
        else:
            assert body == content
            assert headers['Content-CRC32'] == f'{binascii.crc32(content) & 0xffffffff:08x}'
            assert headers['Authorization'] == 'fixed-upload-auth'
            result = {'code': 2000}
        data = json.dumps(result).encode()
        writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ' + str(len(data)).encode() + b'\r\n\r\n' + data)
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(serve, '127.0.0.1', 0)
    port = server.sockets[0].getsockname()[1]
    async with httpx.AsyncClient(trust_env=False) as tcp:
        class FixtureClient:
            async def get(self, url, **kwargs):
                return await tcp.get(f'http://127.0.0.1:{port}/?{urlsplit(url).query}', **kwargs)

            async def post(self, url, **kwargs):
                parsed = urlsplit(url)
                return await tcp.post(f'http://127.0.0.1:{port}{parsed.path}?{parsed.query}', **kwargs)

        try:
            result = await _upload_media_reference(FixtureClient(), content, f'{kind}/fixture', 'reference.fixture', {'service_id': 'fixture-space', 'upload_host': 'vod.fixture', 'upload_auth_token': {'access_key': 'fixed-key', 'secret_key': 'fixed-secret', 'session_token': 'fixed-token'}}, kind)
        finally:
            server.close()
            await server.wait_closed()
    assert result['type'] == kind and result['vid'] == 'fixture-vid' and result['duration'] == 2
    assert len(requests) == 3
    attachment = _build_request_body(PROFILES['dola-seedance-2-5'], VideoRequest(model='dola-seedance-2-5', prompt='参考音视频', duration=30), [result])['messages'][0]['content_block'][0]['content']['attachment_block']['attachments'][0]
    assert attachment['type'] == 3
    assert 'image' not in attachment
    assert attachment['media'] == {'vid': 'fixture-vid', 'media_type': 1 if kind == 'audio' else 2, 'duration': 2.0, 'size': len(content), 'name': 'reference.fixture'}


def test_native_media_credential_scenes_and_type_validation():
    assert _prepare_upload_body('video') == {'tenant_id': '3', 'scene_id': '46', 'resource_type': 4}
    assert _prepare_upload_body('audio') == {'tenant_id': '3', 'scene_id': '47', 'resource_type': 4}
    assert _reference_kind({'dataUrl': 'data:audio/mpeg;base64,' + base64.b64encode(b'test').decode()}) == 'audio'
    with pytest.raises(RuntimeError, match='reference_type_mismatch'):
        _reference_kind({'type': 'image', 'mime': 'audio/mpeg'})
    with pytest.raises(ValueError, match='requires_seedance_2_5'):
        _normalize_request_references(VideoRequest(model='dola-seedance-2-0-fast', prompt='test', duration=5, references=[{'type': 'audio', 'url': 'https://fixture/reference.mp3'}]))


@pytest.mark.anyio
async def test_vod_http_200_business_error_never_becomes_upload_success():
    class RejectedClient:
        async def get(self, *_args, **_kwargs):
            return httpx.Response(200, json={'ResponseMetadata': {'Error': {'Code': 'InvalidAuthorization', 'Message': 'private server details'}}})
    with pytest.raises(RuntimeError, match='vod_apply_rejected_InvalidAuthorization'):
        await _upload_media_reference(RejectedClient(), b'test', 'audio/mpeg', 'test.mp3', {'service_id': 'space', 'upload_host': 'vod.fixture', 'upload_auth_token': {'access_key': 'fixed-key', 'secret_key': 'fixed-secret', 'session_token': 'fixed-token'}}, 'audio')
