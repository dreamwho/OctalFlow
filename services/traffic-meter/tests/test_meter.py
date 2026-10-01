import asyncio
import base64
import shutil
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import pproxy
import pytest

from traffic_meter.client import TrafficMeterClient, request_proxy, request_proxy_sync
from traffic_meter.core import PinnedTarget, TrafficContext, TrafficMeter, TrafficMeterValidationError, UpstreamRoute
from traffic_meter.main import create_app


def _context(
    *,
    model: str = "dola-seedance-2-5",
    role: str = "submit",
    mode: str = "direct",
    request_id: str = "",
    task_id: str = "",
    attempt_id: str = "",
) -> TrafficContext:
    return TrafficContext.from_mapping(
        {
            "channelId": "dola",
            "channelName": "Dola API",
            "model": model,
            "protocol": "protocol-page-signed",
            "connectionMode": mode,
            "role": role,
            **({"requestId": request_id} if request_id else {}),
            **({"taskId": task_id} if task_id else {}),
            **({"attemptId": attempt_id} if attempt_id else {}),
        }
    )


async def _exchange(proxy_url: str, host: str, port: int, payload: bytes) -> bytes:
    parts = urlsplit(proxy_url)
    client = pproxy.Connection(f"http://{parts.hostname}:{parts.port}#{parts.username}:{parts.password}")
    reader, writer = await client.tcp_connect(host, port)
    writer.write(payload)
    await writer.drain()
    response = await reader.readexactly(len(payload))
    writer.close()
    await writer.wait_closed()
    return response


def _header_names(headers: bytes, *, preserve_case: bool = False) -> set[bytes]:
    names = set()
    for line in headers.split(b"\r\n")[1:]:
        name, separator, _value = line.partition(b":")
        if separator:
            names.add(name if preserve_case else name.lower())
    return names


@pytest.mark.anyio
async def test_raw_tcp_bytes_are_grouped_by_context_and_relay_leases_are_reference_counted(tmp_path):
    async def echo(reader, writer):
        try:
            payload = await reader.readexactly(37)
            writer.write(payload[::-1])
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    origin = await asyncio.start_server(echo, "127.0.0.1", 0)
    meter = TrafficMeter(tmp_path / "traffic.sqlite3")
    port = origin.sockets[0].getsockname()[1]
    try:
        first_id, first_proxy = await meter.create_lease(None, _context())
        second_id, second_proxy = await meter.create_lease(None, _context())
        assert first_proxy == second_proxy
        payloads = [bytes([index]) * 37 for index in range(1, 4)]
        assert await asyncio.gather(*(_exchange(first_proxy, "127.0.0.1", port, payload) for payload in payloads)) == [payload[::-1] for payload in payloads]
        assert await meter.release(first_id)
        # Releasing one owner cannot tear down a browser/HTTPX peer's relay.
        assert await _exchange(second_proxy, "127.0.0.1", port, b"x" * 37) == b"x" * 37
        stats = meter.query("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z")
        assert "代理握手" in stats["boundary"] and "TLS 记录" in stats["boundary"]
        assert stats["uploadBytes"] == stats["downloadBytes"] == 37 * 4
        assert stats["items"] == [
            {
                "channelId": "dola",
                "channelName": "Dola API",
                "model": "dola-seedance-2-5",
                "protocol": "protocol-page-signed",
                "connectionMode": "direct",
                "role": "submit",
                "attributionScope": "exact",
                "address": "直连",
                "port": 0,
                "uploadBytes": 37 * 4,
                "downloadBytes": 37 * 4,
                "totalBytes": 37 * 8,
            }
        ]
        assert await meter.release(second_id)
        assert not meter.relays
    finally:
        await meter.close()
        origin.close()
        await origin.wait_closed()


