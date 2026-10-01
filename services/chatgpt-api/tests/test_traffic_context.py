import base64
import json

import pytest
from types import SimpleNamespace
from starlette.requests import Request

from services.traffic_context import (
    TrafficContextError,
    context_for_call,
    create_traffic_lease_sync,
    decode_traffic_context,
)


def encoded_context(value: dict[str, str]) -> str:
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")


def test_decodes_server_owned_context_without_credentials():
    context = decode_traffic_context(encoded_context({
        "channelId": "gpt-channel",
        "channelName": "GPT",
        "model": "gpt-image-1",
        "protocol": "chatgpt-api",
        "connectionMode": "magic",
        "role": "submit",
        "attributionScope": "exact",
        "access_token": "must-not-be-retained",
    }))

    assert context == {
        "channelId": "gpt-channel",
        "channelName": "GPT",
        "model": "gpt-image-1",
        "protocol": "chatgpt-api",
        "connectionMode": "magic",
        "role": "submit",
        "attributionScope": "exact",
    }


def test_decodes_and_preserves_request_task_and_attempt_ids():
    context = decode_traffic_context(encoded_context({
        "channelId": "gpt-channel",
        "channelName": "GPT",
        "model": "gpt-image-1",
        "protocol": "chatgpt-api",
        "connectionMode": "direct",
        "role": "submit",
        "attributionScope": "exact",
        "requestId": "gateway-request-1",
        "taskId": "generation-task-1",
        "attemptId": "attempt-2",
    }))

    assert context is not None
    assert context["requestId"] == "gateway-request-1"
    assert context["taskId"] == "generation-task-1"
    assert context["attemptId"] == "attempt-2"


def test_rejects_malformed_context():
    with pytest.raises(TrafficContextError):
        decode_traffic_context("not-base64")


def test_falls_back_to_unattributed_model_and_passthrough_without_meter(monkeypatch):
    monkeypatch.delenv("DREAMYO_TRAFFIC_METER_URL", raising=False)

    assert context_for_call(protocol="chatgpt-api")["model"] == "__unattributed__"
    assert create_traffic_lease_sync(None, context_for_call()) is None


def test_explicit_profile_connection_mode_overrides_inherited_request_mode():
    from services.traffic_context import bind_traffic_context

    with bind_traffic_context({
        "channelId": "gpt-channel",
        "channelName": "GPT",
        "model": "gpt-image-1",
        "protocol": "chatgpt-api",
        "connectionMode": "magic",
        "role": "submit",
        "attributionScope": "exact",
    }):
        context = context_for_call(connection_mode="direct")

    assert context["channelId"] == "gpt-channel"
    assert context["model"] == "gpt-image-1"
    assert context["connectionMode"] == "direct"


def test_call_id_replaces_gateway_request_id_but_keeps_task_and_attempt_ids():
    from services.traffic_context import bind_traffic_context

    with bind_traffic_context({
        "channelId": "gpt-channel",
        "channelName": "GPT",
        "model": "gpt-image-1",
        "protocol": "chatgpt-api",
        "connectionMode": "direct",
        "role": "submit",
        "attributionScope": "exact",
        "requestId": "gateway-request-1",
        "taskId": "generation-task-1",
        "attemptId": "attempt-2",
    }):
        context = context_for_call(model="gpt-image-1", request_id="call-log-1")

    assert context["requestId"] == "call-log-1"
    assert context["taskId"] == "generation-task-1"
    assert context["attemptId"] == "attempt-2"


def test_shared_scope_drops_request_level_identifiers():
    from services.traffic_context import bind_traffic_context

    with bind_traffic_context({
        "channelId": "shared",
        "channelName": "Shared",
        "model": "__shared_browser__",
        "protocol": "geminiai",
        "connectionMode": "unknown",
        "role": "provider",
        "attributionScope": "shared_browser",
        "requestId": "request-1",
        "taskId": "task-1",
        "attemptId": "attempt-1",
    }):
        context = context_for_call(request_id="call-1")

    assert all(key not in context for key in ("requestId", "taskId", "attemptId"))


def test_maps_provider_proxy_sources_to_meter_connection_modes():
    from services.traffic_context import connection_mode_for_profile

    assert connection_mode_for_profile(SimpleNamespace(proxy_source="magic_upload", proxy_url="http://proxy")) == "magic"
    assert connection_mode_for_profile(SimpleNamespace(proxy_source="chained_group", proxy_url="http://proxy")) == "chained"
    assert connection_mode_for_profile(SimpleNamespace(proxy_source="generic_node", proxy_url="http://proxy")) == "generic"


def test_codex_stream_parser_accepts_curl_response_lines():
    from services.openai_backend_api import OpenAIBackendAPI

    class CurlResponse:
        headers = {"content-type": "text/event-stream"}
        status_code = 200

        def iter_lines(self):
            yield b'data: {"type":"response.completed"}'
            yield b""
            yield b"data: [DONE]"

        def close(self):
            return None

    assert list(OpenAIBackendAPI._iter_codex_response_events(CurlResponse())) == [{"type": "response.completed"}]


def test_internal_dispatch_trust_uses_runtime_key_without_overwriting_provider_auth():
    from api.app import _is_trusted_internal_dispatch

    def request(headers: dict[str, str]) -> Request:
        return Request({
            "type": "http",
            "method": "POST",
            "path": "/v1/chat/completions",
            "query_string": b"",
            "headers": [(key.lower().encode(), value.encode()) for key, value in headers.items()],
        })

    assert _is_trusted_internal_dispatch(request({
        "x-dreamyo-internal-dispatch": "1",
        "x-dreamyo-runtime-key": "runtime-key",
        "authorization": "Bearer user-key",
    }), "runtime-key")
    assert not _is_trusted_internal_dispatch(request({
        "x-dreamyo-internal-dispatch": "1",
        "x-dreamyo-runtime-key": "wrong-key",
        "authorization": "Bearer runtime-key",
    }), "runtime-key")
