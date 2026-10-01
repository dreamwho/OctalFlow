import asyncio
from datetime import datetime, timezone
from urllib.parse import urlsplit

import httpx
import pytest

from dola_api.traffic import TrafficMeter


@pytest.mark.anyio
@pytest.mark.parametrize("scheme", ["http", "socks5", "https", "chained"])
async def test_real_tcp_counter_matches_upstream_bytes_including_handshake(tmp_path, monkeypatch, scheme):
    # Mature pproxy parses upstream HTTP/SOCKS/TLS protocols as in production.
    # The fixture measures independent server-side raw TCP bytes.
    import ssl
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from datetime import timedelta
    import pproxy

    received, sent = [], []
    async def echo(reader, writer):
        data = await reader.readexactly(1037)
        received.append(len(data))
        reply = data[::-1] + b"response"
        sent.append(len(reply))
        writer.write(reply)
        await writer.drain()
        writer.close()
        await writer.wait_closed()
    origin = await asyncio.start_server(echo, "127.0.0.1", 0)
    origin_port = origin.sockets[0].getsockname()[1]
    upstream_reader_bytes, upstream_writer_bytes = [], []
    from pproxy.server import stream_handler
    async def measured_handler(reader, writer, **kwargs):
        protocol = reader._transport.get_protocol()
        original_received = protocol.data_received
        def observe_received(data):
            upstream_reader_bytes.append(len(data)); original_received(data)
        protocol.data_received = observe_received
        original_write = writer.write
        def observe_write(data):
            upstream_writer_bytes.append(len(data)); original_write(data)
        writer.write = observe_write
        await stream_handler(reader, writer, **kwargs)
    # Include TLS records by pproxy's own sslwrap, not asyncio server SSL.
    server = pproxy.Server(f"{'http+ssl' if scheme == 'https' else 'http' if scheme == 'chained' else scheme}://127.0.0.1:0")
    if scheme == "https":
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        subject = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, "localhost")])
        now = datetime.now(timezone.utc)
        cert = x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(days=1)).not_valid_after(now+timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.IPAddress(__import__("ipaddress").ip_address("127.0.0.1"))]), critical=False).sign(key, hashes.SHA256())
        certfile, keyfile = tmp_path/"cert.pem", tmp_path/"key.pem"
        certfile.write_bytes(cert.public_bytes(serialization.Encoding.PEM)); keyfile.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
        server.sslserver.load_cert_chain(certfile, keyfile)
        original_context = ssl.create_default_context
        monkeypatch.setattr("dola_api.traffic.ssl.create_default_context", lambda *args, **kwargs: original_context(*args, cafile=certfile, **kwargs))
    landing = None
    remotes = []
    if scheme == "chained":
        landing = await pproxy.Server("socks5://127.0.0.1:0").start_server({"rserver": []})
        remotes = [pproxy.Connection(f"socks5://127.0.0.1:{landing.sockets[0].getsockname()[1]}")]
    upstream = await server.start_server({"rserver": remotes}, stream_handler=measured_handler)
    port = upstream.sockets[0].getsockname()[1]
    meter = TrafficMeter(tmp_path/"traffic.db")
    try:
        relay = await meter.proxy(f"{'http' if scheme == 'chained' else scheme}://127.0.0.1:{port}", "upload")
        async def send():
            parts = urlsplit(relay)
            client = pproxy.Connection(f"http://{parts.hostname}:{parts.port}#{parts.username}:{parts.password}")
            reader, writer = await client.tcp_connect("127.0.0.1", origin_port)
            writer.write(b"X" * 1037)
            await writer.drain()
            assert await reader.readexactly(1045) == b"X"*1037 + b"response"
            writer.close(); await writer.wait_closed()
        await asyncio.gather(send(), send(), send())
        data = meter.query("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z", port)
        assert data["uploadBytes"] == sum(upstream_reader_bytes)
        assert data["downloadBytes"] == sum(upstream_writer_bytes)
        assert data["uploadBytes"] > sum(received)  # Handshake bytes included.
        assert data["downloadBytes"] > sum(sent)
        assert data["totalBytes"] == data["uploadBytes"] + data["downloadBytes"]
        assert data["items"][0]["port"] == port
        assert not meter.query("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z", port+1)["items"]
        # Querying again does not increment counts; reopening preserves them.
        assert meter.query(data["start"], data["end"]) == data
        await meter.close()
        meter = TrafficMeter(tmp_path/"traffic.db")
        assert meter.query(data["start"], data["end"]) == data
    finally:
        await meter.close()
        upstream.close(); await upstream.wait_closed()
        origin.close(); await origin.wait_closed()
        if landing:
            landing.close(); await landing.wait_closed()


def test_time_window_port_and_roles_share_same_filter(tmp_path):
    meter = TrafficMeter(tmp_path/"traffic.db")
    start = int(datetime(2026, 10, 1, tzinfo=timezone.utc).timestamp()*1_000_000)
    meter.record("submit", "proxy", 9001, 11, 17, time_us=start-1)
    meter.record("upload", "proxy", 9002, 31, 43, time_us=start)
    meter.record("submit", "proxy", 9001, 47, 53, time_us=start+999_999)
    meter.record("upload", "proxy", 9002, 59, 61, time_us=start+1_000_000)
    data = meter.query("2026-10-01T08:00:00+08:00", "2026-10-01T08:00:01+08:00")
    assert (data["uploadBytes"], data["downloadBytes"], data["totalBytes"]) == (78, 96, 174)
    assert meter.query(data["start"], data["end"], 9002)["totalBytes"] == 74
    assert sum(row["totalBytes"] for row in data["items"]) == data["totalBytes"]
    with pytest.raises(ValueError):
        meter.query("2026-10-01T00:00:00", "2026-10-02T00:00:00")
    meter.db.close()


@pytest.mark.anyio
async def test_direct_and_failed_connections_are_counted_without_fallback(tmp_path):
    async def reject(reader, writer):
        await reader.readuntil(b"\r\n\r\n")
        writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 7\r\nConnection: close\r\n\r\nfailure")
        await writer.drain(); writer.close(); await writer.wait_closed()
    server = await asyncio.start_server(reject, "127.0.0.1", 0)
    meter = TrafficMeter(tmp_path/"traffic.db")
    port = server.sockets[0].getsockname()[1]
    try:
        relay = await meter.proxy(None, "submit")
        async with httpx.AsyncClient(proxy=relay, trust_env=False) as client:
            assert (await client.get(f"http://127.0.0.1:{port}/bad")).status_code == 502
        stats = meter.query("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z")
        assert stats["items"][0]["port"] == 0
        assert stats["uploadBytes"] > 0 and stats["downloadBytes"] > 7
        # A second client on the same loopback IP cannot inherit authentication.
        parts = urlsplit(relay)
        async with httpx.AsyncClient(proxy=f"http://{parts.hostname}:{parts.port}", trust_env=False) as client:
            assert (await client.get(f"http://127.0.0.1:{port}/bad")).status_code == 407
        assert meter.query(stats["start"], stats["end"]) == stats
    finally:
        await meter.close(); server.close(); await server.wait_closed()
