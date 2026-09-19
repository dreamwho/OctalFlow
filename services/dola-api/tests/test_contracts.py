from dola_api.protocol import canonical_ratio, validate_request
from dola_api.page_scripts import MAIN_WORLD_SUBMIT_SCRIPT
from dola_api.query import decode_main_url, extract_conversation_id, extract_image_urls, extract_main_url, extract_video_url, extract_vod_payload
from dola_api.sse import iter_sse_events
from dola_api.session import CamoufoxSessionPool, PageSession, _page_has_verification_marker, _proxy_url_for_request
from dola_api.contracts import VideoRequest, VideoTask


def test_model_duration_contract_keeps_fast_at_15_seconds():
    assert validate_request("dola-seedance-2-5", 30, "21:9").upstream_model == "seedance_v2.5"
    try:
        validate_request("dola-seedance-2-0-fast", 30, "16:9")
    except ValueError as error:
        assert str(error) == "unsupported_duration:30"
    else:
        raise AssertionError("Fast must reject 30 seconds")


def test_sse_parser_handles_split_utf8_and_comments():
    chunks = [b": heartbeat\r\n\r\nevent: ack\r\ndata: {\"ok\":", b"true}\r\n\r\n"]
    assert list(iter_sse_events(iter(chunks))) == [{"event": "ack", "data": {"ok": True}}]


def test_query_parser_decodes_direct_and_nested_main_url():
    assert decode_main_url("https://cdn.dola.com/video.mp4") == "https://cdn.dola.com/video.mp4"
    payload = {"data": {"video_model": '{"main_url":"https://cdn.dola.com/video.mp4"}'}}
    assert extract_main_url(payload) == "https://cdn.dola.com/video.mp4"


def test_query_parser_extracts_nested_creation_download_url_and_conversation():
    payload = {
        "ack_client_meta": {"conversation_id": 12345678901234567},
        "downlink_body": {
            "pull_singe_chain_downlink_body": {
                "messages": [{
                    "content": '[{"block_type":2074,"content":{"creation_block":{"creations":[{"type":2,"video":{"download_url":"https://cdn.dola.com/generated.mp4"}}]}}}]',
                }],
            }
        },
    }
    assert extract_conversation_id(payload) == "12345678901234567"
    assert extract_video_url(payload) == "https://cdn.dola.com/generated.mp4"


def test_query_parser_prefers_video_creation_over_unrelated_download_url():
    payload = {
        "download_url": "https://cdn.dola.com/thumbnail.jpg",
        "creation_block": {
            "creations": [
                {"type": 1, "video": {"download_url": "https://cdn.dola.com/image-preview.jpg"}},
                {"type": 2, "video": {"download_url": "https://cdn.dola.com/video.mp4"}},
            ]
        },
    }
    assert extract_video_url(payload) == "https://cdn.dola.com/video.mp4"


def test_query_parser_keeps_only_nested_vod_metadata_for_watermark_resolution():
    payload = {
        "downlink_body": {
            "messages": [{"content": '{"video_model":{"fallback_api":"https://vod.dola.com/fallback?sig=fixture"},"key_seed":"fixture-seed","video_list":{"hd":{"main_url":"encoded-url","vwidth":1920,"vheight":1080}}}'}],
        },
        "unrelated": {"prompt": "do not persist"},
    }
    assert extract_vod_payload(payload) == {
        "fallback_api": "https://vod.dola.com/fallback?sig=fixture",
        "key_seed": "fixture-seed",
        "video_list": {"hd": {"main_url": "encoded-url", "vwidth": 1920, "vheight": 1080}},
    }


def test_main_world_submit_envelope_uses_patched_xhr_and_dom_channel():
    assert "new XMLHttpRequest()" in MAIN_WORLD_SUBMIT_SCRIPT
    assert "__dola_submit_result__" in MAIN_WORLD_SUBMIT_SCRIPT
    assert "SSE_REPLY_END" in MAIN_WORLD_SUBMIT_SCRIPT
    assert "setRequestHeader" in MAIN_WORLD_SUBMIT_SCRIPT


