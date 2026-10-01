"""Trusted traffic context and shared-browser lease helpers."""

from __future__ import annotations

import base64
import binascii
import json
import os
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator, Mapping


TRAFFIC_CONTEXT_HEADER = "x-dreamyo-traffic-context"
SHARED_CHANNEL_ID = "geminiai/sharedchannel"
SHARED_CHANNEL_NAME = "GeminiAI 共享浏览器"
SHARED_MODEL = "__shared_browser__"
SHARED_ATTRIBUTION_SCOPE = "shared_browser"
ALLOWED_CONNECTION_MODES = {"direct", "generic", "magic", "chained", "unknown"}


class TrafficContextError(RuntimeError):
    """The server-owned traffic context is missing or malformed."""


class TrafficMeterIntegrationError(RuntimeError):
    """The meter is configured but its client or lease is unavailable."""


_current_context: ContextVar[dict[str, str] | None] = ContextVar(
    "geminiai_traffic_context",
    default=None,
)


def decode_traffic_context(raw: str | None) -> dict[str, str] | None:
    value = str(raw or "").strip()
    if not value:
        return None
    try:
        padded = value + "=" * (-len(value) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    except (ValueError, UnicodeError, UnicodeDecodeError, binascii.Error) as error:
        raise TrafficContextError("traffic_context_invalid") from error
    if not isinstance(payload, dict):
        raise TrafficContextError("traffic_context_invalid")
    result: dict[str, str] = {}
    for field in ("channelId", "channelName", "model", "protocol", "connectionMode", "role", "attributionScope"):
        item = payload.get(field)
        if item is None:
            continue
        if not isinstance(item, str) or len(item.strip()) > 200:
            raise TrafficContextError("traffic_context_invalid")
        result[field] = item.strip()
    if not result.get("channelId") or not result.get("channelName") or not result.get("protocol"):
        raise TrafficContextError("traffic_context_invalid")
    mode = result.get("connectionMode") or "unknown"
    if mode not in ALLOWED_CONNECTION_MODES:
        raise TrafficContextError("traffic_context_invalid")
    result["connectionMode"] = mode
    result["role"] = result.get("role") or "provider"
    result["attributionScope"] = result.get("attributionScope") or "exact"
    return result


def shared_browser_context(source: Mapping[str, str] | None = None, proxy_url: str | None = None) -> dict[str, str]:
    # The browser is persistent and the underlying proxy may be a local
    # listener, a chained route, or a generic HTTP relay.  A request header
    # cannot prove which mode is active, and the route can change while the
    # browser's TCP connections remain alive.  Keep direct attribution exact;
    # report every proxied shared-browser session as unknown instead of
    # inventing a mode label.
    mode = "unknown" if str(proxy_url or "").strip() else "direct"
    return {
        "channelId": SHARED_CHANNEL_ID,
        "channelName": SHARED_CHANNEL_NAME,
        "model": SHARED_MODEL,
        "protocol": "geminiai",
        "connectionMode": mode,
        "role": "provider",
        "attributionScope": SHARED_ATTRIBUTION_SCOPE,
    }


@contextmanager
def bind_traffic_context(context: Mapping[str, str]) -> Iterator[None]:
    token = _current_context.set(dict(context))
    try:
        yield
    finally:
        _current_context.reset(token)


def current_traffic_context() -> dict[str, str] | None:
    value = _current_context.get()
    return dict(value) if value else None


def create_traffic_lease(proxy_url: str | None, context: Mapping[str, str]):
    if not os.getenv("DREAMYO_TRAFFIC_METER_URL", "").strip():
        return None
    try:
        from traffic_meter.client import TrafficMeterClient, TrafficMeterClientError
    except (ImportError, ModuleNotFoundError) as error:
        raise TrafficMeterIntegrationError("traffic_meter_dependency_missing") from error
    try:
        client = TrafficMeterClient.from_environment()
        if client is None:
            return None
        return client
    except TrafficMeterClientError as error:
        raise TrafficMeterIntegrationError(str(error)) from error


async def acquire_traffic_lease(proxy_url: str | None, context: Mapping[str, str]):
    client = create_traffic_lease(proxy_url, context)
    if client is None:
        return None
    try:
        return await client.create_lease(proxy_url, context)
    except Exception as error:
        raise TrafficMeterIntegrationError("traffic_meter_lease_create_failed") from error


async def release_traffic_lease(lease: object) -> None:
    if lease is None:
        return
    try:
        await lease.release()
    except Exception as error:
        raise TrafficMeterIntegrationError("traffic_meter_lease_release_failed") from error
