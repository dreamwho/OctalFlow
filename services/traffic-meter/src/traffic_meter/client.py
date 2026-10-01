"""Small authenticated client shared by Python provider processes.

The meter endpoint is internal-only.  This module never stores a provider
proxy URL; it only passes it to the meter while creating a relay lease.
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator, Mapping, Sequence
from urllib.parse import urlsplit

import httpx


class TrafficMeterClientError(RuntimeError):
    """The configured meter could not create, release, or query a lease."""


def _base_url(value: str) -> str:
    try:
        parsed = urlsplit(value.strip())
    except ValueError as error:
        raise TrafficMeterClientError("traffic_meter_url_invalid") from error
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise TrafficMeterClientError("traffic_meter_url_invalid")
    return value.strip().rstrip("/")


def _context_payload(context: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in context.items() if value is not None}


def _targets_payload(pinned_targets: Sequence[Mapping[str, str]] | None) -> list[dict[str, str]]:
    if not pinned_targets:
        return []
    return [{"hostname": str(item.get("hostname") or ""), "address": str(item.get("address") or "")} for item in pinned_targets]


@dataclass
class TrafficLease:
    """A relay that stays valid until its owner has consumed or cancelled I/O."""

    client: "TrafficMeterClient"
    lease_id: str
    proxy_url: str
    _released: bool = field(default=False, init=False, repr=False)

    async def release(self) -> None:
        if self._released:
            return
        await self.client.release(self.lease_id)
        self._released = True

    def release_sync(self) -> None:
        if self._released:
            return
        self.client.release_sync(self.lease_id)
        self._released = True


class TrafficMeterClient:
    def __init__(self, base_url: str, key: str, *, timeout: float = 15.0):
        if not key.strip():
            raise TrafficMeterClientError("traffic_meter_key_missing")
        self.base_url = _base_url(base_url)
        self.key = key.strip()
        self.timeout = timeout

    @classmethod
    def from_environment(cls) -> "TrafficMeterClient | None":
        url = os.getenv("DREAMYO_TRAFFIC_METER_URL", "").strip()
        if not url:
            return None
        return cls(url, os.getenv("DREAMYO_TRAFFIC_METER_KEY", ""))

    @property
    def _headers(self) -> dict[str, str]:
        return {"X-Traffic-Key": self.key}

    async def create_lease(
        self,
        proxy_url: str | None,
        context: Mapping[str, Any],
        *,
        pinned_targets: Sequence[Mapping[str, str]] | None = None,
    ) -> TrafficLease:
        payload = {"proxyUrl": proxy_url, "context": _context_payload(context), "pinnedTargets": _targets_payload(pinned_targets)}
        async with httpx.AsyncClient(timeout=self.timeout, trust_env=False) as client:
            response = await self._request_async(client, "POST", "/internal/leases", json=payload)
        return self._lease_from_response(response)

    def create_lease_sync(
        self,
        proxy_url: str | None,
        context: Mapping[str, Any],
        *,
        pinned_targets: Sequence[Mapping[str, str]] | None = None,
    ) -> TrafficLease:
        payload = {"proxyUrl": proxy_url, "context": _context_payload(context), "pinnedTargets": _targets_payload(pinned_targets)}
        with httpx.Client(timeout=self.timeout, trust_env=False) as client:
            response = self._request_sync(client, "POST", "/internal/leases", json=payload)
        return self._lease_from_response(response)

    async def release(self, lease_id: str) -> None:
        async with httpx.AsyncClient(timeout=self.timeout, trust_env=False) as client:
            await self._request_async(client, "DELETE", f"/internal/leases/{_path_id(lease_id)}")

    def release_sync(self, lease_id: str) -> None:
        with httpx.Client(timeout=self.timeout, trust_env=False) as client:
            self._request_sync(client, "DELETE", f"/internal/leases/{_path_id(lease_id)}")

    async def query(
        self,
        start: str,
        end: str,
        *,
        channelId: str | None = None,
        model: str | None = None,
        protocol: str | None = None,
        connectionMode: str | None = None,
        port: int | None = None,
        requestId: str | None = None,
        taskId: str | None = None,
        attemptId: str | None = None,
    ) -> dict[str, Any]:
        params = _query_params(start, end, {"channelId": channelId, "model": model, "protocol": protocol, "connectionMode": connectionMode, "port": port, "requestId": requestId, "taskId": taskId, "attemptId": attemptId})
        async with httpx.AsyncClient(timeout=self.timeout, trust_env=False) as client:
            response = await self._request_async(client, "GET", "/internal/traffic", params=params)
        return _json_object(response)

    def query_sync(
        self,
        start: str,
        end: str,
        *,
        channelId: str | None = None,
        model: str | None = None,
        protocol: str | None = None,
        connectionMode: str | None = None,
        port: int | None = None,
        requestId: str | None = None,
        taskId: str | None = None,
        attemptId: str | None = None,
    ) -> dict[str, Any]:
        params = _query_params(start, end, {"channelId": channelId, "model": model, "protocol": protocol, "connectionMode": connectionMode, "port": port, "requestId": requestId, "taskId": taskId, "attemptId": attemptId})
        with httpx.Client(timeout=self.timeout, trust_env=False) as client:
            response = self._request_sync(client, "GET", "/internal/traffic", params=params)
        return _json_object(response)

    async def query_tasks(
        self,
        *,
        start: str | None = None,
        end: str | None = None,
        channelId: str | None = None,
        model: str | None = None,
        protocol: str | None = None,
        connectionMode: str | None = None,
        port: int | None = None,
        requestId: str | None = None,
        taskId: str | None = None,
        attemptId: str | None = None,
        page: int = 1,
        pageSize: int = 20,
    ) -> dict[str, Any]:
        params = _task_query_params(
            start=start,
            end=end,
            filters={"channelId": channelId, "model": model, "protocol": protocol, "connectionMode": connectionMode, "port": port, "requestId": requestId, "taskId": taskId, "attemptId": attemptId, "page": page, "pageSize": pageSize},
        )
        async with httpx.AsyncClient(timeout=self.timeout, trust_env=False) as client:
            response = await self._request_async(client, "GET", "/internal/traffic/tasks", params=params)
        return _json_object(response)

    def query_tasks_sync(
        self,
        *,
        start: str | None = None,
        end: str | None = None,
        channelId: str | None = None,
        model: str | None = None,
        protocol: str | None = None,
        connectionMode: str | None = None,
        port: int | None = None,
        requestId: str | None = None,
        taskId: str | None = None,
        attemptId: str | None = None,
        page: int = 1,
        pageSize: int = 20,
    ) -> dict[str, Any]:
        params = _task_query_params(
            start=start,
            end=end,
            filters={"channelId": channelId, "model": model, "protocol": protocol, "connectionMode": connectionMode, "port": port, "requestId": requestId, "taskId": taskId, "attemptId": attemptId, "page": page, "pageSize": pageSize},
        )
        with httpx.Client(timeout=self.timeout, trust_env=False) as client:
            response = self._request_sync(client, "GET", "/internal/traffic/tasks", params=params)
        return _json_object(response)

    async def query_requests(self, requestIds: Sequence[str] = (), *, taskIds: Sequence[str] = ()) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout, trust_env=False) as client:
            response = await self._request_async(client, "POST", "/internal/traffic/requests", json={"requestIds": list(requestIds), "taskIds": list(taskIds)})
        return _json_object(response)

    def query_requests_sync(self, requestIds: Sequence[str] = (), *, taskIds: Sequence[str] = ()) -> dict[str, Any]:
        with httpx.Client(timeout=self.timeout, trust_env=False) as client:
            response = self._request_sync(client, "POST", "/internal/traffic/requests", json={"requestIds": list(requestIds), "taskIds": list(taskIds)})
        return _json_object(response)

    async def _request_async(self, client: httpx.AsyncClient, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            response = await client.request(method, f"{self.base_url}{path}", headers=self._headers, **kwargs)
        except httpx.HTTPError as error:
            raise TrafficMeterClientError("traffic_meter_unavailable") from error
        _raise_for_response(response)
        return response

    def _request_sync(self, client: httpx.Client, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            response = client.request(method, f"{self.base_url}{path}", headers=self._headers, **kwargs)
        except httpx.HTTPError as error:
            raise TrafficMeterClientError("traffic_meter_unavailable") from error
        _raise_for_response(response)
        return response

    def _lease_from_response(self, response: httpx.Response) -> TrafficLease:
        value = _json_object(response)
        lease_id = value.get("leaseId")
        proxy_url = value.get("proxyUrl")
        if not isinstance(lease_id, str) or not lease_id or not isinstance(proxy_url, str) or not proxy_url:
            raise TrafficMeterClientError("traffic_meter_invalid_lease_response")
        return TrafficLease(self, lease_id, proxy_url)


@asynccontextmanager
async def request_proxy(
    proxy_url: str | None,
    context: Mapping[str, Any],
    *,
    pinned_targets: Sequence[Mapping[str, str]] | None = None,
    client: TrafficMeterClient | None = None,
):
    """Yield a metered relay for the entire lifetime of an async I/O operation."""

    resolved = client if client is not None else TrafficMeterClient.from_environment()
    if resolved is None:
        yield proxy_url
        return
    lease = await resolved.create_lease(proxy_url, context, pinned_targets=pinned_targets)
    try:
        yield lease.proxy_url
    finally:
        await lease.release()


@contextmanager
def request_proxy_sync(
    proxy_url: str | None,
    context: Mapping[str, Any],
    *,
    pinned_targets: Sequence[Mapping[str, str]] | None = None,
    client: TrafficMeterClient | None = None,
) -> Iterator[str | None]:
    """Synchronous counterpart for providers that use blocking HTTP clients."""

    resolved = client if client is not None else TrafficMeterClient.from_environment()
    if resolved is None:
        yield proxy_url
        return
    lease = resolved.create_lease_sync(proxy_url, context, pinned_targets=pinned_targets)
    try:
        yield lease.proxy_url
    finally:
        lease.release_sync()


def _path_id(value: str) -> str:
    if not value or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in value):
        raise TrafficMeterClientError("traffic_meter_lease_id_invalid")
    return value


def _query_params(start: str, end: str, filters: Mapping[str, str | int | None]) -> dict[str, str]:
    values = {"start": start, "end": end}
    for key, value in filters.items():
        if value is not None and value != "":
            values[key] = str(value)
    return values


def _task_query_params(*, start: str | None, end: str | None, filters: Mapping[str, str | int | None]) -> dict[str, str]:
    values: dict[str, str] = {}
    if start is not None:
        values["start"] = start
    if end is not None:
        values["end"] = end
    for key, value in filters.items():
        if value is not None and value != "":
            values[key] = str(value)
    return values


def _raise_for_response(response: httpx.Response) -> None:
    if response.is_success:
        return
    detail = ""
    try:
        value = response.json()
        if isinstance(value, dict) and isinstance(value.get("detail"), str):
            detail = value["detail"]
    except ValueError:
        pass
    suffix = f":{detail}" if detail else ""
    raise TrafficMeterClientError(f"traffic_meter_http_{response.status_code}{suffix}")


def _json_object(response: httpx.Response) -> dict[str, Any]:
    try:
        value = response.json()
    except ValueError as error:
        raise TrafficMeterClientError("traffic_meter_invalid_response") from error
    if not isinstance(value, dict):
        raise TrafficMeterClientError("traffic_meter_invalid_response")
    return value
