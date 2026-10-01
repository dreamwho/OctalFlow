"""Raw TCP relay accounting used by the internal traffic-meter service.

Only the relay's connection to its configured upstream proxy (or direct
destination) is counted.  Client-to-relay traffic is deliberately excluded so
an app calling a Python provider cannot be counted twice over loopback.
"""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import os
import secrets
import sqlite3
import ssl
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email import policy
from email.parser import BytesHeaderParser
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.parse import unquote, urlparse, urlsplit

import pproxy
from pproxy import proto as pproxy_proto


CONNECTION_MODES = {"direct", "generic", "magic", "chained", "unknown"}
ATTRIBUTION_SCOPES = {"exact", "shared_browser"}
UNATTRIBUTED_MODEL = "__unattributed__"
SHARED_BROWSER_MODEL = "__shared_browser__"


class TrafficMeterValidationError(ValueError):
    pass


class _CaseInsensitiveHTTPProxyProtocol(pproxy_proto.HTTP):
    """Keep pproxy's relay behavior while accepting RFC case-insensitive fields."""

    @property
    def name(self) -> str:
        return "http"

    async def accept(self, reader: asyncio.StreamReader, user: Any, writer: asyncio.StreamWriter, **kwargs: Any):
        raw_headers = await reader.read_until(b"\r\n\r\n")
        method, path, version, forwarded_lines, host, proxy_authorization = _parse_http_headers(raw_headers)

        async def reply(_code: int, message: bytes, body: bytes | None = None, wait: bool = False) -> None:
            writer.write(message)
            if body:
                writer.write(body)
            if wait:
                await writer.drain()

        return await self.http_accept(user, method, path, None, version, forwarded_lines, host, proxy_authorization, reply, **kwargs)

    async def http_channel(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, stat_bytes: Any, stat_conn: Any) -> None:
        """Use pproxy's existing forwarding flow with case-folded proxy fields."""
        try:
            stat_conn(1)
            while not reader.at_eof() and not writer.is_closing():
                data = await reader.read(65536)
                if not data:
                    break
                if b"\r\n" in data:
                    request_line = data.split(b"\r\n", 1)[0].decode("latin-1")
                    if pproxy_proto.HTTP_LINE.match(request_line):
                        if b"\r\n\r\n" not in data:
                            data += await reader.readuntil(b"\r\n\r\n")
                        raw_headers, body = data.split(b"\r\n\r\n", 1)
                        method, path, version, forwarded_lines, _host, _proxy_authorization = _parse_http_headers(raw_headers + b"\r\n\r\n")
                        new_path = urlparse(path)._replace(netloc="", scheme="").geturl()
                        data = f"{method} {new_path} {version}\r\n{forwarded_lines}\r\n\r\n".encode("latin-1") + body
                stat_bytes(len(data))
                writer.write(data)
                await writer.drain()
        except Exception:
            pass
        finally:
            stat_conn(-1)
            writer.close()


@dataclass(frozen=True)
class TrafficContext:
    channel_id: str
    channel_name: str
    model: str
    protocol: str
    connection_mode: str
    role: str
    attribution_scope: str = "exact"
    request_id: str = ""
    task_id: str = ""
    attempt_id: str = ""

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "TrafficContext":
        if not isinstance(value, Mapping):
            raise TrafficMeterValidationError("traffic_context_invalid")
        channel_id = _required_text(value.get("channelId"), "traffic_channel_id_invalid")
        channel_name = _optional_text(value.get("channelName"))
        model = _optional_text(value.get("model")) or UNATTRIBUTED_MODEL
        protocol = _optional_text(value.get("protocol")) or "unknown"
        role = _required_text(value.get("role"), "traffic_role_invalid")
        connection_mode = _required_text(value.get("connectionMode"), "traffic_connection_mode_invalid")
        if connection_mode not in CONNECTION_MODES:
            raise TrafficMeterValidationError("traffic_connection_mode_invalid")
        attribution_scope = _optional_text(value.get("attributionScope")) or "exact"
        if attribution_scope not in ATTRIBUTION_SCOPES:
            raise TrafficMeterValidationError("traffic_attribution_scope_invalid")
        if attribution_scope == "shared_browser" and model != SHARED_BROWSER_MODEL:
            raise TrafficMeterValidationError("traffic_shared_browser_model_required")
        request_id = _optional_text(value.get("requestId"))
        task_id = _optional_text(value.get("taskId"))
        attempt_id = _optional_text(value.get("attemptId"))
        if attribution_scope == "shared_browser" and (request_id or task_id or attempt_id):
            raise TrafficMeterValidationError("traffic_shared_browser_correlation_forbidden")
        return cls(channel_id, channel_name, model, protocol, connection_mode, role, attribution_scope, request_id, task_id, attempt_id)

    def payload(self) -> dict[str, str]:
        payload = {
            "channelId": self.channel_id,
            "channelName": self.channel_name,
            "model": self.model,
            "protocol": self.protocol,
            "connectionMode": self.connection_mode,
            "role": self.role,
            "attributionScope": self.attribution_scope,
        }
        if self.request_id:
            payload["requestId"] = self.request_id
        if self.task_id:
            payload["taskId"] = self.task_id
        if self.attempt_id:
            payload["attemptId"] = self.attempt_id
        return payload


