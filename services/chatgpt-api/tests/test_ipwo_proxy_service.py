from __future__ import annotations

import json
import socket
import sqlite3
from urllib.parse import parse_qs, urlsplit

import pytest


API_URL = (
    "https://www.ipwo.net/api/proxy/get_proxy_ip?"
    "fixture_secret=ipwo-secret-never-network&num=100&protocol=http&return_type=txt&lb=1"
)


class MemoryRepository:
    def __init__(self) -> None:
        self.data: dict[str, object] = {}

    def get(self) -> dict[str, object]:
        return dict(self.data)

    def update(self, patch: dict[str, object]) -> dict[str, object]:
        self.data.update(patch)
        return self.get()


class FakeResponse:
    def __init__(self, status_code: int, payload: object = None, headers: dict[str, str] | None = None) -> None:
        self.status_code = status_code
        self.payload = payload
        self.headers = headers or {}
        self.closed = False

    def json(self) -> object:
        if isinstance(self.payload, Exception):
            raise self.payload
        return self.payload

    def close(self) -> None:
        self.closed = True


class FakeSession:
    def __init__(self, response: FakeResponse, recorded: dict[str, object], **kwargs: object) -> None:
        self.response = response
        self.recorded = recorded
        self.recorded["session_kwargs"] = kwargs
        self.closed = False

    def get(self, url: str, **kwargs: object) -> FakeResponse:
        self.recorded["diagnostic_url"] = url
        self.recorded["diagnostic_kwargs"] = kwargs
        return self.response

    def close(self) -> None:
        self.closed = True


def _public_dns(host: str, port: int, **_kwargs: object):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port))]


def _clash_fake_ip_dns(host: str, port: int, **_kwargs: object):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("198.18.0.121", port))]


@pytest.fixture
def runtime_env(runtime_data_dir):
    """Ensure the session's frozen provider runtime exists before imports."""
    return runtime_data_dir


def _service(repository: MemoryRepository, request_get, session_factory=None):
    from services.ipwo_proxy_service import IpwoProxyService

    return IpwoProxyService(
        repository=repository,
        request_get=request_get,
        dns_resolver=_public_dns,
        session_factory=session_factory,
    )


def _save(service, *, protocol="http", timeout_seconds=10):
    return service.save_settings(
        api_url=API_URL,
        protocol=protocol,
        regions="US",
        timeout_seconds=timeout_seconds,
    )


def test_single_runtime_extraction_overrides_api_link_count_and_format(runtime_env):
    repository = MemoryRepository()
    calls: list[tuple[str, dict[str, object]]] = []

    def request_get(url: str, **kwargs: object):
        calls.append((url, kwargs))
        return FakeResponse(200, {"code": 0, "success": True, "data": [{"ip": "8.8.8.8", "port": 8080}]})

    service = _service(repository, request_get)
    assert _save(service, timeout_seconds=91) == {
        "configured": True,
        "has_api_url": True,
        "protocol": "http",
        "regions": "US",
        "timeout_seconds": 91,
    }
    assert service.get_runtime_proxy() == "http://8.8.8.8:8080"
    assert len(calls) == 1
    query = parse_qs(urlsplit(calls[0][0]).query)
    assert query["num"] == ["1"]
    assert query["return_type"] == ["json"]
    assert query["protocol"] == ["http"]
    assert query["regions"] == ["US"]
    assert query["lb"] == ["1"]
    assert "fixture_secret" not in json.dumps(service.view())


def test_empty_api_url_preserves_saved_secret_and_socks_runtime_is_normalized(runtime_env):
    repository = MemoryRepository()

    def request_get(_url: str, **_kwargs: object):
        return FakeResponse(200, {"code": 0, "success": True, "data": [{"ip": "1.1.1.1", "port": "1080"}]})

    service = _service(repository, request_get)
    _save(service)
    view = service.save_settings(
        api_url="",
        protocol="socks5",
        regions="CA",
        timeout_seconds=1,
    )
    assert view == {
        "configured": True,
        "has_api_url": True,
        "protocol": "socks5",
        "regions": "CA",
        "timeout_seconds": 1,
    }
    assert service.get_runtime_proxy() == "socks5h://1.1.1.1:1080"


