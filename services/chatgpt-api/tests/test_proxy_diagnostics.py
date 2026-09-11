from __future__ import annotations

import socket
import threading
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from services.proxy_service import (
    _parse_proxy_details,
    _probe_dns,
    _probe_tcp,
    test_proxy as run_test_proxy,
)


def test_parse_proxy_details_masks_credentials() -> None:
    details = _parse_proxy_details("http://dreamyo01_custom_zone_US:dream123@us.ipwo.net:7878")
    assert details["scheme"] == "http"
    assert details["host"] == "us.ipwo.net"
    assert details["port"] == 7878
    assert details["has_auth"] is True
    assert "dream123" not in str(details)
    assert details["username_masked"] == "drea***e_US"


def test_probe_dns_with_ip_literal() -> None:
    res = _probe_dns("127.0.0.1")
    assert res["ok"] is True
    assert "127.0.0.1" in res["resolved_ips"]
    assert res["error"] is None


def test_probe_tcp_with_mock_listener() -> None:
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]

    def _accept() -> None:
        try:
            conn, _ = server.accept()
            conn.close()
        except Exception:
            pass

    t = threading.Thread(target=_accept, daemon=True)
    t.start()

    res = _probe_tcp("127.0.0.1", port, timeout=1.0)
    server.close()
    t.join(timeout=1.0)

    assert res["ok"] is True
    assert res["error"] is None
    assert res["latency_ms"] >= 0


def test_probe_tcp_connection_refused() -> None:
    # Port 54321 is unlikely to have a listener
    res = _probe_tcp("127.0.0.1", 54321, timeout=0.5)
    assert res["ok"] is False
    assert "拒绝" in (res["error"] or "") or "refused" in (res["error"] or "").lower()


def test_test_proxy_includes_diagnostics_on_failure() -> None:
    # Mocking Session to simulate curl 56 Connection reset by peer
    with patch("services.proxy_service.Session") as MockSession, \
         patch("services.proxy_service._probe_dns", return_value={"ok": True, "latency_ms": 10, "resolved_ips": ["143.244.1.1"], "error": None}), \
         patch("services.proxy_service._probe_tcp", return_value={"ok": True, "latency_ms": 25, "error": None}), \
         patch("services.proxy_service._get_server_public_ip", return_value="104.28.1.1"):

        mock_session_instance = MagicMock()
        mock_session_instance.get.side_effect = Exception("Failed to perform, curl: (56) Recv failure: Connection reset by peer")
        MockSession.return_value = mock_session_instance

        res = run_test_proxy("http://user:pass@us.ipwo.net:7878")
        assert res["ok"] is False
        assert "56" in (res["error"] or "")
        assert "diagnostics" in res
        diag = res["diagnostics"]
        assert diag is not None
        assert diag["proxy"]["host"] == "us.ipwo.net"
        assert diag["proxy"]["port"] == 7878
        assert diag["dns"]["ok"] is True
        assert diag["tcp"]["ok"] is True
        assert diag["server_context"]["server_public_ip"] == "104.28.1.1"

        analysis = diag["analysis"]
        assert analysis["stage"] == "proxy_handshake"
        assert "重置" in analysis["title"] or "56" in analysis["title"]
        assert any("白名单" in sug for sug in analysis["suggestions"])
        assert any("104.28.1.1" in sug for sug in analysis["suggestions"])


def test_test_proxy_includes_diagnostics_on_success() -> None:
    with patch("services.proxy_service.Session") as MockSession, \
         patch("services.proxy_service._probe_dns", return_value={"ok": True, "latency_ms": 10, "resolved_ips": ["143.244.1.1"], "error": None}), \
         patch("services.proxy_service._probe_tcp", return_value={"ok": True, "latency_ms": 25, "error": None}), \
         patch("services.proxy_service._get_server_public_ip", return_value="104.28.1.1"):

        mock_csrf = MagicMock()
        mock_csrf.status_code = 200
        mock_trace = MagicMock()
        mock_trace.status_code = 200
        mock_trace.text = "ip=143.244.200.5\nloc=US\n"
        mock_http = MagicMock()
        mock_http.status_code = 204

        mock_session_instance = MagicMock()
        mock_session_instance.get.side_effect = [mock_csrf, mock_trace, mock_http]
        MockSession.return_value = mock_session_instance

        res = run_test_proxy("http://user:pass@us.ipwo.net:7878")
        assert res["ok"] is True
        assert res["diagnostics"] is not None
        diag = res["diagnostics"]
        assert diag["analysis"]["stage"] == "healthy"
        assert any(p.get("egress_ip") == "143.244.200.5" for p in diag["probes"])
