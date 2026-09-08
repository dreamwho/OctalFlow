import asyncio
import sys
import pytest

from fastapi import HTTPException
from fastapi.testclient import TestClient

from api.app import create_app
from services.log_service import LoggedCall, log_service
from services.dashboard_metrics_service import DashboardMetricsService

HEADERS = {"x-octal-runtime-key": "fixture-runtime-key-0123456789abcdef", "authorization": "Bearer fixture-runtime-key-0123456789abcdef"}


@pytest.fixture(autouse=True)
def isolated_logs(monkeypatch, tmp_path):
    from services.call_record_service import CallRecordService
    service = CallRecordService(database_url=f"sqlite:///{tmp_path / 'logs.db'}")
    monkeypatch.setattr("services.log_service.log_service", service)
    monkeypatch.setattr("api.integration.log_service", service)
    monkeypatch.setattr(sys.modules[__name__], "log_service", service)


def test_request_is_visible_before_handler_finishes_and_updates_same_record():
    client = TestClient(create_app())
    call = LoggedCall({"id": "fixture"}, "/v1/chat/completions", "fixture-model", "文本生成", request_text="安全测试内容")
    cursor = log_service.current_call_cursor()

    def handler():
        page = client.get("/api/logs?search=" + call.call_id, headers=HEADERS)
        assert page.status_code == 200
        assert page.json()["total"] == 1
        assert page.json()["items"][0]["presentation"]["status"]["label"] == "执行中"
        detail = client.get("/api/logs/" + call.call_id, headers=HEADERS)
        assert detail.status_code == 200
        assert detail.json()["ended_at"] == ""
        assert detail.json()["request_text"] == "安全测试内容"
        assert len(detail.json()["request_meta"]["lifecycle"]) == 2
        return {"result": "ok"}

    assert asyncio.run(call.run(handler)) == {"result": "ok"}
    page = log_service.list_page(search=call.call_id)
    assert page["total"] == 1
    assert page["items"][0]["outcome"] == "success"
    assert log_service.get_detail(call.call_id)["ended_at"]
    assert log_service.current_call_cursor()["generation"] == cursor["generation"]
    assert log_service.current_call_cursor()["sequence"] >= cursor["sequence"] + 2
    assert client.get("/api/logs/" + call.call_id).status_code == 401
    assert client.get("/api/logs/missing-fixture", headers=HEADERS).status_code == 404


def test_failure_is_terminal_and_credentials_are_not_persisted():
    call = LoggedCall({}, "/v1/chat/completions", "fixture", "文本")
    def fail():
        raise HTTPException(503, "password=fixture-secret")
    try:
        asyncio.run(call.run(fail))
    except HTTPException:
        pass
    detail = log_service.get_detail(call.call_id)
    assert detail["outcome"] == "failed"
    assert "fixture-secret" not in str(detail)
    call.log("迟到响应", status="running")
    assert log_service.get_detail(call.call_id)["outcome"] == "failed"


def test_stream_close_records_cancellation_not_success():
    call = LoggedCall({}, "/v1/chat/completions", "fixture", "文本")
    call.log("开始", status="running")
    stream = call.stream(iter([{"a": 1}, {"a": 2}]))
    next(stream)
    stream.close()
    assert log_service.get_detail(call.call_id)["display_status"] == "cancelled"


def test_running_request_does_not_count_as_failed_in_statistics():
    bucket = {}
    DashboardMetricsService._apply_call(bucket, {"detail": {"status": "running"}})
    assert bucket == {}


def test_completion_is_ingested_once_after_report_reads_running_record(tmp_path):
    metrics = DashboardMetricsService(database_url=f"sqlite:///{tmp_path / 'logs.db'}")
    call = LoggedCall({}, "/v1/chat/completions", "fixture", "文本")
    call.log("已提交", status="queued")
    metrics.sync_from_log_service(log_service)
    assert metrics.summary()["totals"]["total"] == 0
    call.log("执行中", status="running")
    metrics.sync_from_log_service(log_service)
    assert metrics.summary()["totals"]["final_failed"] == 0
    call.log("完成")
    metrics.sync_from_log_service(log_service)
    assert metrics.summary()["totals"]["success"] == 1
    metrics.sync_from_log_service(log_service)
    assert metrics.summary()["totals"]["total"] == 1