@pytest.mark.anyio
async def test_real_tcp_task_and_request_breakdowns_keep_retry_routes_together(tmp_path):
    expected_lengths = iter((29, 41, 17))

    async def echo(reader, writer):
        try:
            payload = await reader.readexactly(next(expected_lengths))
            writer.write(payload)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    origin = await asyncio.start_server(echo, "127.0.0.1", 0)
    meter = TrafficMeter(tmp_path / "traffic.sqlite3")
    port = origin.sockets[0].getsockname()[1]
    upload = _context(role="upload", mode="magic", request_id="dola-log-upload", task_id="generation-task-1", attempt_id="dola-attempt-1")
    submit = _context(role="submit", mode="chained", request_id="dola-log-submit", task_id="generation-task-1", attempt_id="dola-attempt-2")
    unrelated = _context(role="submit", mode="direct", request_id="dola-log-other", task_id="generation-task-2", attempt_id="dola-attempt-3")
    try:
        upload_lease, upload_proxy = await meter.create_lease(None, upload)
        submit_lease, submit_proxy = await meter.create_lease(None, submit)
        other_lease, other_proxy = await meter.create_lease(None, unrelated)
        assert await _exchange(upload_proxy, "127.0.0.1", port, b"u" * 29) == b"u" * 29
        assert await _exchange(submit_proxy, "127.0.0.1", port, b"s" * 41) == b"s" * 41
        assert await _exchange(other_proxy, "127.0.0.1", port, b"o" * 17) == b"o" * 17

        task_page = meter.query_tasks(page=1, page_size=20)
        assert task_page["total"] == 2
        grouped = next(item for item in task_page["items"] if item.get("taskId") == "generation-task-1")
        assert "requestId" not in grouped
        assert (grouped["uploadBytes"], grouped["downloadBytes"], grouped["totalBytes"]) == (70, 70, 140)
        split = {item["requestId"]: item for item in grouped["items"]}
        assert split["dola-log-upload"]["connectionMode"] == "magic"
        assert split["dola-log-upload"]["role"] == "upload"
        assert split["dola-log-upload"]["attemptId"] == "dola-attempt-1"
        assert split["dola-log-upload"]["totalBytes"] == 58
        assert split["dola-log-submit"]["connectionMode"] == "chained"
        assert split["dola-log-submit"]["role"] == "submit"
        assert split["dola-log-submit"]["attemptId"] == "dola-attempt-2"
        assert split["dola-log-submit"]["totalBytes"] == 82

        assert meter.query("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z", request_id="dola-log-upload")["totalBytes"] == 58
        assert meter.query_tasks(task_id="generation-task-1", page=1, page_size=20)["total"] == 1
        report = meter.query_requests(["dola-log-upload", "dola-log-submit"], task_ids=["generation-task-1"])
        assert {item["requestId"] for item in report["items"]} == {"dola-log-upload", "dola-log-submit"}
        assert {item["taskId"] for item in report["tasks"]} == {"generation-task-1"}
        assert sum(item["totalBytes"] for item in report["items"]) == 140
        assert report["tasks"][0]["totalBytes"] == 140
        assert all(item["requestId"] != "dola-log-other" for item in report["items"])

        assert await meter.release(upload_lease)
        assert await meter.release(submit_lease)
        assert await meter.release(other_lease)
    finally:
        await meter.close()
        origin.close()
        await origin.wait_closed()


@pytest.mark.anyio
async def test_direct_relay_uses_only_the_registered_dns_pin(tmp_path):
    async def echo(reader, writer):
        try:
            payload = await reader.readexactly(6)
            writer.write(payload)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    origin = await asyncio.start_server(echo, "127.0.0.1", 0)
    meter = TrafficMeter(tmp_path / "traffic.sqlite3")
    port = origin.sockets[0].getsockname()[1]
    try:
        lease_id, proxy_url = await meter.create_lease(
            None,
            _context(),
            [PinnedTarget.from_mapping({"hostname": "pin-does-not-resolve.invalid", "address": "127.0.0.1"})],
        )
        assert await _exchange(proxy_url, "pin-does-not-resolve.invalid", port, b"pinned") == b"pinned"
        assert await meter.release(lease_id)
    finally:
        await meter.close()
        origin.close()
        await origin.wait_closed()


