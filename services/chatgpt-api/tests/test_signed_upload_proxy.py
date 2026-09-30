from __future__ import annotations

from types import SimpleNamespace

import pytest

from services.proxy_management_service import ProxyManagementService
from services.proxy_service import (
    ProxyReferenceUnavailableError,
    ProxyRuntimeProfile,
    ProxySettingsStore,
    SIGNED_UPLOAD_MODE_KEY,
    SIGNED_UPLOAD_PROXY_OVERRIDE_KEY,
)


class MemoryConfig:
    def __init__(self) -> None:
        self.data: dict[str, object] = {}

    def get(self) -> dict[str, object]:
        return dict(self.data)

    def update(self, patch: dict[str, object]) -> dict[str, object]:
        self.data.update(patch)
        return self.get()


def test_signed_upload_defaults_to_magic_and_keeps_submit_egress_independent() -> None:
    store = MemoryConfig()
    admin = ProxyManagementService(store)
    settings = ProxySettingsStore(store)
    submit = ProxyRuntimeProfile(proxy_url="http://residential.test:8080", proxy_source="chained")

    assert settings.signed_upload_profile(submit) is submit
    admin.save_signed_upload_proxy_override("http://magic.test:17895")
    upload = settings.signed_upload_profile(submit)
    assert upload.proxy_url == "http://magic.test:17895"
    assert upload.proxy_source == "magic_upload"
    assert submit.proxy_url == "http://residential.test:8080"

    admin.save_signed_upload_selection("submit")
    assert settings.signed_upload_profile(submit) is submit
    admin.save_signed_upload_selection("direct")
    assert settings.signed_upload_profile(submit).proxy_url == ""
    admin.save_signed_upload_selection("magic", "Upload-01")
    assert admin.signed_upload_selection()["magicNode"] == "Upload-01"
    assert settings.signed_upload_profile(submit).proxy_url == "http://magic.test:17895"
    store.data[SIGNED_UPLOAD_PROXY_OVERRIDE_KEY] = ""
    with pytest.raises(ProxyReferenceUnavailableError, match="魔法代理未配置"):
        settings.signed_upload_profile(submit)
    assert store.data[SIGNED_UPLOAD_MODE_KEY] == "magic"


def test_signed_upload_put_uses_temporary_session_and_closes_it(monkeypatch: pytest.MonkeyPatch) -> None:
    import services.openai_backend_api as module

    calls: list[tuple[str, str]] = []
    temporary = SimpleNamespace(
        put=lambda url, **_kwargs: calls.append(("upload", url)) or "uploaded",
        close=lambda: calls.append(("closed", "")),
    )
    submit_session = SimpleNamespace(put=lambda url, **_kwargs: calls.append(("submit", url)) or "submitted")
    backend = object.__new__(module.OpenAIBackendAPI)
    backend.session = submit_session
    backend.fp = {"impersonate": "chrome"}
    backend.proxy_profile = ProxyRuntimeProfile(proxy_url="http://residential.test:8080")
    monkeypatch.setattr(module.requests, "Session", lambda **_kwargs: temporary)
    monkeypatch.setattr(module.proxy_settings, "signed_upload_profile", lambda _profile: ProxyRuntimeProfile(proxy_url="http://magic.test:17895"))

    assert backend._signed_upload_put("https://blob.test/signed", headers={}, data=b"image", timeout=10) == "uploaded"
    assert calls == [("upload", "https://blob.test/signed"), ("closed", "")]

    monkeypatch.setattr(module.proxy_settings, "signed_upload_profile", lambda profile: profile)
    assert backend._signed_upload_put("https://blob.test/signed", headers={}, data=b"image", timeout=10) == "submitted"
    assert calls[-1] == ("submit", "https://blob.test/signed")
