from dola_api.protocol import canonical_ratio, sanitize_video_prompt_duration, validate_request
from dola_api.page_scripts import DOLA_30S_UNLOCKER_SCRIPT, MAIN_WORLD_CREDIT_SCRIPT, MAIN_WORLD_JSON_REQUEST_SCRIPT, MAIN_WORLD_SUBMIT_SCRIPT
from dola_api.query import decode_main_url, extract_conversation_id, extract_image_urls, extract_main_url, extract_video_url, extract_vod_payload, generation_query_payloads, parse_generation_payloads
from dola_api.sse import iter_sse_events
from dola_api.session import CamoufoxSessionPool, PageSession, _build_completion_query, _build_request_body, _camoufox_browser_options, _camoufox_context_options, _page_has_verification_marker, _proxy_url_for_request, _sse_verification_decision, _submission_diagnostics, parse_browser_submission, prepare_browser_submission
from dola_api.contracts import VideoRequest, VideoTask
import asyncio
import pytest


def test_model_duration_contract_keeps_fast_at_15_seconds():
    assert validate_request("dola-seedance-2-5", 30, "21:9").upstream_model == "seedance_v2.5"
    try:
        validate_request("dola-seedance-2-0-fast", 30, "16:9")
    except ValueError as error:
        assert str(error) == "unsupported_duration:30"
    else:
        raise AssertionError("Fast must reject 30 seconds")


def test_duration_policy_confirmation_refusal_terminates():
    payload = {"messages": [{"user_type": 2, "content": '[{"block_type":10000,"content":{"text_block":{"text":"我会按你给的24秒完整脚本执行。由于单条视频目前支持4\u201315秒，我建议拆成两段连续生成：第1段0-14秒，第2段14-24秒。确认后我直接生成这两段视频。"}}}]'}]}
    result = parse_generation_payloads([payload])
    assert result.get("error") == "upstream_unsupported_duration"
    assert "建议拆成两段" in result.get("rawError", "")


def test_duration_talk_with_active_creation_block_keeps_polling():
    payload = {"messages": [{"user_type": 2, "content": '[{"block_type":10000,"content":{"text_block":{"text":"先说明：视频目前支持4-15秒，但本次我按约定继续生成。"}}},{"block_type":2074,"content":{"creation_block":{"creations":[{"type":2,"video":{"status":1}}]}}}]'}]}
    assert parse_generation_payloads([payload]) == {}


def test_seedance_2_5_duration_is_continuous_5_to_30():
    for duration in (5, 12, 20, 28, 30):
        assert validate_request("dola-seedance-2-5", duration, "16:9").upstream_model == "seedance_v2.5"
    for duration in (4, 31):
        try:
            validate_request("dola-seedance-2-5", duration, "16:9")
        except ValueError as error:
            assert str(error) == f"unsupported_duration:{duration}"
        else:
            raise AssertionError("2.5 must stay inside 5-30 seconds")


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
    assert MAIN_WORLD_SUBMIT_SCRIPT.count("xhr.send(request.body)") == 1
    assert "xhr.send(cfg.body)" not in MAIN_WORLD_SUBMIT_SCRIPT


def test_main_world_submit_script_primes_over_15s_duration_with_rule_message():
    assert "cfg.ruleBody" in MAIN_WORLD_SUBMIT_SCRIPT
    assert 'extractConversationId(ruleResult.text)' in MAIN_WORLD_SUBMIT_SCRIPT
    assert '"rule_prime"' in MAIN_WORLD_SUBMIT_SCRIPT
    assert "body.client_meta.conversation_id = ruleConversationId" in MAIN_WORLD_SUBMIT_SCRIPT
    assert "body.option.need_create_conversation = false" in MAIN_WORLD_SUBMIT_SCRIPT
    assert "delete body.option.conversation_init_option" in MAIN_WORLD_SUBMIT_SCRIPT
    assert "ruleConversationId" in MAIN_WORLD_SUBMIT_SCRIPT
    # single-shot path must stay intact when no rule body is configured
    assert "if (!cfg.ruleBody) return send({ ...request, body: cfg.body }, done);" in MAIN_WORLD_SUBMIT_SCRIPT


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
    assert [path for path, _ in queries] == ["/im/chain/single", "/im/conversation/info"]
    result = parse_generation_payloads([{"creation_block": {"creations": [{"type": 2, "video": {"download_url": "https://cdn.dola.com/final.mp4"}}]}}])
    assert result["url"] == "https://cdn.dola.com/final.mp4"