@pytest.mark.anyio
async def test_undici_lowercase_proxy_headers_authenticate_without_reaching_the_http_origin(tmp_path):
    node = shutil.which("node")
    web_root = Path(__file__).resolve().parents[3] / "web"
    if node is None or not (web_root / "node_modules" / "undici").exists():
        pytest.skip("requires the workspace Node.js and undici fixture")

    origin_header_names = []
    origin_request_count = 0

    async def origin(reader, writer):
        nonlocal origin_request_count
        try:
            while not reader.at_eof():
                try:
                    headers = await reader.readuntil(b"\r\n\r\n")
                except asyncio.IncompleteReadError:
                    return
                origin_request_count += 1
                origin_header_names.append(_header_names(headers))
                closing = origin_request_count >= 2
                writer.write(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: "
                    + (b"close" if closing else b"keep-alive")
                    + b"\r\n\r\nmeter-ok"
                )
                await writer.drain()
                if closing:
                    return
        finally:
            writer.close()
            await writer.wait_closed()

    origin_server = await asyncio.start_server(origin, "127.0.0.1", 0)
    meter = TrafficMeter(tmp_path / "traffic.sqlite3")
    front_server = None
    try:
        lease_id, relay_proxy_url = await meter.create_lease(None, _context())
        relay_parts = urlsplit(relay_proxy_url)
        received_header_names = []

        async def recording_forwarder(reader, writer):
            upstream_writer = None
            try:
                headers = await reader.readuntil(b"\r\n\r\n")
                received_header_names.append(_header_names(headers, preserve_case=True))
                upstream_reader, upstream_writer = await asyncio.open_connection(relay_parts.hostname, relay_parts.port)
                upstream_writer.write(headers)
                await upstream_writer.drain()

                async def pipe(source, destination):
                    try:
                        while data := await source.read(65536):
                            destination.write(data)
                            await destination.drain()
                    finally:
                        destination.close()

                await asyncio.gather(pipe(reader, upstream_writer), pipe(upstream_reader, writer))
            finally:
                if upstream_writer is not None:
                    upstream_writer.close()
                writer.close()

        front_server = await asyncio.start_server(recording_forwarder, "127.0.0.1", 0)
        front_port = front_server.sockets[0].getsockname()[1]
        proxy_url = f"http://{relay_parts.username}:{relay_parts.password}@127.0.0.1:{front_port}"
        origin_url = f"http://127.0.0.1:{origin_server.sockets[0].getsockname()[1]}"
        script = """
const { ProxyAgent, request } = require('undici');
(async () => {
  const agent = new ProxyAgent({ uri: process.argv[1], proxyTunnel: false, connections: 1 });
  try {
    for (const path of ['/first', '/second']) {
      const response = await request(process.argv[2] + path, { dispatcher: agent });
      if (response.statusCode !== 200 || await response.body.text() !== 'meter-ok') process.exitCode = 1;
    }
  } catch (_) {
    process.exitCode = 1;
  } finally {
    await agent.close();
  }
})();
"""
        process = await asyncio.create_subprocess_exec(
            node,
            "-e",
            script,
            proxy_url,
            origin_url,
            cwd=web_root,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            await asyncio.wait_for(process.wait(), timeout=15)
        except TimeoutError:
            process.kill()
            await process.wait()
            pytest.fail("Undici proxy fixture did not complete")
        assert process.returncode == 0
        assert len(received_header_names) == 2
        assert all(b"host" in names and b"proxy-authorization" in names for names in received_header_names)
        assert all(b"Host" not in names and b"Proxy-Authorization" not in names for names in received_header_names)
        assert len(origin_header_names) == 2
        assert all(not any(name.lower().startswith(b"proxy-") for name in names) for names in origin_header_names)
        assert await meter.release(lease_id)
    finally:
        await meter.close()
        if front_server is not None:
            front_server.close()
            await front_server.wait_closed()
        origin_server.close()
        await origin_server.wait_closed()


@pytest.mark.anyio
async def test_lowercase_proxy_authorization_is_stripped_on_a_persistent_http_proxy_connection(tmp_path):
    origin_header_names = []

    async def origin(reader, writer):
        try:
            for index in range(2):
                headers = await reader.readuntil(b"\r\n\r\n")
                origin_header_names.append(_header_names(headers))
                writer.write(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: "
                    + (b"close" if index else b"keep-alive")
                    + b"\r\n\r\nok"
                )
                await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    origin_server = await asyncio.start_server(origin, "127.0.0.1", 0)
    meter = TrafficMeter(tmp_path / "traffic.sqlite3")
    try:
        lease_id, proxy_url = await meter.create_lease(None, _context())
        parts = urlsplit(proxy_url)
        authorization = base64.b64encode(f"{parts.username}:{parts.password}".encode()).decode()
        reader, writer = await asyncio.open_connection(parts.hostname, parts.port)

        async def request(path: str) -> None:
            writer.write(
                f"GET http://127.0.0.1:{origin_server.sockets[0].getsockname()[1]}{path} HTTP/1.1\r\n"
                f"host: 127.0.0.1:{origin_server.sockets[0].getsockname()[1]}\r\n"
                f"proxy-authorization: Basic {authorization}\r\n"
                "connection: keep-alive\r\n\r\n".encode()
            )
            await writer.drain()
            response_headers = await reader.readuntil(b"\r\n\r\n")
            assert response_headers.split(b"\r\n", 1)[0] == b"HTTP/1.1 200 OK"
            assert await reader.readexactly(2) == b"ok"

        await request("/first")
        await request("/second")
        writer.close()
        await writer.wait_closed()
        assert len(origin_header_names) == 2
        assert all(not any(name.lower().startswith(b"proxy-") for name in names) for names in origin_header_names)
        assert await meter.release(lease_id)
    finally:
        await meter.close()
        origin_server.close()
        await origin_server.wait_closed()


@pytest.mark.anyio
async def test_http_proxy_route_uses_registered_dns_pin_in_native_connect_handshake_and_preserves_tls_sni(tmp_path):
    import ssl
    from datetime import timedelta

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    hostname = "pin-does-not-resolve.invalid"
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = datetime.now(timezone.utc)
    subject = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, hostname)])
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(hostname)]), critical=False)
        .sign(key, hashes.SHA256())
    )
    cert_path, key_path = tmp_path / "pin-cert.pem", tmp_path / "pin-key.pem"
    cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(cert_path, key_path)
    observed_sni = []
    server_context.set_servername_callback(lambda _socket, server_name, _context: observed_sni.append(server_name))

    async def echo(reader, writer):
        try:
            payload = await reader.readexactly(12)
            writer.write(payload[::-1])
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    origin = await asyncio.start_server(echo, "127.0.0.1", 0, ssl=server_context)
    origin_port = origin.sockets[0].getsockname()[1]
    observed_connects = []

    async def strict_http_proxy(reader, writer):
        origin_writer = None
        try:
            headers = await reader.readuntil(b"\r\n\r\n")
            connect_line = headers.split(b"\r\n", 1)[0].decode("ascii")
            observed_connects.append(connect_line)
            expected = f"CONNECT 127.0.0.1:{origin_port} HTTP/1.1"
            if connect_line != expected:
                writer.write(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
                await writer.drain()
                return
            origin_reader, origin_writer = await asyncio.open_connection("127.0.0.1", origin_port)
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()

            async def pipe(source, destination):
                try:
                    while data := await source.read(65536):
                        destination.write(data)
                        await destination.drain()
                finally:
                    destination.close()

            await asyncio.gather(pipe(reader, origin_writer), pipe(origin_reader, writer))
        finally:
            if origin_writer is not None:
                origin_writer.close()
            writer.close()

    upstream = await asyncio.start_server(strict_http_proxy, "127.0.0.1", 0)
    meter = TrafficMeter(tmp_path / "traffic.sqlite3")
    try:
        lease_id, proxy_url = await meter.create_lease(
            f"http://127.0.0.1:{upstream.sockets[0].getsockname()[1]}",
            _context(mode="generic"),
            [PinnedTarget.from_mapping({"hostname": hostname, "address": "127.0.0.1"})],
        )
        parts = urlsplit(proxy_url)
        client = pproxy.Connection(f"http://{parts.hostname}:{parts.port}#{parts.username}:{parts.password}")
        reader, writer = await client.tcp_connect(hostname, origin_port)
        client_context = ssl.create_default_context()
        client_context.check_hostname = False
        client_context.verify_mode = ssl.CERT_NONE
        await writer.start_tls(client_context, server_hostname=hostname)
        writer.write(b"pinned-proxy")
        await writer.drain()
        assert await reader.readexactly(12) == b"yxorp-dennip"
        writer.close()
        await writer.wait_closed()
        assert observed_connects == [f"CONNECT 127.0.0.1:{origin_port} HTTP/1.1"]
        assert observed_sni == [hostname]
        assert await meter.release(lease_id)
    finally:
        await meter.close()
        upstream.close()
        await upstream.wait_closed()
        origin.close()
        await origin.wait_closed()


@pytest.mark.anyio
async def test_https_proxy_route_counts_the_tls_transport_not_http_metadata(tmp_path, monkeypatch):
    import ssl
    from datetime import timedelta
    from ipaddress import ip_address

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from pproxy.server import stream_handler

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = datetime.now(timezone.utc)
    subject = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, "localhost")])
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ip_address("127.0.0.1"))]), critical=False)
        .sign(key, hashes.SHA256())
    )
    cert_path, key_path = tmp_path / "cert.pem", tmp_path / "key.pem"
    cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))

    async def echo(reader, writer):
        try:
            payload = await reader.readexactly(100)
            writer.write(payload[::-1])
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    origin = await asyncio.start_server(echo, "127.0.0.1", 0)
    upstream_received, upstream_sent = [], []

    async def measured_handler(reader, writer, **kwargs):
        protocol = reader._transport.get_protocol()
        received = protocol.data_received

        def observe_received(data):
            upstream_received.append(len(data))
            received(data)

        protocol.data_received = observe_received
        written = writer.write

        def observe_write(data):
            upstream_sent.append(len(data))
            written(data)

        writer.write = observe_write
        await stream_handler(reader, writer, **kwargs)

    upstream_server = pproxy.Server("http+ssl://127.0.0.1:0")
    upstream_server.sslserver.load_cert_chain(cert_path, key_path)
    upstream = await upstream_server.start_server({"rserver": []}, stream_handler=measured_handler)
    upstream_port = upstream.sockets[0].getsockname()[1]
    original_context = ssl.create_default_context
    monkeypatch.setattr("traffic_meter.core.ssl.create_default_context", lambda *args, **kwargs: original_context(*args, cafile=cert_path, **kwargs))
    meter = TrafficMeter(tmp_path / "traffic.sqlite3")
    try:
        lease_id, proxy_url = await meter.create_lease(f"https://127.0.0.1:{upstream_port}", _context(mode="generic"))
        assert await _exchange(proxy_url, "127.0.0.1", origin.sockets[0].getsockname()[1], b"t" * 100) == b"t" * 100
        await asyncio.sleep(0)
        stats = meter.query("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z", port=upstream_port)
        assert stats["uploadBytes"] == sum(upstream_received)
        assert stats["downloadBytes"] == sum(upstream_sent)
        assert stats["uploadBytes"] > 100 and stats["downloadBytes"] > 100
        assert await meter.release(lease_id)
    finally:
        await meter.close()
        upstream.close()
        await upstream.wait_closed()
        origin.close()
        await origin.wait_closed()