@dataclass(frozen=True)
class PinnedTarget:
    hostname: str
    address: str

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "PinnedTarget":
        if not isinstance(value, Mapping):
            raise TrafficMeterValidationError("traffic_pinned_target_invalid")
        hostname = _normalize_host(_required_text(value.get("hostname"), "traffic_pinned_target_invalid"))
        address = _required_text(value.get("address"), "traffic_pinned_target_invalid")
        try:
            ipaddress.ip_address(address)
        except ValueError as error:
            raise TrafficMeterValidationError("traffic_pinned_target_address_invalid") from error
        return cls(hostname, address)


@dataclass(frozen=True)
class UpstreamRoute:
    proxy_url: str | None
    address: str
    port: int
    scheme: str

    @classmethod
    def from_proxy_url(cls, proxy_url: str | None) -> "UpstreamRoute":
        if proxy_url is None or not proxy_url.strip():
            return cls(None, "直连", 0, "direct")
        value = proxy_url.strip()
        try:
            parts = urlsplit(value)
            port = parts.port
        except ValueError as error:
            raise TrafficMeterValidationError("traffic_proxy_url_invalid") from error
        if parts.scheme not in {"http", "https", "socks5", "socks5h"} or not parts.hostname or parts.query or parts.fragment or parts.path not in {"", "/"}:
            raise TrafficMeterValidationError("traffic_proxy_url_invalid")
        default_port = {"http": 80, "https": 443, "socks5": 1080, "socks5h": 1080}[parts.scheme]
        return cls(value, _normalize_host(parts.hostname), port or default_port, parts.scheme)

    def fingerprint(self) -> str:
        return hashlib.sha256((self.proxy_url or "direct").encode("utf-8")).hexdigest()


@dataclass
class Relay:
    key: str
    server: asyncio.Server
    proxy_url: str
    context: TrafficContext
    route: UpstreamRoute
    references: set[str] = field(default_factory=set)
    writers: set[asyncio.StreamWriter] = field(default_factory=set)


