from __future__ import annotations

import json
from typing import Any

import pytest

from services.log_service import current_call_id, pop_call_egress, register_call_egress
from services.proxy_management_service import (
    normalize_proxy_node_url,
    proxy_group_error_text,
    proxy_node_url_error,
)
from services.proxy_service import ProxyRuntimeProfile


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("http://user:pass@us.ipwo.net:7878", "http://user:pass@us.ipwo.net:7878"),
        ("us.ipwo.net:7878", "http://us.ipwo.net:7878"),
        ("us.ipwo.net:7878:dreamyo01_zone_US:dream123", "http://dreamyo01_zone_US:dream123@us.ipwo.net:7878"),
        ("us.ipwo.net:7878:user:p@ss:word", "http://user:p%40ss%3Aword@us.ipwo.net:7878"),
        ("socks5://10.0.0.1:1080", "socks5h://10.0.0.1:1080"),
        ("socks5://user:pass@10.0.0.1:1080", "socks5h://user:pass@10.0.0.1:1080"),
        ("us.ipwo.net:7878:用户:p@ss", "http://%E7%94%A8%E6%88%B7:p%40ss@us.ipwo.net:7878"),
        ("http://us.ipwo.net", "http://us.ipwo.net"),
    ],
)
def test_normalize_proxy_node_url_accepts_supported_formats(raw: str, expected: str) -> None:
    assert normalize_proxy_node_url(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "us.ipwo.net",
        "us.ipwo.net:not-a-port",
        "ftp://us.ipwo.net:7878",
        "us.ipwo.net:7878/user",
        "http://us.ipwo.net:7878/path",
    ],
)
def test_normalize_proxy_node_url_rejects_invalid_formats(raw: str) -> None:
    assert proxy_node_url_error(raw)


def test_proxy_group_error_text_translates_node_suffix() -> None:
    assert proxy_group_error_text("proxy group already exists") == "代理组已存在"
    assert (
        proxy_group_error_text("proxy node url is required: node-1")
        == "地址为空（节点 node-1）"
    )
    assert (
        proxy_group_error_text(
            "proxy node url must start with http://, https://, socks5://, or socks5h://, or use host:port[:user:pass]: node-2"
        )
        == "请填写以 http://、https://、socks5:// 或 socks5h:// 开头的地址，或使用 host:port:用户名:密码 格式（节点 node-2）"
    )
    assert proxy_group_error_text("") == "proxy group is invalid"


def test_egress_snapshot_strips_credentials_and_marks_mode() -> None:
    profile = ProxyRuntimeProfile(
        proxy_url="http://user:secret@us.ipwo.net:7878",
        proxy_source="native",
        proxy_group_id="ipwo-group",
        proxy_node_id="node-1",
        proxy_node_name="美国节点",
    )
    snapshot = profile.egress_snapshot()
    assert snapshot == {
        "mode": "generic",
        "group_id": "ipwo-group",
        "node_id": "node-1",
        "node_name": "美国节点",
        "address": "us.ipwo.net:7878",
    }
    assert "secret" not in json.dumps(snapshot)
    assert ProxyRuntimeProfile(proxy_source="magic", proxy_url="http://127.0.0.1:7890").egress_snapshot()["mode"] == "magic"
    assert ProxyRuntimeProfile().egress_snapshot() == {}


class _MemoryConfig:
    def __init__(self, data: dict[str, object] | None = None) -> None:
        self.data: dict[str, object] = dict(data or {})

    def get(self) -> dict[str, object]:
        return dict(self.data)

    def update(self, patch: dict[str, object]) -> dict[str, object]:
        self.data.update(patch)
        return self.get()


def _service_with_group() -> Any:
    from services.proxy_management_service import ProxyManagementService

    return ProxyManagementService(_MemoryConfig({
        "proxy_groups": [{
            "id": "ipwo-group",
            "name": "IPWO 分组",
            "enabled": True,
            "nodes": [{"id": "node-1", "name": "美国节点", "url": "http://user:pass@us.ipwo.net:7878", "enabled": True}],
        }],
    }))


def test_node_reference_roundtrip_and_effective_label() -> None:
    from contracts.proxy import ProxyReference

    service = _service_with_group()
    result = service.save_defaults(default_reference=ProxyReference(mode="node", node_id="node-1"), fallback_reference=None)
    assert result.default_reference.mode == "node"
    assert result.default_reference.node_id == "node-1"
    assert service.view().default_reference.node_id == "node-1"
    assert service.view().effective_default.label == "IPWO 分组 · 美国节点"
    assert service.view().effective_default.source == "node"

    with pytest.raises(ValueError, match="proxy node not found"):
        service.save_defaults(default_reference=ProxyReference(mode="node", node_id="ghost"), fallback_reference=None)

    stale = service._effective_reference(service._parse_reference("node:ghost", empty_is_direct=True), {"proxy_groups": []})
    assert stale.label == "代理节点 ghost（不存在）"
    assert stale.available is False


def test_node_reference_registers_group_usage_for_delete_guard() -> None:
    from contracts.proxy import ProxyReference

    service = _service_with_group()
    service.save_defaults(default_reference=ProxyReference(mode="node", node_id="node-1"), fallback_reference=None)
    with pytest.raises(Exception, match="proxy group is in use"):
        service.delete_group("ipwo-group")


def test_call_egress_registry_scopes_by_call_id() -> None:
    register_call_egress("call-1", {"mode": "generic", "address": "us.ipwo.net:7878"})
    register_call_egress("", {"mode": "generic"})
    register_call_egress("call-2", {"mode": "generic", "address": ""})
    assert current_call_id() == ""
    assert pop_call_egress("call-1") == {"mode": "generic", "address": "us.ipwo.net:7878"}
    assert pop_call_egress("call-1") == {}
    assert pop_call_egress("call-2") == {"mode": "generic"}
    assert pop_call_egress("call-2") == {}