def test_time_window_filters_and_shared_browser_attribution_are_explicit(tmp_path):
    meter = TrafficMeter(tmp_path / "traffic.sqlite3")
    stamp = int(datetime(2026, 10, 1, tzinfo=timezone.utc).timestamp() * 1_000_000)
    direct = UpstreamRoute.from_proxy_url(None)
    generic = UpstreamRoute.from_proxy_url("http://proxy.example:8080")
    exact = _context()
    shared = TrafficContext.from_mapping(
        {
            "channelId": "dola",
            "channelName": "Dola API",
            "model": "__shared_browser__",
            "protocol": "camoufox-page",
            "connectionMode": "generic",
            "role": "browser",
            "attributionScope": "shared_browser",
        }
    )
    meter.record(exact, direct, upload=3, download=5, time_us=stamp - 1)
    meter.record(exact, direct, upload=7, download=11, time_us=stamp)
    meter.record(shared, generic, upload=13, download=17, time_us=stamp + 999_999)
    meter.record(shared, generic, upload=19, download=23, time_us=stamp + 1_000_000)
    data = meter.query("2026-10-01T08:00:00+08:00", "2026-10-01T08:00:01+08:00")
    assert (data["uploadBytes"], data["downloadBytes"], data["totalBytes"]) == (20, 28, 48)
    assert meter.query(data["start"], data["end"], model="__shared_browser__")["totalBytes"] == 30
    assert meter.query(data["start"], data["end"], protocol="camoufox-page")["totalBytes"] == 30
    assert meter.query(data["start"], data["end"], connection_mode="direct", port=0)["totalBytes"] == 18
    assert data["options"] == {
        "channels": [{"id": "dola", "name": "Dola API"}],
        "models": ["__shared_browser__", "dola-seedance-2-5"],
        "connectionModes": ["direct", "generic"],
    }
    with pytest.raises(TrafficMeterValidationError, match="traffic_shared_browser_model_required"):
        TrafficContext.from_mapping({**shared.payload(), "model": "dola-seedance-2-5"})
    with pytest.raises(TrafficMeterValidationError, match="traffic_shared_browser_correlation_forbidden"):
        TrafficContext.from_mapping({**shared.payload(), "requestId": "dola-log-1"})
    meter.db.close()