def test_pending_chain_uses_one_protocol_request_without_browser_fallback(monkeypatch):
    import asyncio
    import httpx
    import dola_api.query as query_module
    import dola_api.session as session_module

    requested_paths = []

    def handler(request):
        requested_paths.append(request.url.path)
        return httpx.Response(200, json={"code": 0, "downlink_body": {"pull_singe_chain_downlink_body": {"messages": [
            {"user_type": 1, "content_block": [{"block_type": 10000, "content": {"text_block": {"text": "请分析视频生成失败的原因"}}}]},
            {"user_type": 2, "tts_content": "正在生成中"},
        ]}}})

    client = httpx.AsyncClient
    monkeypatch.setattr(query_module.httpx, "AsyncClient", lambda **kwargs: client(transport=httpx.MockTransport(handler), **kwargs))
    result = asyncio.run(query_module.fetch_generation_result("session=fixture", "38418045496287761", {}))
    assert result == {"pending": True, "assistantText": "正在生成中"}
    assert requested_paths == ["/im/chain/single"]

    pool = CamoufoxSessionPool()
    pool._tasks["pending-video"] = VideoTask(id="pending-video", model="dola-seedance-2-5", status="accepted", conversationId="38418045496287761")
    pool._task_meta["pending-video"] = {"conversationId": "38418045496287761", "cookie": "session=fixture", "identity": {}}

    async def pending(*_args):
        return result

    async def unexpected_browser(*_args):
        raise AssertionError("有效的等待响应不应启动浏览器")

    async def persist():
        return None

    monkeypatch.setattr(session_module, "fetch_generation_result", pending)
    monkeypatch.setattr(pool, "_fetch_generation_result_in_page", unexpected_browser)
    monkeypatch.setattr(pool, "_persist", persist)
    asyncio.run(pool._refresh_task("pending-video"))
    assert pool._tasks["pending-video"].status == "accepted"
    assert pool._tasks["pending-video"].diagnostics["upstreamResponseText"] == "正在生成中"


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


def test_browser_submit_uses_existing_request_builder_without_extra_browser():
    request = VideoRequest(model="dola-seedance-2-5", prompt="云朵缓慢飘过", duration=5, ratio="16:9")
    prepared = asyncio.run(prepare_browser_submission(request, None))
    assert prepared["body"]["option"]["need_create_conversation"] is True
    assert "__dola_submit_result__" in prepared["script"]
    assert prepared["referenceCount"] == 0


def test_browser_submit_accepts_uploaded_references_without_upload_credentials():
    references = [{"uri": f"imagex://reference-{index}", "name": f"图{index}.jpg", "width": 1280, "height": 720, "mime": "image/jpeg"} for index in range(3)]
    request = VideoRequest(model="dola-seedance-2-5", prompt="云朵缓慢飘过", duration=5, references=references)
    prepared = asyncio.run(prepare_browser_submission(request, None))
    assert prepared["referenceCount"] == 3
    assert prepared["resolvedReferences"] == references
    assert prepared["body"]["option"]["need_create_conversation"] is True
    assert all(item["uri"] in str(prepared["body"]) for item in references)


def test_browser_submit_still_requires_credentials_for_unuploaded_reference():
    request = VideoRequest(model="dola-seedance-2-5", prompt="云朵", duration=5, references=[{"uri": "imagex://ready"}, {"dataUrl": "data:image/jpeg;base64,dGVzdA=="}])
    with pytest.raises(ValueError, match="browser_upload_config_missing"):
        asyncio.run(prepare_browser_submission(request, None))


