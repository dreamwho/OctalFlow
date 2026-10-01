import base64
import json

import asyncio

import pytest

from dola_api.contracts import VideoRequest, VideoTask
from dola_api.session import CamoufoxSessionPool
from dola_api.traffic import bind_trusted_traffic_context, decode_trusted_traffic_context, traffic_context


def _header(payload: dict[str, object]) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")


def test_trusted_header_accepts_only_route_metadata_and_replaces_body_context():
    request = VideoRequest(
        model="dola-seedance-2-5",
        prompt="fixture",
        requestId="body-request-id",
        trafficContext={"channelId": "untrusted", "channelName": "untrusted", "protocol": "untrusted", "model": "wrong"},
    )
    bound = bind_trusted_traffic_context(
        request,
        _header(
            {
                "channelId": "channel-7",
                "channelName": "Channel 7",
                "protocol": "dola-runtime",
                "requestId": "trusted-request-id",
                "taskId": "trusted-task-id",
                "attemptId": "untrusted-attempt-id",
                "model": "must-not-pass",
                "role": "must-not-pass",
            }
        ),
    )
    assert bound.trafficContext == {
        "channelId": "channel-7",
        "channelName": "Channel 7",
        "protocol": "dola-runtime",
        "requestId": "trusted-request-id",
        "taskId": "trusted-task-id",
        "attemptId": "untrusted-attempt-id",
    }
    assert bound.requestId == "trusted-request-id"
    unbound = bind_trusted_traffic_context(request, None)
    assert unbound.trafficContext is None
    assert unbound.requestId is None


def test_trusted_context_rejects_bad_encoding_and_derives_execution_only_fields():
    with pytest.raises(ValueError, match="traffic_context_invalid"):
        decode_trusted_traffic_context("not json")
    source = decode_trusted_traffic_context(_header({"channelId": "dola", "protocol": "protocol-page-signed", "requestId": "dola-log-1", "taskId": "generation-task-1", "attemptId": "attempt-from-header"}))
    exact = traffic_context(source, role="submit", model="dola-seedance-2-5", proxy_mode="managed", proxy_source="magic")
    assert exact == {
        "channelId": "dola",
        "channelName": "Dola API",
        "model": "dola-seedance-2-5",
        "protocol": "protocol-page-signed",
        "connectionMode": "magic",
        "role": "submit",
        "attributionScope": "exact",
        "requestId": "dola-log-1",
        "taskId": "generation-task-1",
        "attemptId": "attempt-from-header",
    }
    browser = traffic_context(exact, role="browser", shared_browser=True)
    assert browser["model"] == "__shared_browser__"
    assert browser["attributionScope"] == "shared_browser"
    assert browser["connectionMode"] == "magic"
    assert not {"requestId", "taskId", "attemptId"}.intersection(browser)


def test_submit_persists_trusted_request_and_task_ids_with_a_new_attempt(monkeypatch, tmp_path):
    monkeypatch.setenv("DOLA_PROFILE_DIR", str(tmp_path))
    pool = CamoufoxSessionPool()

    async def noop():
        return None

    async def stop_background_submit(*_args, **_kwargs):
        raise AssertionError("background submit must not run in this unit test")

    monkeypatch.setattr(pool, "_ensure_loaded", noop)
    monkeypatch.setattr(pool, "_persist", noop)
    monkeypatch.setattr(pool, "_run_page_submit", stop_background_submit)
    task = asyncio.run(
        pool.submit(
            VideoRequest(
                model="dola-seedance-2-5",
                prompt="fixture",
                duration=5,
                cookie="sid=fixture",
                trafficContext={
                    "channelId": "dola",
                    "channelName": "Dola API",
                    "protocol": "protocol-page-signed",
                    "requestId": "dola-log-1",
                    "taskId": "generation-task-1",
                    "attemptId": "spoofed-by-caller",
                },
            )
        )
    )

    assert task.id.startswith("dola-")
    assert task.requestId == "dola-log-1"
    assert task.trafficTaskId == "generation-task-1"
    assert task.attemptId and task.attemptId.startswith("dola-attempt-")
    assert task.attemptId != "spoofed-by-caller"
    execution = pool._task_meta[task.id]["trafficContext"]
    assert execution["requestId"] == "dola-log-1"
    assert execution["taskId"] == "generation-task-1"
    assert execution["attemptId"] == task.attemptId
    assert traffic_context(execution, role="upload")["taskId"] == "generation-task-1"
    browser = traffic_context(execution, role="browser", shared_browser=True)
    assert not {"requestId", "taskId", "attemptId"}.intersection(browser)


def test_submit_response_keeps_dola_runtime_task_id_separate_from_traffic_task(monkeypatch):
    import dola_api.app as app_module

    received = []

    async def submit_task(request):
        received.append(request)
        return VideoTask(
            id="dola-runtime-task-id",
            model=request.model,
            status="queued",
            requestId=request.requestId,
            trafficTaskId=request.trafficContext["taskId"],
            attemptId="dola-attempt-1",
        )

    monkeypatch.setattr(app_module.pool, "submit", submit_task)
    response = asyncio.run(
        app_module.submit(
            VideoRequest(model="dola-seedance-2-5", prompt="fixture", requestId="body-request-id"),
            _header({"requestId": "dola-log-1", "taskId": "generation-task-1"}),
        )
    )

    assert received[0].requestId == "dola-log-1"
    assert response["id"] == "dola-runtime-task-id"
    assert response["taskId"] == "dola-runtime-task-id"
    assert response["trafficTaskId"] == "generation-task-1"
    assert response["attemptId"] == "dola-attempt-1"


@pytest.mark.anyio
async def test_legacy_local_await_form_stays_available_but_central_requires_a_lease_context(tmp_path, monkeypatch):
    import dola_api.traffic as traffic

    await traffic.close_meter()
    monkeypatch.delenv("DREAMYO_TRAFFIC_METER_URL", raising=False)
    monkeypatch.setenv("DOLA_TRAFFIC_STATE_PATH", str(tmp_path / "traffic.sqlite3"))
    traffic.start_meter()
    try:
        assert (await traffic.metered_proxy(None, "submit")).startswith("http://dola:")
        monkeypatch.setenv("DREAMYO_TRAFFIC_METER_URL", "http://meter.internal:18083")
        with pytest.raises(RuntimeError, match="traffic_meter_lease_context_required"):
            await traffic.metered_proxy(None, "submit")
    finally:
        monkeypatch.delenv("DREAMYO_TRAFFIC_METER_URL", raising=False)
        await traffic.close_meter()