class TrafficMeter:
    def __init__(self, path: Path, *, bind_host: str = "127.0.0.1", public_host: str = "127.0.0.1"):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS traffic_events (
                time_us INTEGER NOT NULL,
                channel_id TEXT NOT NULL,
                channel_name TEXT NOT NULL,
                model TEXT NOT NULL,
                protocol TEXT NOT NULL,
                connection_mode TEXT NOT NULL,
                role TEXT NOT NULL,
                attribution_scope TEXT NOT NULL,
                request_id TEXT NOT NULL,
                task_id TEXT NOT NULL,
                attempt_id TEXT NOT NULL,
                address TEXT NOT NULL,
                port INTEGER NOT NULL,
                upload INTEGER NOT NULL,
                download INTEGER NOT NULL
            )"""
        )
        self.db.execute("CREATE INDEX IF NOT EXISTS traffic_events_time ON traffic_events(time_us)")
        self.db.execute("CREATE INDEX IF NOT EXISTS traffic_events_filter ON traffic_events(channel_id, model, connection_mode, port, time_us)")
        self.db.execute("CREATE INDEX IF NOT EXISTS traffic_events_request_filter ON traffic_events(request_id, time_us)")
        self.db.execute("CREATE INDEX IF NOT EXISTS traffic_events_task_filter ON traffic_events(task_id, request_id, attribution_scope, time_us)")
        self.db.commit()
        try:
            path.chmod(0o600)
        except OSError:
            pass
        self.bind_host = _normalize_bind_host(bind_host)
        self.public_host = _normalize_bind_host(public_host)
        self.relays: dict[str, Relay] = {}
        self.references: dict[str, str] = {}
        self._lock = asyncio.Lock()
        self.closed = False

    @classmethod
    def from_environment(cls) -> "TrafficMeter":
        return cls(
            Path(os.getenv("TRAFFIC_METER_STATE_PATH", "/data/traffic.sqlite3")),
            bind_host=os.getenv("TRAFFIC_METER_BIND_HOST", "127.0.0.1"),
            public_host=os.getenv("TRAFFIC_METER_PUBLIC_HOST", "127.0.0.1"),
        )

    async def create_lease(
        self,
        proxy_url: str | None,
        context: TrafficContext,
        pinned_targets: Sequence[PinnedTarget] = (),
    ) -> tuple[str, str]:
        if self.closed:
            raise RuntimeError("traffic_meter_closed")
        route = UpstreamRoute.from_proxy_url(proxy_url)
        pins = {target.hostname: target.address for target in pinned_targets}
        key = _relay_key(route, context, pins)
        async with self._lock:
            relay = self.relays.get(key)
            if relay is None:
                relay = await self._start_relay(key, route, context, pins)
                self.relays[key] = relay
            reference_id = secrets.token_urlsafe(24)
            relay.references.add(reference_id)
            self.references[reference_id] = key
            return reference_id, relay.proxy_url

    async def release(self, reference_id: str) -> bool:
        async with self._lock:
            key = self.references.pop(reference_id, None)
            if key is None:
                return False
            relay = self.relays.get(key)
            if relay is None:
                return False
            relay.references.discard(reference_id)
            if relay.references:
                return True
            self.relays.pop(key, None)
        await self._close_relay(relay)
        return True

    def record(self, context: TrafficContext, route: UpstreamRoute, *, upload: int = 0, download: int = 0, time_us: int | None = None) -> None:
        if self.closed or (not upload and not download):
            return
        stamp = time_us if time_us is not None else int(datetime.now(timezone.utc).timestamp() * 1_000_000)
        with self.db:
            self.db.execute(
                "INSERT INTO traffic_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    stamp,
                    context.channel_id,
                    context.channel_name,
                    context.model,
                    context.protocol,
                    context.connection_mode,
                    context.role,
                    context.attribution_scope,
                    context.request_id,
                    context.task_id,
                    context.attempt_id,
                    route.address,
                    route.port,
                    upload,
                    download,
                ),
            )

    def query(
        self,
        start: str,
        end: str,
        *,
        channel_id: str | None = None,
        model: str | None = None,
        protocol: str | None = None,
        connection_mode: str | None = None,
        port: int | None = None,
        request_id: str | None = None,
        task_id: str | None = None,
        attempt_id: str | None = None,
    ) -> dict[str, Any]:
        condition, values = _event_condition(
            start=start,
            end=end,
            channel_id=channel_id,
            model=model,
            protocol=protocol,
            connection_mode=connection_mode,
            port=port,
            request_id=request_id,
            task_id=task_id,
            attempt_id=attempt_id,
        )
        rows = self.db.execute(
            f"""SELECT request_id, task_id, attempt_id, channel_id, channel_name, model, protocol, connection_mode, role, attribution_scope, address, port,
                       SUM(upload), SUM(download)
                FROM traffic_events WHERE {condition}
                GROUP BY request_id, task_id, attempt_id, channel_id, channel_name, model, protocol, connection_mode, role, attribution_scope, address, port
                ORDER BY SUM(upload) + SUM(download) DESC""",
            values,
        ).fetchall()
        items = [
            _traffic_item(
                request_id=row_request_id,
                task_id=row_task_id,
                attempt_id=row_attempt_id,
                channel_id=channel,
                channel_name=name,
                model=row_model,
                protocol=row_protocol,
                connection_mode=mode,
                role=role,
                attribution_scope=scope,
                address=address,
                port=row_port,
                upload=upload,
                download=download,
            )
            for row_request_id, row_task_id, row_attempt_id, channel, name, row_model, row_protocol, mode, role, scope, address, row_port, upload, download in rows
        ]
        return {
            "start": start,
            "end": end,
            "uploadBytes": sum(item["uploadBytes"] for item in items),
            "downloadBytes": sum(item["downloadBytes"] for item in items),
            "totalBytes": sum(item["totalBytes"] for item in items),
            "boundary": "计量服务到上游代理或目标站的 TCP 字节流（含代理握手与 TLS 记录）；不含 IP/TCP 包头、重传、DNS UDP、代理后续跳点，不等同 ISP 或供应商账单。",
            "items": items,
            "options": self.options(),
        }

    def query_tasks(
        self,
        *,
        start: str | None = None,
        end: str | None = None,
        channel_id: str | None = None,
        model: str | None = None,
        protocol: str | None = None,
        connection_mode: str | None = None,
        port: int | None = None,
        request_id: str | None = None,
        task_id: str | None = None,
        attempt_id: str | None = None,
        page: int = 1,
        page_size: int = 20,
    ) -> dict[str, Any]:
        """Page task-level groups while keeping each group's route splits together."""

        page, page_size = _page_values(page, page_size)
        condition, values = _event_condition(
            start=start,
            end=end,
            channel_id=channel_id,
            model=model,
            protocol=protocol,
            connection_mode=connection_mode,
            port=port,
            request_id=request_id,
            task_id=task_id,
            attempt_id=attempt_id,
            task_only=True,
        )
        base = f"""WITH filtered AS (
                SELECT *, CASE WHEN task_id <> '' THEN 'task:' || task_id ELSE 'request:' || request_id END AS task_group_key
                FROM traffic_events WHERE {condition}
            ), task_groups AS (
                SELECT task_group_key,
                       MAX(NULLIF(task_id, '')) AS task_id,
                       CASE WHEN COUNT(DISTINCT NULLIF(request_id, '')) = 1 THEN MAX(NULLIF(request_id, '')) ELSE '' END AS request_id,
                       MIN(time_us) AS first_seen_us, MAX(time_us) AS last_seen_us,
                       SUM(upload) AS upload_bytes, SUM(download) AS download_bytes,
                       SUM(upload) + SUM(download) AS total_bytes
                FROM filtered
                GROUP BY task_group_key
            )"""
        total = int(self.db.execute(f"{base} SELECT COUNT(*) FROM task_groups", values).fetchone()[0])
        cursor = self.db.execute(
            f"""{base}, page_groups AS (
                    SELECT * FROM task_groups
                    ORDER BY total_bytes DESC, last_seen_us DESC, task_group_key
                    LIMIT ? OFFSET ?
                )
                SELECT page_groups.task_group_key, page_groups.task_id, page_groups.request_id,
                       page_groups.first_seen_us, page_groups.last_seen_us,
                       page_groups.upload_bytes, page_groups.download_bytes, page_groups.total_bytes,
                       filtered.request_id AS route_request_id, filtered.task_id AS route_task_id, filtered.attempt_id,
                       filtered.channel_id, filtered.channel_name, filtered.model, filtered.protocol,
                       filtered.connection_mode, filtered.role, filtered.attribution_scope, filtered.address, filtered.port,
                       MIN(filtered.time_us) AS route_first_seen_us, MAX(filtered.time_us) AS route_last_seen_us,
                       SUM(filtered.upload) AS route_upload_bytes, SUM(filtered.download) AS route_download_bytes
                FROM page_groups
                JOIN filtered ON filtered.task_group_key = page_groups.task_group_key
                GROUP BY page_groups.task_group_key, page_groups.task_id, page_groups.request_id,
                         page_groups.first_seen_us, page_groups.last_seen_us,
                         page_groups.upload_bytes, page_groups.download_bytes, page_groups.total_bytes,
                         filtered.request_id, filtered.task_id, filtered.attempt_id,
                         filtered.channel_id, filtered.channel_name, filtered.model, filtered.protocol,
                         filtered.connection_mode, filtered.role, filtered.attribution_scope, filtered.address, filtered.port
                ORDER BY page_groups.total_bytes DESC, page_groups.last_seen_us DESC, page_groups.task_group_key,
                         route_upload_bytes + route_download_bytes DESC, filtered.request_id, filtered.task_id, filtered.attempt_id, filtered.role""",
            [*values, page_size, (page - 1) * page_size],
        )
        columns = [item[0] for item in cursor.description]
        groups: dict[str, dict[str, Any]] = {}
        for raw in cursor.fetchall():
            row = dict(zip(columns, raw))
            key = str(row["task_group_key"])
            group = groups.setdefault(
                key,
                {
                    **({"taskId": str(row["task_id"])} if row["task_id"] else {}),
                    **({"requestId": str(row["request_id"])} if row["request_id"] else {}),
                    "firstSeenAt": _time_text(int(row["first_seen_us"])),
                    "lastSeenAt": _time_text(int(row["last_seen_us"])),
                    "uploadBytes": int(row["upload_bytes"] or 0),
                    "downloadBytes": int(row["download_bytes"] or 0),
                    "totalBytes": int(row["total_bytes"] or 0),
                    "items": [],
                },
            )
            group["items"].append(
                _traffic_item(
                    request_id=str(row["route_request_id"]),
                    task_id=str(row["route_task_id"]),
                    attempt_id=str(row["attempt_id"]),
                    channel_id=str(row["channel_id"]),
                    channel_name=str(row["channel_name"]),
                    model=str(row["model"]),
                    protocol=str(row["protocol"]),
                    connection_mode=str(row["connection_mode"]),
                    role=str(row["role"]),
                    attribution_scope=str(row["attribution_scope"]),
                    address=str(row["address"]),
                    port=int(row["port"]),
                    upload=int(row["route_upload_bytes"] or 0),
                    download=int(row["route_download_bytes"] or 0),
                    first_seen_us=int(row["route_first_seen_us"]),
                    last_seen_us=int(row["route_last_seen_us"]),
                )
            )
        return {"page": page, "pageSize": page_size, "total": total, "items": list(groups.values())}

    def query_requests(self, request_ids: Sequence[str] = (), *, task_ids: Sequence[str] = ()) -> dict[str, Any]:
        """Return exact request-log and generation-task breakdowns without time matching."""

        request_values = _correlation_ids(request_ids, "traffic_request_ids", required=False)
        task_values = _correlation_ids(task_ids, "traffic_task_ids", required=False)
        if not request_values and not task_values:
            raise TrafficMeterValidationError("traffic_lookup_ids_required")
        result: dict[str, Any] = {"items": self._request_groups_for_ids(request_values) if request_values else []}
        if task_values:
            result["tasks"] = self._task_groups_for_ids(task_values)
        return result

    def _request_groups_for_ids(self, ids: Sequence[str]) -> list[dict[str, Any]]:
        placeholders = ", ".join("?" for _ in ids)
        base = f"""WITH filtered AS (
                SELECT * FROM traffic_events
                WHERE attribution_scope <> ? AND request_id IN ({placeholders})
            ), request_groups AS (
                SELECT request_id,
                       MIN(time_us) AS first_seen_us, MAX(time_us) AS last_seen_us,
                       SUM(upload) AS upload_bytes, SUM(download) AS download_bytes,
                       SUM(upload) + SUM(download) AS total_bytes
                FROM filtered
                GROUP BY request_id
            )"""
        cursor = self.db.execute(
            f"""{base}
                SELECT request_groups.request_id,
                       request_groups.first_seen_us, request_groups.last_seen_us,
                       request_groups.upload_bytes, request_groups.download_bytes, request_groups.total_bytes,
                       filtered.task_id, filtered.attempt_id, filtered.channel_id, filtered.channel_name,
                       filtered.model, filtered.protocol, filtered.connection_mode, filtered.role,
                       filtered.attribution_scope, filtered.address, filtered.port,
                       MIN(filtered.time_us) AS route_first_seen_us, MAX(filtered.time_us) AS route_last_seen_us,
                       SUM(filtered.upload) AS route_upload_bytes, SUM(filtered.download) AS route_download_bytes
                FROM request_groups
                JOIN filtered ON filtered.request_id = request_groups.request_id
                GROUP BY request_groups.request_id,
                         request_groups.first_seen_us, request_groups.last_seen_us,
                         request_groups.upload_bytes, request_groups.download_bytes, request_groups.total_bytes,
                         filtered.task_id, filtered.attempt_id, filtered.channel_id, filtered.channel_name,
                         filtered.model, filtered.protocol, filtered.connection_mode, filtered.role,
                         filtered.attribution_scope, filtered.address, filtered.port
                ORDER BY request_groups.total_bytes DESC, request_groups.last_seen_us DESC, request_groups.request_id,
                         route_upload_bytes + route_download_bytes DESC, filtered.task_id, filtered.attempt_id, filtered.role""",
            ["shared_browser", *ids],
        )
        columns = [item[0] for item in cursor.description]
        groups: dict[str, dict[str, Any]] = {}
        for raw in cursor.fetchall():
            row = dict(zip(columns, raw))
            row_request_id = str(row["request_id"])
            group = groups.setdefault(
                row_request_id,
                {
                    "requestId": row_request_id,
                    "firstSeenAt": _time_text(int(row["first_seen_us"])),
                    "lastSeenAt": _time_text(int(row["last_seen_us"])),
                    "uploadBytes": int(row["upload_bytes"] or 0),
                    "downloadBytes": int(row["download_bytes"] or 0),
                    "totalBytes": int(row["total_bytes"] or 0),
                    "items": [],
                },
            )
            group["items"].append(
                _traffic_item(
                    request_id=row_request_id,
                    task_id=str(row["task_id"]),
                    attempt_id=str(row["attempt_id"]),
                    channel_id=str(row["channel_id"]),
                    channel_name=str(row["channel_name"]),
                    model=str(row["model"]),
                    protocol=str(row["protocol"]),
                    connection_mode=str(row["connection_mode"]),
                    role=str(row["role"]),
                    attribution_scope=str(row["attribution_scope"]),
                    address=str(row["address"]),
                    port=int(row["port"]),
                    upload=int(row["route_upload_bytes"] or 0),
                    download=int(row["route_download_bytes"] or 0),
                    first_seen_us=int(row["route_first_seen_us"]),
                    last_seen_us=int(row["route_last_seen_us"]),
                )
            )
        return list(groups.values())

    def _task_groups_for_ids(self, ids: Sequence[str]) -> list[dict[str, Any]]:
        placeholders = ", ".join("?" for _ in ids)
        base = f"""WITH filtered AS (
                SELECT * FROM traffic_events
                WHERE attribution_scope <> ? AND task_id IN ({placeholders})
            ), task_groups AS (
                SELECT task_id,
                       CASE WHEN COUNT(DISTINCT NULLIF(request_id, '')) = 1 THEN MAX(NULLIF(request_id, '')) ELSE '' END AS request_id,
                       MIN(time_us) AS first_seen_us, MAX(time_us) AS last_seen_us,
                       SUM(upload) AS upload_bytes, SUM(download) AS download_bytes,
                       SUM(upload) + SUM(download) AS total_bytes
                FROM filtered
                GROUP BY task_id
            )"""
        cursor = self.db.execute(
            f"""{base}
                SELECT task_groups.task_id, task_groups.request_id,
                       task_groups.first_seen_us, task_groups.last_seen_us,
                       task_groups.upload_bytes, task_groups.download_bytes, task_groups.total_bytes,
                       filtered.request_id AS route_request_id, filtered.attempt_id,
                       filtered.channel_id, filtered.channel_name, filtered.model, filtered.protocol,
                       filtered.connection_mode, filtered.role, filtered.attribution_scope, filtered.address, filtered.port,
                       MIN(filtered.time_us) AS route_first_seen_us, MAX(filtered.time_us) AS route_last_seen_us,
                       SUM(filtered.upload) AS route_upload_bytes, SUM(filtered.download) AS route_download_bytes
                FROM task_groups
                JOIN filtered ON filtered.task_id = task_groups.task_id
                GROUP BY task_groups.task_id, task_groups.request_id,
                         task_groups.first_seen_us, task_groups.last_seen_us,
                         task_groups.upload_bytes, task_groups.download_bytes, task_groups.total_bytes,
                         filtered.request_id, filtered.attempt_id,
                         filtered.channel_id, filtered.channel_name, filtered.model, filtered.protocol,
                         filtered.connection_mode, filtered.role, filtered.attribution_scope, filtered.address, filtered.port
                ORDER BY task_groups.total_bytes DESC, task_groups.last_seen_us DESC, task_groups.task_id,
                         route_upload_bytes + route_download_bytes DESC, filtered.request_id, filtered.attempt_id, filtered.role""",
            ["shared_browser", *ids],
        )
        columns = [item[0] for item in cursor.description]
        groups: dict[str, dict[str, Any]] = {}
        for raw in cursor.fetchall():
            row = dict(zip(columns, raw))
            row_task_id = str(row["task_id"])
            group = groups.setdefault(
                row_task_id,
                {
                    "taskId": row_task_id,
                    **({"requestId": str(row["request_id"])} if row["request_id"] else {}),
                    "firstSeenAt": _time_text(int(row["first_seen_us"])),
                    "lastSeenAt": _time_text(int(row["last_seen_us"])),
                    "uploadBytes": int(row["upload_bytes"] or 0),
                    "downloadBytes": int(row["download_bytes"] or 0),
                    "totalBytes": int(row["total_bytes"] or 0),
                    "items": [],
                },
            )
            group["items"].append(
                _traffic_item(
                    request_id=str(row["route_request_id"]),
                    task_id=row_task_id,
                    attempt_id=str(row["attempt_id"]),
                    channel_id=str(row["channel_id"]),
                    channel_name=str(row["channel_name"]),
                    model=str(row["model"]),
                    protocol=str(row["protocol"]),
                    connection_mode=str(row["connection_mode"]),
                    role=str(row["role"]),
                    attribution_scope=str(row["attribution_scope"]),
                    address=str(row["address"]),
                    port=int(row["port"]),
                    upload=int(row["route_upload_bytes"] or 0),
                    download=int(row["route_download_bytes"] or 0),
                    first_seen_us=int(row["route_first_seen_us"]),
                    last_seen_us=int(row["route_last_seen_us"]),
                )
            )
        return list(groups.values())

    def options(self) -> dict[str, Any]:
        channels = [
            {"id": row[0], **({"name": row[1]} if row[1] else {})}
            for row in self.db.execute("SELECT channel_id, MAX(channel_name) FROM traffic_events GROUP BY channel_id ORDER BY channel_id").fetchall()
        ]
        models = [row[0] for row in self.db.execute("SELECT DISTINCT model FROM traffic_events ORDER BY model").fetchall()]
        modes = [row[0] for row in self.db.execute("SELECT DISTINCT connection_mode FROM traffic_events ORDER BY connection_mode").fetchall()]
        return {"channels": channels, "models": models, "connectionModes": modes}

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        async with self._lock:
            relays = list(self.relays.values())
            self.relays.clear()
            self.references.clear()
        for relay in relays:
            await self._close_relay(relay)
        self.db.close()

    async def _start_relay(self, key: str, route: UpstreamRoute, context: TrafficContext, pinned_targets: Mapping[str, str]) -> Relay:
        remote = _remote_for_route(route)
        relay_holder: list[Relay | None] = [None]
        meter = self

        if route.proxy_url is not None and pinned_targets:
            # pproxy owns the HTTP CONNECT/SOCKS handshake.  Supplying a
            # registered IP here makes that handshake use the DNS answer the
            # caller already resolved, while the client-side tunnel continues
            # to carry its original HTTP Host header and TLS SNI unchanged.
            original_prepare_connection = remote.prepare_connection

            async def prepare_connection_with_pin(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, host: str, target_port: int):
                pinned = pinned_targets.get(_normalize_host(host))
                return await original_prepare_connection(reader, writer, pinned or host, target_port)

            remote.prepare_connection = prepare_connection_with_pin  # type: ignore[method-assign]

        async def connect(host: str, target_port: int, local_addr: Any, family: int):
            reader = asyncio.StreamReader()
            writer_holder: list[asyncio.StreamWriter | None] = [None]

            class Protocol(asyncio.StreamReaderProtocol):
                def data_received(self, data: bytes) -> None:
                    meter.record(context, route, download=len(data))
                    super().data_received(data)

                def connection_lost(self, exc: Exception | None) -> None:
                    writer = writer_holder[0]
                    relay = relay_holder[0]
                    if writer is not None and relay is not None:
                        relay.writers.discard(writer)
                    super().connection_lost(exc)

            protocol = Protocol(reader)
            destination_host, destination_port = remote.destination(host, target_port)
            if route.proxy_url is None:
                pinned = pinned_targets.get(_normalize_host(host))
                if pinned:
                    destination_host = pinned
            transport, _ = await asyncio.get_running_loop().create_connection(
                lambda: protocol,
                destination_host,
                destination_port,
                local_addr=local_addr,
                family=family,
            )
            writer = asyncio.StreamWriter(transport, protocol, reader, asyncio.get_running_loop())
            writer_holder[0] = writer
            original_write = writer.write

            def write(data: bytes) -> None:
                original_write(data)
                self.record(context, route, upload=len(data))

            writer.write = write  # type: ignore[method-assign]
            relay = relay_holder[0]
            if relay is not None:
                relay.writers.add(writer)
            return reader, writer

        remote.wait_open_connection = connect
        # pproxy consumes this value inside its compact URI grammar.  Hex keeps
        # the generated credential opaque without introducing URI delimiters.
        password = secrets.token_hex(32)
        bind_uri_host = _uri_host(self.bind_host)
        listener = pproxy.Server(f"http://{bind_uri_host}:0#traffic:{password}")
        listener.protos = [
            _CaseInsensitiveHTTPProxyProtocol(protocol.param) if type(protocol) is pproxy_proto.HTTP else protocol
            for protocol in listener.protos
        ]
        server = await listener.start_server({"rserver": [remote], "authtime": 0})
        socket = server.sockets[0] if server.sockets else None
        if socket is None:
            server.close()
            raise RuntimeError("traffic_meter_relay_socket_missing")
        public_uri_host = _uri_host(self.public_host)
        relay = Relay(key, server, f"http://traffic:{password}@{public_uri_host}:{socket.getsockname()[1]}", context, route)
        relay_holder[0] = relay
        return relay

    @staticmethod
    async def _close_relay(relay: Relay) -> None:
        relay.server.close()
        await relay.server.wait_closed()
        for writer in tuple(relay.writers):
            writer.close()
        for writer in tuple(relay.writers):
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass
        relay.writers.clear()