def test_submit_body_keeps_page_fingerprint_and_reference_collection():
    request = VideoRequest(model="dola-seedance-2-5", prompt="云朵", duration=5, ratio="16:9", cookie="s_v_web_id=page-fp")
    body = _build_request_body(validate_request(request.model, request.duration, request.ratio), request, [{"uri": "imagex://reference", "name": "图.png"}])
    assert body["ext"]["fp"] == "page-fp"
    assert body["option"]["collect_id"] == body["ext"]["collection_id"]
    assert body["option"]["collect_id"]
    assert len(body["client_meta"]["local_conversation_id"]) == 22


def test_code_only_rejection_is_not_reported_as_account_rate_limit():
    payload = {"status": 200, "signed": True, "text": 'event: STREAM_ERROR\ndata: {"code":710022002}\n\n'}
    result = asyncio.run(parse_browser_submission(payload, "session=test", None))
    assert result["status"] == "failed"
    assert result["error"] == "dola_upstream_rejected_710022002"
    assert result["diagnostics"]["codes"] == ["710022002"]


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
        "image": {"url": "https://img.dola.com/assistant-avatar.png"},
        "messages": [{
            "content": '[{"block_type":2074,"content":{"creation_block":{"creations":[{"type":1,"image":{"image_raw":{"url":"https://img.dola.com/a_wm.jpeg"},"image_ori":{"url":"https://img.dola.com/a.jpeg"}}}]}}}]',
        }],
    }
    urls = extract_image_urls(payload)
    assert urls == ["https://img.dola.com/a.jpeg"]


def test_query_parser_extracts_failed_creation_error_and_does_not_hang():
    failed_payload = {
        "messages": [{
            "content": '[{"block_type":2074,"content":{"creation_block":{"creations":[{"type":2,"video":{"status":4,"fail_code":710001,"fail_msg":"内容可能违反社区规范，无法生成视频"}}]}}}]',
        }],
    }
    result = parse_generation_payloads([failed_payload])
    assert result["error"] == "content_policy_violation"
    assert "违反社区规范" in result["rawError"]
    assert result["url"] == ""

    generic_failed_payload = {
        "messages": [{
            "content": '[{"block_type":2074,"content":{"creation_block":{"creations":[{"type":2,"video":{"status":4,"fail_code":50001,"error_msg":"生成视频失败，出了点问题"}}]}}}]',
        }],
    }
    result2 = parse_generation_payloads([generic_failed_payload])
    assert result2["error"] == "upstream_generation_failed"
    assert "生成视频失败" in result2["rawError"]


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

    async def recover_recent(cookie, identity, proxy_url=None, http_identity=None):
        assert cookie == "sid=abc"
        return "38417880090853905"

    async def query(cookie, conversation_id, identity, proxy_url=None, http_identity=None):
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

    async def recover_recent(cookie, identity, proxy_url=None, http_identity=None):
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


def test_protocol_failure_keeps_reply_without_starting_screenshot_browser(monkeypatch):
    import asyncio
    import dola_api.session as session_module
    from dola_api.app import query

    pool = CamoufoxSessionPool()
    pool._tasks["task-failed-query"] = VideoTask(id="task-failed-query", model="dola-seedance-2-0-fast", status="accepted", conversationId="38417845959375633", screenshotBase64="stale-submission-screen")
    pool._task_meta["task-failed-query"] = {"conversationId": "38417845959375633", "cookie": "sid=abc", "identity": {}, "screenshotBase64": "stale-submission-screen"}

    async def direct_query(*_args, **_kwargs):
        return {"error": "content_policy_violation", "rawError": "老房改造提示词存在不符合社区规范的内容，无法生成视频", "assistantText": "老房改造提示词存在不符合社区规范的内容，无法生成视频"}

    async def page_query(*_args, **_kwargs):
        raise AssertionError("协议已返回明确原因时不应启动浏览器")

    async def persist():
        return None

    monkeypatch.setenv("DOLA_ENABLE_BROWSER", "1")
    monkeypatch.setattr(session_module, "fetch_generation_result", direct_query)
    monkeypatch.setattr(pool, "_fetch_generation_result_in_page", page_query)
    monkeypatch.setattr(pool, "_persist", persist)
    asyncio.run(pool._refresh_task("task-failed-query"))

    task = pool._tasks["task-failed-query"]
    assert task.status == "failed"
    assert task.error == "content_policy_violation"
    assert task.rawError == "老房改造提示词存在不符合社区规范的内容，无法生成视频"
    assert task.screenshotBase64 is None

    monkeypatch.setattr("dola_api.app.pool", pool)
    serialized = asyncio.run(query("task-failed-query"))
    assert serialized["rawError"] == "老房改造提示词存在不符合社区规范的内容，无法生成视频"
    assert serialized["raw_error"] == "老房改造提示词存在不符合社区规范的内容，无法生成视频"
    assert serialized.get("screenshotBase64") is None


