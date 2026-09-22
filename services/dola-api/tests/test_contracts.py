from dola_api.protocol import canonical_ratio, sanitize_video_prompt_duration, validate_request
from dola_api.page_scripts import DOLA_30S_UNLOCKER_SCRIPT, MAIN_WORLD_CREDIT_SCRIPT, MAIN_WORLD_JSON_REQUEST_SCRIPT, MAIN_WORLD_SUBMIT_SCRIPT
from dola_api.query import decode_main_url, extract_conversation_id, extract_image_urls, extract_main_url, extract_video_url, extract_vod_payload, generation_query_payloads, parse_generation_payloads
from dola_api.sse import iter_sse_events
from dola_api.session import CamoufoxSessionPool, PageSession, _build_completion_query, _build_request_body, _camoufox_browser_options, _camoufox_context_options, _page_has_verification_marker, _proxy_url_for_request, _sse_verification_decision, _submission_diagnostics
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


def test_main_world_submit_waits_for_live_signer_before_one_send():
    assert 'performance.getEntriesByType("resource")' in MAIN_WORLD_SUBMIT_SCRIPT
    assert 'xhr.open("POST", request.url)' in MAIN_WORLD_SUBMIT_SCRIPT
    assert "const params = new URLSearchParams();" in MAIN_WORLD_SUBMIT_SCRIPT
    assert "best.searchParams.entries()" in MAIN_WORLD_SUBMIT_SCRIPT
    assert 'const completionKeys = new Set' in MAIN_WORLD_SUBMIT_SCRIPT
    assert '"channel"' not in MAIN_WORLD_SUBMIT_SCRIPT
    assert '"msToken"' not in MAIN_WORLD_SUBMIT_SCRIPT
    assert 'identitySource: "provider_fresh_identity"' in MAIN_WORLD_SUBMIT_SCRIPT
    assert "fallbackQuery" in MAIN_WORLD_SUBMIT_SCRIPT
    assert 'typeof window.bdms === "object"' in MAIN_WORLD_SUBMIT_SCRIPT
    assert "request && (signerReady || deadlineReached)" in MAIN_WORLD_SUBMIT_SCRIPT
    assert '.searchParams.has("a_bogus")' in MAIN_WORLD_SUBMIT_SCRIPT
    assert MAIN_WORLD_SUBMIT_SCRIPT.count("xhr.send(cfg.body)") == 1


def test_completion_query_has_full_generation_identity_contract():
    query, identity = _build_completion_query("flow_user_country=TW; s_v_web_id=verify_fixture; msToken=token_fixture")
    assert "channel=g" in query
    assert "msToken=token_fixture" in query
    assert "fp=verify_fixture" in query
    assert identity["region"] == "TW"


def test_camoufox_browser_selection_keeps_binary_and_fingerprint_versions_aligned(monkeypatch, tmp_path):
    monkeypatch.setenv("DOLA_CAMOUFOX_BROWSER", "135.0.1-beta.24")
    monkeypatch.setenv("DOLA_CAMOUFOX_OS", "macos")
    monkeypatch.setenv("DOLA_PROFILE_DIR", str(tmp_path))
    options = _camoufox_browser_options(True, "http://proxy.example:8080", "account-1")
    assert options["headless"] is True
    assert options["enable_cache"] is False
    assert options["browser"] == "135.0.1-beta.24"
    assert options["window"] == (1365, 900)
    assert options["ff_version"] == 135
    assert options["i_know_what_im_doing"] is True
    assert options["os"] == "macos"
    assert options["locale"] == "zh-CN"
    assert options["geoip"] is True
    assert options["proxy"] == {"server": "http://proxy.example:8080"}
    assert isinstance(options["fingerprint_preset"], dict)
    assert options["config"] == _camoufox_browser_options(True, None, "account-1")["config"]
    assert (tmp_path / "account-1" / "fingerprint-preset.json").exists()
    assert _camoufox_context_options() == {"storage_state": None, "locale": "zh-CN", "no_viewport": True}


def test_camoufox_defaults_to_macos_fingerprint(monkeypatch):
    monkeypatch.delenv("DOLA_CAMOUFOX_OS", raising=False)
    assert _camoufox_browser_options(True)["os"] == "macos"