def test_allows_only_clash_fake_ip_for_the_verified_ipwo_vendor_host(runtime_env):
    from curl_cffi import CurlOpt
    from services.ipwo_proxy_service import IpwoProxyConfigurationError, IpwoProxyService

    calls: list[dict[object, object]] = []

    def request_get(_url: str, **kwargs: object):
        calls.append(dict(kwargs["curl_options"]))
        assert kwargs["verify"] is True
        return FakeResponse(200, {"code": 0, "success": True, "data": [{"ip": "8.8.8.8", "port": 80}]})

    service = IpwoProxyService(
        repository=MemoryRepository(),
        request_get=request_get,
        dns_resolver=_clash_fake_ip_dns,
    )
    _save(service)
    assert service.get_runtime_proxy() == "http://8.8.8.8:80"
    assert calls[0][CurlOpt.RESOLVE] == ["www.ipwo.net:443:198.18.0.121"]

    def private_dns(host: str, port: int, **_kwargs: object):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.8", port))]

    rejected = IpwoProxyService(
        repository=MemoryRepository(),
        request_get=lambda *_args, **_kwargs: pytest.fail("private DNS must not reach HTTP"),
        dns_resolver=private_dns,
    )
    with pytest.raises(IpwoProxyConfigurationError) as raised:
        _save(rejected)
    assert raised.value.public_message == "IPWO API 主机未解析到公网地址"


def test_ipwo_configuration_is_encrypted_in_proxy_repository(runtime_env, tmp_path):
    from services.application_database import dispose_database_engine
    from services.ipwo_proxy_service import IpwoProxyService
    from services.storage.configuration_repository import ProxyConfigurationRepository

    database_path = tmp_path / "ipwo.db"
    database_url = f"sqlite:///{database_path}"
    repository = ProxyConfigurationRepository(database_url=database_url)
    service = IpwoProxyService(
        repository=repository,
        request_get=lambda *_args, **_kwargs: pytest.fail("IPWO HTTP must not run while saving"),
        dns_resolver=_public_dns,
    )
    _save(service)
    database_bytes = database_path.read_bytes()
    assert API_URL.encode() not in database_bytes
    with sqlite3.connect(database_path) as connection:
        stored = connection.execute("SELECT data FROM proxy_configuration").fetchone()[0]
    assert "octalaicanvas-secret:v1:" in stored
    dispose_database_engine(database_url)


@pytest.mark.parametrize(
    ("response", "message"),
    [
        (FakeResponse(403), "IPWO API HTTP 403：控制台 IP 白名单未授权"),
        (FakeResponse(429), "IPWO API HTTP 429：供应商限流"),
        (FakeResponse(200, {"code": 7, "success": False, "data": []}), "IPWO API 返回 code=7"),
        (FakeResponse(200, {"code": 0, "success": True, "data": []}), "IPWO API 未返回可用代理"),
        (FakeResponse(200, ValueError("upstream fixture body")), "IPWO API 返回 JSON 无法解析"),
        (FakeResponse(200, {"code": 0, "success": True, "data": [{"ip": "127.0.0.1", "port": 80}]}), "IPWO API 返回代理 IP 不是公网地址"),
        (FakeResponse(200, {"code": 0, "success": True, "data": [{"ip": "198.18.0.121", "port": 80}]}), "IPWO API 返回代理 IP 不是公网地址"),
    ],
)
def test_runtime_errors_are_specific_and_never_echo_the_api_link(runtime_env, response, message):
    from services.ipwo_proxy_service import IpwoProxyUnavailableError

    service = _service(MemoryRepository(), lambda *_args, **_kwargs: response)
    _save(service)
    with pytest.raises(IpwoProxyUnavailableError) as raised:
        service.get_runtime_proxy()
    assert raised.value.public_message == message
    assert "fixture_secret" not in raised.value.public_message
    assert "ipwo-secret-never-network" not in raised.value.public_message


