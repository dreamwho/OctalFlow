import asyncio
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from aistudio_api.api.schemas import ImageRequest
from aistudio_api.application.api_service import handle_image_edit, handle_image_generation
from aistudio_api.domain.errors import AuthError


class _UnusedClient:
    async def generate_image(self, *args, **kwargs):
        raise AssertionError("generate_image should not be called for invalid requests")


def test_handle_image_generation_rejects_unsupported_n():
    req = ImageRequest(prompt="hello", n=2)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(handle_image_generation(req, _UnusedClient()))

    assert exc.value.status_code == 400
    assert exc.value.detail["type"] == "invalid_request_error"
    assert exc.value.detail["message"] == "Only n=1 is currently supported"


def test_handle_image_edit_rejects_unsupported_size():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            handle_image_edit(
                prompt="hello",
                image_files=[],
                mask_file=None,
                model="gemini-3.1-flash-image-preview",
                n=1,
                size="800x600",
                client=_UnusedClient(),
            )
        )

    assert exc.value.status_code == 400
    assert exc.value.detail["type"] == "invalid_request_error"
    assert exc.value.detail["message"] == "Unsupported image size '800x600'"


class _CaptureImageClient:
    def __init__(self):
        self.calls = []

    async def generate_image(self, *args, **kwargs):
        self.calls.append({"args": args, "kwargs": kwargs})

        class _Output:
            images = []
            text = ""
            usage = None

        return _Output()


def test_handle_image_generation_passes_split_search_flags(monkeypatch):
    from aistudio_api.application import api_service_openai

    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr(api_service_openai, "require_busy_lock", lambda: asyncio.Semaphore(1))
    monkeypatch.setattr(api_service_openai, "ensure_active_account", _noop)
    monkeypatch.setattr(api_service_openai, "record_rotator_event", lambda *args, **kwargs: None)

    client = _CaptureImageClient()
    req = ImageRequest(prompt="hello", google_search=True, image_search=True)

    asyncio.run(handle_image_generation(req, client))

    assert len(client.calls) == 1
    assert client.calls[0]["kwargs"]["google_search"] is True
    assert client.calls[0]["kwargs"]["image_search"] is True
    assert client.calls[0]["kwargs"]["use_default_tools"] is False


def test_handle_image_generation_allows_default_tools_when_search_flags_omitted(monkeypatch):
    from aistudio_api.application import api_service_openai

    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr(api_service_openai, "require_busy_lock", lambda: asyncio.Semaphore(1))
    monkeypatch.setattr(api_service_openai, "ensure_active_account", _noop)
    monkeypatch.setattr(api_service_openai, "record_rotator_event", lambda *args, **kwargs: None)

    client = _CaptureImageClient()
    req = ImageRequest(prompt="hello")

    asyncio.run(handle_image_generation(req, client))

    assert len(client.calls) == 1
    assert client.calls[0]["kwargs"]["use_default_tools"] is True


def test_handle_image_generation_passes_canvas_ratio_and_resolution(monkeypatch):
    from aistudio_api.application import api_service_openai

    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr(api_service_openai, "require_busy_lock", lambda: asyncio.Semaphore(1))
    monkeypatch.setattr(api_service_openai, "ensure_active_account", _noop)
    monkeypatch.setattr(api_service_openai, "record_rotator_event", lambda *args, **kwargs: None)

    client = _CaptureImageClient()
    req = ImageRequest(prompt="portrait", size="3840x2160", aspect_ratio="9:16", image_size="4K")

    asyncio.run(handle_image_generation(req, client))

    assert client.calls[0]["kwargs"]["aspect_ratio"] == "9:16"
    assert client.calls[0]["kwargs"]["image_size"] == "4K"


def test_image_generation_queues_after_the_provider_concurrency_contract(monkeypatch):
    from aistudio_api.api.state import runtime_state
    from aistudio_api.application import api_service_openai

    class _QueuedClient:
        def __init__(self, full: asyncio.Event, release: asyncio.Event):
            self.full = full
            self.release = release
            self.calls = 0
            self.active = 0
            self.max_active = 0

        async def generate_image(self, *args, **kwargs):
            self.calls += 1
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            if self.active == 3:
                self.full.set()
            try:
                await self.release.wait()
                return _ImageOutput()
            finally:
                self.active -= 1

    class _ImageOutput:
        images = []
        text = ""
        usage = None

    async def _noop(*args, **kwargs):
        return None

    async def scenario():
        provider_limit = asyncio.Semaphore(3)
        full = asyncio.Event()
        release = asyncio.Event()
        client = _QueuedClient(full, release)
        previous_lock = runtime_state.busy_lock
        runtime_state.busy_lock = provider_limit
        try:
            tasks = [asyncio.create_task(handle_image_generation(ImageRequest(prompt=f"frame {index}"), client)) for index in range(4)]
            await asyncio.wait_for(full.wait(), timeout=1)
            assert client.calls == 3
            assert client.max_active == 3
            assert not tasks[3].done()
            release.set()
            await asyncio.gather(*tasks)
            assert client.calls == 4
            assert client.max_active == 3
        finally:
            runtime_state.busy_lock = previous_lock

    monkeypatch.setattr(api_service_openai, "ensure_active_account", _noop)
    monkeypatch.setattr(api_service_openai, "record_rotator_event", lambda *args, **kwargs: None)
    asyncio.run(scenario())


