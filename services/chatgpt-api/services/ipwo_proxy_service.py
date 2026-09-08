"""IPWO managed proxy-source configuration and single-endpoint extraction."""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
import ipaddress
import json
import logging
import re
import socket
import time
from uuid import uuid4
from typing import Any, Literal
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

from curl_cffi import CurlOpt, requests
from curl_cffi.requests import Session

from services.storage.configuration_repository import (
    ProxyConfigurationRepository,
    proxy_configuration_repository,
)


IPWO_API_URL_KEY = "octalaicanvas_ipwo_api_url"
IPWO_PROTOCOL_KEY = "octalaicanvas_ipwo_protocol"
IPWO_REGIONS_KEY = "octalaicanvas_ipwo_regions"
IPWO_TIMEOUT_SECONDS_KEY = "octalaicanvas_ipwo_timeout_seconds"
IPWO_PROTOCOLS = ("http", "socks5")
DEFAULT_TIMEOUT_SECONDS = 10
IPINFO_DIAGNOSTIC_URL = "https://ipinfo.io/json"
CLASH_FAKE_IP_NETWORK = ipaddress.ip_network("198.18.0.0/15")
logger = logging.getLogger("uvicorn.error.ipwo")

HttpProtocol = Literal["http", "socks5"]
HttpGet = Callable[..., Any]
DnsResolver = Callable[..., list[tuple[Any, ...]]]
SessionFactory = Callable[..., Any]


class IpwoProxyError(RuntimeError):
    """A controlled IPWO error that is safe to present outside the service."""

    default_public_message = "IPWO 代理服务不可用"

    def __init__(self, public_message: str | None = None) -> None:
        self.public_message = public_message or self.default_public_message
        super().__init__(self.public_message)


class IpwoProxyConfigurationError(IpwoProxyError):
    default_public_message = "IPWO 配置无效"


class IpwoProxyUnavailableError(IpwoProxyError):
    default_public_message = "IPWO 代理获取失败"


class IpwoProxyDiagnosticError(IpwoProxyError):
    default_public_message = "代理出口诊断失败"


@dataclass(frozen=True)
class IpwoProxySettings:
    api_url: str = field(default="", repr=False)
    protocol: HttpProtocol = "http"
    regions: str = ""
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS


@dataclass(frozen=True)
class _ValidatedIpwoUrl:
    url: str = field(repr=False)
    hostname: str
    port: int
    addresses: tuple[str, ...]


def _clean(value: object) -> str:
    return str(value or "").strip()


def _safe_exception_message(error: IpwoProxyError) -> str:
    return error.public_message


