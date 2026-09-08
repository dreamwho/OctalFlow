from __future__ import annotations

import json
import socket

import pytest


API_URL = "https://www.ipwo.net/api/proxy/get_proxy_ip?fixture_secret=ipwo-secret-never-network&num=100"


class MemoryRepository:
    def __init__(self) -> None:
        self.data: dict[str, object] = {}

    def get(self) -> dict[str, object]:
        return dict(self.data)

    def update(self, patch: dict[str, object]) -> dict[str, object]:
        self.data.update(patch)
        return self.get()


class FakeResponse:
    def __init__(self, payload: object) -> None:
        self.status_code = 200
        self.payload = payload
        self.headers: dict[str, str] = {}

    def json(self) -> object:
        return self.payload

    def close(self) -> None:
        pass


class FakeSession:
    def __init__(self, **_kwargs: object) -> None:
        pass

    def get(self, _url: str, **_kwargs: object) -> FakeResponse:
        return FakeResponse({"ip": "1.1.1.1"})

    def close(self) -> None:
        pass


def _public_dns(host: str, port: int, **_kwargs: object):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port))]


@pytest.fixture
def runtime_env(runtime_data_dir):
    """Ensure the session's frozen provider runtime exists before imports."""
    return runtime_data_dir


def _client(runtime_env, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from api import ipwo
    from services.ipwo_proxy_service import IpwoProxyService

    service = IpwoProxyService(
        repository=MemoryRepository(),
        request_get=lambda *_args, **_kwargs: FakeResponse({"code": 0, "success": True, "data": [{"ip": "8.8.8.8", "port": 8080}]}),
        dns_resolver=_public_dns,
        session_factory=FakeSession,
    )
    monkeypatch.setattr(ipwo, "ipwo_proxy_service", service)
    monkeypatch.setattr(ipwo, "require_admin", lambda _authorization: {"role": "admin"})
    app = FastAPI()
    app.include_router(ipwo.router)
    return TestClient(app)


def test_ipwo_router_uses_redacted_contract_and_explicit_ndjson_diagnostic(runtime_env, monkeypatch):
    client = _client(runtime_env, monkeypatch)
    assert client.get("/integration/ipwo").json() == {
        "configured": False,
        "has_api_url": False,
        "protocol": "http",
        "regions": "",
        "timeout_seconds": 10,
    }
    saved = client.patch("/integration/ipwo", json={
        "api_url": API_URL,
        "protocol": "http",
        "regions": "US",
        "timeout_seconds": 1,
    })
    assert saved.status_code == 200
    assert saved.json() == {
        "configured": True,
        "has_api_url": True,
        "protocol": "http",
        "regions": "US",
        "timeout_seconds": 1,
    }
    assert "fixture_secret" not in saved.text
    stream = client.post("/integration/ipwo/test")
    assert stream.headers["content-type"].startswith("application/x-ndjson")
    events = [json.loads(line) for line in stream.text.splitlines()]
    assert events[-1] == {
        "stage": "ipinfo",
        "status": "success",
        "message": "出口 IP 信息读取成功",
        "elapsed_ms": events[-1]["elapsed_ms"],
        "done": True,
        "exit_ip": "1.1.1.1",
    }
    assert "fixture_secret" not in stream.text


def test_ipwo_router_requires_saved_configuration_and_emits_terminal_error(runtime_env, monkeypatch):
    client = _client(runtime_env, monkeypatch)
    stream = client.post("/integration/ipwo/test")
    events = [json.loads(line) for line in stream.text.splitlines()]
    assert [(event["stage"], event["status"]) for event in events] == [
        ("configuration", "running"),
        ("configuration", "error"),
    ]
    assert events[-1]["done"] is True
    assert events[-1]["message"] == "未保存 IPWO API 地址"
    invalid_timeout = client.patch("/integration/ipwo", json={
        "api_url": API_URL,
        "protocol": "http",
        "regions": "US",
        "timeout_seconds": 0,
    })
    assert invalid_timeout.status_code == 422
