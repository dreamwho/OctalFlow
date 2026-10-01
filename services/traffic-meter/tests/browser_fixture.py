"""Local-only seed service used by the traffic-meter browser E2E fixture.

The fixture creates direct and independently ported HTTP-proxied loopback
routes, sends deterministic raw bytes through each relay, and exposes the
meter control plane on a dynamic loopback port. It never contacts an external
network.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

import pproxy
import uvicorn

from traffic_meter.core import TrafficContext, TrafficMeter
from traffic_meter.main import create_app


def _fixture_root() -> Path:
    configured = os.environ.get("DREAMYO_TRAFFIC_FIXTURE_DIR", "").strip()
    if configured:
        root = Path(configured).expanduser()
        root.mkdir(parents=True, exist_ok=True)
        return root
    return Path(tempfile.mkdtemp(prefix="dreamyo-traffic-e2e-"))


async def main() -> None:
    key = os.environ.get("TRAFFIC_METER_KEY", "").strip()
    if len(key) < 32:
        raise RuntimeError("TRAFFIC_METER_KEY must contain at least 32 characters")

    root = _fixture_root()
    meter = TrafficMeter(root / "traffic.sqlite3")

    async def start_echo_capture() -> tuple[asyncio.Server, int, dict[str, int]]:
        """Start a per-seed direct target and count its actual TCP stream."""

        stats = {"connections": 0, "uploadBytes": 0, "downloadBytes": 0}

        async def echo(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            stats["connections"] += 1
            try:
                while payload := await reader.read(65536):
                    stats["uploadBytes"] += len(payload)
                    writer.write(payload)
                    await writer.drain()
                    stats["downloadBytes"] += len(payload)
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_server(echo, "127.0.0.1", 0)
        return server, server.sockets[0].getsockname()[1], stats

    async def start_proxy_capture() -> tuple[asyncio.Server, object, int, dict[str, int]]:
        """Proxy bytes through an independently audited TCP forwarding socket.

        The outer socket is the actual upstream endpoint used by the meter. It
        forwards to a private pproxy listener and counts each direction before
        forwarding, so the manifest is independent from the meter SQLite query.
        A fresh pair is created for every seed, avoiding request association by
        timing or by a shared proxy connection.
        """

        inner = await pproxy.Server("http://127.0.0.1:0").start_server({"rserver": []})
        inner_port = inner.sockets[0].getsockname()[1]
        stats = {"connections": 0, "uploadBytes": 0, "downloadBytes": 0}

        async def forward(
            source: asyncio.StreamReader,
            destination: asyncio.StreamWriter,
            direction: str,
        ) -> None:
            try:
                while payload := await source.read(65536):
                    stats[direction] += len(payload)
                    destination.write(payload)
                    await destination.drain()
            except (ConnectionError, OSError, asyncio.IncompleteReadError):
                pass
            finally:
                try:
                    destination.write_eof()
                except (AttributeError, OSError, RuntimeError):
                    pass

        async def proxy(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            stats["connections"] += 1
            inner_reader: asyncio.StreamReader | None = None
            inner_writer: asyncio.StreamWriter | None = None
            try:
                inner_reader, inner_writer = await asyncio.open_connection("127.0.0.1", inner_port)
                await asyncio.gather(
                    forward(reader, inner_writer, "uploadBytes"),
                    forward(inner_reader, writer, "downloadBytes"),
                )
            except (ConnectionError, OSError, asyncio.IncompleteReadError):
                pass
            finally:
                writer.close()
                await writer.wait_closed()
                if inner_writer is not None:
                    inner_writer.close()
                    await inner_writer.wait_closed()

        server = await asyncio.start_server(proxy, "127.0.0.1", 0)
        return server, inner, server.sockets[0].getsockname()[1], stats

    async def close_server(server: asyncio.Server) -> None:
        server.close()
        await server.wait_closed()

    async def close_proxy_server(server: asyncio.Server, inner: object) -> None:
        await close_server(server)
        inner.close()  # type: ignore[attr-defined]
        await inner.wait_closed()  # type: ignore[attr-defined]

    async def seed(
        *,
        channel: str,
        model: str,
        mode: str,
        role: str,
        task_id: str,
        request_id: str,
        attempt_id: str,
        payload: bytes,
        route_kind: str | None,
    ) -> dict[str, object]:
        direct_server, direct_port, direct_stats = await start_echo_capture()
        proxy_server: asyncio.Server | None = None
        proxy_inner: object | None = None
        capture_stats = direct_stats
        capture_port = direct_port
        capture_source = "direct_target_capture"
        upstream_proxy_url: str | None = None
        if route_kind == "proxy":
            proxy_server, proxy_inner, capture_port, capture_stats = await start_proxy_capture()
            upstream_proxy_url = f"http://127.0.0.1:{capture_port}"
            capture_source = "upstream_proxy_capture"
        elif route_kind is not None:
            raise RuntimeError(f"fixture_route_kind_invalid:{route_kind}")

        context = TrafficContext.from_mapping(
            {
                "channelId": channel,
                "channelName": channel,
                "model": model,
                "protocol": "openai",
                "connectionMode": mode,
                "role": role,
                "taskId": task_id,
                "requestId": request_id,
                "attemptId": attempt_id,
            }
        )
        lease: str | None = None
        try:
            lease, proxy = await meter.create_lease(upstream_proxy_url, context)
            parts = urlsplit(proxy)
            client = pproxy.Connection(f"http://{parts.hostname}:{parts.port}#{parts.username}:{parts.password}")
            reader, writer = await client.tcp_connect("127.0.0.1", direct_port)
            writer.write(payload)
            await writer.drain()
            assert await reader.readexactly(len(payload)) == payload
            writer.close()
            await writer.wait_closed()
            raw_bytes = {
                "uploadBytes": capture_stats["uploadBytes"],
                "downloadBytes": capture_stats["downloadBytes"],
                "totalBytes": capture_stats["uploadBytes"] + capture_stats["downloadBytes"],
            }
            return {
                "taskId": task_id,
                "requestId": request_id,
                "attemptId": attempt_id,
                "channelId": channel,
                "model": model,
                "role": role,
                "connectionMode": mode,
                "payloadBytes": len(payload),
                "rawBytes": raw_bytes,
                "wireAudit": {
                    "source": capture_source,
                    "requestId": request_id,
                    "port": capture_port,
                    "connectionCount": capture_stats["connections"],
                },
                "upstreamPort": capture_port,
            }
        finally:
            if lease is not None:
                await meter.release(lease)
            if proxy_server is not None and proxy_inner is not None:
                await close_proxy_server(proxy_server, proxy_inner)
            await close_server(direct_server)

    seeded_requests = await asyncio.gather(
        # 7 * 128 = 896 bytes in both the upload and echoed download paths.
        seed(
            channel="e2e-primary",
            model="e2e-image",
            mode="direct",
            role="upload",
            task_id="e2e-task-image",
            request_id="e2e-request-image",
            attempt_id="e2e-attempt-image-upload",
            payload=b"fixture" * 128,
            route_kind=None,
        ),
        # Keep the historic magic/generic seeds for existing browser checks.
        seed(
            channel="e2e-primary",
            model="e2e-video",
            mode="magic",
            role="upload",
            task_id="e2e-task-video",
            request_id="e2e-request-video",
            attempt_id="e2e-attempt-video-upload",
            payload=b"fixture" * 73,
            route_kind="proxy",
        ),
        seed(
            channel="e2e-backup",
            model="e2e-text",
            mode="generic",
            role="upload",
            task_id="e2e-task-text",
            request_id="e2e-request-text",
            attempt_id="e2e-attempt-text-upload",
            payload=b"fixture" * 29,
            route_kind="proxy",
        ),
        # The same task/request crosses a second, independently bound HTTP
        # upstream port.  The body is intentionally short and deterministic.
        seed(
            channel="e2e-primary",
            model="e2e-image",
            mode="chained",
            role="submit",
            task_id="e2e-task-image",
            request_id="e2e-request-image",
            attempt_id="e2e-attempt-image-submit",
            payload=b"submit-body",
            route_kind="proxy",
        ),
    )

    def request_expected(items: list[dict[str, object]], request_id: str) -> dict[str, object]:
        matching = [item for item in items if item["requestId"] == request_id]
        if not matching:
            raise RuntimeError(f"fixture_request_missing:{request_id}")
        task_id = str(matching[0]["taskId"])
        raw_upload = sum(int(item["rawBytes"]["uploadBytes"]) for item in matching)  # type: ignore[index]
        raw_download = sum(int(item["rawBytes"]["downloadBytes"]) for item in matching)  # type: ignore[index]
        payload_upload = sum(int(item["payloadBytes"]) for item in matching)
        routes: dict[str, object] = {}
        for item in matching:
            route_name = str(item["role"])
            if route_name in routes:
                route_name = f"{route_name}:{item['attemptId']}"
            routes[route_name] = {
                "mode": item["connectionMode"],
                "port": item["upstreamPort"],
                "payloadBytes": item["payloadBytes"],
                "rawBytes": item["rawBytes"],
                "wireAudit": item["wireAudit"],
            }
        return {
            "taskId": task_id,
            "uploadBytes": raw_upload,
            "downloadBytes": raw_download,
            "totalBytes": raw_upload + raw_download,
            "roles": [str(item["role"]) for item in matching],
            "payloadBytes": {"uploadBytes": payload_upload, "downloadBytes": payload_upload, "totalBytes": payload_upload * 2},
            "routes": routes,
        }

    raw_expected = {
        request_id: request_expected(seeded_requests, request_id)
        for request_id in ("e2e-request-image", "e2e-request-video", "e2e-request-text")
    }
    payload_expected = {
        request_id: {
            "taskId": report["taskId"],
            "uploadBytes": report["payloadBytes"]["uploadBytes"],
            "downloadBytes": report["payloadBytes"]["downloadBytes"],
            "totalBytes": report["payloadBytes"]["totalBytes"],
        }
        for request_id, report in raw_expected.items()
    }
    by_request = {str(item["requestId"]): item for item in seeded_requests}
    image_upload = next(item for item in seeded_requests if item["attemptId"] == "e2e-attempt-image-upload")
    image_submit = next(item for item in seeded_requests if item["attemptId"] == "e2e-attempt-image-submit")
    video = by_request["e2e-request-video"]
    text = by_request["e2e-request-text"]
    proxy = int(video["upstreamPort"])
    generic_proxy = int(text["upstreamPort"])
    chained_proxy = int(image_submit["upstreamPort"])
    direct_origin = int(image_upload["upstreamPort"])

    control = socket.socket()
    control.bind(("127.0.0.1", 0))
    control.listen()
    port = control.getsockname()[1]
    ports_path = root / "ports.json"
    ports_path.write_text(
        json.dumps(
            {
                "meter": port,
                "proxy": proxy,
                "genericProxy": generic_proxy,
                "chainedProxy": chained_proxy,
                "origin": direct_origin,
                "directUpload": 896,
                "directDownload": 896,
                "directRaw": image_upload["rawBytes"],
                "splitPorts": {
                    "direct": direct_origin,
                    "magic": proxy,
                    "generic": generic_proxy,
                    "chained": chained_proxy,
                },
                "meterPorts": {"direct": 0, "magic": proxy, "generic": generic_proxy, "chained": chained_proxy},
                "payloadExpected": payload_expected,
                "rawExpected": raw_expected,
                "seededRequests": seeded_requests,
            }
        ),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "fixtureDir": str(root),
                "portsPath": str(ports_path),
                "meter": port,
                "proxy": proxy,
                "seeded": True,
            }
        ),
        flush=True,
    )

    server = uvicorn.Server(uvicorn.Config(create_app(meter), log_level="warning"))
    try:
        await server.serve(sockets=[control])
    finally:
        pass


if __name__ == "__main__":
    asyncio.run(main())
