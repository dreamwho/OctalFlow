import asyncio
import json

import pytest

from dola_api.contracts import AdoptBrowserTaskRequest, BrowserQueryResultRequest, VideoTask
from dola_api.query import extract_generation_input
from dola_api.session import CamoufoxSessionPool


def test_adopted_browser_task_is_registered_once_and_pollable(monkeypatch):
    pool = CamoufoxSessionPool()
    pool._loaded = True

    async def persist():
        return None

    monkeypatch.setattr(pool, "_persist", persist)
    request = AdoptBrowserTaskRequest(
        taskId="dola-11111111-1111-4111-8111-111111111111",
        conversationId="38418080062463249",
        model="dola-seedance-2-5",
        accountId="desktop-account",
        cookie="sid=fixture",
        identity={"device_id": "device"},
    )
    first = asyncio.run(pool.adopt_browser_task(request))
    second = asyncio.run(pool.adopt_browser_task(request.model_copy(update={"taskId": "dola-22222222-2222-4222-8222-222222222222"})))
    assert first.id == second.id
    assert first.status == "accepted"
    assert pool._task_meta[first.id]["conversationId"] == "38418080062463249"
    assert pool._task_meta[first.id]["identity"]["device_id"] == "device"


def test_live_browser_result_updates_only_its_bound_task_and_keeps_success_on_query_errors(monkeypatch):
    pool = CamoufoxSessionPool()
    pool._loaded = True
    task = VideoTask(id="browser-task", accountId="account", model="dola-seedance-2-5", status="accepted", conversationId="38418080062463249")
    pool._tasks[task.id] = task

    async def persist():
        return None

    monkeypatch.setattr(pool, "_persist", persist)
    chain = {"conversation_id": task.conversationId, "messages": [{"user_type": 1, "content": '[{"content":{"text_block":{"text":"原始需求"}}}]'}, {"user_type": 2, "content": '[{"content":{"text_block":{"text":"生成好了"},"creation_block":{"creations":[{"type":2,"video":{"download_url":"http://v16-dola.dola.com/final.mp4"}}]}}}]'}]}
    request = BrowserQueryResultRequest(accountId="account", conversationId=task.conversationId, payload={"code": 0, "downlink_body": {"pull_singe_chain_downlink_body": chain}})
    result = asyncio.run(pool.apply_browser_result(task.id, request))
    assert result.status == "completed"
    assert result.videoUrl == "http://v16-dola.dola.com/final.mp4"
    assert extract_generation_input(request.payload) == {"prompt": "原始需求", "references": []}
    assert "原始需求" not in str(result.diagnostics)
    for patch in [{"accountId": "another"}, {"conversationId": "38418080062463250"}, {"payload": {"code": 710022004}}]:
        with pytest.raises(ValueError):
            asyncio.run(pool.apply_browser_result(task.id, request.model_copy(update=patch)))
    assert pool._tasks[task.id].status == "completed"
    assert pool._tasks[task.id].videoUrl == result.videoUrl


def test_generation_input_never_restores_unknown_or_assistant_messages():
    assert extract_generation_input({"messages": [{"content": '[{"text_block":{"text":"未知来源"}}]'}, {"user_type": 2, "content": '[{"text_block":{"text":"内部执行"}}]'}]}) == {}


def test_original_native_ability_restores_editable_input_and_exact_parameters():
    message = {"user_type": 1, "create_time": "1790767917", "content": '[{"text_block":{"text":"生成视频：公开草稿"}}]', "ext": {"chat_ability": json.dumps({"ability_type": 17, "ability_param": json.dumps({"duration": 5, "ratio": "9:16", "input_box_content": {"user_input_content": "公开草稿"}})})}}
    result = extract_generation_input({"messages": [message]})
    assert result == {"prompt": "公开草稿", "references": [], "duration": 5, "ratio": "9:16", "createdAt": "2026-09-30T11:31:57+00:00"}


def test_adopted_browser_task_persists_desktop_http_identity(monkeypatch):
    pool = CamoufoxSessionPool()
    pool._loaded = True

    async def persist():
        return None

    monkeypatch.setattr(pool, "_persist", persist)
    request = AdoptBrowserTaskRequest(
        taskId="dola-33333333-3333-4333-8333-333333333333",
        conversationId="38418080062463250",
        model="dola-seedance-2-5",
        accountId="desktop-account",
        cookie="sid=fixture",
        identity={"device_id": "device"},
        userAgent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        acceptLanguage="zh-CN,zh;q=0.9,en;q=0.8",
    )
    task = asyncio.run(pool.adopt_browser_task(request))
    assert pool._task_meta[task.id]["httpIdentity"] == {"userAgent": request.userAgent, "acceptLanguage": request.acceptLanguage}

    plain = AdoptBrowserTaskRequest(
        taskId="dola-44444444-4444-4444-8444-444444444444",
        conversationId="38418080062463251",
        model="dola-seedance-2-5",
        accountId="desktop-account-2",
        cookie="sid=fixture",
        identity={},
    )
    plain_task = asyncio.run(pool.adopt_browser_task(plain))
    assert "httpIdentity" not in pool._task_meta[plain_task.id]