def test_packaged_camoufox_uses_executable_without_treating_path_as_version(monkeypatch):
    monkeypatch.delenv("DOLA_CAMOUFOX_BROWSER", raising=False)
    monkeypatch.setenv("DOLA_CAMOUFOX_EXECUTABLE", "/Applications/Camoufox.app/Contents/MacOS/camoufox")
    monkeypatch.setenv("DOLA_CAMOUFOX_FF_VERSION", "135")
    options = _camoufox_browser_options(True)
    assert options["executable_path"] == "/Applications/Camoufox.app/Contents/MacOS/camoufox"
    assert "browser" not in options
    assert options["ff_version"] == 135
    assert _camoufox_context_options()["no_viewport"] is True


def test_main_world_json_request_uses_live_identity_and_page_signer():
    assert 'performance.getEntriesByType("resource")' in MAIN_WORLD_JSON_REQUEST_SCRIPT
    assert "new XMLHttpRequest()" in MAIN_WORLD_JSON_REQUEST_SCRIPT
    assert 'typeof window.bdms === "object"' in MAIN_WORLD_JSON_REQUEST_SCRIPT
    assert "resultId" in MAIN_WORLD_JSON_REQUEST_SCRIPT


def test_real_submit_page_does_not_run_any_protocol_probe_before_generation():
    from pathlib import Path

    source = Path(__file__).parents[1].joinpath("src/dola_api/session.py").read_text("utf-8")
    submit_scope = source.split("async def _submit_in_camoufox", 1)[1].split("async def _refresh_task", 1)[0]
    before_submit = submit_scope.split("result = await _execute_completion_submit", 1)[0]
    assert "_probe_account_protocol(page)" not in submit_scope
    assert "_page_recent_conversation_id(page)" not in before_submit


def test_generation_query_payloads_and_parser_share_result_contract():
    conversation_id = "12345678901234567"
    queries = generation_query_payloads(conversation_id)
    assert [path for path, _ in queries] == ["/im/conversation/info", "/im/chain/single"]
    result = parse_generation_payloads([{"creation_block": {"creations": [{"type": 2, "video": {"download_url": "https://cdn.dola.com/final.mp4"}}]}}])
    assert result["url"] == "https://cdn.dola.com/final.mp4"


def test_credit_probe_uses_signed_live_page_identity():
    assert "get_credit_num_optional_tasks" in MAIN_WORLD_CREDIT_SCRIPT
    assert "need_tasks: true" in MAIN_WORLD_CREDIT_SCRIPT
    assert "upstream_quota_not_exposed" in MAIN_WORLD_CREDIT_SCRIPT
    assert "enableCommerceCredit" in MAIN_WORLD_CREDIT_SCRIPT
    assert 'performance.getEntriesByType("resource")' in MAIN_WORLD_CREDIT_SCRIPT
    assert 'typeof window.bdms === "object"' in MAIN_WORLD_CREDIT_SCRIPT


def test_verification_requires_structured_challenge_data():
    ordinary = [("SSE_MESSAGE", {"message": "验证码说明只是帮助文案，页面没有挑战"})]
    challenge = [("SSE_ERROR", {"decision": {"type": "verify", "subtype": "slide", "verification_id": "v-1", "code": 12345}})]
    signature_rejection = [("STREAM_ERROR", {"decision": {"type": "verify", "subtype": "slide", "verification_id": "v-2", "code": 710022004}})]
    assert _sse_verification_decision(ordinary) is None
    assert _sse_verification_decision(challenge) == {"type": "verify", "subtype": "slide", "code": "12345"}
    assert _sse_verification_decision(signature_rejection) is None


def test_submission_diagnostics_keeps_codes_without_secrets():
    diagnostics = _submission_diagnostics([("SSE_ERROR", {"code": 710022002, "message": "服务访问频繁", "token": "secret"})], "", {"status": 429, "responseBytes": 32, "identitySource": "/alice/user/profile"})
    assert diagnostics["codes"] == ["710022002"]
    assert diagnostics["messages"] == ["服务访问频繁"]
    assert "secret" not in str(diagnostics)


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


def test_video_task_screenshot_base64_and_contract():
    task = VideoTask(
        id="task-screenshot-1",
        model="dola-seedance-2-5",
        status="needs_review",
        verificationId="ver-123",
        screenshotBase64="iVBORw0KGgoAAAANSUhEUgAA",
    )
    dumped = task.model_dump()
    assert dumped["screenshotBase64"] == "iVBORw0KGgoAAAANSUhEUgAA"
    assert dumped["verificationId"] == "ver-123"