@pytest.mark.anyio
async def test_private_control_plane_authenticates_leases_and_filters(tmp_path, monkeypatch):
    monkeypatch.setenv("TRAFFIC_METER_KEY", "test-key")
    meter = TrafficMeter(tmp_path / "traffic.sqlite3")
    app = create_app(meter)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://meter") as client:
            body = {"proxyUrl": None, "context": _context().payload()}
            assert (await client.post("/internal/leases", json=body)).status_code == 401
            created = await client.post("/internal/leases", json=body, headers={"X-Traffic-Key": "test-key"})
            assert created.status_code == 200
            lease = created.json()
            assert lease["leaseId"] and lease["proxyUrl"].startswith("http://traffic:")
            queried = await client.get(
                "/internal/traffic",
                params={"start": "2026-10-01T00:00:00Z", "end": "2026-10-02T00:00:00Z", "channelId": "dola"},
                headers={"X-Traffic-Key": "test-key"},
            )
            assert queried.status_code == 200
            assert queried.json()["items"] == []
            meter.record(_context(request_id="dola-log-1", task_id="generation-task-1", attempt_id="attempt-1"), UpstreamRoute.from_proxy_url(None), upload=3, download=5)
            task_report = await client.get(
                "/internal/traffic/tasks",
                params={"taskId": "generation-task-1", "page": 1, "pageSize": 20},
                headers={"X-Traffic-Key": "test-key"},
            )
            assert task_report.status_code == 200
            assert task_report.json()["items"][0]["items"][0]["attemptId"] == "attempt-1"
            request_report = await client.post(
                "/internal/traffic/requests",
                json={"requestIds": ["dola-log-1"], "taskIds": ["generation-task-1"]},
                headers={"X-Traffic-Key": "test-key"},
            )
            assert request_report.status_code == 200
            assert request_report.json()["items"][0]["totalBytes"] == 8
            assert request_report.json()["tasks"][0]["taskId"] == "generation-task-1"
            assert (await client.post("/internal/traffic/requests", json={}, headers={"X-Traffic-Key": "test-key"})).status_code == 422
            assert (await client.delete(f"/internal/leases/{lease['leaseId']}", headers={"X-Traffic-Key": "test-key"})).json() == {"released": True}


