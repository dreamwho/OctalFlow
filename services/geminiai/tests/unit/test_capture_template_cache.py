import asyncio
import json

from aistudio_api.infrastructure.cache.snapshot_cache import SnapshotCache
from aistudio_api.infrastructure.gateway.capture import RequestCaptureService


class _Session:
    def __init__(self) -> None:
        self.url = "https://example.test/first"
        self.calls: list[tuple[str, bool]] = []

    async def capture_template(self, model: str, *, force_refresh: bool = False):
        self.calls.append((model, force_refresh))
        return {
            "url": self.url,
            "headers": {"content-type": "application/json"},
            "body": json.dumps(
                [
                    "models/gemma-4-31b-it",
                    [[[[None, "old"]], "user"]],
                    None,
                    [None] * 27,
                    "old-snapshot",
                    None,
                    None,
                ]
            ),
        }

    async def generate_snapshot(self, contents):
        return "fresh-snapshot"


def test_capture_uses_session_cache_as_the_single_source_of_truth_after_account_switch():
    session = _Session()
    service = RequestCaptureService(session, SnapshotCache())

    first = asyncio.run(service.capture("first", model="gemini-3-pro-image-preview"))
    session.url = "https://example.test/second"
    second = asyncio.run(service.capture("second", model="gemini-3-pro-image-preview"))

    assert first.url.endswith("/first")
    assert second.url.endswith("/second")
    assert first.model == "models/gemini-3-pro-image-preview"
    assert second.model == "models/gemini-3-pro-image-preview"
    assert session.calls == [
        ("gemini-3-pro-image-preview", False),
        ("gemini-3-pro-image-preview", False),
    ]


def test_capture_forwards_force_refresh_to_browser_session():
    session = _Session()
    service = RequestCaptureService(session, SnapshotCache())

    asyncio.run(service.capture("retry", model="gemini-3-pro-image-preview", force_refresh=True))

    assert session.calls == [("gemini-3-pro-image-preview", True)]