def _remote_for_route(route: UpstreamRoute):
    if route.proxy_url is None:
        from pproxy.server import ProxyDirect

        return ProxyDirect()
    parts = urlsplit(route.proxy_url)
    scheme = {"http": "http", "https": "http+ssl", "socks5": "socks5", "socks5h": "socks5"}[route.scheme]
    host = _uri_host(route.address)
    remote = pproxy.Connection(f"{scheme}://{host}:{route.port}")
    if parts.username is not None:
        remote.users = [f"{unquote(parts.username)}:{unquote(parts.password or '')}".encode()]
    if route.scheme == "https":
        remote.sslclient = ssl.create_default_context()
    return remote


def _parse_http_headers(raw_headers: bytes) -> tuple[str, str, str, str, str, str | None]:
    """Parse lookup fields with stdlib's case-insensitive header mapping.

    The forwarded header lines stay byte-for-byte intact except every
    case-insensitive ``Proxy-*`` field (and its folded continuations), so a
    relay credential cannot reach a target HTTP origin.
    """
    block = raw_headers[:-4] if raw_headers.endswith(b"\r\n\r\n") else raw_headers
    request_line, separator, field_lines = block.partition(b"\r\n")
    if not separator:
        raise ValueError("traffic_http_request_invalid")
    match = pproxy_proto.HTTP_LINE.match(request_line.decode("latin-1"))
    if match is None:
        raise ValueError("traffic_http_request_invalid")
    message = BytesHeaderParser(policy=policy.default).parsebytes(field_lines + b"\r\n\r\n")
    host = message.get("host", "")
    proxy_authorization = message.get("proxy-authorization")
    forwarded = _strip_proxy_headers(field_lines).decode("latin-1")
    return (*match.groups(), forwarded, str(host), str(proxy_authorization) if proxy_authorization is not None else None)