@pytest.mark.anyio
async def test_async_python_client_holds_then_releases_one_lease_and_forwards_protocol_filter(monkeypatch):
    import traffic_meter.client as client_module

    requests = []

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def request(self, method, url, **kwargs):
            requests.append((method, url, kwargs))
            if method == "POST":
                return httpx.Response(200, json={"leaseId": "lease_1", "proxyUrl": "http://traffic:secret@meter:1234"})
            return httpx.Response(200, json={"items": []})

    monkeypatch.setattr(client_module.httpx, "AsyncClient", FakeClient)
    client = TrafficMeterClient("http://meter", "secret")
    async with request_proxy(None, _context().payload(), client=client) as proxy_url:
        assert proxy_url == "http://traffic:secret@meter:1234"
    assert [item[0] for item in requests[:2]] == ["POST", "DELETE"]
    assert requests[0][2]["headers"] == {"X-Traffic-Key": "secret"}
    await client.query("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z", protocol="protocol-page-signed")
    assert requests[-1][2]["params"]["protocol"] == "protocol-page-signed"
    await client.query_tasks(taskId="generation-task-1", page=2, pageSize=20)
    assert requests[-1][1].endswith("/internal/traffic/tasks")
    assert requests[-1][2]["params"] == {"taskId": "generation-task-1", "page": "2", "pageSize": "20"}
    await client.query_requests(["dola-log-1"], taskIds=["generation-task-1"])
    assert requests[-1][1].endswith("/internal/traffic/requests")
    assert requests[-1][2]["json"] == {"requestIds": ["dola-log-1"], "taskIds": ["generation-task-1"]}


def test_sync_python_client_releases_one_lease(monkeypatch):
    import traffic_meter.client as client_module

    requests = []

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def request(self, method, url, **kwargs):
            requests.append((method, url, kwargs))
            if method == "POST":
                return httpx.Response(200, json={"leaseId": "lease_2", "proxyUrl": "http://traffic:secret@meter:1235"})
            return httpx.Response(200, json={"items": []})

    monkeypatch.setattr(client_module.httpx, "Client", FakeClient)
    with request_proxy_sync(None, _context().payload(), client=TrafficMeterClient("http://meter", "secret")) as proxy_url:
        assert proxy_url == "http://traffic:secret@meter:1235"
    assert [item[0] for item in requests] == ["POST", "DELETE"]
