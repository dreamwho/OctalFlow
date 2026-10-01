import base64
import asyncio
import json

import pytest
from starlette.requests import Request
from starlette.responses import Response

from aistudio_api.traffic_context import (
    SHARED_ATTRIBUTION_SCOPE,
    SHARED_CHANNEL_ID,
    SHARED_CHANNEL_NAME,
    SHARED_MODEL,
    TrafficContextError,
    decode_traffic_context,
    shared_browser_context,
)


def encoded_context(value: dict[str, str]) -> str:
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")


def test_shared_browser_context_does_not_claim_request_model_or_custom_channel():
    context = shared_browser_context({
        "channelId": "custom-gemini-channel",
        "channelName": "Custom Gemini",
        "model": "gemini-2.5-pro",
        "protocol": "gemini",
        "connectionMode": "magic",
        "role": "submit",
    }, "http://proxy.example:8080")

    assert context["channelId"] == SHARED_CHANNEL_ID
    assert context["channelName"] == SHARED_CHANNEL_NAME
    assert context["model"] == SHARED_MODEL
    assert context["attributionScope"] == SHARED_ATTRIBUTION_SCOPE
    assert context["connectionMode"] == "unknown"


def test_shared_browser_context_reports_direct_or_unknown_mode():
    assert shared_browser_context()["connectionMode"] == "direct"
    assert shared_browser_context(proxy_url="http://proxy.example:8080")["connectionMode"] == "unknown"
    assert shared_browser_context({"connectionMode": "magic"})["connectionMode"] == "direct"
    assert shared_browser_context({"connectionMode": "direct"}, "http://proxy.example:8080")["connectionMode"] == "unknown"


def test_decodes_only_valid_server_context():
    value = decode_traffic_context(encoded_context({
        "channelId": "gemini-channel",
        "channelName": "Gemini",
        "model": "gemini-2.5-flash",
        "protocol": "geminiai",
        "connectionMode": "generic",
    }))
    assert value == {
        "channelId": "gemini-channel",
        "channelName": "Gemini",
        "model": "gemini-2.5-flash",
        "protocol": "geminiai",
        "connectionMode": "generic",
        "role": "provider",
        "attributionScope": "exact",
    }

    with pytest.raises(TrafficContextError):
        decode_traffic_context("invalid")


def test_persistent_browser_lease_covers_warmup_and_is_released(monkeypatch):
    import aistudio_api.infrastructure.gateway.client as client_module
    from aistudio_api.config import settings
    from aistudio_api.infrastructure.gateway.client import AIStudioClient

    events: list[object] = []

    class Lease:
        proxy_url = "http://meter-relay:19000"

        async def release(self):
            events.append("release")

    class Session:
        async def ensure_botguard_service(self):
            events.append(("warmup", settings.proxy_url))

        async def restart(self):
            events.append(("restart", settings.proxy_url))

        async def close(self):
            events.append(("close", settings.proxy_url))

    async def acquire(proxy_url, context):
        events.append(("lease", proxy_url, context["channelId"], context["model"], context["attributionScope"]))
        return Lease()

    original_proxy = settings.proxy_url
    try:
        settings.proxy_url = "http://source-proxy:8080"
        monkeypatch.setenv("DREAMYO_TRAFFIC_METER_URL", "http://meter:18083")
        monkeypatch.setattr(client_module, "acquire_traffic_lease", acquire)
        client = AIStudioClient.__new__(AIStudioClient)
        client._session = Session()
        client._traffic_lease = None
        client._traffic_source_proxy_url = settings.proxy_url
        client._traffic_leased_proxy_url = ""
        client._traffic_lease_lock = asyncio.Lock()

        asyncio.run(client.warmup())
        assert events[:2] == [
            ("lease", "http://source-proxy:8080", "geminiai/sharedchannel", "__shared_browser__", "shared_browser"),
            ("warmup", "http://meter-relay:19000"),
        ]

        asyncio.run(client.restart_browser_session())
        assert events[2:] == [
            "release",
            ("lease", "http://source-proxy:8080", "geminiai/sharedchannel", "__shared_browser__", "shared_browser"),
            ("restart", "http://meter-relay:19000"),
        ]

        asyncio.run(client.close())
        assert events[-2:] == [("close", "http://meter-relay:19000"), "release"]
        assert settings.proxy_url == "http://source-proxy:8080"
    finally:
        settings.proxy_url = original_proxy


def test_browser_control_routes_enter_the_same_ingress_guard():
    import aistudio_api.api.app as app_module
    from aistudio_api.api.state import runtime_state
    from aistudio_api.config import settings

    calls: list[dict[str, str] | None] = []

    class Client:
        async def ensure_traffic_lease(self, context):
            calls.append(context)

    def request(path: str) -> Request:
        raw = encoded_context({
            "channelId": "gemini-channel",
            "channelName": "Gemini",
            "model": "gemini-2.5-flash",
            "protocol": "geminiai",
        })
        return Request({
            "type": "http",
            "method": "POST",
            "path": path,
            "query_string": b"",
            "headers": [(b"x-dreamyo-traffic-context", raw.encode())],
            "scheme": "http",
            "server": ("test", 80),
            "client": ("test", 1),
        })

    async def call_next(_request):
        return Response("ok")

    original_client = runtime_state.client
    original_api_keys = settings.api_keys
    try:
        runtime_state.client = Client()
        settings.api_keys = frozenset()
        for path in ("/v1/chat/completions", "/accounts/account-1/activate", "/accounts/import-cookies", "/rotation/next"):
            response = asyncio.run(app_module._capture_traffic_context(request(path), call_next))
            assert response.status_code == 200
        assert len(calls) == 4
        assert all(item and item["channelId"] == "gemini-channel" for item in calls)

        response = asyncio.run(app_module._capture_traffic_context(request("/accounts/account-1"), call_next))
        assert response.status_code == 200
        assert len(calls) == 4
    finally:
        runtime_state.client = original_client
        settings.api_keys = original_api_keys