def test_ratio_contract_snaps_reduced_values_onto_supported_set():
    profile = validate_request("dola-seedance-2-5", 5, "7:3")
    assert profile.upstream_model == "seedance_v2.5"
    assert canonical_ratio("7:3", profile.ratios) == "21:9"
    assert canonical_ratio("21:9", profile.ratios) == "21:9"
    assert canonical_ratio("garbage", profile.ratios) == ""
    image_profile = validate_request("dola-seedream-4-5", 0, "1:1")
    assert image_profile.capability == "image"
    assert image_profile.upstream_model == "Seedream 4.5"


def test_query_parser_collects_image_creation_urls_preferring_originals():
    payload = {
        "messages": [{
            "content": '[{"block_type":2074,"content":{"creation_block":{"creations":[{"type":1,"image":{"image_raw":{"url":"https://img.dola.com/a_wm.jpeg"},"image_ori":{"url":"https://img.dola.com/a.jpeg"}}}]}}}]',
        }],
    }
    urls = extract_image_urls(payload)
    assert urls == ["https://img.dola.com/a.jpeg", "https://img.dola.com/a_wm.jpeg"]


def test_verification_detection_ignores_normal_cookie_page_copy():
    assert not _page_has_verification_marker("Dola", "Cookie 政策与安全性措施")
    assert _page_has_verification_marker("Dola", "请完成滑块验证")


def test_proxy_contract_accepts_only_task_level_managed_urls():
    assert _proxy_url_for_request("direct", "http://ignored.example") is None
    assert _proxy_url_for_request("managed", "http://proxy.example:8080") == "http://proxy.example:8080"
    try:
        _proxy_url_for_request("managed", "file:///tmp/proxy")
    except RuntimeError as error:
        assert str(error) == "managed_proxy_invalid"
    else:
        raise AssertionError("managed proxy must be an HTTP(S)/SOCKS URL")


def test_page_submit_persists_ack_conversation_without_real_browser(monkeypatch):
    import asyncio

    pool = CamoufoxSessionPool()
    request = VideoRequest(model="dola-seedance-2-0-fast", prompt="test", duration=5)
    key = ("account-1", 1, "direct")
    pool._sessions[key] = PageSession("account-1", 1, "direct", "", "", "sid=abc")
    pool._tasks["task-1"] = VideoTask(id="task-1", model=request.model, status="queued", accountId="account-1")
    pool._task_meta["task-1"] = {"accountId": "account-1", "cookie": "sid=abc"}

    async def submit(*_args, **_kwargs):
        return {"status": 200, "ackReceived": True, "conversationId": "12345678901234567", "identity": {}, "cookie": "sid=abc"}

    async def persist():
        return None

    monkeypatch.setattr(pool, "_submit_in_camoufox", submit)
    monkeypatch.setattr(pool, "_persist", persist)
    asyncio.run(pool._run_page_submit("task-1", request, key))

    assert pool._tasks["task-1"].status == "accepted"
    assert pool._tasks["task-1"].conversationId == "12345678901234567"
    assert pool._task_meta["task-1"]["conversationId"] == "12345678901234567"


def test_page_submit_uses_recent_conversation_only_after_ack(monkeypatch):
    import asyncio
    import dola_api.session as session_module

    pool = CamoufoxSessionPool()
    request = VideoRequest(model="dola-seedance-2-0-fast", prompt="test", duration=5)
    key = ("account-1", 1, "direct")
    pool._sessions[key] = PageSession("account-1", 1, "direct", "", "", "sid=abc")
    pool._tasks["task-2"] = VideoTask(id="task-2", model=request.model, status="queued", accountId="account-1")
    pool._task_meta["task-2"] = {"accountId": "account-1", "cookie": "sid=abc"}

    async def submit(*_args, **_kwargs):
        return {"status": 200, "ackReceived": True, "identity": {}, "cookie": "sid=abc"}

    async def recent(*_args, **_kwargs):
        return "12345678901234568"

    async def persist():
        return None

    monkeypatch.setattr(pool, "_submit_in_camoufox", submit)
    monkeypatch.setattr(pool, "_persist", persist)
    monkeypatch.setattr(session_module, "fetch_recent_conversation_id", recent)
    asyncio.run(pool._run_page_submit("task-2", request, key))

    assert pool._tasks["task-2"].status == "accepted"
    assert pool._tasks["task-2"].conversationId == "12345678901234568"