def test_image_output_resolution_accepts_all_geminiai_supported_ratios():
    from aistudio_api.infrastructure.gateway.client import AIStudioClient

    assert AIStudioClient.resolve_image_size("", aspect_ratio="9:16", image_size="4k") == ["9:16", "4K"]
    assert AIStudioClient.resolve_image_size("", aspect_ratio="auto", image_size="2K") == [None, "2K"]
    assert AIStudioClient.resolve_image_size("", image_size="4K") == [None, "4K"]
    for ratio in ("1:1", "9:16", "16:9", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9"):
        assert AIStudioClient.resolve_image_size("", aspect_ratio=ratio, image_size="2K") == [ratio, "2K"]
    assert AIStudioClient.resolve_image_size("", aspect_ratio="7:5", image_size="4K") is None
    assert AIStudioClient.resolve_image_size("", aspect_ratio="1:1", image_size="8K") is None


def test_client_replays_captured_request_for_supported_image_model(tmp_path):
    from aistudio_api.infrastructure.gateway.client import AIStudioClient
    from aistudio_api.infrastructure.gateway.capture import CapturedRequest

    class _ReplayService:
        def __init__(self):
            self.calls = []

        async def replay(self, captured, body, timeout):
            self.calls.append({"captured": captured, "body": body, "timeout": timeout})
            raw = (Path(__file__).resolve().parents[1] / "test-image-output.json").read_bytes()
            return 200, raw

    client = AIStudioClient.__new__(AIStudioClient)
    client._replay_service = _ReplayService()

    async def _capture(*_args, **_kwargs):
        return CapturedRequest(
            url="https://example.test/generate",
            headers={},
            body=json.dumps(
                [
                    "models/gemini-3-pro-image",
                    [[[[None, "template"]], "user"]],
                    None,
                    [None] * 27,
                    "snapshot",
                    None,
                    None,
                ]
            ),
        )

    client.capture_request = _capture
    output = asyncio.run(
        client.generate_image(
            prompt="red apple",
            model="gemini-3-pro-image",
            aspect_ratio="9:16",
            image_size="4K",
            save_path=str(tmp_path / "result"),
        )
    )

    assert output.model == "gemini-3-pro-image"
    assert output.images
    assert client._replay_service.calls[0]["timeout"] == 120
    assert json.loads(client._replay_service.calls[0]["body"])[3][26] == ["9:16", "4K"]
    assert (tmp_path / "result.jpg").read_bytes() == output.images[0].data


def test_client_rejects_lite_image_model_before_browser_use():
    from aistudio_api.domain.errors import RequestError
    from aistudio_api.infrastructure.gateway.client import AIStudioClient

    client = AIStudioClient.__new__(AIStudioClient)
    with pytest.raises(RequestError, match="不支持的 GeminiAIStudio 生图模型"):
        asyncio.run(client.generate_image(prompt="red apple", model="gemini-3.1-flash-lite-image"))


def test_client_rejects_unsupported_image_search_tool_before_browser_use():
    from aistudio_api.domain.errors import RequestError
    from aistudio_api.infrastructure.gateway.client import AIStudioClient

    client = AIStudioClient.__new__(AIStudioClient)
    with pytest.raises(RequestError, match="不支持独立图片搜索工具"):
        asyncio.run(
            client.generate_image(
                prompt="red apple",
                model="gemini-3-pro-image",
                image_search=True,
            )
        )


def test_image_permission_denial_rotates_across_the_account_pool(monkeypatch):
    from aistudio_api.application import api_service_openai

    class _DeniedClient:
        def __init__(self):
            self.calls = 0

        async def generate_image(self, *args, **kwargs):
            self.calls += 1
            raise AuthError("禁止访问")

    switches = 0

    async def _noop(*args, **kwargs):
        return None

    async def _switch():
        nonlocal switches
        switches += 1
        return True

    monkeypatch.setattr(api_service_openai, "MAX_RETRIES", 3)
    monkeypatch.setattr(api_service_openai, "require_busy_lock", lambda: asyncio.Semaphore(1))
    monkeypatch.setattr(api_service_openai, "ensure_active_account", _noop)
    monkeypatch.setattr(api_service_openai, "try_switch_account", _switch)
    monkeypatch.setattr(api_service_openai, "record_rotator_event", lambda *args, **kwargs: None)

    client = _DeniedClient()
    req = ImageRequest(model="gemini-3.1-flash-image", prompt="hello")

    with pytest.raises(HTTPException) as exc:
        asyncio.run(handle_image_generation(req, client))

    assert client.calls == 3
    assert switches == 2
    assert exc.value.status_code == 403
    assert exc.value.detail["type"] == "account_access_denied"
    assert "页面原生通道未能使用当前账号" in exc.value.detail["message"]