def test_page_submit_never_attaches_an_unrelated_recent_conversation(monkeypatch):
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

    async def persist():
        return None

    monkeypatch.setattr(pool, "_submit_in_camoufox", submit)
    monkeypatch.setattr(pool, "_persist", persist)
    asyncio.run(pool._run_page_submit("task-2", request, key))

    assert pool._tasks["task-2"].status == "accepted"
    assert pool._tasks["task-2"].conversationId is None
    assert pool._task_meta["task-2"]["ackReceived"] is True


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

    async def persist():
        return None

    monkeypatch.setattr(pool, "_submit_in_camoufox", submit)
    monkeypatch.setattr(pool, "_persist", persist)
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


def test_refresh_task_recovers_conversation_for_ack_only_task(monkeypatch):
    import asyncio
    import dola_api.session as session_module

    pool = CamoufoxSessionPool()
    pool._tasks["task-recover"] = VideoTask(id="task-recover", model="dola-seedance-2-5", status="accepted")
    pool._task_meta["task-recover"] = {"ackReceived": True, "cookie": "sid=abc", "identity": {}}

    async def recover_recent(cookie, identity, proxy_url=None):
        assert cookie == "sid=abc"
        return "38417880090853905"

    async def query(cookie, conversation_id, identity, proxy_url=None):
        assert conversation_id == "38417880090853905"
        return {"url": "https://cdn.dola.com/generated.mp4", "imageUrls": [], "payload": {}}

    async def persist():
        return None

    monkeypatch.setattr(session_module, "fetch_recent_conversation_id", recover_recent)
    monkeypatch.setattr(session_module, "fetch_generation_result", query)
    monkeypatch.setattr(pool, "_persist", persist)
    asyncio.run(pool._refresh_task("task-recover"))

    task = pool._tasks["task-recover"]
    assert task.status == "completed"
    assert task.conversationId == "38417880090853905"
    assert task.videoUrl == "https://cdn.dola.com/generated.mp4"


def test_refresh_task_keeps_accepted_when_recovery_finds_no_conversation(monkeypatch):
    import asyncio
    import dola_api.session as session_module

    pool = CamoufoxSessionPool()
    pool._tasks["task-recover"] = VideoTask(id="task-recover", model="dola-seedance-2-5", status="accepted")
    pool._task_meta["task-recover"] = {"ackReceived": True, "cookie": "sid=abc", "identity": {}}

    async def recover_recent(cookie, identity, proxy_url=None):
        return ""

    async def query(*_args, **_kwargs):
        raise AssertionError("upstream result query must not run without a conversation id")

    async def persist():
        return None

    monkeypatch.setattr(session_module, "fetch_recent_conversation_id", recover_recent)
    monkeypatch.setattr(session_module, "fetch_generation_result", query)
    monkeypatch.setattr(pool, "_persist", persist)
    asyncio.run(pool._refresh_task("task-recover"))

    assert pool._tasks["task-recover"].status == "accepted"
    assert pool._tasks["task-recover"].conversationId is None


def test_refresh_task_uses_page_signed_result_fallback(monkeypatch):
    import asyncio
    import dola_api.session as session_module

    pool = CamoufoxSessionPool()
    pool._tasks["task-page-result"] = VideoTask(id="task-page-result", model="dola-seedance-2-0-fast", status="accepted", conversationId="12345678901234567")
    pool._task_meta["task-page-result"] = {"conversationId": "12345678901234567", "cookie": "sid=abc", "identity": {}}

    async def direct_query(*_args, **_kwargs):
        return {}

    async def page_query(*_args, **_kwargs):
        return {"url": "https://cdn.dola.com/page-signed.mp4", "payload": {"fallback_api": "https://vod.dola.com/fallback"}}

    async def persist():
        return None

    monkeypatch.setattr(session_module, "fetch_generation_result", direct_query)
    monkeypatch.setattr(pool, "_fetch_generation_result_in_page", page_query)
    monkeypatch.setattr(pool, "_persist", persist)
    asyncio.run(pool._refresh_task("task-page-result"))

    task = pool._tasks["task-page-result"]
    assert task.status == "completed"
    assert task.videoUrl == "https://cdn.dola.com/page-signed.mp4"
    assert task.vodPayload == {"fallback_api": "https://vod.dola.com/fallback"}


