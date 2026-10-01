"""Durable byte counts on outbound TCP streams, including proxy/TLS records.

pproxy owns HTTP/SOCKS parsing. TCP headers, retransmissions and subsequent
chained hops are outside this boundary. Chunks use their own UTC timestamps.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import secrets
import sqlite3
import ssl
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import unquote, urlsplit

import pproxy

from .task_store import task_state_path

try:
    from traffic_meter.client import TrafficMeterClient, TrafficMeterClientError, request_proxy
except ImportError:  # The legacy Provider image remains usable until the central client is bundled.
    TrafficMeterClient = None  # type: ignore[assignment,misc]
    TrafficMeterClientError = RuntimeError  # type: ignore[assignment,misc]
    request_proxy = None  # type: ignore[assignment]


_CONNECTION_MODES = {"direct", "generic", "magic", "chained", "unknown"}
_SHARED_BROWSER_MODEL = "__shared_browser__"
_ACCOUNT_PROBE_MODEL = "__account_probe__"


class TrafficMeter:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS traffic (time_us INTEGER NOT NULL, role TEXT NOT NULL, address TEXT NOT NULL, port INTEGER NOT NULL, upload INTEGER NOT NULL, download INTEGER NOT NULL)")
        self.db.execute("CREATE INDEX IF NOT EXISTS traffic_time ON traffic(time_us)")
        self.db.commit()
        path.chmod(0o600)
        self.relays: dict[tuple[str, str], tuple[asyncio.Server, str]] = {}
        self.writers: set[asyncio.StreamWriter] = set()
        self.closed = False

    def record(self, role: str, address: str, port: int, upload: int = 0, download: int = 0, *, time_us: int | None = None):
        if self.closed or (not upload and not download):
            return
        stamp = time_us if time_us is not None else int(datetime.now(timezone.utc).timestamp() * 1_000_000)
        with self.db:
            self.db.execute("INSERT INTO traffic VALUES (?, ?, ?, ?, ?, ?)", (stamp, role, address, port, upload, download))

    async def proxy(self, url: str | None, role: str) -> str:
        key = (role, hashlib.sha256((url or "direct").encode()).hexdigest())
        if key in self.relays:
            return self.relays[key][1]
        parts = urlsplit(url or "")
        address = parts.hostname or "直连"
        port = parts.port or ({"http": 80, "https": 443, "socks5": 1080, "socks5h": 1080}.get(parts.scheme, 0))
        if url:
            scheme = {"http": "http", "https": "http+ssl", "socks5": "socks5", "socks5h": "socks5"}.get(parts.scheme)
            if not scheme:
                raise RuntimeError("traffic_proxy_scheme_invalid")
            host = f"[{address}]" if ":" in address else address
            remote = pproxy.Connection(f"{scheme}://{host}:{port}")
            if parts.username is not None:
                remote.users = [f"{unquote(parts.username)}:{unquote(parts.password or '')}".encode()]
            if parts.scheme == "https":
                remote.sslclient = ssl.create_default_context()
        else:
            from pproxy.server import ProxyDirect
            remote = ProxyDirect()
        meter = self

        async def connect(host, target_port, local_addr, family):
            reader = asyncio.StreamReader()
            writer = None

            class Protocol(asyncio.StreamReaderProtocol):
                def data_received(self, data):
                    meter.record(role, address, port, download=len(data))
                    super().data_received(data)

                def connection_lost(self, exc):
                    meter.writers.discard(writer)
                    super().connection_lost(exc)

            protocol = Protocol(reader)
            dest_host, dest_port = remote.destination(host, target_port)
            transport, _ = await asyncio.get_running_loop().create_connection(lambda: protocol, dest_host, dest_port, local_addr=local_addr, family=family)
            writer = asyncio.StreamWriter(transport, protocol, reader, asyncio.get_running_loop())
            original_write = writer.write

            def write(data):
                original_write(data)
                meter.record(role, address, port, upload=len(data))

            writer.write = write
            meter.writers.add(writer)
            return reader, writer

        remote.wait_open_connection = connect
        password = secrets.token_urlsafe()
        # Never cache authentication by IP: every local client shares loopback.
        server = await pproxy.Server(f"http://127.0.0.1:0#dola:{password}").start_server({"rserver": [remote], "authtime": 0})
        local_url = f"http://dola:{password}@127.0.0.1:{server.sockets[0].getsockname()[1]}"
        self.relays[key] = (server, local_url)
        return local_url

    def query(self, start: str, end: str, port: int | None = None) -> dict:
        def stamp(value):
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError("traffic_range_timezone_required")
            return int(parsed.timestamp() * 1_000_000)
        begin, finish = stamp(start), stamp(end)
        if begin >= finish:
            raise ValueError("traffic_range_invalid")
        condition = "time_us >= ? AND time_us < ?"
        params = [begin, finish]
        if port is not None:
            condition += " AND port = ?"
            params.append(port)
        rows = self.db.execute(f"SELECT role, address, port, SUM(upload), SUM(download) FROM traffic WHERE {condition} GROUP BY role, address, port ORDER BY SUM(upload)+SUM(download) DESC", params).fetchall()
        items = [{"role": r, "address": a, "port": p, "uploadBytes": u, "downloadBytes": d, "totalBytes": u+d} for r, a, p, u, d in rows]
        return {"start": start, "end": end, "items": items, "uploadBytes": sum(i["uploadBytes"] for i in items), "downloadBytes": sum(i["downloadBytes"] for i in items), "totalBytes": sum(i["totalBytes"] for i in items), "boundary": "outbound-tcp-stream"}

    async def close(self):
        for server, _ in self.relays.values():
            server.close()
            await server.wait_closed()
        for writer in tuple(self.writers):
            writer.close()
        for writer in tuple(self.writers):
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass
        self.relays.clear()
        self.closed = True
        self.db.close()


_meter: TrafficMeter | None = None
_lock: asyncio.Lock | None = None


def start_meter():
    global _meter, _lock
    if _central_meter_configured():
        _meter = None
        _lock = None
        return
    _meter = TrafficMeter(Path(os.getenv("DOLA_TRAFFIC_STATE_PATH", str(task_state_path().with_name("traffic.sqlite3")))))
    _lock = asyncio.Lock()


async def close_meter():
    global _meter
    if _meter:
        await _meter.close()
        _meter = None


def decode_trusted_traffic_context(value: str | None) -> dict[str, str]:
    """Decode only app-supplied route metadata after the Provider authenticated it.

    The caller never controls model, role, or connection mode through this
    header.  Those remain derived from the concrete DOLA operation below.
    """

    if not value:
        return {}
    try:
        padded = value + "=" * (-len(value) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as error:
        raise ValueError("traffic_context_invalid") from error
    if not isinstance(payload, dict):
        raise ValueError("traffic_context_invalid")
    context: dict[str, str] = {}
    for source, target in (
        ("channelId", "channelId"),
        ("channelName", "channelName"),
        ("protocol", "protocol"),
        ("requestId", "requestId"),
        ("taskId", "taskId"),
        ("attemptId", "attemptId"),
    ):
        item = payload.get(source)
        if item is None:
            continue
        if not isinstance(item, str) or not item.strip() or len(item.strip()) > 512 or "\x00" in item:
            raise ValueError("traffic_context_invalid")
        context[target] = item.strip()
    return context


def bind_trusted_traffic_context(request: Any, value: str | None):
    context = decode_trusted_traffic_context(value)
    # The request body is never an attribution source.  A caller that reached
    # this authenticated Provider endpoint without the trusted Web header gets
    # the safe DOLA defaults below, not a self-selected channel or protocol.
    update = {"trafficContext": context or None}
    if "requestId" in getattr(type(request), "model_fields", {}):
        update["requestId"] = context.get("requestId") or None
    return request.model_copy(update=update)


def traffic_context(
    source: Mapping[str, Any] | None = None,
    *,
    role: str,
    model: str | None = None,
    proxy_mode: str | None = None,
    proxy_source: str | None = None,
    shared_browser: bool = False,
    request_id: str | None = None,
    task_id: str | None = None,
    attempt_id: str | None = None,
) -> dict[str, str]:
    inherited = source if isinstance(source, Mapping) else {}
    channel_id = _context_text(inherited.get("channelId")) or "dola"
    channel_name = _context_text(inherited.get("channelName")) or "Dola API"
    protocol = _context_text(inherited.get("protocol")) or "camoufox-page"
    inherited_mode = _context_text(inherited.get("connectionMode"))
    mode = proxy_source if proxy_source in _CONNECTION_MODES else (inherited_mode if inherited_mode in _CONNECTION_MODES else ("direct" if proxy_mode == "direct" else "unknown"))
    context = {
        "channelId": channel_id,
        "channelName": channel_name,
        # A request context is persisted with a background task.  Keep its
        # concrete model for later HTTP query/upload work; a browser connection
        # is deliberately attributed only to the shared-browser bucket.
        "model": _SHARED_BROWSER_MODEL if shared_browser else (_context_text(inherited.get("model")) or model or _ACCOUNT_PROBE_MODEL),
        "protocol": protocol,
        "connectionMode": mode,
        "role": role,
        "attributionScope": "shared_browser" if shared_browser else "exact",
    }
    if shared_browser:
        return context
    for key, override in (("requestId", request_id), ("taskId", task_id), ("attemptId", attempt_id)):
        value = _context_text(override if override is not None else inherited.get(key))
        if value:
            context[key] = value
    return context


class _MeteredProxy:
    """Async lease context with the old local ``await`` form kept for callers.

    The central service needs an explicit lifetime so the caller must use
    ``async with`` when it is configured.  Standalone DOLA library users that
    have no central meter retain the former ``await metered_proxy(...)`` API.
    """

    def __init__(self, url: str | None, context: Mapping[str, Any] | str) -> None:
        self.url = url
        self.context = {"channelId": "dola", "channelName": "Dola API", "model": _ACCOUNT_PROBE_MODEL, "protocol": "camoufox-page", "connectionMode": "unknown", "role": context, "attributionScope": "exact"} if isinstance(context, str) else dict(context)
        self._central_scope: Any | None = None

    async def __aenter__(self) -> str | None:
        if _central_meter_configured():
            if TrafficMeterClient is None or request_proxy is None:
                raise RuntimeError("traffic_meter_client_unavailable")
            client = TrafficMeterClient.from_environment()
            if client is None:
                raise RuntimeError("traffic_meter_unavailable")
            try:
                self._central_scope = request_proxy(self.url, self.context, client=client)
                return await self._central_scope.__aenter__()
            except TrafficMeterClientError as error:
                raise RuntimeError(str(error)) from error
        return await self._legacy_proxy()

    async def __aexit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if self._central_scope is None:
            return
        try:
            await self._central_scope.__aexit__(exc_type, exc, traceback)
        except TrafficMeterClientError as error:
            raise RuntimeError(str(error)) from error
        finally:
            self._central_scope = None

    def __await__(self):
        async def resolve() -> str | None:
            if _central_meter_configured():
                raise RuntimeError("traffic_meter_lease_context_required")
            return await self._legacy_proxy()

        return resolve().__await__()

    async def _legacy_proxy(self) -> str | None:
        if _meter is None:
            return self.url  # Library usage without the Provider lifecycle.
        if _lock is None:
            raise RuntimeError("traffic_meter_not_started")
        async with _lock:
            return await _meter.proxy(self.url, str(self.context.get("role") or "submit"))


def metered_proxy(url: str | None, context: Mapping[str, Any] | str) -> _MeteredProxy:
    return _MeteredProxy(url, context)


def query_traffic(start: str, end: str, port: int | None = None):
    """Legacy local-meter read for standalone callers and their tests."""

    if _central_meter_configured():
        raise RuntimeError("traffic_meter_query_requires_async")
    if _meter is None:
        raise RuntimeError("traffic_meter_not_started")
    return _meter.query(start, end, port)


async def query_traffic_async(start: str, end: str, port: int | None = None):
    if _central_meter_configured():
        if TrafficMeterClient is None:
            raise RuntimeError("traffic_meter_client_unavailable")
        client = TrafficMeterClient.from_environment()
        if client is None:
            raise RuntimeError("traffic_meter_unavailable")
        try:
            return await client.query(start, end, channelId="dola", port=port)
        except TrafficMeterClientError as error:
            raise RuntimeError(str(error)) from error
    return query_traffic(start, end, port)


def _central_meter_configured() -> bool:
    return bool(os.getenv("DREAMYO_TRAFFIC_METER_URL", "").strip())


def _context_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    text = value.strip()
    return text if text and len(text) <= 512 and "\x00" not in text else ""
