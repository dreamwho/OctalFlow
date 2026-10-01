from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from services.account_service import AccountService
from services.proxy_service import ProxyRuntimeProfile
from services.traffic_context import TrafficMeterIntegrationError, bind_traffic_context


class _Response:
    status_code = 200
    text = json.dumps({"access_token": "next-access"})

    @staticmethod
    def json() -> dict[str, str]:
        return {"access_token": "next-access"}


class _Session:
    instances: list["_Session"] = []

    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs
        self.posts: list[dict[str, object]] = []
        self.closed = False
        self.instances.append(self)

    def post(self, _url: str, **kwargs: object) -> _Response:
        self.posts.append(kwargs)
        return _Response()

    def close(self) -> None:
        self.closed = True


class _FailingSession(_Session):
    def post(self, _url: str, **_kwargs: object) -> _Response:
        raise RuntimeError("fixture refresh network failure")


def _service() -> AccountService:
    return object.__new__(AccountService)


def test_access_token_refresh_uses_account_probe_lease_and_releases_it(monkeypatch: pytest.MonkeyPatch) -> None:
    import curl_cffi.requests as curl_requests
    import services.account_service as account_module
    import services.proxy_service as proxy_module

    _Session.instances.clear()
    profile = ProxyRuntimeProfile(
        proxy_url="http://origin.test:8080",
        proxy_source="magic",
        egress_mode="proxy",
    )
    lease = SimpleNamespace(proxy_url="http://meter.test:19001")
    contexts: list[dict[str, str]] = []
    built_profiles: list[ProxyRuntimeProfile] = []

    monkeypatch.setattr(curl_requests, "Session", _Session)
    monkeypatch.setattr(proxy_module.proxy_settings, "get_profile", lambda **_kwargs: profile)
    monkeypatch.setattr(
        proxy_module.proxy_settings,
        "build_session_kwargs_from_profile",
        lambda current, **kwargs: built_profiles.append(current) or {"proxy": current.proxy_url, **kwargs},
    )

    def create_lease(proxy_url: str | None, context: dict[str, str]) -> object:
        assert proxy_url == profile.proxy_url
        contexts.append(dict(context))
        return lease

    released: list[object] = []
    monkeypatch.setattr(account_module, "create_traffic_lease_sync", create_lease)
    monkeypatch.setattr(account_module, "release_traffic_lease_sync", released.append)

    with bind_traffic_context({
        "channelId": "gpt-channel",
        "channelName": "GPT 渠道",
        "model": "gpt-image-1",
        "protocol": "chatgpt-api",
        "connectionMode": "magic",
        "role": "submit",
        "attributionScope": "exact",
    }):
        result = _service()._request_access_token_refresh("refresh-fixture", {"proxy": "account-fixture"})

    assert result == {"access_token": "next-access", "refresh_token": "refresh-fixture", "id_token": ""}
    assert contexts == [{
        "channelId": "gpt-channel",
        "channelName": "GPT 渠道",
        "model": "__account_probe__",
        "protocol": "chatgpt-api",
        "connectionMode": "magic",
        "role": "account_maintenance",
        "attributionScope": "exact",
    }]
    assert built_profiles[0].proxy_url == lease.proxy_url
    assert _Session.instances[0].kwargs["proxy"] == lease.proxy_url
    assert _Session.instances[0].closed is True
    assert released == [lease]


def test_access_token_refresh_preserves_direct_passthrough_when_meter_is_unconfigured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import curl_cffi.requests as curl_requests
    import services.account_service as account_module
    import services.proxy_service as proxy_module

    _Session.instances.clear()
    profile = ProxyRuntimeProfile(proxy_url="http://origin.test:8080", proxy_source="generic")
    built_profiles: list[ProxyRuntimeProfile] = []
    released: list[object] = []

    monkeypatch.setattr(curl_requests, "Session", _Session)
    monkeypatch.setattr(proxy_module.proxy_settings, "get_profile", lambda **_kwargs: profile)
    monkeypatch.setattr(
        proxy_module.proxy_settings,
        "build_session_kwargs_from_profile",
        lambda current, **kwargs: built_profiles.append(current) or {"proxy": current.proxy_url, **kwargs},
    )
    monkeypatch.setattr(account_module, "create_traffic_lease_sync", lambda *_args: None)
    monkeypatch.setattr(account_module, "release_traffic_lease_sync", released.append)

    result = _service()._request_access_token_refresh("refresh-fixture", {})

    assert result["access_token"] == "next-access"
    assert built_profiles == [profile]
    assert _Session.instances[0].kwargs["proxy"] == profile.proxy_url
    assert released == []


