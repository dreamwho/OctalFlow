"""Real Firefox regression: document replacement during upload preparation."""
import asyncio
import json
from urllib.parse import parse_qs, urlsplit

import pytest

from dola_api.session import _camoufox_proxy_options
from dola_api.traffic import TrafficMeter
from dola_api.uploads import _prepare_upload


@pytest.mark.anyio
async def test_prepare_keeps_signed_request_and_proxy_across_three_document_replacements(tmp_path):
    camoufox = pytest.importorskip("camoufox.async_api")
    arrived = asyncio.Queue()
    releases, observed = [], []
    html = b'''<html><title>Upload navigation fixture</title><script>
      const original = window.fetch;
      window.fetch = (url, options) => {
        const signed = new URL(url, location.href);
        signed.searchParams.set('a_bogus', 'fixture-sdk-signature');
        options.headers['x-fixture-sdk'] = 'native-signing-hook';
        return original(signed.href, options);
      };
    </script></html>'''

    async def origin(reader, writer):
        try:
            headers = await reader.readuntil(b"\r\n\r\n")
            first, *lines = headers.decode().split("\r\n")
            fields = dict(line.lower().split(": ", 1) for line in lines if ": " in line)
            body = await reader.readexactly(int(fields.get("content-length", "0")))
            if "/alice/resource/prepare_upload?" in first:
                observed.append((first, fields, json.loads(body), len(headers) + len(body)))
                release = asyncio.Event(); releases.append(release)
                await arrived.put(release)
                await release.wait()
                content = json.dumps({"code": 0, "data": {"service_id": f"reference-{len(observed)}"}}).encode()
                mime = "application/json"
            else:
                content, mime = html, "text/html"
            writer.write(f"HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nConnection: close\r\nContent-Length: {len(content)}\r\n\r\n".encode() + content)
            await writer.drain()
        finally:
            writer.close(); await writer.wait_closed()

    server = await asyncio.start_server(origin, "127.0.0.1", 0)
    url = f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}"
    meter = TrafficMeter(tmp_path / "traffic.sqlite3")
    relay = await meter.proxy(None, "submit")
    pending = None
    try:
        async with camoufox.AsyncCamoufox(headless=True, geoip=False, proxy=_camoufox_proxy_options(relay), firefox_user_prefs={"network.proxy.allow_hijacking_localhost": True}) as browser:
            context = await browser.new_context()
            await context.add_cookies([{"name": "fixture_session", "value": "fixture-cookie", "url": url}])
            page = await context.new_page()
            await page.route("**/favicon.ico", lambda route: route.abort())
            await page.goto(url)
            for index in range(3):
                before = meter.query("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z")["uploadBytes"]
                pending = asyncio.create_task(_prepare_upload(page))
                release = await asyncio.wait_for(arrived.get(), 90)
                after = meter.query("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z")["uploadBytes"]
                assert after - before == observed[-1][3]  # API request uses the same metered proxy.
                await page.goto(f"{url}/replacement-{index}")
                release.set()
                assert (await pending)["service_id"] == f"reference-{index+1}"
                pending = None
            assert len(observed) == 3  # The native request never reaches the origin twice.
            for first, fields, body, _size in observed:
                assert parse_qs(urlsplit(first.split(" ")[1]).query)["a_bogus"] == ["fixture-sdk-signature"]
                assert fields["x-fixture-sdk"] == "native-signing-hook"
                assert "fixture_session=fixture-cookie" in fields["cookie"]
                assert body == {"tenant_id": "5", "scene_id": "4", "resource_type": 2}
            assert meter.query("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z")["uploadBytes"] > 0
    finally:
        if pending:
            pending.cancel(); await asyncio.gather(pending, return_exceptions=True)
        for release in releases:
            release.set()
        await meter.close()
        server.close(); await server.wait_closed()