@pytest.mark.parametrize("api_url", [
    "http://www.ipwo.net/api/proxy/get_proxy_ip",
    "https://www.ipwo.net:8443/api/proxy/get_proxy_ip",
    "https://www.ipwo.net.example/api/proxy/get_proxy_ip",
])
def test_fake_ip_exception_requires_verified_ipwo_https_on_standard_port(runtime_env, api_url):
    from services.ipwo_proxy_service import IpwoProxyConfigurationError, IpwoProxyService

    service = IpwoProxyService(
        repository=MemoryRepository(),
        request_get=lambda *_args, **_kwargs: pytest.fail("invalid source must not reach HTTP"),
        dns_resolver=_clash_fake_ip_dns,
    )
    with pytest.raises(IpwoProxyConfigurationError):
        service.save_settings(
            api_url=api_url,
            protocol="http",
            regions="US",
            timeout_seconds=1,
        )


def test_redirect_chain_respects_one_deadline(runtime_env, monkeypatch):
    from services import ipwo_proxy_service as module
    from services.ipwo_proxy_service import IpwoProxyUnavailableError

    responses = [
        FakeResponse(302, headers={"location": "https://www.ipwo.net/next"}),
        FakeResponse(200, {"code": 0, "success": True, "data": [{"ip": "8.8.8.8", "port": 80}]}),
    ]
    service = _service(MemoryRepository(), lambda *_args, **_kwargs: responses.pop(0))
    _save(service, timeout_seconds=1)
    ticks = iter((0.0, 0.0, 0.0, 0.0, 2.0))
    monkeypatch.setattr(module.time, "monotonic", lambda: next(ticks))
    with pytest.raises(IpwoProxyUnavailableError) as raised:
        service.get_runtime_proxy()
    assert raised.value.public_message == "IPWO API 请求超时"
    assert len(responses) == 1


def test_rejects_redirects_outside_the_ipwo_public_dns_boundary(runtime_env):
    from services.ipwo_proxy_service import IpwoProxyUnavailableError

    calls: list[object] = []

    def request_get(*_args: object, **_kwargs: object):
        calls.append(object())
        return FakeResponse(302, headers={"location": "https://localhost/private"})

    service = _service(MemoryRepository(), request_get)
    _save(service)
    with pytest.raises(IpwoProxyUnavailableError) as raised:
        service.get_runtime_proxy()
    assert raised.value.public_message == "IPWO API 地址仅允许 HTTPS 的 ipwo.net 域名"
    assert len(calls) == 1


def test_dns_and_connection_timeout_errors_are_safe_and_actionable(runtime_env):
    from services.ipwo_proxy_service import (
        IpwoProxyConfigurationError,
        IpwoProxyUnavailableError,
    )

    def failing_dns(*_args: object, **_kwargs: object):
        raise socket.gaierror("fixture DNS failure")

    dns_service = _service(MemoryRepository(), lambda *_args, **_kwargs: pytest.fail("unexpected HTTP"))
    dns_service._dns_resolver = failing_dns
    with pytest.raises(IpwoProxyConfigurationError) as dns_error:
        _save(dns_service)
    assert dns_error.value.public_message == "IPWO API 主机 DNS 解析失败"

    timeout_service = _service(
        MemoryRepository(),
        lambda *_args, **_kwargs: (_ for _ in ()).throw(TimeoutError("fixture timeout")),
    )
    _save(timeout_service)
    with pytest.raises(IpwoProxyUnavailableError) as timeout_error:
        timeout_service.get_runtime_proxy()
    assert timeout_error.value.public_message == "IPWO API 连接超时"