def test_access_token_refresh_uses_profile_mode_over_inherited_generation_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import curl_cffi.requests as curl_requests
    import services.account_service as account_module
    import services.proxy_service as proxy_module

    _Session.instances.clear()
    profile = ProxyRuntimeProfile(proxy_url="", proxy_source="direct")
    contexts: list[dict[str, str]] = []

    monkeypatch.setattr(curl_requests, "Session", _Session)
    monkeypatch.setattr(proxy_module.proxy_settings, "get_profile", lambda **_kwargs: profile)
    monkeypatch.setattr(
        proxy_module.proxy_settings,
        "build_session_kwargs_from_profile",
        lambda current, **kwargs: {"proxy": current.proxy_url, **kwargs},
    )
    monkeypatch.setattr(
        account_module,
        "create_traffic_lease_sync",
        lambda _proxy_url, context: contexts.append(dict(context)) or None,
    )

    with bind_traffic_context({
        "channelId": "gpt-channel",
        "channelName": "GPT 渠道",
        "model": "gpt-image-1",
        "protocol": "chatgpt-api",
        "connectionMode": "magic",
        "role": "submit",
        "attributionScope": "exact",
    }):
        _service()._request_access_token_refresh("refresh-fixture", {})

    assert contexts[0]["channelId"] == "gpt-channel"
    assert contexts[0]["model"] == "__account_probe__"
    assert contexts[0]["connectionMode"] == "direct"
    assert contexts[0]["role"] == "account_maintenance"


def test_access_token_refresh_surfaces_configured_meter_failure_before_provider_http(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import curl_cffi.requests as curl_requests
    import services.account_service as account_module
    import services.proxy_service as proxy_module

    _Session.instances.clear()
    profile = ProxyRuntimeProfile(proxy_url="http://origin.test:8080")
    monkeypatch.setattr(curl_requests, "Session", _Session)
    monkeypatch.setattr(proxy_module.proxy_settings, "get_profile", lambda **_kwargs: profile)
    monkeypatch.setattr(
        account_module,
        "create_traffic_lease_sync",
        lambda *_args: (_ for _ in ()).throw(TrafficMeterIntegrationError("traffic_meter_lease_create_failed")),
    )

    with pytest.raises(TrafficMeterIntegrationError, match="traffic_meter_lease_create_failed"):
        _service()._request_access_token_refresh("refresh-fixture", {})

    assert _Session.instances == []


def test_access_token_refresh_releases_lease_when_provider_http_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import curl_cffi.requests as curl_requests
    import services.account_service as account_module
    import services.proxy_service as proxy_module

    _Session.instances.clear()
    profile = ProxyRuntimeProfile(proxy_url="http://origin.test:8080")
    lease = SimpleNamespace(proxy_url="http://meter.test:19001")
    released: list[object] = []

    monkeypatch.setattr(curl_requests, "Session", _FailingSession)
    monkeypatch.setattr(proxy_module.proxy_settings, "get_profile", lambda **_kwargs: profile)
    monkeypatch.setattr(
        proxy_module.proxy_settings,
        "build_session_kwargs_from_profile",
        lambda current, **kwargs: {"proxy": current.proxy_url, **kwargs},
    )
    monkeypatch.setattr(account_module, "create_traffic_lease_sync", lambda *_args: lease)
    monkeypatch.setattr(account_module, "release_traffic_lease_sync", released.append)

    with pytest.raises(RuntimeError, match="fixture refresh network failure"):
        _service()._request_access_token_refresh("refresh-fixture", {})

    assert _Session.instances[0].closed is True
    assert released == [lease]