def test_submit_stream_extraction_walks_sse_event_tuples():
    events = [("SSE_ACK", {"ack_client_meta": {"conversation_id": "38417880090853905"}})]
    assert extract_conversation_id(events) == "38417880090853905"
    video_events = [("FULL_MSG_NOTIFY", {"messages": [{"content": '[{"block_type":2074,"content":{"creation_block":{"creations":[{"type":2,"video":{"download_url":"https://cdn.dola.com/generated.mp4"}}]}}}]'}]})]
    assert extract_video_url(video_events) == "https://cdn.dola.com/generated.mp4"
    image_events = [("FULL_MSG_NOTIFY", {"messages": [{"content": '[{"content":{"creation_block":{"creations":[{"type":1,"image":{"image_ori":{"url":"https://cdn.dola.com/image.png"}}}]}}}]'}]})]
    assert extract_image_urls(image_events) == ["https://cdn.dola.com/image.png"]


def test_generic_failure_message_terminates_generation_result():
    payload = {"messages": [{"content": '[{"block_type":10000,"content":{"text_block":{"text":"出了点问题，请稍后重试。"}}}]'}]}
    assert parse_generation_payloads([payload])["error"] == "upstream_generation_failed"


def test_sanitize_video_prompt_duration_removes_conversational_triggers():
    assert sanitize_video_prompt_duration("生成30秒视频：海边日落") == "海边日落"
    assert sanitize_video_prompt_duration("海边日落，时长30秒，超清画质") == "海边日落，超清画质"
    assert sanitize_video_prompt_duration("生成一段15秒的微电影：秋天的落叶") == "秋天的落叶"
    assert sanitize_video_prompt_duration("一只猫咪在草地上玩耍 30s") == "一只猫咪在草地上玩耍"
    assert sanitize_video_prompt_duration("A futuristic city at night, duration: 30s, cinematic lighting") == "A futuristic city at night，cinematic lighting"
    assert sanitize_video_prompt_duration("30秒") == ""


def test_build_request_body_for_30s_video_passes_structured_ability_and_clean_prompt():
    import json
    request = VideoRequest(model="dola-seedance-2-5", prompt="生成30秒视频：海边日落", duration=30, ratio="16:9")
    profile = validate_request(request.model, request.duration, request.ratio)
    body = _build_request_body(profile, request, [])
    chat_ability = body["chat_ability"]
    assert chat_ability["ability_type"] == 17
    ability_param = json.loads(chat_ability["ability_param"])
    assert ability_param["duration"] == 30
    assert ability_param["model"] == "seedance_v2.5"
    assert ability_param["camera_movement"] == "fixed"
    assert ability_param["ratio"] == "16:9"
    assert ability_param["input_box_content"]["user_input_content"] == "海边日落"
    visible_text = body["messages"][0]["content_block"][0]["content"]["text_block"]["text"]
    assert "30秒" not in visible_text
    assert "海边日落" in visible_text


def test_dola_30s_unlocker_script_contains_required_hooks():
    assert "30s" in DOLA_30S_UNLOCKER_SCRIPT
    assert "15s" in DOLA_30S_UNLOCKER_SCRIPT
    assert "patchAnyDuration" in DOLA_30S_UNLOCKER_SCRIPT
    assert "samantha/skill/pack" in DOLA_30S_UNLOCKER_SCRIPT
    assert "action_bar_v3/get_item_conf" in DOLA_30S_UNLOCKER_SCRIPT
    assert "slot/action_bar" in DOLA_30S_UNLOCKER_SCRIPT
    assert "/chat/completion" in DOLA_30S_UNLOCKER_SCRIPT



def test_quota_exhausted_message_terminates_generation_result():
    payload = {"messages": [{"content": '[{"block_type":10000,"content":{"text_block":{"text":"今天的生成次数已经到达上限，明天再来免费生成吧"}}}]'}]}
    result = parse_generation_payloads([payload])
    assert result["error"] == "upstream_quota_exhausted"
    assert result["rawError"] == "今天的生成次数已经到达上限，明天再来免费生成吧"


