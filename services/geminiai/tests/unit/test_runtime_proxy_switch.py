from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from aistudio_api.api.routes_system import set_runtime_proxy
from aistudio_api.api.schemas import RuntimeProxyPayload
from aistudio_api.config import settings


class FakeClient:
    def __init__(self) -> None:
        self.restarts = 0

    async def restart_browser_session(self) -> None:
        self.restarts += 1


def _state(client: FakeClient) -> SimpleNamespace:
    return SimpleNamespace(client=client)


def test_runtime_proxy_switch_updates_settings_and_restarts_session() -> None:
    client = FakeClient()
    original = settings.proxy_url
    try:
        result = asyncio.run(
            set_runtime_proxy(
                RuntimeProxyPayload(proxy_url="http://user:secret@127.0.0.1:18998"),
                _state(client),
            )
        )
        assert result == {"proxy_url": "http://user:secret@127.0.0.1:18998"}
        assert settings.proxy_url == "http://user:secret@127.0.0.1:18998"
        assert client.restarts == 1
    finally:
        settings.proxy_url = original
        asyncio.run(set_runtime_proxy(RuntimeProxyPayload(proxy_url=""), _state(client)))


def test_runtime_proxy_clears_proxy_with_empty_url() -> None:
    client = FakeClient()
    original = settings.proxy_url
    try:
        settings.proxy_url = "http://127.0.0.1:18998"
        result = asyncio.run(set_runtime_proxy(RuntimeProxyPayload(proxy_url=""), _state(client)))
        assert result == {"proxy_url": ""}
        assert settings.proxy_url is None
        assert client.restarts == 1
    finally:
        settings.proxy_url = original
        asyncio.run(set_runtime_proxy(RuntimeProxyPayload(proxy_url=""), _state(client)))


def test_runtime_proxy_rejects_invalid_url_without_restart() -> None:
    client = FakeClient()
    original = settings.proxy_url
    try:
        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(set_runtime_proxy(RuntimeProxyPayload(proxy_url="not-a-url"), _state(client)))
        assert exc_info.value.status_code == 400
        assert client.restarts == 0
    finally:
        settings.proxy_url = original