def _strip_proxy_headers(field_lines: bytes) -> bytes:
    forwarded: list[bytes] = []
    skip_continuation = False
    for line in field_lines.split(b"\r\n"):
        if line.startswith((b" ", b"\t")):
            if not skip_continuation:
                forwarded.append(line)
            continue
        name, separator, _value = line.partition(b":")
        skip_continuation = bool(separator) and name.strip().lower().startswith(b"proxy-")
        if not skip_continuation:
            forwarded.append(line)
    return b"\r\n".join(forwarded)


def _relay_key(route: UpstreamRoute, context: TrafficContext, pins: Mapping[str, str]) -> str:
    payload = {"route": route.fingerprint(), "context": context.payload(), "pins": dict(sorted(pins.items()))}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _range_us(start: str, end: str) -> tuple[int, int]:
    def parse(value: str) -> int:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise TrafficMeterValidationError("traffic_range_invalid") from error
        if parsed.tzinfo is None:
            raise TrafficMeterValidationError("traffic_range_timezone_required")
        return int(parsed.timestamp() * 1_000_000)

    begin, finish = parse(start), parse(end)
    if begin >= finish:
        raise TrafficMeterValidationError("traffic_range_invalid")
    return begin, finish


def _event_condition(
    *,
    start: str | None,
    end: str | None,
    channel_id: str | None,
    model: str | None,
    protocol: str | None,
    connection_mode: str | None,
    port: int | None,
    request_id: str | None,
    task_id: str | None,
    attempt_id: str | None,
    task_only: bool = False,
) -> tuple[str, list[Any]]:
    if (start is None) != (end is None):
        raise TrafficMeterValidationError("traffic_range_pair_required")
    if connection_mode and connection_mode not in CONNECTION_MODES:
        raise TrafficMeterValidationError("traffic_connection_mode_invalid")
    if port is not None and not 0 <= port <= 65535:
        raise TrafficMeterValidationError("traffic_port_invalid")
    where: list[str] = []
    values: list[Any] = []
    if start is not None and end is not None:
        begin, finish = _range_us(start, end)
        where.extend(("time_us >= ?", "time_us < ?"))
        values.extend((begin, finish))
    for column, value in (
        ("channel_id", channel_id),
        ("model", model),
        ("protocol", protocol),
        ("connection_mode", connection_mode),
        ("port", port),
        ("request_id", request_id),
        ("task_id", task_id),
        ("attempt_id", attempt_id),
    ):
        if value is not None and value != "":
            where.append(f"{column} = ?")
            values.append(value)
    if task_only:
        where.extend(("attribution_scope <> ?", "(task_id <> '' OR request_id <> '')"))
        values.append("shared_browser")
    return " AND ".join(where) if where else "1 = 1", values