class IpwoProxyService:
    """Stores one IPWO source and extracts exactly one endpoint per request."""

    def __init__(
        self,
        repository: ProxyConfigurationRepository | None = None,
        *,
        request_get: HttpGet | None = None,
        dns_resolver: DnsResolver | None = None,
        session_factory: SessionFactory | None = None,
    ) -> None:
        self._repository = repository or proxy_configuration_repository
        self._request_get = request_get or requests.get
        self._dns_resolver = dns_resolver or socket.getaddrinfo
        self._session_factory = session_factory or Session

    def view(self) -> dict[str, object]:
        settings = self._read_settings()
        has_api_url = bool(settings.api_url)
        return {
            "configured": has_api_url,
            "has_api_url": has_api_url,
            "protocol": settings.protocol,
            "regions": settings.regions,
            "timeout_seconds": settings.timeout_seconds,
        }

    def is_configured(self) -> bool:
        """Report saved source availability without DNS or remote network I/O."""
        return bool(self._read_settings().api_url)

    def save_settings(
        self,
        *,
        api_url: str | None,
        protocol: str,
        regions: str,
        timeout_seconds: int,
    ) -> dict[str, object]:
        existing = self._read_settings()
        candidate_api_url = _clean(api_url) or existing.api_url
        settings = self._normalize_settings(
            api_url=candidate_api_url,
            protocol=protocol,
            regions=regions,
            timeout_seconds=timeout_seconds,
        )
        validated_url = self._validate_api_url(
            settings.api_url,
            deadline=self._deadline(settings.timeout_seconds),
        )
        self._repository.update({
            IPWO_API_URL_KEY: validated_url.url,
            IPWO_PROTOCOL_KEY: settings.protocol,
            IPWO_REGIONS_KEY: settings.regions,
            IPWO_TIMEOUT_SECONDS_KEY: settings.timeout_seconds,
        })
        return self.view()

    def get_runtime_proxy(self) -> str:
        """Fetch one endpoint or fail closed; callers must apply their own mode gate."""
        settings = self._read_settings()
        deadline = self._deadline(settings.timeout_seconds)
        settings, validated_url = self._validated_settings(
            settings=settings,
            deadline=deadline,
        )
        return self._acquire_proxy(settings, validated_url, deadline=deadline)

    def diagnostic_events(self) -> Iterator[dict[str, object]]:
        """Yield actual, redacted configuration/acquisition/egress progress."""
        started = time.perf_counter()
        diagnostic_id = uuid4().hex

        def event(
            stage: str,
            status: Literal["running", "success", "error"],
            message: str,
            *,
            done: bool = False,
            exit_ip: str = "",
        ) -> dict[str, object]:
            value: dict[str, object] = {
                "stage": stage,
                "status": status,
                "message": message,
                "elapsed_ms": int((time.perf_counter() - started) * 1000),
            }
            if done:
                value["done"] = True
            if exit_ip:
                value["exit_ip"] = exit_ip
            # Log only controlled fields, never raw exceptions, URLs or proxy credentials.
            logger.log(
                logging.WARNING if status == "error" else logging.INFO,
                "IPWO diagnostic=%s stage=%s status=%s elapsed_ms=%s message=%s",
                diagnostic_id, stage, status, value["elapsed_ms"], message,
            )
            return value

        stage = "configuration"
        yield event(stage, "running", "正在校验 IPWO 配置")
        try:
            settings = self._read_settings()
            deadline = self._deadline(settings.timeout_seconds)
            settings, validated_url = self._validated_settings(
                settings=settings,
                deadline=deadline,
            )
        except IpwoProxyError as exc:
            yield event(stage, "error", _safe_exception_message(exc), done=True)
            return
        except Exception:
            yield event(stage, "error", IpwoProxyConfigurationError.default_public_message, done=True)
            return
        yield event(stage, "success", "IPWO 配置已就绪")

        stage = "ipwo_api"
        yield event(stage, "running", "正在获取 IPWO 代理")
        try:
            proxy_url = self._acquire_proxy(settings, validated_url, deadline=deadline)
        except IpwoProxyError as exc:
            yield event(stage, "error", _safe_exception_message(exc), done=True)
            return
        except Exception:
            yield event(stage, "error", IpwoProxyUnavailableError.default_public_message, done=True)
            return
        yield event(stage, "success", "已获取单个代理出口")

        stage = "proxy_egress"
        yield event(stage, "running", f"正在通过 {settings.protocol.upper()} 代理连接 ipinfo.io（超时 {settings.timeout_seconds} 秒，TLS 证书校验开启）")
        try:
            response = self._request_ipinfo(proxy_url, settings.timeout_seconds)
        except IpwoProxyError as exc:
            yield event(stage, "error", _safe_exception_message(exc), done=True)
            return
        except Exception:
            yield event(stage, "error", IpwoProxyDiagnosticError.default_public_message, done=True)
            return
        yield event(stage, "success", "代理出口连接成功")

        stage = "ipinfo"
        yield event(stage, "running", "正在读取出口 IP 信息")
        try:
            exit_ip = self._exit_ip_from_response(response)
        except IpwoProxyError as exc:
            yield event(stage, "error", _safe_exception_message(exc), done=True)
            return
        except Exception:
            yield event(stage, "error", IpwoProxyDiagnosticError.default_public_message, done=True)
            return
        yield event(stage, "success", "出口 IP 信息读取成功", done=True, exit_ip=exit_ip)

    def _read_settings(self) -> IpwoProxySettings:
        value = self._repository.get()
        configuration = dict(value) if isinstance(value, Mapping) else {}
        try:
            return self._normalize_settings(
                api_url=_clean(configuration.get(IPWO_API_URL_KEY)),
                protocol=_clean(configuration.get(IPWO_PROTOCOL_KEY)) or "http",
                regions=_clean(configuration.get(IPWO_REGIONS_KEY)),
                timeout_seconds=configuration.get(
                    IPWO_TIMEOUT_SECONDS_KEY,
                    DEFAULT_TIMEOUT_SECONDS,
                ),
                require_api_url=False,
            )
        except IpwoProxyConfigurationError:
            return IpwoProxySettings()

    @staticmethod
    def _normalize_settings(
        *,
        api_url: str,
        protocol: str,
        regions: str,
        timeout_seconds: object,
        require_api_url: bool = True,
    ) -> IpwoProxySettings:
        normalized_api_url = _clean(api_url)
        if require_api_url and not normalized_api_url:
            raise IpwoProxyConfigurationError("未提供 IPWO API 地址")
        normalized_protocol = _clean(protocol).lower()
        if normalized_protocol not in IPWO_PROTOCOLS:
            raise IpwoProxyConfigurationError("IPWO 代理协议无效")
        if isinstance(timeout_seconds, bool):
            raise IpwoProxyConfigurationError("IPWO 超时必须是正整数秒")
        try:
            normalized_timeout = int(timeout_seconds)
        except (TypeError, ValueError) as exc:
            raise IpwoProxyConfigurationError("IPWO 超时必须是正整数秒") from exc
        if normalized_timeout < 1:
            raise IpwoProxyConfigurationError("IPWO 超时必须是正整数秒")
        return IpwoProxySettings(
            api_url=normalized_api_url,
            protocol=normalized_protocol,  # type: ignore[arg-type]
            regions=_clean(regions),
            timeout_seconds=normalized_timeout,
        )

    def _validated_settings(
        self,
        *,
        settings: IpwoProxySettings,
        deadline: float,
    ) -> tuple[IpwoProxySettings, _ValidatedIpwoUrl]:
        if not settings.api_url:
            raise IpwoProxyConfigurationError("未保存 IPWO API 地址")
        return settings, self._validate_api_url(settings.api_url, deadline=deadline)

    def _acquire_proxy(
        self,
        settings: IpwoProxySettings,
        validated_url: _ValidatedIpwoUrl,
        *,
        deadline: float,
    ) -> str:
        payload = self._request_ipwo_payload(settings, validated_url, deadline=deadline)
        if not isinstance(payload, Mapping):
            raise IpwoProxyUnavailableError("IPWO API 返回 JSON 对象无效")
        code = payload.get("code")
        if isinstance(code, bool) or not isinstance(code, int):
            raise IpwoProxyUnavailableError("IPWO API 返回无效 code")
        if code != 0:
            raise IpwoProxyUnavailableError(f"IPWO API 返回 code={code}")
        if payload.get("success") is not True:
            raise IpwoProxyUnavailableError("IPWO API 返回 success=false")
        data = payload.get("data")
        if not isinstance(data, list):
            raise IpwoProxyUnavailableError("IPWO API 返回 data 格式无效")
        if not data:
            raise IpwoProxyUnavailableError("IPWO API 未返回可用代理")
        if not isinstance(data[0], Mapping):
            raise IpwoProxyUnavailableError("IPWO API 返回代理格式无效")
        endpoint = data[0]
        raw_ip = _clean(endpoint.get("ip"))
        try:
            address = ipaddress.ip_address(raw_ip)
        except ValueError as exc:
            raise IpwoProxyUnavailableError("IPWO API 返回代理 IP 无效") from exc
        if not address.is_global:
            raise IpwoProxyUnavailableError("IPWO API 返回代理 IP 不是公网地址")
        raw_port = endpoint.get("port")
        if isinstance(raw_port, bool):
            raise IpwoProxyUnavailableError("IPWO API 返回代理端口无效")
        try:
            port = int(raw_port)
        except (TypeError, ValueError) as exc:
            raise IpwoProxyUnavailableError("IPWO API 返回代理端口无效") from exc
        if not 1 <= port <= 65535:
            raise IpwoProxyUnavailableError("IPWO API 返回代理端口无效")
        host = f"[{address}]" if address.version == 6 else str(address)
        scheme = "http" if settings.protocol == "http" else "socks5h"
        return f"{scheme}://{host}:{port}"

    def _request_ipwo_payload(
        self,
        settings: IpwoProxySettings,
        validated_url: _ValidatedIpwoUrl,
        *,
        deadline: float,
    ) -> object:
        current = self._request_url(settings, validated_url.url)
        current_validation = validated_url
        seen_urls: set[str] = set()
        while True:
            if current in seen_urls:
                raise IpwoProxyUnavailableError("IPWO API 重定向循环")
            seen_urls.add(current)
            remaining_timeout = self._remaining_timeout(deadline, IpwoProxyUnavailableError)
            try:
                response = self._request_get(
                    current,
                    timeout=remaining_timeout,
                    verify=True,
                    allow_redirects=False,
                    curl_options=self._curl_options(current_validation),
                )
            except Exception as exc:
                raise IpwoProxyUnavailableError(
                    self._request_failure_message("IPWO API", exc)
                ) from exc
            try:
                try:
                    status_code = int(getattr(response, "status_code", 0) or 0)
                except (TypeError, ValueError) as exc:
                    raise IpwoProxyUnavailableError("IPWO API HTTP 状态无效") from exc
                if 300 <= status_code < 400:
                    location = _clean(getattr(response, "headers", {}).get("location"))
                    if not location:
                        raise IpwoProxyUnavailableError("IPWO API 重定向缺少地址")
                    redirected_url = urljoin(current, location)
                    try:
                        current_validation = self._validate_api_url(
                            redirected_url,
                            deadline=deadline,
                        )
                    except IpwoProxyConfigurationError as exc:
                        raise IpwoProxyUnavailableError(exc.public_message) from exc
                    current = current_validation.url
                    continue
                if not 200 <= status_code < 300:
                    raise IpwoProxyUnavailableError(
                        self._http_failure_message("IPWO API", status_code)
                    )
                return self._response_json(
                    response,
                    error_type=IpwoProxyUnavailableError,
                    error_message="IPWO API 返回 JSON 无法解析",
                )
            finally:
                close = getattr(response, "close", None)
                if callable(close):
                    close()

    def _request_ipinfo(self, proxy_url: str, timeout_seconds: int) -> object:
        session: object | None = None
        response: object | None = None
        try:
            session = self._session_factory(
                impersonate="edge101",
                verify=True,
                proxy=proxy_url,
            )
            response = session.get(
                IPINFO_DIAGNOSTIC_URL,
                timeout=timeout_seconds,
                allow_redirects=False,
                headers={"Accept": "application/json"},
            )
            try:
                status_code = int(getattr(response, "status_code", 0) or 0)
            except (TypeError, ValueError) as exc:
                raise IpwoProxyDiagnosticError("ipinfo.io HTTP 状态无效") from exc
            if not 200 <= status_code < 300:
                raise IpwoProxyDiagnosticError(
                    self._http_failure_message("ipinfo.io", status_code)
                )
            return self._response_json(
                response,
                error_type=IpwoProxyDiagnosticError,
                error_message="ipinfo.io 返回 JSON 无法解析",
            )
        except IpwoProxyError:
            raise
        except Exception as exc:
            raise IpwoProxyDiagnosticError(
                self._request_failure_message("ipinfo.io", exc)
            ) from exc
        finally:
            close = getattr(response, "close", None)
            if callable(close):
                close()
            close = getattr(session, "close", None)
            if callable(close):
                close()

    @staticmethod
    def _response_json(
        response: object,
        *,
        error_type: type[IpwoProxyError],
        error_message: str,
    ) -> object:
        parser = getattr(response, "json", None)
        if callable(parser):
            try:
                return parser()
            except Exception as exc:
                raise error_type(error_message) from exc
        content = getattr(response, "content", b"")
        try:
            return json.loads(bytes(content).decode("utf-8"))
        except (TypeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise error_type(error_message) from exc

    @staticmethod
    def _exit_ip_from_response(response: object) -> str:
        if not isinstance(response, Mapping):
            raise IpwoProxyDiagnosticError("ipinfo.io 返回 JSON 对象无效")
        value = _clean(response.get("ip"))
        try:
            address = ipaddress.ip_address(value)
        except ValueError as exc:
            raise IpwoProxyDiagnosticError("ipinfo.io 返回出口 IP 无效") from exc
        if not address.is_global:
            raise IpwoProxyDiagnosticError("ipinfo.io 返回出口 IP 不是公网地址")
        return str(address)

    def _validate_api_url(
        self,
        value: str,
        *,
        deadline: float,
    ) -> _ValidatedIpwoUrl:
        candidate = _clean(value)
        try:
            parsed = urlsplit(candidate)
            hostname = (parsed.hostname or "").rstrip(".").lower()
            port = parsed.port
        except ValueError as exc:
            raise IpwoProxyConfigurationError("IPWO API 地址无效") from exc
        if (
            parsed.scheme.lower() != "https"
            or not parsed.netloc
            or parsed.username
            or parsed.password
            or parsed.fragment
            or not self._is_allowed_host(hostname)
            or port not in {None, 443}
        ):
            raise IpwoProxyConfigurationError("IPWO API 地址仅允许 HTTPS 的 ipwo.net 域名")
        resolved_port = port or 443
        self._remaining_timeout(deadline, IpwoProxyConfigurationError)
        try:
            # getaddrinfo has no portable cancellation API; check the shared
            # operation deadline again immediately after this blocking lookup.
            addresses = tuple(dict.fromkeys(
                item[4][0]
                for item in self._dns_resolver(
                    hostname,
                    resolved_port,
                    type=socket.SOCK_STREAM,
                )
            ))
        except OSError as exc:
            raise IpwoProxyConfigurationError("IPWO API 主机 DNS 解析失败") from exc
        self._remaining_timeout(deadline, IpwoProxyConfigurationError)
        if not addresses:
            raise IpwoProxyConfigurationError("IPWO API 主机未解析到公网地址")
        try:
            if any(not self._is_allowed_ipwo_resolution(address) for address in addresses):
                raise IpwoProxyConfigurationError("IPWO API 主机未解析到公网地址")
        except ValueError as exc:
            raise IpwoProxyConfigurationError("IPWO API 主机未解析到公网地址") from exc
        normalized = urlunsplit((
            "https",
            hostname if port is None else f"{hostname}:{port}",
            parsed.path or "/",
            parsed.query,
            "",
        ))
        return _ValidatedIpwoUrl(
            url=normalized,
            hostname=hostname,
            port=resolved_port,
            addresses=addresses,
        )

    @staticmethod
    def _deadline(timeout_seconds: int) -> float:
        return time.monotonic() + timeout_seconds

    @staticmethod
    def _remaining_timeout(
        deadline: float,
        error_type: type[IpwoProxyError],
    ) -> float:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise error_type("IPWO API 请求超时")
        return remaining

    @staticmethod
    def _http_failure_message(target: str, status_code: int) -> str:
        if status_code == 407:
            return f"{target} HTTP 407：代理要求身份认证，请检查代理使用授权"
        if target == "IPWO API" and status_code == 403:
            return "IPWO API HTTP 403：控制台 IP 白名单未授权"
        if target == "IPWO API" and status_code == 429:
            return "IPWO API HTTP 429：供应商限流"
        return f"{target} HTTP {status_code}：请求失败"

    @staticmethod
    def _request_failure_message(target: str, exc: Exception) -> str:
        name = type(exc).__name__.lower()
        detail = str(exc).lower()
        # libcurl codes are stable; do not echo its error buffer (it can contain secrets).
        raw_code = getattr(exc, "code", None)
        code = int(raw_code) if isinstance(raw_code, int) and not isinstance(raw_code, bool) else None
        descriptions = {
            5: "代理域名解析失败，请检查代理 DNS 配置",
            6: "目标域名解析失败，请检查解析链路",
            7: "TCP 连接失败，请检查代理出口和目标的网络可达性",
            28: "连接超时，尚不能确定发生在连接、握手还是响应阶段",
            35: "TLS 握手失败，请检查代理 HTTPS 隧道及网络环境",
            52: "连接未返回有效响应，对端可能已关闭连接",
            55: "网络发送失败，请检查连接是否中断",
            56: "网络接收失败，请检查连接是否被重置或代理隧道被拒绝",
            60: "TLS 证书校验失败，请检查证书信任链和系统时间；不要关闭证书校验",
            67: "认证被拒绝，请检查代理使用授权",
            77: "本地 CA 证书无法读取，请检查证书文件及权限",
            97: "代理协议握手失败，请检查代理协议及使用授权",
        }
        prefix = f"{target} [curl {code}]" if code is not None else target
        if code == 56 and "proxy connect aborted" in detail:
            return f"{prefix}：代理隧道连接被中止，尚未取得目标 HTTP 响应。请核对 IPWO 白名单出口、海外网络环境及代理协议；API 提取成功不代表出口可用"
        # Only extract the numeric CONNECT status from a known libcurl diagnostic.
        connect_status = re.search(r"connect tunnel failed, response ([1-5][0-9]{2})\b", detail)
        if connect_status:
            status = int(connect_status.group(1))
            hint = "代理要求身份认证，请检查代理使用授权" if status == 407 else "代理拒绝建立 HTTPS 隧道，请检查代理授权及目标访问限制"
            return f"{prefix} CONNECT HTTP {status}：{hint}"
        if code in descriptions:
            return f"{prefix}：{descriptions[code]}"
        if isinstance(exc, socket.gaierror):
            return f"{prefix}：DNS 解析失败"
        if isinstance(exc, (TimeoutError, socket.timeout)) or "timeout" in name or "timed out" in detail:
            return f"{prefix} 连接超时"
        return f"{prefix} 连接失败：未提供可识别的网络错误码，具体阶段尚未确定"

    @staticmethod
    def _is_allowed_host(hostname: str) -> bool:
        return hostname == "ipwo.net" or hostname.endswith(".ipwo.net")

    @staticmethod
    def _is_allowed_ipwo_resolution(address: str) -> bool:
        parsed = ipaddress.ip_address(address)
        return parsed.is_global or (
            isinstance(parsed, ipaddress.IPv4Address)
            and parsed in CLASH_FAKE_IP_NETWORK
        )

    @staticmethod
    def _curl_options(validated_url: _ValidatedIpwoUrl) -> dict[CurlOpt, object]:
        resolved = [
            f"{validated_url.hostname}:{validated_url.port}:"
            f"{'[' + address + ']' if ':' in address else address}"
            for address in validated_url.addresses
        ]
        return {
            CurlOpt.NOPROXY: "*",
            CurlOpt.RESOLVE: resolved,
        }

    @staticmethod
    def _request_url(settings: IpwoProxySettings, source_url: str) -> str:
        parsed = urlsplit(source_url)
        retained = [
            (name, value)
            for name, value in parse_qsl(parsed.query, keep_blank_values=True)
            if name.lower() not in {"num", "regions", "protocol", "return_type"}
        ]
        retained.extend((
            ("num", "1"),
            ("protocol", settings.protocol),
            ("return_type", "json"),
        ))
        if settings.regions:
            retained.append(("regions", settings.regions))
        return urlunsplit(parsed._replace(query=urlencode(retained)))


ipwo_proxy_service = IpwoProxyService()


def is_configured() -> bool:
    return ipwo_proxy_service.is_configured()


def get_runtime_proxy() -> str:
    return ipwo_proxy_service.get_runtime_proxy()
