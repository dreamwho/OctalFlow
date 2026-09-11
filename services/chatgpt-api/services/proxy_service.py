"""Global outbound proxy and Cloudflare clearance helpers."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
import json
import platform
import random
import re
import socket
import threading
import time
from typing import Any, Callable, Mapping
from urllib import request as urllib_request
from urllib.parse import quote, urlparse

from curl_cffi.requests import Session

from services.config import config
from services.storage.configuration_repository import (
    ProxyConfigurationRepository,
    proxy_configuration_repository,
)


FlareSolverrRequestMethod = Callable[[str, bytes, dict[str, str], float], bytes]

DEFAULT_PROXY_NODE_IMAGE_CONCURRENCY_LIMIT = 30
MAX_PROXY_NODE_IMAGE_CONCURRENCY_LIMIT = 10000
MAGIC_PROXY_OVERRIDE_KEY = "octalaicanvas_magic_proxy_override"
PROXY_SELECTION_KEY = "octalaicanvas_proxy_selection"
PROXY_SELECTION_MODES = {"native", "magic"}
PROXY_SELECTION_NATIVE_SOURCES = {"manual", "ipwo"}
PROXY_NODE_IMAGE_CONCURRENCY_FIELDS = (
    "image_concurrency_limit",
    "image_concurrency",
    "max_image_concurrency",
)


class ProxyReferenceUnavailableError(RuntimeError):
    """Raised when a configured proxy reference cannot provide its egress."""


class ImageEgressDeadlineError(RuntimeError):
    """Raised when image egress capacity cannot be acquired before its deadline."""


@dataclass(frozen=True)
class ProxySelection:
    """The sole persisted switch selecting normal-request egress behavior."""

    enabled: bool = False
    mode: str = "native"
    native_source: str = "manual"

    @property
    def is_valid(self) -> bool:
        return (
            self.mode in PROXY_SELECTION_MODES
            and self.native_source in PROXY_SELECTION_NATIVE_SOURCES
        )


def proxy_selection_from_configuration(
    configuration: Mapping[str, object],
) -> ProxySelection:
    raw = configuration.get(PROXY_SELECTION_KEY)
    if not isinstance(raw, Mapping):
        return ProxySelection()
    mode = str(raw.get("mode") or "native").strip().lower()
    return ProxySelection(
        enabled=raw.get("enabled") is True,
        mode=mode if mode in PROXY_SELECTION_MODES else "native",
        native_source=str(raw.get("native_source") or "manual").strip().lower(),
    )


def normalize_proxy_url(url: str) -> str:
    """Normalize proxy URLs for curl_cffi.

    SOCKS proxies should use remote-DNS resolution by default, so generic
    ``socks://`` and ``socks5://`` inputs are upgraded to ``socks5h://``.
    HTTP/HTTPS/socks5h inputs are otherwise left untouched except trimming.
    """
    candidate = str(url or "").strip()
    if candidate and "://" not in candidate:
        candidate = _colon_proxy_to_url(candidate)
    lowered = candidate.lower()
    if lowered.startswith("socks://"):
        return "socks5h://" + candidate[len("socks://") :]
    if lowered.startswith("socks5://"):
        return "socks5h://" + candidate[len("socks5://") :]
    return candidate


@dataclass(frozen=True)
class ProxyRuntimeProfile:
    proxy_url: str = ""
    proxy_source: str = "direct"
    egress_key: str = "direct"
    egress_label: str = "direct"
    proxy_group_id: str = ""
    proxy_node_id: str = ""
    proxy_node_name: str = ""
    image_concurrency_limit: int = 0
    image_egress_reserved: bool = False
    image_egress_wait_ms: int = 0
    resource: bool = False
    runtime_enabled: bool = False
    egress_mode: str = "direct"
    skip_ssl_verify: bool = False
    reset_session_status_codes: tuple[int, ...] = field(default_factory=lambda: (403,))
    clearance: dict[str, object] = field(default_factory=dict, repr=False)

    @property
    def clearance_enabled(self) -> bool:
        return (
            self.runtime_enabled
            and bool(self.clearance.get("enabled"))
            and self.clearance_mode in {"manual", "flaresolverr"}
        )

    @property
    def clearance_mode(self) -> str:
        return str(self.clearance.get("mode") or "none").strip().lower()

    def egress_snapshot(self) -> dict[str, str]:
        """Credential-free egress description for request logging (mode/group/node/address)."""
        if not self.proxy_url:
            return {}
        parsed = urlparse(self.proxy_url)
        host = (parsed.hostname or "").strip()
        address = f"{host}:{parsed.port}" if host and parsed.port else host
        return {
            "mode": "magic" if str(self.proxy_source or "") == "magic" else "generic",
            "group_id": self.proxy_group_id,
            "node_id": self.proxy_node_id,
            "node_name": self.proxy_node_name,
            "address": address,
        }

    @property
    def refresh_interval(self) -> int:
        try:
            return max(0, int(self.clearance.get("refresh_interval") or 0))
        except (OverflowError, TypeError, ValueError):
            return 0

    @property
    def timeout_sec(self) -> int:
        try:
            return max(1, int(self.clearance.get("timeout_sec") or 60))
        except (OverflowError, TypeError, ValueError):
            return 60


@dataclass(frozen=True)
class ClearanceBundle:
    target_host: str
    proxy_url: str = ""
    cookies: dict[str, str] = field(default_factory=dict, repr=False)
    user_agent: str = ""
    created_at: float = field(default_factory=time.time)
    expires_at: float | None = None

    def is_valid_for(self, target_host: str, proxy_url: str, *, now: float | None = None) -> bool:
        host = _normalize_host(target_host)
        if self.target_host and host and _normalize_host(self.target_host) != host:
            return False
        if normalize_proxy_url(self.proxy_url) != normalize_proxy_url(proxy_url):
            return False
        if self.expires_at is not None and (time.time() if now is None else now) >= self.expires_at:
            return False
        return bool(self.cookies or self.user_agent)

    def cookie_header(self) -> str:
        return _cookies_to_header(self.cookies)


@dataclass(frozen=True)
class ProxyGroupSelection:
    proxy_url: str = ""
    group_id: str = ""
    node_id: str = ""
    node_name: str = ""
    image_concurrency_limit: int = 0
    image_egress_reserved: bool = False
    image_egress_wait_ms: int = 0

    @property
    def egress_key(self) -> str:
        if self.group_id and self.node_id:
            return f"group:{self.group_id}:{self.node_id}"
        return _egress_key_for_proxy(self.proxy_url)

    @property
    def egress_label(self) -> str:
        if self.group_id and self.node_id:
            return f"{self.group_id}/{self.node_name or self.node_id}"
        return _egress_key_for_proxy(self.proxy_url)


@dataclass(frozen=True)
class ResolvedProxyReference:
    proxy_url: str = ""
    source: str = "direct"
    terminal: bool = False
    egress_key: str = "direct"
    egress_label: str = "direct"
    proxy_group_id: str = ""
    proxy_node_id: str = ""
    proxy_node_name: str = ""
    image_concurrency_limit: int = 0
    image_egress_reserved: bool = False
    image_egress_wait_ms: int = 0


class FlareSolverrClearanceProvider:
    def __init__(self, flaresolverr_url: str, request_method: FlareSolverrRequestMethod | None = None) -> None:
        self.flaresolverr_url = str(flaresolverr_url or "").strip().rstrip("/")
        self._request_method = request_method or self._urllib_post

    def get_clearance(self, target_url: str, proxy_url: str = "", timeout_sec: int = 60) -> ClearanceBundle | None:
        if not self.flaresolverr_url:
            return None

        timeout = _coerce_timeout(timeout_sec)
        payload: dict[str, object] = {
            "cmd": "request.get",
            "url": str(target_url or ""),
            "maxTimeout": int(timeout * 1000),
        }
        proxy_url = normalize_proxy_url(proxy_url)
        if proxy_url:
            payload["proxy"] = {"url": proxy_url}

        endpoint = f"{self.flaresolverr_url}/v1"
        try:
            body = json.dumps(payload).encode("utf-8")
            raw_response = self._request_method(
                endpoint,
                body,
                {"Content-Type": "application/json"},
                timeout,
            )
            data = json.loads(raw_response.decode("utf-8") if isinstance(raw_response, bytes) else raw_response)
        except Exception:
            return None

        if not isinstance(data, dict) or str(data.get("status") or "").lower() != "ok":
            return None
        solution = data.get("solution")
        if not isinstance(solution, dict):
            return None

        target_host = _host_from_url(target_url)
        cookies = _filter_flaresolverr_cookies(solution.get("cookies"), target_host)
        user_agent = str(solution.get("userAgent") or "").strip()
        if not cookies and not user_agent:
            return None
        return ClearanceBundle(
            target_host=target_host,
            proxy_url=proxy_url,
            cookies=cookies,
            user_agent=user_agent,
        )

    @staticmethod
    def _urllib_post(endpoint: str, body: bytes, headers: dict[str, str], timeout: float) -> bytes:
        req = urllib_request.Request(endpoint, data=body, headers=headers, method="POST")
        with urllib_request.urlopen(req, timeout=timeout) as response:
            return response.read()


class ProxySettingsStore:
    def __init__(
        self,
        config_store=None,
        clearance_provider_factory: Callable[[str], FlareSolverrClearanceProvider] | None = None,
        proxy_repository: ProxyConfigurationRepository | None = None,
    ) -> None:
        self._config = config_store or config
        self._proxy_repository = (
            proxy_repository
            or (config_store if config_store is not None else proxy_configuration_repository)
        )
        self._clearance_provider_factory = clearance_provider_factory or FlareSolverrClearanceProvider
        self._clearance_cache: dict[tuple[str, str], ClearanceBundle] = {}
        self._provider_cache: dict[str, FlareSolverrClearanceProvider] = {}
        self._flight_locks: dict[tuple[str, str], threading.Lock] = {}
        self._egress_inflight: dict[str, int] = {}
        self._lock = threading.RLock()
        self._egress_condition = threading.Condition(self._lock)

    def get_profile(
        self,
        account: dict | None = None,
        proxy: str = "",
        resource: bool = False,
        upstream: bool = False,
        reserve_image_egress: bool = False,
        deadline_monotonic: float | None = None,
    ) -> ProxyRuntimeProfile:
        runtime = self._get_runtime_settings()
        proxy_configuration = self._proxy_configuration()
        selection = proxy_selection_from_configuration(proxy_configuration)
        if not selection.enabled:
            # An explicit direct profile also suppresses curl_cffi's environment
            # proxy lookup in build_session_kwargs*.  It must happen before every
            # account/default/fallback/resource/clearance branch.
            return ProxyRuntimeProfile(
                resource=bool(resource),
                runtime_enabled=False,
                reset_session_status_codes=_status_codes_tuple(
                    runtime.get("reset_session_status_codes")
                ),
            )
        if not selection.is_valid:
            raise ProxyReferenceUnavailableError("代理选择配置无效")

        clearance = dict(runtime.get("clearance") if isinstance(runtime.get("clearance"), dict) else {})
        runtime_enabled = bool(runtime.get("enabled"))

        selected_proxy = ""
        source = "direct"
        terminal = False
        egress_key = "direct"
        egress_label = "direct"
        proxy_group_id = ""
        proxy_node_id = ""
        proxy_node_name = ""
        image_concurrency_limit = 0
        image_egress_reserved = False
        image_egress_wait_ms = 0

        if selection.mode == "magic":
            magic_proxy = _clean(proxy_configuration.get(MAGIC_PROXY_OVERRIDE_KEY))
            if not magic_proxy:
                raise ProxyReferenceUnavailableError(
                    "魔法代理未配置"
                )
            resolved = self._resolve_proxy_reference(
                magic_proxy,
                source="magic",
                terminal_when_unresolved=True,
                reserve_image_egress=reserve_image_egress,
                deadline_monotonic=deadline_monotonic,
            )
            selected_proxy, source, terminal = resolved.proxy_url, resolved.source, resolved.terminal
            egress_key = resolved.egress_key
            egress_label = resolved.egress_label
            proxy_group_id = resolved.proxy_group_id
            proxy_node_id = resolved.proxy_node_id
            proxy_node_name = resolved.proxy_node_name
            image_concurrency_limit = resolved.image_concurrency_limit
            image_egress_reserved = resolved.image_egress_reserved
            image_egress_wait_ms = resolved.image_egress_wait_ms
        elif selection.native_source == "ipwo":
            resolved = self._resolve_proxy_reference(
                self._ipwo_proxy_url(),
                source="ipwo",
                terminal_when_unresolved=True,
                reserve_image_egress=reserve_image_egress,
                deadline_monotonic=deadline_monotonic,
            )
            selected_proxy, source, terminal = resolved.proxy_url, resolved.source, resolved.terminal
            egress_key = resolved.egress_key
            egress_label = resolved.egress_label
            proxy_group_id = resolved.proxy_group_id
            proxy_node_id = resolved.proxy_node_id
            proxy_node_name = resolved.proxy_node_name
            image_concurrency_limit = resolved.image_concurrency_limit
            image_egress_reserved = resolved.image_egress_reserved
            image_egress_wait_ms = resolved.image_egress_wait_ms

        account_proxy = _clean((account or {}).get("proxy") if isinstance(account, dict) else "")
        if not selected_proxy and not terminal and account_proxy:
            resolved = self._resolve_proxy_reference(
                account_proxy,
                source="account",
                terminal_when_unresolved=True,
                reserve_image_egress=reserve_image_egress,
                deadline_monotonic=deadline_monotonic,
            )
            selected_proxy, source, terminal = resolved.proxy_url, resolved.source, resolved.terminal
            egress_key = resolved.egress_key
            egress_label = resolved.egress_label
            proxy_group_id = resolved.proxy_group_id
            proxy_node_id = resolved.proxy_node_id
            proxy_node_name = resolved.proxy_node_name
            image_concurrency_limit = resolved.image_concurrency_limit
            image_egress_reserved = resolved.image_egress_reserved
            image_egress_wait_ms = resolved.image_egress_wait_ms

        if not selected_proxy and not terminal:
            account_group_proxy = self._account_group_proxy_reference(account)
            if account_group_proxy:
                resolved = self._resolve_proxy_reference(
                    account_group_proxy,
                    source="account_group",
                    terminal_when_unresolved=False,
                    reserve_image_egress=reserve_image_egress,
                    deadline_monotonic=deadline_monotonic,
                )
                selected_proxy, source, terminal = resolved.proxy_url, resolved.source, resolved.terminal
                egress_key = resolved.egress_key
                egress_label = resolved.egress_label
                proxy_group_id = resolved.proxy_group_id
                proxy_node_id = resolved.proxy_node_id
                proxy_node_name = resolved.proxy_node_name
                image_concurrency_limit = resolved.image_concurrency_limit
                image_egress_reserved = resolved.image_egress_reserved
                image_egress_wait_ms = resolved.image_egress_wait_ms

        if not selected_proxy and not terminal:
            explicit_proxy = _clean(proxy)
            if explicit_proxy:
                resolved = self._resolve_proxy_reference(
                    explicit_proxy,
                    source="explicit",
                    terminal_when_unresolved=True,
                    reserve_image_egress=reserve_image_egress,
                    deadline_monotonic=deadline_monotonic,
                )
                selected_proxy, source, terminal = resolved.proxy_url, resolved.source, resolved.terminal
                egress_key = resolved.egress_key
                egress_label = resolved.egress_label
                proxy_group_id = resolved.proxy_group_id
                proxy_node_id = resolved.proxy_node_id
                proxy_node_name = resolved.proxy_node_name
                image_concurrency_limit = resolved.image_concurrency_limit
                image_egress_reserved = resolved.image_egress_reserved
                image_egress_wait_ms = resolved.image_egress_wait_ms

        if not selected_proxy and not terminal and upstream and resource and runtime_enabled:
            resource_proxy = _clean(runtime.get("resource_proxy_url"))
            if resource_proxy:
                resolved = self._resolve_proxy_reference(
                    resource_proxy,
                    source="resource",
                    terminal_when_unresolved=True,
                    reserve_image_egress=reserve_image_egress,
                    deadline_monotonic=deadline_monotonic,
                )
                selected_proxy, source, terminal = resolved.proxy_url, resolved.source, resolved.terminal
                egress_key = resolved.egress_key
                egress_label = resolved.egress_label
                proxy_group_id = resolved.proxy_group_id
                proxy_node_id = resolved.proxy_node_id
                proxy_node_name = resolved.proxy_node_name
                image_concurrency_limit = resolved.image_concurrency_limit
                image_egress_reserved = resolved.image_egress_reserved
                image_egress_wait_ms = resolved.image_egress_wait_ms

        if not selected_proxy and not terminal:
            legacy_proxy = _clean(proxy_configuration.get("proxy"))
            if legacy_proxy:
                resolved = self._resolve_proxy_reference(
                    legacy_proxy,
                    source="default",
                    terminal_when_unresolved=False,
                    reserve_image_egress=reserve_image_egress,
                    deadline_monotonic=deadline_monotonic,
                )
                selected_proxy, source, terminal = resolved.proxy_url, resolved.source, resolved.terminal
                egress_key = resolved.egress_key
                egress_label = resolved.egress_label
                proxy_group_id = resolved.proxy_group_id
                proxy_node_id = resolved.proxy_node_id
                proxy_node_name = resolved.proxy_node_name
                image_concurrency_limit = resolved.image_concurrency_limit
                image_egress_reserved = resolved.image_egress_reserved
                image_egress_wait_ms = resolved.image_egress_wait_ms

        return ProxyRuntimeProfile(
            proxy_url=normalize_proxy_url(selected_proxy),
            proxy_source=source,
            egress_key=egress_key or _egress_key_for_proxy(selected_proxy),
            egress_label=egress_label or source,
            proxy_group_id=proxy_group_id,
            proxy_node_id=proxy_node_id,
            proxy_node_name=proxy_node_name,
            image_concurrency_limit=max(0, int(image_concurrency_limit or 0)),
            image_egress_reserved=bool(image_egress_reserved),
            image_egress_wait_ms=max(0, int(image_egress_wait_ms or 0)),
            resource=bool(resource),
            runtime_enabled=runtime_enabled,
            egress_mode="proxy" if selected_proxy else "direct",
            skip_ssl_verify=bool(runtime.get("skip_ssl_verify")),
            reset_session_status_codes=_status_codes_tuple(runtime.get("reset_session_status_codes")),
            clearance=clearance,
        )

    def get_fallback_proxy_reference(self) -> str:
        selection = self.get_proxy_selection()
        if (
            not selection.enabled
            or not selection.is_valid
            or selection.mode != "native"
            or selection.native_source != "manual"
        ):
            return ""
        reference = _clean(self._proxy_configuration().get("fallback_proxy"))
        return "" if reference.lower() == "global" else reference

    def get_fallback_profile(
        self,
        *,
        resource: bool = False,
        upstream: bool = False,
        reserve_image_egress: bool = False,
        deadline_monotonic: float | None = None,
    ) -> ProxyRuntimeProfile | None:
        reference = self.get_fallback_proxy_reference()
        if not reference:
            return None
        profile = self.get_profile(
            account=None,
            proxy=reference,
            resource=resource,
            upstream=upstream,
            reserve_image_egress=reserve_image_egress,
            deadline_monotonic=deadline_monotonic,
        )
        source = str(profile.proxy_source or "direct").strip() or "direct"
        if source.startswith("explicit"):
            source = "fallback" + source[len("explicit"):]
        elif not source.startswith("fallback"):
            source = f"fallback_{source}"
        label = str(profile.egress_label or "").strip()
        if not label or label.startswith("explicit"):
            label = "fallback" if profile.proxy_url else source
        return replace(profile, proxy_source=source, egress_label=label)

    def build_session_kwargs(
        self,
        account: dict | None = None,
        proxy: str = "",
        resource: bool = False,
        upstream: bool = False,
        **session_kwargs,
    ) -> dict[str, object]:
        profile = self.get_profile(account=account, proxy=proxy, resource=resource, upstream=upstream)
        session_kwargs["trust_env"] = False
        if profile.proxy_url:
            session_kwargs["proxy"] = profile.proxy_url
        if profile.skip_ssl_verify:
            session_kwargs["verify"] = False
        return session_kwargs

    @staticmethod
    def build_session_kwargs_from_profile(
        profile: ProxyRuntimeProfile,
        **session_kwargs,
    ) -> dict[str, object]:
        session_kwargs["trust_env"] = False
        if profile.proxy_url:
            session_kwargs["proxy"] = profile.proxy_url
        if profile.skip_ssl_verify:
            session_kwargs["verify"] = False
        return session_kwargs

    def build_headers(
        self,
        headers: Mapping[str, object] | None = None,
        target_url: str = "https://chatgpt.com",
        account: dict | None = None,
        proxy: str = "",
        resource: bool = False,
        upstream: bool = True,
        proxy_profile: ProxyRuntimeProfile | None = None,
    ) -> dict[str, object]:
        merged_headers: dict[str, object] = dict(headers or {})
        profile = proxy_profile or self.get_profile(
            account=account, proxy=proxy, resource=resource, upstream=upstream
        )
        if not profile.clearance_enabled:
            return merged_headers

        target_host = _host_from_url(target_url)
        bundle = self._bundle_for_headers(profile, target_host)
        if bundle is None or not bundle.is_valid_for(target_host, profile.proxy_url):
            return merged_headers

        if bundle.user_agent and _find_header_key(merged_headers, "user-agent") is None:
            merged_headers["User-Agent"] = bundle.user_agent

        if bundle.cookies:
            cookie_key = _find_header_key(merged_headers, "cookie") or "Cookie"
            existing_cookie = str(merged_headers.get(cookie_key) or "")
            cookie_header = _merge_cookie_header(existing_cookie, bundle.cookies)
            if cookie_header:
                merged_headers[cookie_key] = cookie_header
        return merged_headers

    def refresh_clearance(
        self,
        target_url: str = "https://chatgpt.com",
        account: dict | None = None,
        proxy: str = "",
        resource: bool = False,
        force: bool = False,
        upstream: bool = True,
        proxy_profile: ProxyRuntimeProfile | None = None,
    ) -> ClearanceBundle | None:
        profile = proxy_profile or self.get_profile(
            account=account, proxy=proxy, resource=resource, upstream=upstream
        )
        if not profile.clearance_enabled:
            return None

        target_host = _host_from_url(target_url)
        key = self._cache_key(profile.proxy_url, target_host)
        if profile.clearance_mode == "manual":
            bundle = self._build_manual_bundle(profile, target_host)
            if bundle is not None:
                self._set_cached_bundle(key, bundle)
            return bundle
        if profile.clearance_mode != "flaresolverr":
            return None

        cached_before = self._get_cached_bundle(key)
        if cached_before is not None and not force and cached_before.is_valid_for(target_host, profile.proxy_url):
            return cached_before

        lock = self._get_flight_lock(key)
        if not lock.acquire(blocking=False):
            with lock:
                pass
            return self._get_cached_bundle(key) or cached_before

        try:
            cached_now = self._get_cached_bundle(key)
            if cached_now is not None and not force and cached_now.is_valid_for(target_host, profile.proxy_url):
                return cached_now

            flaresolverr_url = str(profile.clearance.get("flaresolverr_url") or "").strip()
            provider = self._get_provider(flaresolverr_url)
            new_bundle = provider.get_clearance(target_url, proxy_url=profile.proxy_url, timeout_sec=profile.timeout_sec)
            if new_bundle is not None:
                expires_at = time.time() + profile.refresh_interval if profile.refresh_interval else None
                if (
                    not new_bundle.target_host
                    or normalize_proxy_url(new_bundle.proxy_url) != normalize_proxy_url(profile.proxy_url)
                    or new_bundle.expires_at != expires_at
                ):
                    new_bundle = replace(
                        new_bundle,
                        target_host=new_bundle.target_host or target_host,
                        proxy_url=profile.proxy_url,
                        expires_at=expires_at,
                    )
                self._set_cached_bundle(key, new_bundle)
                return new_bundle
            return cached_now or cached_before
        finally:
            lock.release()

    def invalidate_clearance(
        self,
        target_url: str = "https://chatgpt.com",
        account: dict | None = None,
        proxy: str = "",
        resource: bool = False,
        upstream: bool = True,
        proxy_profile: ProxyRuntimeProfile | None = None,
    ) -> None:
        profile = proxy_profile or self.get_profile(
            account=account, proxy=proxy, resource=resource, upstream=upstream
        )
        target_host = _host_from_url(target_url)
        key = self._cache_key(profile.proxy_url, target_host)
        with self._lock:
            self._clearance_cache.pop(key, None)

    def get_runtime_status(self) -> dict[str, object]:
        runtime = self._get_runtime_settings()
        selection = self.get_proxy_selection()
        proxy_configuration = self._proxy_configuration()
        clearance = dict(
            runtime.get("clearance")
            if isinstance(runtime.get("clearance"), dict)
            else {}
        )
        selection_enabled = selection.enabled and selection.is_valid
        if not selection_enabled:
            source = "disabled"
            has_proxy = False
        elif selection.mode == "magic":
            source = "magic"
            has_proxy = bool(_clean(proxy_configuration.get(MAGIC_PROXY_OVERRIDE_KEY)))
        elif selection.native_source == "ipwo":
            source = "ipwo"
            has_proxy = False
        else:
            source = "native"
            has_proxy = bool(_clean(proxy_configuration.get("proxy")))
        runtime_enabled = selection_enabled and bool(runtime.get("enabled"))
        with self._lock:
            cached_hosts = [host for _proxy, host in self._clearance_cache]
            cached_count = len(self._clearance_cache)
        return {
            "enabled": runtime_enabled,
            "egress_mode": "proxy" if selection_enabled and source != "native" or has_proxy else "direct",
            "proxy_source": source,
            "egress_key": f"selection:{source}" if selection_enabled else "direct",
            "egress_label": source,
            "image_concurrency_limit": 0,
            "has_proxy": has_proxy,
            "skip_ssl_verify": bool(runtime.get("skip_ssl_verify")),
            "clearance_enabled": runtime_enabled and bool(clearance.get("enabled")),
            "clearance_mode": str(clearance.get("mode") or "none").strip().lower(),
            "has_clearance_bundle": cached_count > 0,
            "cached_clearance_hosts": sorted(set(cached_hosts)),
        }

    def should_skip_ssl_verify(self) -> bool:
        return bool(self._get_runtime_settings().get("skip_ssl_verify"))

    def acquire_image_egress(
        self,
        profile: ProxyRuntimeProfile,
        *,
        deadline_monotonic: float | None = None,
    ) -> int:
        if (
            deadline_monotonic is not None
            and deadline_monotonic > 0
            and time.monotonic() >= deadline_monotonic
        ):
            raise ImageEgressDeadlineError(
                "image request deadline exceeded before egress acquisition"
            )
        if bool(getattr(profile, "image_egress_reserved", False)):
            return max(0, int(getattr(profile, "image_egress_wait_ms", 0) or 0))
        limit = max(0, int(getattr(profile, "image_concurrency_limit", 0) or 0))
        if limit <= 0:
            return 0
        key = _clean(getattr(profile, "egress_key", "")) or _egress_key_for_proxy(profile.proxy_url)
        started = time.perf_counter()
        with self._egress_condition:
            while int(self._egress_inflight.get(key, 0)) >= limit:
                remaining = (
                    deadline_monotonic - time.monotonic()
                    if deadline_monotonic is not None and deadline_monotonic > 0
                    else None
                )
                if remaining is not None and remaining <= 0:
                    raise ImageEgressDeadlineError(
                        "image request deadline exceeded while waiting for egress capacity"
                    )
                self._egress_condition.wait(
                    timeout=min(1.0, remaining) if remaining is not None else 1.0
                )
            self._egress_inflight[key] = int(self._egress_inflight.get(key, 0)) + 1
        return int((time.perf_counter() - started) * 1000)

    def release_image_egress(self, profile: ProxyRuntimeProfile) -> None:
        limit = max(0, int(getattr(profile, "image_concurrency_limit", 0) or 0))
        if limit <= 0:
            return
        key = _clean(getattr(profile, "egress_key", "")) or _egress_key_for_proxy(profile.proxy_url)
        with self._egress_condition:
            current = int(self._egress_inflight.get(key, 0))
            if current <= 1:
                self._egress_inflight.pop(key, None)
            else:
                self._egress_inflight[key] = current - 1
            self._egress_condition.notify_all()

    def _get_runtime_settings(self) -> dict[str, object]:
        try:
            runtime = self._config.get_proxy_runtime_settings()
        except AttributeError:
            runtime = {}
        return runtime if isinstance(runtime, dict) else {}

    def _config_dict_list(self, key: str) -> list[dict]:
        data = getattr(self._config, "data", None)
        if not isinstance(data, dict):
            try:
                data = self._config.get()
            except AttributeError:
                data = {}
        raw = data.get(key) if isinstance(data, dict) else None
        if not isinstance(raw, list):
            return []
        return [dict(item) for item in raw if isinstance(item, dict)]

    def _proxy_configuration(self) -> dict[str, object]:
        try:
            value = self._proxy_repository.get()
        except AttributeError:
            value = getattr(self._proxy_repository, "data", None)
        return dict(value) if isinstance(value, dict) else {}

    def get_proxy_selection(self) -> ProxySelection:
        return proxy_selection_from_configuration(self._proxy_configuration())

    @staticmethod
    def _ipwo_proxy_url() -> str:
        try:
            from services.ipwo_proxy_service import IpwoProxyError, ipwo_proxy_service

            proxy_url = normalize_proxy_url(str(ipwo_proxy_service.get_runtime_proxy() or ""))
        except IpwoProxyError as exc:
            raise ProxyReferenceUnavailableError(exc.public_message) from exc
        except Exception as exc:
            raise ProxyReferenceUnavailableError("IPWO 代理获取失败") from exc
        if not proxy_url:
            raise ProxyReferenceUnavailableError("IPWO 代理获取失败")
        return proxy_url

    def _proxy_dict_list(self, key: str) -> list[dict]:
        raw = self._proxy_configuration().get(key)
        if not isinstance(raw, list):
            return []
        return [dict(item) for item in raw if isinstance(item, dict)]

    def _account_group_proxy_reference(self, account: dict | None) -> str:
        if not isinstance(account, dict):
            return ""
        group_id = _clean(account.get("group_id"))
        if not group_id:
            return ""
        for group in self._config_dict_list("account_groups"):
            if _clean(group.get("id")) != group_id or group.get("enabled") is False:
                continue
            proxy = _clean(group.get("proxy"))
            if proxy:
                return proxy
            proxy_group_id = _clean(group.get("proxy_group_id"))
            return f"group:{proxy_group_id}" if proxy_group_id else ""
        return ""

    def _resolve_proxy_reference(
        self,
        value: object,
        *,
        source: str,
        terminal_when_unresolved: bool,
        reserve_image_egress: bool = False,
        deadline_monotonic: float | None = None,
    ) -> ResolvedProxyReference:
        raw = _clean(value)
        lower = raw.lower()
        if not raw or lower == "global":
            return ResolvedProxyReference(source=source)
        if lower == "direct":
            return ResolvedProxyReference(source=f"{source}_direct", terminal=True)
        if lower.startswith("profile:"):
            proxy = self._resolve_proxy_profile(raw.split(":", 1)[1])
            return ResolvedProxyReference(
                proxy_url=proxy,
                source=f"{source}_profile",
                terminal=bool(proxy) or terminal_when_unresolved,
                egress_key=_egress_key_for_proxy(proxy),
                egress_label=f"{source}_profile",
            )
        if lower.startswith("group:"):
            group_id = _clean(raw.split(":", 1)[1])
            selection = self._resolve_proxy_group(
                group_id,
                reserve_image_egress=reserve_image_egress,
                deadline_monotonic=deadline_monotonic,
            )
            if not selection.proxy_url:
                raise ProxyReferenceUnavailableError(
                    f"proxy group is unavailable: {group_id or '(missing id)'}"
                )
            return ResolvedProxyReference(
                proxy_url=selection.proxy_url,
                source=f"{source}_group",
                terminal=bool(selection.proxy_url) or terminal_when_unresolved,
                egress_key=selection.egress_key,
                egress_label=selection.egress_label,
                proxy_group_id=selection.group_id,
                proxy_node_id=selection.node_id,
                proxy_node_name=selection.node_name,
                image_concurrency_limit=selection.image_concurrency_limit,
                image_egress_reserved=selection.image_egress_reserved,
                image_egress_wait_ms=selection.image_egress_wait_ms,
            )
        if lower.startswith("node:"):
            wanted_node = _clean(raw.split(":", 1)[1])
            try:
                url, group_id_value, node_id_value, image_limit = self.resolve_egress_url(node_id=wanted_node)
            except ValueError as exc:
                raise ProxyReferenceUnavailableError(str(exc)) from exc
            return ResolvedProxyReference(
                proxy_url=url,
                source=f"{source}_node",
                terminal=True,
                egress_key=f"group:{group_id_value}:{node_id_value}",
                egress_label=f"{source}_node",
                proxy_group_id=group_id_value,
                proxy_node_id=node_id_value,
                image_concurrency_limit=image_limit,
            )
        return ResolvedProxyReference(
            proxy_url=raw,
            source=source,
            terminal=True,
            egress_key=_egress_key_for_proxy(raw),
            egress_label=source,
        )

    def _resolve_proxy_profile(self, profile_id: object) -> str:
        normalized = _clean(profile_id)
        if not normalized:
            return ""
        for profile in self._proxy_dict_list("proxy_profiles"):
            if _clean(profile.get("id")) == normalized and profile.get("enabled", True):
                return _clean(profile.get("proxy"))
        return ""

    def _resolve_proxy_group(
        self,
        group_id: object,
        *,
        reserve_image_egress: bool = False,
        deadline_monotonic: float | None = None,
    ) -> ProxyGroupSelection:
        normalized = _clean(group_id)
        if not normalized:
            return ProxyGroupSelection()
        for group in self._proxy_dict_list("proxy_groups"):
            if _clean(group.get("id")) != normalized or group.get("enabled") is False:
                continue
            nodes = [
                node for node in group.get("nodes", [])
                if isinstance(node, dict)
                and node.get("enabled", True)
                and _clean(node.get("url"))
            ]
            if not nodes:
                return ProxyGroupSelection()
            started = time.perf_counter()
            indexed_nodes = list(enumerate(nodes))
            with self._egress_condition:
                while True:
                    remaining = (
                        deadline_monotonic - time.monotonic()
                        if deadline_monotonic is not None and deadline_monotonic > 0
                        else None
                    )
                    if remaining is not None and remaining <= 0:
                        raise ImageEgressDeadlineError(
                            "image request deadline exceeded while selecting proxy group capacity"
                        )
                    available_nodes = [
                        (node_index, node)
                        for node_index, node in indexed_nodes
                        if self._proxy_node_has_image_capacity(normalized, node, node_index)
                    ]
                    if available_nodes:
                        selected_index, selected = random.choice(available_nodes)
                        selection = _proxy_group_selection(normalized, selected, selected_index)
                        if reserve_image_egress and selection.image_concurrency_limit > 0:
                            self._egress_inflight[selection.egress_key] = int(
                                self._egress_inflight.get(selection.egress_key, 0)
                            ) + 1
                            selection = replace(
                                selection,
                                image_egress_reserved=True,
                                image_egress_wait_ms=int((time.perf_counter() - started) * 1000),
                            )
                        return selection
                    if not reserve_image_egress:
                        selected_index, selected = min(
                            indexed_nodes,
                            key=lambda item: self._proxy_node_load_score(normalized, item[1], item[0]),
                        )
                        return _proxy_group_selection(normalized, selected, selected_index)
                    self._egress_condition.wait(
                        timeout=min(1.0, remaining) if remaining is not None else 1.0
                    )
        return ProxyGroupSelection()

    def resolve_egress_url(self, group_id: str = "", node_id: str = "") -> tuple[str, str, str, int]:
        """Resolve a concrete (proxy_url, group_id, node_id, image_concurrency_limit) for surface egress bindings.

        With ``group_id`` the same capacity-aware rotation as upstream requests picks
        the node; with ``node_id`` the exact enabled node is returned.
        """
        wanted_group = _clean(group_id)
        wanted_node = _clean(node_id)
        if wanted_group:
            selection = self._resolve_proxy_group(wanted_group)
            if not selection.proxy_url:
                raise ValueError(f"proxy group is unavailable: {wanted_group}")
            return selection.proxy_url, selection.group_id, selection.node_id, selection.image_concurrency_limit
        if wanted_node:
            for group in self._proxy_dict_list("proxy_groups"):
                if not isinstance(group, dict) or group.get("enabled") is False:
                    continue
                group_id_value = _clean(group.get("id"))
                for index, node in enumerate(node for node in group.get("nodes", []) if isinstance(node, dict)):
                    if _clean(node.get("id")) != wanted_node or node.get("enabled", True) is False:
                        continue
                    url = _clean(node.get("url"))
                    if url:
                        node_id_value = _clean(node.get("id")) or f"node-{index + 1}"
                        return url, group_id_value, node_id_value, proxy_node_image_concurrency_limit(node)
        raise ValueError("proxy egress is unavailable")

    def _proxy_node_has_image_capacity(self, group_id: str, node: Mapping[str, object], index: int) -> bool:
        limit = proxy_node_image_concurrency_limit(node)
        if limit <= 0:
            return True
        key = _proxy_group_node_key(group_id, node, index)
        return int(self._egress_inflight.get(key, 0)) < limit

    def _proxy_node_load_score(self, group_id: str, node: Mapping[str, object], index: int) -> tuple[float, int]:
        key = _proxy_group_node_key(group_id, node, index)
        current = int(self._egress_inflight.get(key, 0))
        limit = proxy_node_image_concurrency_limit(node)
        if limit <= 0:
            return 0.0, current
        return current / max(1, limit), current

    def _bundle_for_headers(self, profile: ProxyRuntimeProfile, target_host: str) -> ClearanceBundle | None:
        key = self._cache_key(profile.proxy_url, target_host)
        if profile.clearance_mode == "manual":
            bundle = self._build_manual_bundle(profile, target_host)
            if bundle is not None:
                self._set_cached_bundle(key, bundle)
            return bundle
        if profile.clearance_mode == "flaresolverr":
            return self._get_cached_bundle(key)
        return None

    def _build_manual_bundle(self, profile: ProxyRuntimeProfile, target_host: str) -> ClearanceBundle | None:
        cookies = _parse_cookie_header(str(profile.clearance.get("cf_cookies") or ""))
        cf_clearance = str(profile.clearance.get("cf_clearance") or "").strip()
        if cf_clearance and "cf_clearance" not in cookies:
            cookies["cf_clearance"] = cf_clearance
        user_agent = str(profile.clearance.get("user_agent") or "").strip()
        if not cookies and not user_agent:
            return None

        now = time.time()
        expires_at = now + profile.refresh_interval if profile.refresh_interval else None
        return ClearanceBundle(
            target_host=target_host,
            proxy_url=profile.proxy_url,
            cookies=cookies,
            user_agent=user_agent,
            created_at=now,
            expires_at=expires_at,
        )

    def _get_provider(self, flaresolverr_url: str) -> FlareSolverrClearanceProvider:
        url = str(flaresolverr_url or "").strip().rstrip("/")
        with self._lock:
            provider = self._provider_cache.get(url)
            if provider is None:
                provider = self._clearance_provider_factory(url)
                self._provider_cache[url] = provider
            return provider

    def _get_flight_lock(self, key: tuple[str, str]) -> threading.Lock:
        with self._lock:
            lock = self._flight_locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._flight_locks[key] = lock
            return lock

    def _get_cached_bundle(self, key: tuple[str, str]) -> ClearanceBundle | None:
        with self._lock:
            return self._clearance_cache.get(key)

    def _set_cached_bundle(self, key: tuple[str, str], bundle: ClearanceBundle) -> None:
        with self._lock:
            self._clearance_cache[key] = bundle

    @staticmethod
    def _cache_key(proxy_url: str, target_host: str) -> tuple[str, str]:
        return (normalize_proxy_url(proxy_url), _normalize_host(target_host))


def _clean(value: object) -> str:
    return str(value or "").strip()


def _colon_proxy_to_url(url: str) -> str:
    raw = str(url or "").strip()
    if not raw:
        return ""
    has_explicit_scheme = False
    scheme = "http://"
    candidate = raw
    for s in ("socks5h://", "socks5://", "https://", "http://"):
        if candidate.lower().startswith(s):
            has_explicit_scheme = True
            scheme = s
            candidate = candidate[len(s):]
            break
    if candidate.startswith("//"):
        candidate = candidate[2:]

    parts = candidate.split(":", 3)
    if len(parts) == 4 and parts[1].isdigit():
        host, port, username, password = parts
        return f"{scheme}{quote(username, safe='')}:{quote(password, safe='')}@{host}:{port}"
    if len(parts) == 4 and parts[3].isdigit():
        username, password, host, port = parts
        return f"{scheme}{quote(username, safe='')}:{quote(password, safe='')}@{host}:{port}"
    if len(parts) == 2 and parts[1].isdigit():
        return f"{scheme}{candidate}"
    if "@" in candidate:
        userinfo, host_port = candidate.rsplit("@", 1)
        if ":" in host_port:
            _h, port_str = host_port.split(":", 1)
            if port_str.isdigit():
                return f"{scheme}{candidate}"
    return raw


def _normalize_host(host: str) -> str:
    return str(host or "").strip().strip(".").lower()


def _host_from_url(url: str) -> str:
    candidate = str(url or "").strip()
    parsed = urlparse(candidate)
    if not parsed.hostname and candidate and "://" not in candidate:
        parsed = urlparse(f"https://{candidate}")
    return _normalize_host(parsed.hostname or "")


def _status_codes_tuple(value: object) -> tuple[int, ...]:
    source = value if isinstance(value, list) else [403]
    codes: list[int] = []
    for item in source:
        if isinstance(item, bool):
            continue
        try:
            code = int(item)
        except (OverflowError, TypeError, ValueError):
            continue
        if 100 <= code <= 599 and code not in codes:
            codes.append(code)
    return tuple(codes or [403])


def _egress_key_for_proxy(proxy_url: object) -> str:
    normalized = normalize_proxy_url(_clean(proxy_url))
    return f"proxy:{normalized}" if normalized else "direct"


def _proxy_node_id(node: Mapping[str, object], index: int) -> str:
    return _clean(node.get("id")) or _clean(node.get("name")) or f"node-{index + 1}"


def _proxy_group_node_key(group_id: str, node: Mapping[str, object], index: int) -> str:
    return f"group:{group_id}:{_proxy_node_id(node, index)}"


def proxy_node_image_concurrency_limit(
    node: Mapping[str, object],
    *,
    fallback: Mapping[str, object] | None = None,
) -> int:
    for source in (node, fallback):
        if source is None:
            continue
        for key in PROXY_NODE_IMAGE_CONCURRENCY_FIELDS:
            value = source.get(key)
            if value is None or value == "":
                continue
            try:
                return max(0, min(int(float(value)), MAX_PROXY_NODE_IMAGE_CONCURRENCY_LIMIT))
            except (OverflowError, TypeError, ValueError):
                return DEFAULT_PROXY_NODE_IMAGE_CONCURRENCY_LIMIT
    return DEFAULT_PROXY_NODE_IMAGE_CONCURRENCY_LIMIT


def _proxy_group_selection(group_id: str, node: Mapping[str, object], index: int) -> ProxyGroupSelection:
    node_id = _proxy_node_id(node, index)
    return ProxyGroupSelection(
        proxy_url=_clean(node.get("url")),
        group_id=group_id,
        node_id=node_id,
        node_name=_clean(node.get("name")) or node_id,
        image_concurrency_limit=proxy_node_image_concurrency_limit(node),
    )


def _coerce_timeout(value: object) -> float:
    try:
        timeout = float(value)
    except (OverflowError, TypeError, ValueError):
        timeout = 60.0
    return max(1.0, timeout)


def _is_valid_proxy_url(url: str) -> bool:
    parsed = urlparse(normalize_proxy_url(url))
    return parsed.scheme in {"http", "https", "socks5", "socks5h"} and bool(parsed.netloc)


def _domain_matches(host: str, domain: str) -> bool:
    normalized_host = _normalize_host(host)
    normalized_domain = _normalize_host(domain.lstrip("."))
    if not normalized_domain:
        return True
    return normalized_host == normalized_domain or normalized_host.endswith(f".{normalized_domain}")


def _filter_flaresolverr_cookies(raw_cookies: object, target_host: str) -> dict[str, str]:
    if not isinstance(raw_cookies, list):
        return {}

    filtered_cookies: dict[str, str] = {}
    for item in raw_cookies:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        value = str(item.get("value") or "")
        domain = str(item.get("domain") or "").strip()
        if not domain or _domain_matches(target_host, domain):
            filtered_cookies[name] = value
    return filtered_cookies


def _parse_cookie_header(header: str) -> dict[str, str]:
    cookies: dict[str, str] = {}
    for part in str(header or "").split(";"):
        name, sep, value = part.strip().partition("=")
        if sep and name:
            cookies[name.strip()] = value.strip()
    return cookies


def _cookies_to_header(cookies: Mapping[str, str]) -> str:
    return "; ".join(f"{name}={value}" for name, value in cookies.items() if name)


def _merge_cookie_header(existing_header: str, cookies: Mapping[str, str]) -> str:
    existing = str(existing_header or "").strip()
    existing_names = set(_parse_cookie_header(existing).keys())
    additions = [f"{name}={value}" for name, value in cookies.items() if name and name not in existing_names]
    if existing and additions:
        return existing.rstrip("; ") + "; " + "; ".join(additions)
    if existing:
        return existing
    return "; ".join(additions)


def _find_header_key(headers: Mapping[str, object], name: str) -> str | None:
    target = name.lower()
    for key in headers:
        if str(key).lower() == target:
            return str(key)
    return None


def _redact_url_credentials(text: str) -> str:
    return re.sub(
        r"((?:https?|socks5h?|socks)://)([^\s/@:]+):([^\s/@]+)@",
        r"\1[REDACTED]@",
        str(text or ""),
        flags=re.IGNORECASE,
    )


_SERVER_PUBLIC_IP_CACHE: tuple[float, str | None] = (0.0, None)
_SERVER_PUBLIC_IP_LOCK = threading.Lock()


def _get_server_public_ip(timeout: float = 2.0) -> str | None:
    global _SERVER_PUBLIC_IP_CACHE
    now = time.time()
    with _SERVER_PUBLIC_IP_LOCK:
        cached_time, cached_ip = _SERVER_PUBLIC_IP_CACHE
        if cached_ip and (now - cached_time) < 600:
            return cached_ip
    for url in ("https://api.ipify.org", "https://icanhazip.com", "https://ifconfig.me/ip"):
        try:
            req = urllib_request.Request(url, headers={"User-Agent": "curl/7.88.1"})
            with urllib_request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", errors="ignore").strip()
                if raw and len(raw) <= 64 and not raw.startswith("<"):
                    with _SERVER_PUBLIC_IP_LOCK:
                        _SERVER_PUBLIC_IP_CACHE = (now, raw)
                    return raw
        except Exception:
            continue
    return None


def _parse_proxy_details(url: str) -> dict[str, Any]:
    parsed = urlparse(url)
    scheme = parsed.scheme.lower() if parsed.scheme else "http"
    host = parsed.hostname or ""
    port = parsed.port or (1080 if "socks" in scheme else 80)
    username = parsed.username
    has_auth = bool(username)
    masked_user = None
    if username:
        if len(username) <= 6:
            masked_user = f"{username[:2]}***"
        else:
            masked_user = f"{username[:4]}***{username[-4:]}"
    return {
        "scheme": scheme,
        "host": host,
        "port": port,
        "has_auth": has_auth,
        "username_masked": masked_user,
    }


def _probe_dns(host: str, timeout: float = 3.0) -> dict[str, Any]:
    if not host:
        return {"ok": False, "latency_ms": 0, "resolved_ips": [], "error": "代理主机名为空"}
    started = time.perf_counter()
    try:
        if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", host) or ":" in host:
            return {
                "ok": True,
                "latency_ms": 0,
                "resolved_ips": [host],
                "error": None,
            }
        addr_info = socket.getaddrinfo(host, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
        ips = sorted(list({info[4][0] for info in addr_info if info and len(info) > 4 and info[4]}))
        latency = int((time.perf_counter() - started) * 1000)
        return {
            "ok": True,
            "latency_ms": latency,
            "resolved_ips": ips,
            "error": None,
        }
    except Exception as exc:
        latency = int((time.perf_counter() - started) * 1000)
        return {
            "ok": False,
            "latency_ms": latency,
            "resolved_ips": [],
            "error": f"DNS 解析失败: {exc}",
        }


def _probe_tcp(host: str, port: int, timeout: float = 3.5) -> dict[str, Any]:
    if not host or port <= 0:
        return {"ok": False, "latency_ms": 0, "error": f"无效的主机或端口: {host}:{port}"}
    started = time.perf_counter()
    sock = None
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
        latency = int((time.perf_counter() - started) * 1000)
        return {
            "ok": True,
            "latency_ms": latency,
            "error": None,
        }
    except Exception as exc:
        latency = int((time.perf_counter() - started) * 1000)
        err_msg = str(exc)
        if "timed out" in err_msg.lower():
            err_msg = f"连接超时 ({timeout}s)。服务器无法直连代理端口 {port}，请检查云服务器安全组/防火墙出站规则或代理服务器状态"
        elif "refused" in err_msg.lower():
            err_msg = f"连接被拒绝 (Connection Refused)。代理服务器未在端口 {port} 监听或拒绝了来自本机的 TCP 连接"
        return {
            "ok": False,
            "latency_ms": latency,
            "error": err_msg,
        }
    finally:
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass


def test_proxy(url: str = "", *, timeout: float = 15.0) -> dict:
    candidate = normalize_proxy_url(_clean(url))
    proxy_source = "input"
    if not candidate:
        profile = proxy_settings.get_profile(upstream=True)
        candidate = profile.proxy_url
        proxy_source = profile.proxy_source
    result_base = {"proxy_source": proxy_source, "has_proxy": bool(candidate)}
    if not candidate:
        return {
            "ok": False,
            "status": 0,
            "latency_ms": 0,
            "error": "no active proxy configured",
            "diagnostics": None,
            **result_base,
        }
    if not _is_valid_proxy_url(candidate):
        return {
            "ok": False,
            "status": 0,
            "latency_ms": 0,
            "error": "invalid proxy url",
            "diagnostics": None,
            **result_base,
        }

    proxy_meta = _parse_proxy_details(candidate)
    server_public_ip = _get_server_public_ip()
    headers = {
        "user-agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
    }

    # 1. 预检阶段：DNS 解析与 TCP 直连探测
    dns_diag = _probe_dns(proxy_meta["host"], timeout=3.0)
    tcp_diag = (
        _probe_tcp(proxy_meta["host"], proxy_meta["port"], timeout=3.5)
        if dns_diag["ok"]
        else {"ok": False, "latency_ms": 0, "error": "DNS 未解析，跳过 TCP 探测"}
    )

    # 2. 端点探针配置
    probe_targets = [
        {
            "id": "chatgpt_csrf",
            "name": "ChatGPT 网页端鉴权探针 (HTTPS)",
            "url": "https://chatgpt.com/api/auth/csrf",
            "timeout": min(timeout, 8.0),
        },
        {
            "id": "cloudflare_trace",
            "name": "Cloudflare CDN 与出口IP探针 (HTTPS)",
            "url": "https://www.cloudflare.com/cdn-cgi/trace",
            "timeout": 5.0,
        },
        {
            "id": "http_204",
            "name": "HTTP 基础隧道连通性探针 (HTTP 204)",
            "url": "http://cp.cloudflare.com/generate_204",
            "timeout": 4.0,
        },
        {
            "id": "openai_api",
            "name": "OpenAI 官方 API 探针 (HTTPS)",
            "url": "https://api.openai.com/v1/models",
            "timeout": 5.0,
        },
    ]

    probes_recorded: list[dict[str, Any]] = []
    primary_succeeded = False
    any_succeeded = False
    proxy_egress_ip: str | None = None
    proxy_egress_loc: str | None = None
    primary_status = 0
    primary_latency = 0
    primary_err: str | None = None
    target_warning: str | None = None

    started_total = time.perf_counter()

    for idx, target_info in enumerate(probe_targets):
        p_id = target_info["id"]
        p_name = target_info["name"]
        p_url = target_info["url"]
        p_timeout = target_info["timeout"]

        # 如果前两个探针均发生强 reset (curl 56)，且代理握手断开，则后续不用持续消耗超时
        if idx >= 2 and not any_succeeded:
            consecutive_resets = sum(
                1 for p in probes_recorded if "56" in str(p.get("error") or "") or "reset" in str(p.get("error") or "").lower()
            )
            if consecutive_resets >= 2:
                probes_recorded.append({
                    "id": p_id,
                    "name": p_name,
                    "url": p_url,
                    "ok": False,
                    "status_code": 0,
                    "latency_ms": 0,
                    "error": "前序探针遭遇连续 TCP Reset，代理网关主动断开，跳过后续探针",
                })
                continue

        p_session = None
        p_start = time.perf_counter()
        try:
            p_session = Session(
                impersonate="chrome124",
                verify=not proxy_settings.should_skip_ssl_verify(),
                proxy=candidate,
                trust_env=False,
            )
            p_resp = p_session.get(p_url, headers=headers, timeout=p_timeout)
            p_lat = int((time.perf_counter() - p_start) * 1000)
            p_status = int(p_resp.status_code)
            # 对于 openai models，无 key 返回 401 说明隧道与网关完全正常响应
            is_probe_ok = p_status < 400 or (p_id == "openai_api" and p_status == 401)
            p_rec: dict[str, Any] = {
                "id": p_id,
                "name": p_name,
                "url": p_url,
                "ok": is_probe_ok,
                "status_code": p_status,
                "latency_ms": p_lat,
                "error": None if is_probe_ok else f"HTTP {p_status}",
            }
            if p_id == "cloudflare_trace" and p_resp.text:
                ip_match = re.search(r"^ip=(.+)$", p_resp.text, re.MULTILINE)
                loc_match = re.search(r"^loc=(.+)$", p_resp.text, re.MULTILINE)
                if ip_match:
                    proxy_egress_ip = ip_match.group(1).strip()
                    p_rec["egress_ip"] = proxy_egress_ip
                if loc_match:
                    proxy_egress_loc = loc_match.group(1).strip()
                    p_rec["loc"] = proxy_egress_loc

            probes_recorded.append(p_rec)
            if is_probe_ok:
                any_succeeded = True
                if idx == 0:
                    primary_succeeded = True
                    primary_status = p_status
                    primary_latency = p_lat
        except Exception as exc:
            p_lat = int((time.perf_counter() - p_start) * 1000)
            raw_err = _redact_url_credentials(str(exc) or exc.__class__.__name__)
            probes_recorded.append({
                "id": p_id,
                "name": p_name,
                "url": p_url,
                "ok": False,
                "status_code": 0,
                "latency_ms": p_lat,
                "error": raw_err,
            })
            if idx == 0:
                primary_err = raw_err
                primary_latency = p_lat
        finally:
            if p_session is not None:
                try:
                    p_session.close()
                except Exception:
                    pass

    total_latency_ms = int((time.perf_counter() - started_total) * 1000)

    # 3. 智能诊断阶段与排查建议推导
    scheme_str = proxy_meta["scheme"].upper()
    port_int = proxy_meta["port"]
    has_reset_error = any(
        "curl: (56)" in str(p.get("error") or "") or "connection reset by peer" in str(p.get("error") or "").lower()
        for p in probes_recorded
    )
    has_407 = any(p.get("status_code") == 407 for p in probes_recorded)

    if not dns_diag["ok"]:
        stage = "dns"
        analysis_title = "代理域名 DNS 解析失败"
        analysis_summary = f"服务器无法解析代理域名 {proxy_meta['host']}：{dns_diag.get('error')}"
        suggestions = [
            "请检查代理节点地址中的主机名拼写是否正确。",
            "检查服务器 /etc/resolv.conf 中的 DNS 设置，可临时更换为 8.8.8.8 或 1.1.1.1 尝试解析。",
        ]
    elif not tcp_diag["ok"]:
        stage = "tcp_connect"
        analysis_title = f"TCP 握手建立失败 (端口 {port_int})"
        analysis_summary = f"服务器向代理主机 {proxy_meta['host']}:{port_int} 发起 TCP 握手失败：{tcp_diag.get('error')}"
        suggestions = [
            f"云服务器出站限制：请检查阿里云/腾讯云/AWS 安全组与系统防火墙，确保允许访问外部端口 {port_int}。",
            "代理节点维护：代理服务商对应的服务器节点可能处于离线或维护状态。",
            "如果协议支持 SOCKS5/HTTP 切换，请尝试更换端口测试。",
        ]
    elif has_407:
        stage = "auth"
        analysis_title = "代理身份认证被拒绝 (HTTP 407 Proxy Authentication Required)"
        analysis_summary = "代理服务器接收到了请求，但明确拒绝了当前提供的账号密码。"
        suggestions = [
            "请核对节点中的用户名与密码，注意特殊字符的 URL 编码。",
            "检查代理商控制台，确认对应通道账号密码是否已被重置或变更。",
        ]
    elif has_reset_error and not any_succeeded:
        stage = "proxy_handshake"
        analysis_title = "代理服务端主动切断重置连接 (TCP Reset / curl 56)"
        analysis_summary = (
            f"服务器已成功与 {proxy_meta['host']}:{port_int} 建立 TCP 握手，但在发送 HTTP/SOCKS 握手认证报文后，"
            "代理服务端或中间网关主动发送了 RST 包强制切断了连接。"
        )
        suggestions = [
            f"【本地通但服务器不通 · 出境网络/分流差异】：本地开发电脑若常驻科学上网客户端（如 Clash / Surge / 魔法代理 / TUN 模式），连接境外代理节点 (us.ipwo.net:7878) 会被本地代理软件转发从而顺利通畅；而 Linux 服务器上的 Docker 通常是直接走公司宽带裸连境外，直接连接境外明文 HTTP 代理端口 (7878) 极易被国内网络运营商防火墙 (GFW) 或路由器安全网关拦截并发送 TCP RST 重置切断连接。",
            f"【协议类型不匹配 (SOCKS5 vs HTTP)】：当前配置的协议为 {scheme_str}。请检查 IPWO 控制台该端口实际是 HTTP 还是 SOCKS5。如果该端口实际是 SOCKS5，使用 HTTP 握手会导致代理网关等待握手超时后重置切断连接；请尝试切换为 SOCKS5 (socks5://) 重新测试。",
            f"【Docker 容器 MTU 网络分片丢包】：若公司路由器使用 PPPoE 宽带拨号（MTU 为 1492 或更低），Docker 默认虚拟网桥 MTU 1500 会导致带证书/大 Header 的报文被静默丢弃，现象为连接挂起约 14 秒后被 TCP RST 切断。",
            f"【IP 白名单限制】：如果后续在 IPWO 开启了白名单授权，请将当前服务器公网出口 IP「{server_public_ip or '未知'}」添加到代理控制台白名单。",
            f"【通道状态与套餐余额】：检查代理后台对应的通道名称（如 {proxy_meta.get('username_masked') or '自定义通道'}）是否有效激活、账密是否正确或套餐流量是否耗尽。",
        ]
    elif any_succeeded and not primary_succeeded:
        stage = "target_blocked"
        analysis_title = f"代理基础连通正常，但 ChatGPT 目标被拦截 (出口 IP: {proxy_egress_ip or '未知'})"
        analysis_summary = (
            f"代理节点成功连通公网，出口 IP 为 {proxy_egress_ip or '未知'}（地区: {proxy_egress_loc or '未知'}），"
            f"但 ChatGPT 目标站点鉴权失败 ({primary_err or '受阻'})。"
        )
        suggestions = [
            "代理本身工作正常，但当前出口 IP 可能被 Cloudflare WAF 或 OpenAI 风控标记为受限或爬虫阻断。",
            "建议在代理服务商后台切换通道的出口地区或重新分配新的出口 IP。",
        ]
    elif any_succeeded and primary_succeeded:
        stage = "healthy"
        analysis_title = f"代理节点健康可用 (出口 IP: {proxy_egress_ip or '未知'})"
        analysis_summary = f"所有端点探针测试通过，代理出口 IP 为 {proxy_egress_ip or '未知'}，所属地区为 {proxy_egress_loc or '未知'}。"
        suggestions = [
            "代理节点工作正常，可以安全用于生产调用。",
        ]
    else:
        stage = "unknown"
        analysis_title = "探针全部异常"
        analysis_summary = f"所有端点探针均失败：{primary_err or '未知原因'}"
        suggestions = [
            "请检查代理节点地址、协议、端口与网络连通性。",
        ]

    diagnostics: dict[str, Any] = {
        "proxy": proxy_meta,
        "server_context": {
            "server_public_ip": server_public_ip,
            "server_os": f"{platform.system()} {platform.release()}",
            "dns_servers": dns_diag.get("resolved_ips", []),
        },
        "dns": dns_diag,
        "tcp": tcp_diag,
        "probes": probes_recorded,
        "egress": {
            "ip": proxy_egress_ip,
            "loc": proxy_egress_loc,
        },
        "analysis": {
            "stage": stage,
            "title": analysis_title,
            "summary": analysis_summary,
            "suggestions": suggestions,
        },
    }

    # 4. 构建最终对外响应契约
    if primary_succeeded:
        return {
            "ok": True,
            "status": primary_status or 200,
            "latency_ms": primary_latency or total_latency_ms,
            "error": None,
            "diagnostics": diagnostics,
            **result_base,
        }
    elif any_succeeded:
        return {
            "ok": True,
            "status": 200,
            "latency_ms": total_latency_ms,
            "error": None,
            "target_warning": f"ChatGPT 端点受阻 ({primary_err})，通用连通性正常 (出口: {proxy_egress_ip or '可用'})",
            "diagnostics": diagnostics,
            **result_base,
        }
    else:
        user_friendly_error = primary_err or "所有测试探针均失败"
        if has_reset_error:
            user_friendly_error = (
                f"{user_friendly_error} (连接被代理服务端重置。常见原因：1. IPWO等代理后台未添加当前服务器公网IP为白名单；"
                f"2. 协议不匹配，如SOCKS5端口被当作HTTP连接；3. 账密错误或流量耗尽)"
            )
        return {
            "ok": False,
            "status": 0,
            "latency_ms": total_latency_ms,
            "error": user_friendly_error,
            "diagnostics": diagnostics,
            **result_base,
        }


def test_clearance(target_url: str = "https://chatgpt.com") -> dict:
    target_url = str(target_url or "https://chatgpt.com").strip() or "https://chatgpt.com"
    started = time.perf_counter()
    status = proxy_settings.get_runtime_status()
    if not status.get("clearance_enabled"):
        return {
            "ok": False,
            "status": "disabled",
            "latency_ms": 0,
            "has_cookies": False,
            "user_agent": "",
            "error": "clearance is disabled",
            "runtime": status,
        }
    try:
        bundle = proxy_settings.refresh_clearance(target_url=target_url, force=True, upstream=True)
    except Exception as exc:
        latency_ms = int((time.perf_counter() - started) * 1000)
        return {
            "ok": False,
            "status": "error",
            "latency_ms": latency_ms,
            "has_cookies": False,
            "user_agent": "",
            "error": _redact_url_credentials(str(exc) or exc.__class__.__name__),
            "runtime": proxy_settings.get_runtime_status(),
        }

    latency_ms = int((time.perf_counter() - started) * 1000)
    runtime = proxy_settings.get_runtime_status()
    if bundle is None:
        return {
            "ok": False,
            "status": "failed",
            "latency_ms": latency_ms,
            "has_cookies": False,
            "user_agent": "",
            "error": "clearance refresh returned no bundle",
            "runtime": runtime,
        }
    return {
        "ok": True,
        "status": "ok",
        "latency_ms": latency_ms,
        "has_cookies": bool(bundle.cookies),
        "user_agent": bundle.user_agent or "",
        "error": None,
        "runtime": runtime,
    }


proxy_settings = ProxySettingsStore()