def test_refresh_task_does_not_reuse_unrelated_submission_screenshot(monkeypatch):
    import asyncio
    import dola_api.session as session_module

    pool = CamoufoxSessionPool()
    pool._tasks["task-failed-query"] = VideoTask(id="task-failed-query", model="dola-seedance-2-0-fast", status="accepted", conversationId="38417845959375633", screenshotBase64="stale-submission-screen")
    pool._task_meta["task-failed-query"] = {"cookie": "sid=abc", "identity": {}, "screenshotBase64": "stale-submission-screen"}

    async def direct_query(*_args, **_kwargs):
        return {"error": "upstream_generation_failed"}

    async def page_query(*_args, **_kwargs):
        raise RuntimeError("result_query_wrong_conversation")

    async def persist():
        return None

    monkeypatch.setenv("DOLA_ENABLE_BROWSER", "1")
    monkeypatch.setattr(session_module, "fetch_generation_result", direct_query)
    monkeypatch.setattr(pool, "_fetch_generation_result_in_page", page_query)
    monkeypatch.setattr(pool, "_persist", persist)
    asyncio.run(pool._refresh_task("task-failed-query"))

    assert pool._tasks["task-failed-query"].screenshotBase64 is None


def test_failed_conversation_screenshot_never_uses_another_sidebar_chat(monkeypatch):
    import asyncio
    import camoufox.async_api as camoufox_api
    import dola_api.session as session_module

    conversation_id = "38417845959375633"
    requested_urls = []

    class Page:
        url = "https://www.dola.com/chat/create-image"

        @property
        def first(self):
            return self

        async def title(self):
            return "Dola"

        def locator(self, *_args):
            return self

        async def inner_text(self):
            return "视频创作"

        async def count(self):
            return 0

    class Context:
        async def add_init_script(self, *_args):
            return None

        async def add_cookies(self, *_args):
            return None

        async def new_page(self):
            return Page()

    class Browser:
        async def new_context(self, **_kwargs):
            return Context()

    class Camoufox:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return Browser()

        async def __aexit__(self, *_args):
            return None

    async def goto(_page, url):
        requested_urls.append(url)
        return "ready"

    monkeypatch.setenv("DOLA_ENABLE_BROWSER", "1")
    monkeypatch.setattr(camoufox_api, "AsyncCamoufox", Camoufox)
    monkeypatch.setattr(session_module, "_goto_dola_page", goto)
    try:
        asyncio.run(CamoufoxSessionPool()._fetch_generation_result_in_page(conversation_id, {"cookie": "sid=abc"}))
        assert False, "a redirected conversation must not produce a screenshot"
    except RuntimeError as error:
        assert str(error) == "result_query_wrong_conversation"
    assert requested_urls == [f"https://www.dola.com/chat/{conversation_id}"]


def test_submit_stream_extraction_walks_sse_event_tuples():
    events = [("SSE_ACK", {"ack_client_meta": {"conversation_id": "38417880090853905"}})]
    assert extract_conversation_id(events) == "38417880090853905"
    video_events = [("FULL_MSG_NOTIFY", {"messages": [{"content": '[{"block_type":2074,"content":{"creation_block":{"creations":[{"type":2,"video":{"download_url":"https://cdn.dola.com/generated.mp4"}}]}}}]'}]})]
    assert extract_video_url(video_events) == "https://cdn.dola.com/generated.mp4"
    image_events = [("FULL_MSG_NOTIFY", {"messages": [{"content": '[{"content":{"creation_block":{"creations":[{"type":1,"image":{"image_ori":{"url":"https://cdn.dola.com/image.png"}}}]}}}]'}]})]
    assert extract_image_urls(image_events) == ["https://cdn.dola.com/image.png"]


