"""Real browser signer, document replacement and interrupted SSE transmission."""
import asyncio
import json
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from dola_api.contracts import VideoRequest, VideoTask
from dola_api.session import CamoufoxSessionPool, PageSession, _camoufox_proxy_options, _execute_completion_submit, _send_completion_stream
from dola_api.traffic import TrafficMeter


@pytest.mark.anyio
async def test_signed_submission_survives_navigation_without_duplicate_requests(tmp_path):
    camoufox = pytest.importorskip("camoufox.async_api")
    arrived = asyncio.Queue()
    observed, releases = [], []
    html = b'''<html><title>Submission navigation fixture</title>
      <script src="/samantha/user/info?device_id=fixture-device&web_id=fixture-web&tea_uuid=fixture-tea&web_tab_id=fixture-tab&fp=fixture-fp"></script></html>'''
    sdk = b'''window.bdms = {};
      const originalOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, ...args) {
        if (location.pathname === '/sdk-failure') throw new Error('fixture_sdk_failure');
        const signed = new URL(url, location.href);
        signed.searchParams.set('a_bogus', 'fixture-sdk-signature');
        originalOpen.call(this, method, signed.href, ...args);
        this.setRequestHeader('x-fixture-sdk', 'native-signing-hook');
      };'''

    async def origin(reader, writer):
        try:
            headers = await reader.readuntil(b"\r\n\r\n")
            first, *lines = headers.decode().split("\r\n")
            fields = dict(line.lower().split(": ", 1) for line in lines if ": " in line)
            body = await reader.readexactly(int(fields.get("content-length", "0")))
            if "/chat/completion?" in first:
                index = len(observed)
                observed.append((first, fields, json.loads(body)))
                release = asyncio.Event(); releases.append(release)
                await arrived.put(release)
                await release.wait()
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n")
                if index < 2:
                    event = f'event: SSE_ACK\r\ndata: {{"ack_client_meta":{{"conversation_id":"38417880090853905"}}}}\r\n\r\n'.encode()
                    if index == 0:
                        event += b'event: SSE_REPLY_END\r\ndata: {}\r\n\r\n'
                    writer.write(f"{len(event):x}\r\n".encode() + event + b"\r\n")
                    await writer.drain()
                    if index == 0:
                        # No terminating HTTP chunk: reception must stop at END.
                        await reader.read()
            else:
                content, mime = (sdk, "application/javascript") if "/samantha/user/info?" in first else (html, "text/html")
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
            request = VideoRequest(model="dola-seedance-2-5", prompt="fixture", duration=5, ratio="16:9")
            for index in range(3):
                pending = asyncio.create_task(_execute_completion_submit(page, request, [], proxy_url=relay))
                arrival = asyncio.create_task(arrived.get())
                done, _waiting = await asyncio.wait((pending, arrival), timeout=70, return_when=asyncio.FIRST_COMPLETED)
                if arrival not in done:
                    arrival.cancel(); await asyncio.gather(arrival, return_exceptions=True)
                    assert pending not in done, f"submission finished before origin: {pending.result()}"
                    raise TimeoutError("fixture_request_not_received")
                release = arrival.result()
                await page.goto(f"{url}/replacement-{index}")
                release.set()
                result = await pending
                pending = None
                assert result["requestSigned"]
                assert result["device_id"] == "fixture-device"
                assert result["ackReceived"] == (index < 2)
                assert result["conversationId"] == ("38417880090853905" if index < 2 else "")
                assert result["submissionUncertain"] == (index == 2)
                if index:
                    assert result["diagnostics"]["transportError"] == "RemoteProtocolError"
            await page.goto(f"{url}/sdk-failure")
            with pytest.raises(RuntimeError, match="submission_transport_fixture_sdk_failure"):
                await _execute_completion_submit(page, request, [], proxy_url=relay)
            assert len(observed) == 3
            assert len({entry[2]["client_meta"]["local_conversation_id"] for entry in observed}) == 3
            for first, fields, body in observed:
                assert parse_qs(urlsplit(first.split(" ")[1]).query)["a_bogus"] == ["fixture-sdk-signature"]
                assert fields["x-fixture-sdk"] == "native-signing-hook"
                assert "fixture_session=fixture-cookie" in fields["cookie"]
                assert body["messages"]
            assert meter.query("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z")["uploadBytes"] > 0
    finally:
        if pending:
            pending.cancel(); await asyncio.gather(pending, return_exceptions=True)
        for release in releases:
            release.set()
        await meter.close()
        server.close(); await server.wait_closed()


@pytest.mark.anyio
async def test_uncertain_transmission_stays_on_original_task_and_recovers_correlated_id(monkeypatch):
    import dola_api.session as session_module

    pool = CamoufoxSessionPool()
    request = VideoRequest(model="dola-seedance-2-5", prompt="fixture", duration=5)
    key = ("fixture-account", 1, "direct")
    pool._sessions[key] = PageSession("fixture-account", 1, "direct", "", "", "sid=fixture")
    pool._tasks["original-task"] = VideoTask(id="original-task", model=request.model, status="queued")
    pool._task_meta["original-task"] = {"cookie": "sid=fixture"}
    submissions, lookups = [], []

    async def submit(*args):
        submissions.append(args)
        return {"status": 200, "submissionUncertain": True, "cookie": "sid=fixture", "localConversationId": "fixture-local-id", "identity": {"device_id": "fixture-device"}}

    async def persist():
        pass

    async def lookup(cookie, identity, local_id, *_args):
        lookups.append((cookie, identity, local_id))
        return "38417880090853905"

    async def result(*_args):
        return {"pending": True}

    monkeypatch.setattr(pool, "_submit_in_camoufox", submit)
    monkeypatch.setattr(pool, "_persist", persist)
    monkeypatch.setattr(session_module, "fetch_recent_conversation_id", lookup)
    monkeypatch.setattr(session_module, "fetch_generation_result", result)
    await pool._run_page_submit("original-task", request, key)
    assert pool._tasks["original-task"].status == "accepted"
    assert pool._task_meta["original-task"]["submissionUncertain"]
    await pool._refresh_task("original-task")
    assert pool._tasks["original-task"].conversationId == "38417880090853905"
    assert lookups == [("sid=fixture", {"device_id": "fixture-device"}, "fixture-local-id")]
    assert len(submissions) == 1


@pytest.mark.anyio
async def test_connection_failure_is_not_an_uncertain_generation(monkeypatch):
    import dola_api.session as session_module

    async def disconnected(_request):
        raise httpx.ConnectError("fixture_connection_refused")

    async def headers():
        return {}

    async def direct(*_args):
        return None

    client_factory = httpx.AsyncClient
    monkeypatch.setattr(session_module, "metered_proxy", direct)
    monkeypatch.setattr(session_module.httpx, "AsyncClient", lambda **kwargs: client_factory(transport=httpx.MockTransport(disconnected), **kwargs))
    request = SimpleNamespace(url="https://fixture.invalid/chat/completion?a_bogus=fixture", all_headers=headers, post_data_buffer=b"{}")
    with pytest.raises(httpx.ConnectError, match="fixture_connection_refused"):
        await _send_completion_stream(request, None, 60)