def _page_values(page: int, page_size: int) -> tuple[int, int]:
    if isinstance(page, bool) or isinstance(page_size, bool) or not isinstance(page, int) or not isinstance(page_size, int):
        raise TrafficMeterValidationError("traffic_page_invalid")
    # The admin request-log list already uses 20 rows by default and caps a
    # page at 100; use that established resource contract for its meter detail.
    if page < 1 or not 1 <= page_size <= 100:
        raise TrafficMeterValidationError("traffic_page_invalid")
    return page, page_size


def _correlation_ids(value: Sequence[str], error_prefix: str, *, required: bool) -> list[str]:
    if isinstance(value, (str, bytes)):
        raise TrafficMeterValidationError(f"{error_prefix}_invalid")
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            raise TrafficMeterValidationError(f"{error_prefix}_invalid")
        text = _optional_text(item)
        if not text:
            raise TrafficMeterValidationError(f"{error_prefix}_invalid")
        if text not in seen:
            seen.add(text)
            result.append(text)
    if required and not result:
        raise TrafficMeterValidationError(f"{error_prefix}_required")
    return result


def _time_text(value: int) -> str:
    return datetime.fromtimestamp(value / 1_000_000, timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _traffic_item(
    *,
    channel_id: str,
    channel_name: str,
    model: str,
    protocol: str,
    connection_mode: str,
    role: str,
    attribution_scope: str,
    address: str,
    port: int,
    upload: int,
    download: int,
    request_id: str = "",
    task_id: str = "",
    attempt_id: str = "",
    first_seen_us: int | None = None,
    last_seen_us: int | None = None,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        **({"requestId": request_id} if request_id else {}),
        **({"taskId": task_id} if task_id else {}),
        **({"attemptId": attempt_id} if attempt_id else {}),
        "channelId": channel_id,
        **({"channelName": channel_name} if channel_name else {}),
        "model": model,
        "protocol": protocol,
        "connectionMode": connection_mode,
        "role": role,
        "attributionScope": attribution_scope,
        "address": address,
        "port": port,
        "uploadBytes": int(upload or 0),
        "downloadBytes": int(download or 0),
        "totalBytes": int(upload or 0) + int(download or 0),
    }
    if first_seen_us is not None:
        item["firstSeenAt"] = _time_text(first_seen_us)
    if last_seen_us is not None:
        item["lastSeenAt"] = _time_text(last_seen_us)
    return item


def _required_text(value: Any, error: str) -> str:
    text = _optional_text(value)
    if not text:
        raise TrafficMeterValidationError(error)
    return text


def _optional_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    text = value.strip()
    if len(text) > 512 or "\x00" in text:
        raise TrafficMeterValidationError("traffic_text_invalid")
    return text


def _normalize_host(value: str) -> str:
    normalized = value.strip().strip("[]").lower()
    if not normalized or "/" in normalized or "@" in normalized or "\x00" in normalized:
        raise TrafficMeterValidationError("traffic_host_invalid")
    return normalized


def _normalize_bind_host(value: str) -> str:
    return _normalize_host(value)


def _uri_host(value: str) -> str:
    return f"[{value}]" if ":" in value and not value.startswith("[") else value