def test_generic_failure_message_terminates_generation_result():
    payload = {"messages": [{"sender_type": 2, "content": '[{"block_type":10000,"content":{"text_block":{"text":"出了点问题，请稍后重试。"}}}]'}]}
    assert parse_generation_payloads([payload])["error"] == "upstream_generation_failed"


def test_later_failure_message_overrides_stale_active_creation():
    active = {"messages": [{"sender_type": 2, "content": '[{"block_type":2074,"content":{"creation_block":{"creations":[{"type":2,"video":{"status":1},"image":{"image_ori":{"url":"https://cdn.dola.com/cover.png"}}}]}}}]'}, {"sender_type": 2, "content": '[{"block_type":10000,"content":{"text_block":{"text":"视频生成好后，我会主动发送给你。"}}}]'}]}
    failed = {"messages": [{"sender_type": 2, "content": '[{"block_type":10000,"content":{"text_block":{"text":"视频生成失败，生成额度未扣除。"}}}]'}]}
    result = parse_generation_payloads([active, failed])
    assert result["error"] == "upstream_generation_failed"
    assert result["rawError"] == "视频生成失败，生成额度未扣除。"


def test_sanitize_video_prompt_duration_removes_conversational_triggers():
    assert sanitize_video_prompt_duration("生成30秒视频：海边日落") == "海边日落"
    assert sanitize_video_prompt_duration("海边日落，时长30秒，超清画质") == "海边日落，超清画质"
    assert sanitize_video_prompt_duration("生成一段15秒的微电影：秋天的落叶") == "秋天的落叶"
    assert sanitize_video_prompt_duration("一只猫咪在草地上玩耍 30s") == "一只猫咪在草地上玩耍"
    assert sanitize_video_prompt_duration("A futuristic city at night, duration: 30s, cinematic lighting") == "A futuristic city at night，cinematic lighting"
    assert sanitize_video_prompt_duration("30秒") == ""


def test_sanitize_video_prompt_duration_strips_storyboard_and_bare_mentions():
    assert sanitize_video_prompt_duration("按 30 秒完整分镜生成：门外吐槽，进门，客厅被惊艳") == "按 完整分镜生成：门外吐槽，进门，客厅被惊艳"
    assert "30 秒" not in sanitize_video_prompt_duration("完整 30 秒的手持生活流脚本：门外吐槽，进门")
    assert sanitize_video_prompt_duration("15s intro scene") == "intro scene"


def test_sanitize_video_prompt_duration_strips_segment_timeline_and_approx_duration():
    assert sanitize_video_prompt_duration("0-2.5秒：\n初始状态：跟随设计师穿过走廊") == "初始状态：跟随设计师穿过走廊"
    assert sanitize_video_prompt_duration("时间轴：2.5-6秒转身，27.2-30秒收尾定格") == "时间轴：转身，收尾定格"
    assert sanitize_video_prompt_duration("短片时长约28秒，节奏紧凑") == "短片，节奏紧凑"
    assert sanitize_video_prompt_duration("opening 0-2.5s handheld walk") == "opening handheld walk"


def test_build_rule_prime_body_only_for_over_15s_video():
    import json
    from dola_api.session import _build_rule_prime_body

    prime = VideoRequest(model="dola-seedance-2-5", prompt="海边日落", duration=30, ratio="9:16")
    profile = validate_request(prime.model, prime.duration, prime.ratio)
    rule_body = _build_rule_prime_body(profile, prime)
    assert isinstance(rule_body, dict)
    rule_text = rule_body["messages"][0]["content_block"][0]["content"]["text_block"]["text"]
    assert "## 30 秒视频生成规则" in rule_text
    assert "duration=30" in rule_text
    assert "seedance2.5" in rule_text
    assert "请提供 30s 提示词" in rule_text
    assert rule_body["option"]["need_create_conversation"] is True
    rule_ability = json.loads(rule_body["chat_ability"]["ability_param"])
    assert rule_ability["duration"] == 30
    assert rule_ability["ratio"] == "9:16"
    # 规则消息独立成条：不带参考素材集合
    assert rule_body["option"]["collect_id"] == ""

    for duration in (5, 10, 15):
        request = VideoRequest(model="dola-seedance-2-5", prompt="海边日落", duration=duration)
        assert _build_rule_prime_body(validate_request(request.model, duration, request.ratio), request) is None
    image = VideoRequest(model="dola-seedream-4-5", prompt="画一间客厅", duration=0)
    assert _build_rule_prime_body(validate_request(image.model, 0, image.ratio), image) is None