def test_conversational_refusal_without_creation_terminates_with_exact_text():
    # When Dola assistant replies with conversational refusal (e.g. 30s limitation or policy)
    # without a creation block, parse_generation_payloads must fail the task and preserve the full original text.
    refusal_text = (
        "视频生成目前支持 4–15 秒。你要求的 30 秒无法直接生成，我建议按完整脚本拆为 3 段各 10 秒竖屏视频，"
        "这样故事更有节奏感，细节也更丰富。我们可以这样安排：A. 生成 3 段 9:16、10 秒视频，分别对应 0–10s / 10–20s / 20–30s..."
    )
    downlink_payload = {
        "downlink_body": {
            "pull_singe_chain_downlink_body": {
                "messages": [
                    {
                        "sender_type": 1,
                        "content": '[{"block_type":10000,"content":{"text_block":{"text":"生成30秒视频：海边日落"}}}]',
                    },
                    {
                        "sender_type": 2,
                        "content": f'[{{"block_type":10000,"content":{{"text_block":{{"text":"{refusal_text}"}}}}}}]',
                    },
                ]
            }
        }
    }
    result = parse_generation_payloads([downlink_payload])
    assert result.get("error") == refusal_text
    assert result.get("rawError") == refusal_text
    assert result.get("url") == ""


def test_user_message_only_continues_polling_until_assistant_replies():
    # When only the user prompt exists in downlink messages and assistant has not answered yet,
    # it must return {} to continue polling.
    downlink_payload = {
        "downlink_body": {
            "pull_singe_chain_downlink_body": {
                "messages": [
                    {
                        "sender_type": 1,
                        "content": '[{"block_type":10000,"content":{"text_block":{"text":"生成视频：日出"}}}]',
                    }
                ]
            }
        }
    }
    result = parse_generation_payloads([downlink_payload])
    assert result == {}


def test_active_creation_block_continues_polling():
    # When an active creation block is present (status 1 = generating), return {} to keep polling.
    downlink_payload = {
        "downlink_body": {
            "pull_singe_chain_downlink_body": {
                "messages": [
                    {
                        "sender_type": 2,
                        "content": '[{"block_type":2074,"content":{"creation_block":{"creations":[{"type":2,"video":{"status":1}}]}}}]',
                    }
                ]
            }
        }
    }
    result = parse_generation_payloads([downlink_payload])
    assert result == {}


def test_ensure_loaded_reclassifies_orphaned_running_tasks(monkeypatch, tmp_path):
    import asyncio

    from dola_api.task_store import save_state

    monkeypatch.setenv("DOLA_TASK_STATE_PATH", str(tmp_path / "tasks.json"))
    monkeypatch.setenv("DOLA_PROVIDER_KEY", "unit-test-provider-key")
    save_state(
        [
            {"id": "dola-ack", "model": "dola-seedance-2-5", "status": "running"},
            {"id": "dola-noack", "model": "dola-seedance-2-5", "status": "running"},
            {"id": "dola-kept", "model": "dola-seedance-2-5", "status": "accepted"},
        ],
        {
            "dola-ack": {"accountId": "acc-1", "ackReceived": True},
            "dola-noack": {"accountId": "acc-2"},
            "dola-kept": {"accountId": "acc-3", "ackReceived": True},
        },
    )
    pool = CamoufoxSessionPool()
    asyncio.run(pool._ensure_loaded())
    assert pool._tasks["dola-ack"].status == "accepted"
    assert pool._tasks["dola-noack"].status == "failed"
    assert pool._tasks["dola-noack"].error == "submission_interrupted"
    assert pool._tasks["dola-kept"].status == "accepted"


def test_finalize_headed_test_reports_account_on_needs_login(monkeypatch):
    import asyncio

    import dola_api.session as session_module
    from dola_api.contracts import VerificationLease
    from dola_api.session import VerificationSession

    pool = CamoufoxSessionPool()
    pool._loaded = True

    class FakeContext:
        async def cookies(self, *_args, **_kwargs):
            return [{"name": "sessionid", "value": "abc"}]

    lease = "l" * 24
    pool._verifications["ver-1"] = VerificationSession(
        verification_id="ver-1",
        task_id="",
        request=None,
        page_session=PageSession("acc-149", 1, "direct", "", "", "", "sessionid=abc"),
        browser=None,
        context=FakeContext(),
        page=None,
        references=[],
        decision={"type": "inspect", "subtype": "headed_test"},
        lease_token=lease,
        created_at="2026-09-22T00:00:00Z",
    )

    async def fake_probe(cookie, proxy_url=None):
        return {"state": "needs_login"}

    monkeypatch.setattr(session_module, "probe_account_login", fake_probe)
    result = asyncio.run(pool.finalize_headed_test("ver-1", VerificationLease(leaseToken=lease)))
    assert result["status"] == "needs_login"
    assert result["accountId"] == "acc-149"