def test_diagnostic_events_report_real_stages_without_secrets(runtime_env, caplog):
    caplog.set_level("INFO", logger="uvicorn.error.ipwo")
    recorded: dict[str, object] = {}
    ipinfo_response = FakeResponse(200, {"ip": "1.1.1.1"})
    service = _service(
        MemoryRepository(),
        lambda *_args, **_kwargs: FakeResponse(200, {"code": 0, "success": True, "data": [{"ip": "8.8.8.8", "port": 8080}]}),
        session_factory=lambda **kwargs: FakeSession(ipinfo_response, recorded, **kwargs),
    )
    _save(service)
    events = list(service.diagnostic_events())
    assert [(event["stage"], event["status"]) for event in events] == [
        ("configuration", "running"),
        ("configuration", "success"),
        ("ipwo_api", "running"),
        ("ipwo_api", "success"),
        ("proxy_egress", "running"),
        ("proxy_egress", "success"),
        ("ipinfo", "running"),
        ("ipinfo", "success"),
    ]
    assert events[-1]["done"] is True
    assert events[-1]["exit_ip"] == "1.1.1.1"
    assert all("done" not in event for event in events[:-1])
    assert recorded["diagnostic_url"] == "https://ipinfo.io/json"
    assert recorded["session_kwargs"] == {
        "impersonate": "edge101",
        "verify": True,
        "proxy": "http://8.8.8.8:8080",
    }
    assert "fixture_secret" not in json.dumps(events, ensure_ascii=False)
    assert "stage=ipinfo status=success" in caplog.text
    assert "fixture_secret" not in caplog.text
    assert "8.8.8.8" not in caplog.text


@pytest.mark.parametrize("code, expected", [
    (5, "代理域名解析失败"), (6, "目标域名解析失败"), (7, "TCP 连接失败"),
    (28, "连接超时"), (35, "TLS 握手失败"), (52, "未返回有效响应"),
    (55, "网络发送失败"), (56, "网络接收失败"), (60, "TLS 证书校验失败"),
    (67, "认证被拒绝"), (77, "本地 CA 证书无法读取"), (97, "代理协议握手失败"),
    (999, "具体阶段尚未确定"),
])
def test_curl_diagnostics_are_specific_and_redacted(runtime_env, caplog, code, expected):
    from curl_cffi.requests.exceptions import RequestException

    caplog.set_level("INFO", logger="uvicorn.error.ipwo")
    class FailedSession(FakeSession):
        def get(self, *_args, **_kwargs):
            raise RequestException(f"secret-password http://secret-user:secret-password@8.8.8.8 {API_URL}", code=code)

    session = FailedSession(FakeResponse(200), {})
    service = _service(MemoryRepository(), lambda **_kwargs: None,
                       session_factory=lambda **_kwargs: session)
    service._request_get = lambda *_args, **_kwargs: FakeResponse(200, {"code": 0, "success": True, "data": [{"ip": "8.8.8.8", "port": 8080}]})
    _save(service)
    events = list(service.diagnostic_events())
    assert events[-1]["done"] is True
    assert events[-1]["stage"] == "proxy_egress"
    assert events[-1]["status"] == "error"
    assert f"curl {code}" in events[-1]["message"]
    assert expected in events[-1]["message"]
    assert "stage=proxy_egress status=error" in caplog.text
    assert session.closed
    output = json.dumps(events, ensure_ascii=False) + caplog.text
    for secret in ["secret-password", "secret-user", "fixture_secret", "8.8.8.8", API_URL]:
        assert secret not in output


def test_connect_status_and_unknown_error_are_safe(runtime_env):
    from curl_cffi.requests.exceptions import RequestException
    from services.ipwo_proxy_service import IpwoProxyService

    for status in (403, 407, 502):
        message = IpwoProxyService._request_failure_message("ipinfo.io", RequestException(
            f"CONNECT tunnel failed, response {status}; https://secret:password@example.test", code=56))
        assert f"CONNECT HTTP {status}" in message
        assert "password" not in message
        if status == 407:
            assert "身份认证" in message
    assert "具体阶段尚未确定" in IpwoProxyService._request_failure_message("ipinfo.io", ValueError(API_URL))
    aborted = IpwoProxyService._request_failure_message("ipinfo.io", RequestException("Proxy CONNECT aborted " + API_URL, code=56))
    assert "代理隧道连接被中止" in aborted
    assert "fixture_secret" not in aborted