def test_prepare_browser_submission_returns_rule_body_for_30s():
    import json
    request = VideoRequest(model="dola-seedance-2-5", prompt="云朵缓慢飘过", duration=30, ratio="9:16")
    prepared = asyncio.run(prepare_browser_submission(request, None))
    assert "ruleBody" not in prepared
    content_ability = json.loads(prepared["body"]["chat_ability"]["ability_param"])
    assert content_ability["duration"] == 30
    short = VideoRequest(model="dola-seedance-2-5", prompt="云朵缓慢飘过", duration=15, ratio="9:16")
    assert "ruleBody" not in asyncio.run(prepare_browser_submission(short, None))


def test_completion_transport_falls_back_to_rule_conversation_id():
    from dola_api.session import parse_completion_transport

    payload = {"status": 200, "contentType": "text/event-stream", "text": "event: SSE_HEARTBEAT\r\ndata: {}\r\n\r\n", "ruleConversationId": "38418048283899153", "identity": {}}
    result = parse_completion_transport({**payload, "requestObserved": True, "requestSigned": True})
    assert result["conversationId"] == "38418048283899153"
    assert result["ackReceived"] is True


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
    payload = {"messages": [{"sender_type": 2, "content": '[{"block_type":10000,"content":{"text_block":{"text":"今天的生成次数已经到达上限，明天再来免费生成吧"}}}]'}]}
    result = parse_generation_payloads([payload])
    assert result["error"] == "upstream_quota_exhausted"
    assert result["rawError"] == "今天的生成次数已经到达上限，明天再来免费生成吧"


def test_unverified_face_refusal_terminates_task_with_original_reason():
    import json
    reply = "出于肖像保护考虑，未认证人脸暂不支持用 Dreamina Seedance 2.5 生成视频。你可以尝试换其它参考图或文生视频。"
    payload = {"messages": [{"sender_type": 2, "content": json.dumps([{"block_type": 10000, "content": {"text_block": {"text": reply}}}])}]}
    result = parse_generation_payloads([payload])
    assert result["error"] == "content_policy_violation"
    assert result["rawError"] == reply


def test_user_quoting_face_restriction_does_not_fail_active_generation():
    import json
    payload = {"messages": [
        {"sender_type": 1, "content": json.dumps([{"block_type": 10000, "content": {"text_block": {"text": "未认证人脸不支持生成视频，请仅生成房间。"}}}])},
        {"sender_type": 2, "content": json.dumps([{"block_type": 10000, "content": {"text_block": {"text": "正在生成房间视频。"}}}])},
    ]}
    assert parse_generation_payloads([payload]) == {}


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
    assert result.get("error") == "upstream_unsupported_duration"
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


def test_normalize_request_references():
    from dola_api.session import _normalize_request_references
    from dola_api.contracts import VideoRequest

    req = VideoRequest(
        model="dola-seedance-2-5",
        prompt="test prompt",
        images=["https://example.com/img1.png", "https://example.com/img2.png"],
        first_frame="https://example.com/first.png",
        last_frame="https://example.com/last.png",
    )
    refs = _normalize_request_references(req)
    assert len(refs) == 4
    assert refs[0]["role"] == "first_frame"
    assert refs[0]["url"] == "https://example.com/first.png"
    assert refs[1]["role"] == "reference"
    assert refs[1]["url"] == "https://example.com/img1.png"
    assert refs[2]["role"] == "reference"
    assert refs[2]["url"] == "https://example.com/img2.png"
    assert refs[3]["role"] == "last_frame"
    assert refs[3]["url"] == "https://example.com/last.png"
