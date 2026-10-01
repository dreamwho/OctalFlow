"""Trusted request context and lease helpers for the ChatGPT provider.

The web gateway is the only component allowed to create the traffic context.
This module deliberately keeps the context small and credential-free; request
payloads, cookies, access tokens, and proxy credentials never enter it.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator, Mapping


TRAFFIC_CONTEXT_HEADER = "x-dreamyo-traffic-context"
TRAFFIC_CONTEXT_FIELDS = (
    "channelId",
    "channelName",
    "model",
    "protocol",
    "connectionMode",
    "role",
    "attributionScope",
    "requestId",
    "taskId",
    "attemptId",
)
TRAFFIC_CONTEXT_IDENTIFIERS = ("requestId", "taskId", "attemptId")
ALLOWED_CONNECTION_MODES = {"direct", "generic", "magic", "chained", "unknown"}
ALLOWED_ATTRIBUTION_SCOPES = {"exact", "shared_browser"}
DEFAULT_CHANNEL_ID = "chatgpt-api"
DEFAULT_CHANNEL_NAME = "ChatGPT API"
DEFAULT_PROTOCOL = "chatgpt-api"
DEFAULT_ROLE = "provider"


class TrafficContextError(RuntimeError):
    """The server-owned traffic context is missing or malformed."""


_current_context: ContextVar[dict[str, str] | None] = ContextVar(
    "chatgpt_traffic_context",
    default=None,
)


def decode_traffic_context(raw: str | None) -> dict[str, str] | None:
    """Decode the base64url JSON header created by the Next.js gateway."""

    value = str(raw or "").strip()
    if not value:
        return None
    try:
        padded = value + "=" * (-len(value) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("ascii"))
        payload = json.loads(decoded.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, UnicodeError, binascii.Error) as error:
        raise TrafficContextError("traffic_context_invalid") from error
    if not isinstance(payload, dict):
        raise TrafficContextError("traffic_context_invalid")

    context: dict[str, str] = {}
    for field in TRAFFIC_CONTEXT_FIELDS:
        item = payload.get(field)
        if item is None:
            continue
        if not isinstance(item, str):
            raise TrafficContextError("traffic_context_invalid")
        text = item.strip()
        if len(text) > 200:
            raise TrafficContextError("traffic_context_invalid")
        context[field] = text

    if not context.get("channelId") or not context.get("channelName") or not context.get("protocol"):
        raise TrafficContextError("traffic_context_invalid")
    connection_mode = context.get("connectionMode") or "unknown"
    if connection_mode not in ALLOWED_CONNECTION_MODES:
        raise TrafficContextError("traffic_context_invalid")
    context["connectionMode"] = connection_mode
    context["role"] = context.get("role") or DEFAULT_ROLE
    scope = context.get("attributionScope") or "exact"
    if scope not in ALLOWED_ATTRIBUTION_SCOPES:
        raise TrafficContextError("traffic_context_invalid")
    context["attributionScope"] = scope
    context["model"] = context.get("model") or "__unattributed__"
    return context


def default_traffic_context(
    *,
    model: str = "",
    protocol: str = DEFAULT_PROTOCOL,
    connection_mode: str = "unknown",
) -> dict[str, str]:
    mode = connection_mode if connection_mode in ALLOWED_CONNECTION_MODES else "unknown"
    return {
        "channelId": DEFAULT_CHANNEL_ID,
        "channelName": DEFAULT_CHANNEL_NAME,
        "model": str(model or "__unattributed__").strip() or "__unattributed__",
        "protocol": str(protocol or DEFAULT_PROTOCOL).strip() or DEFAULT_PROTOCOL,
        "connectionMode": mode,
        "role": DEFAULT_ROLE,
        "attributionScope": "exact",
    }


def context_for_call(
    *,
    model: str = "",
    protocol: str = DEFAULT_PROTOCOL,
    connection_mode: str = "unknown",
    request_id: str = "",
    task_id: str = "",
    attempt_id: str = "",
) -> dict[str, str]:
    current = dict(_current_context.get() or {})
    fallback = default_traffic_context(model=model, protocol=protocol, connection_mode=connection_mode)
    for key, value in fallback.items():
        if key == "connectionMode" and connection_mode != "unknown":
            # The provider's resolved profile is authoritative for this
            # request.  An inherited gateway mode may describe the parent
            # request while this control/upload request uses another route.
            current[key] = value
        elif not current.get(key) or (key == "model" and current[key] == "__unattributed__" and model):
            current[key] = value
    if current.get("connectionMode") not in ALLOWED_CONNECTION_MODES:
        current["connectionMode"] = fallback["connectionMode"]
    for key, value in (("requestId", request_id), ("taskId", task_id), ("attemptId", attempt_id)):
        normalized = str(value or "").strip()
        if normalized:
            current[key] = normalized
    if current.get("attributionScope") == "shared_browser":
        # A persistent/shared browser cannot prove which logical task caused
        # bytes on a pooled connection.  Do not emit misleading exact IDs.
        for key in TRAFFIC_CONTEXT_IDENTIFIERS:
            current.pop(key, None)
    return current


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


class TrafficMeterIntegrationError(RuntimeError):
    """The meter is configured but its client or lease is unavailable."""


def _meter_client():
    if not os.getenv("DREAMYO_TRAFFIC_METER_URL", "").strip():
        return None
    try:
        from traffic_meter.client import TrafficMeterClient, TrafficMeterClientError
    except (ImportError, ModuleNotFoundError) as error:
        raise TrafficMeterIntegrationError("traffic_meter_dependency_missing") from error
    try:
        return TrafficMeterClient.from_environment()
    except TrafficMeterClientError as error:
        raise TrafficMeterIntegrationError(str(error)) from error


def connection_mode_for_profile(profile: object) -> str:
    raw = str(getattr(profile, "egress_mode", "") or "").strip().lower()
    if raw in ALLOWED_CONNECTION_MODES:
        return raw
    source = str(getattr(profile, "proxy_source", "") or "").strip().lower()
    if source in ALLOWED_CONNECTION_MODES:
        return source
    if source.startswith("magic"):
        return "magic"
    if source.startswith("chained"):
        return "chained"
    if source.startswith(("generic", "ipwo", "fallback")):
        return "generic"
    return "generic" if str(getattr(profile, "proxy_url", "") or "").strip() else "direct"


def create_traffic_lease_sync(proxy_url: str | None, context: Mapping[str, str]):
    """Create a lease when configured, while preserving passthrough by default."""

    client = _meter_client()
    if client is None:
        return None
    try:
        return client.create_lease_sync(proxy_url, context)
    except Exception as error:
        raise TrafficMeterIntegrationError("traffic_meter_lease_create_failed") from error


def release_traffic_lease_sync(lease: object) -> None:
    if lease is None:
        return
    try:
        lease.release_sync()
    except Exception as error:
        raise TrafficMeterIntegrationError("traffic_meter_lease_release_failed") from error
