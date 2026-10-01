"""Durable byte counts on outbound TCP streams, including proxy/TLS records.

pproxy owns HTTP/SOCKS parsing. TCP headers, retransmissions and subsequent
chained hops are outside this boundary. Chunks use their own UTC timestamps.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import secrets
import sqlite3
import ssl
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit

import pproxy

from .task_store import task_state_path


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
    _meter = TrafficMeter(Path(os.getenv("DOLA_TRAFFIC_STATE_PATH", str(task_state_path().with_name("traffic.sqlite3")))))
    _lock = asyncio.Lock()


async def close_meter():
    global _meter
    if _meter:
        await _meter.close()
        _meter = None


async def metered_proxy(url: str | None, role: str) -> str | None:
    if _meter is None:
        return url  # Library usage without the Provider lifecycle.
    async with _lock:
        return await _meter.proxy(url, role)


def query_traffic(start: str, end: str, port: int | None = None):
    if _meter is None:
        raise RuntimeError("traffic_meter_not_started")
    return _meter.query(start, end, port)