def test_ack_without_conversation_stays_accepted_until_recent_lookup(monkeypatch):
    import asyncio
    import dola_api.session as session_module

    pool = CamoufoxSessionPool()
    request = VideoRequest(model="dola-seedance-2-0-fast", prompt="test", duration=5)
    key = ("account-1", 1, "direct")
    pool._sessions[key] = PageSession("account-1", 1, "direct", "", "", "sid=abc")
    pool._tasks["task-ack"] = VideoTask(id="task-ack", model=request.model, status="queued", accountId="account-1")
    pool._task_meta["task-ack"] = {"accountId": "account-1", "cookie": "sid=abc"}

    async def submit(*_args, **_kwargs):
        return {"status": 200, "ackReceived": True, "identity": {}, "cookie": "sid=abc"}

    async def recent(*_args, **_kwargs):
        return ""

    async def persist():
        return None

    monkeypatch.setattr(pool, "_submit_in_camoufox", submit)
    monkeypatch.setattr(pool, "_persist", persist)
    monkeypatch.setattr(session_module, "fetch_recent_conversation_id", recent)
    asyncio.run(pool._run_page_submit("task-ack", request, key))

    assert pool._tasks["task-ack"].status == "accepted"
    assert pool._tasks["task-ack"].conversationId is None
    assert pool._task_meta["task-ack"]["ackReceived"] is True


def test_refresh_task_promotes_nested_download_url_to_completed(monkeypatch):
    import asyncio
    import dola_api.session as session_module

    pool = CamoufoxSessionPool()
    pool._tasks["task-3"] = VideoTask(id="task-3", model="dola-seedance-2-5", status="accepted", conversationId="12345678901234567")
    pool._task_meta["task-3"] = {"conversationId": "12345678901234567", "cookie": "sid=abc", "identity": {}}

    async def query(*_args, **_kwargs):
        return {"url": "https://cdn.dola.com/generated.mp4", "payload": {"video_model": '{"fallback_api":"https://vod.dola.com/fallback"}'}}

    async def persist():
        return None

    monkeypatch.setattr(session_module, "fetch_generation_result", query)
    monkeypatch.setattr(pool, "_persist", persist)
    asyncio.run(pool._refresh_task("task-3"))

    task = pool._tasks["task-3"]
    assert task.status == "completed"
    assert task.videoUrl == "https://cdn.dola.com/generated.mp4"
    assert task.vodPayload == {"video_model": '{"fallback_api":"https://vod.dola.com/fallback"}'}


def test_refresh_task_recovers_ack_conversation_before_query(monkeypatch):
    import asyncio
    import dola_api.session as session_module

    pool = CamoufoxSessionPool()
    pool._tasks["task-recover"] = VideoTask(id="task-recover", model="dola-seedance-2-5", status="accepted")
    pool._task_meta["task-recover"] = {"ackReceived": True, "cookie": "sid=abc", "identity": {}}

    async def recent(*_args, **_kwargs):
        return "12345678901234567"

    async def query(*_args, **_kwargs):
        return {}

    async def persist():
        return None

    monkeypatch.setattr(session_module, "fetch_recent_conversation_id", recent)
    monkeypatch.setattr(session_module, "fetch_generation_result", query)
    monkeypatch.setattr(pool, "_persist", persist)
    asyncio.run(pool._refresh_task("task-recover"))

    assert pool._tasks["task-recover"].status == "accepted"
    assert pool._tasks["task-recover"].conversationId == "12345678901234567"
