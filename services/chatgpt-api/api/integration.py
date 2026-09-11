"""Small, explicitly allowlisted bridge and management surface."""

from __future__ import annotations

import hmac
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from api.call_contract import CallDetail, CallLogStatus, CallSummaryPage
from api.support import extract_bearer_token, require_admin, require_identity
from contracts.models import ModelCatalogView
from contracts.proxy import (
    ProxyDefaultsMutation,
    ProxyGroup,
    ProxyGroupDeleteMutation,
    ProxyGroupMutation,
    ProxyGroupPatch,
    ProxyNode,
    ProxyReference,
    ProxyView,
)
from contracts.settings import SettingsMutationResult, SettingsPatch, SettingsView
from services.config import config
from services.auth_service import auth_service
from services.dashboard_metrics_service import dashboard_metrics_service
from services.runtime_environment_service import snapshot as runtime_snapshot
from services.image_service import get_image_response, get_thumbnail_response
from services.internal_runtime import runtime_key
from services.log_service import log_service
from services.model_catalog_service import get_model_catalog
from services.proxy_management_service import (
    ProxyGroupInUseError,
    ProxySelectionUnavailableError,
    normalize_proxy_node_url,
    proxy_group_error_text,
    proxy_management_service,
)
from services.proxy_service import ImageEgressDeadlineError, proxy_settings, test_proxy
from services.settings_management_service import (
    SettingsRevisionConflictError,
    settings_management_service,
)


GATEWAY_SETTING = "octalaicanvas_gateway_enabled"
REDACTED_PROXY_AUTH = "__OCTAL_PROXY_AUTH_REDACTED__"
router = APIRouter()


class GatewayPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool


class ProxyPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    proxy_url: str | None = Field(alias="proxyUrl")


class ProxySelectionPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    mode: Literal["native", "magic"]
    native_source: Literal["manual", "ipwo"]


class SafeProxyReference(BaseModel):
    """A proxy reference that permits a blank custom URL for credential-safe edits."""

    model_config = ConfigDict(extra="forbid")

    mode: Literal["direct", "group", "node", "custom"]
    group_id: str = ""
    node_id: str = ""
    url: str = ""


class SafeProxyDefaultsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    default_reference: SafeProxyReference
    fallback_reference: SafeProxyReference | None = None


class ProxyNodeImportPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(default="", max_length=1_000_000)


class ProxyGroupTestPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = ""
    node_id: str = ""
    url: str = ""


class SafeSettingsPatch(BaseModel):
    """Only source fields that affect normal request handling, never runtime control."""

    model_config = ConfigDict(extra="forbid")

    revision: str = Field(min_length=1, max_length=64)
    global_system_prompt: str | None = None
    sensitive_words: list[str] | None = None
    log_levels: list[Literal["debug", "info", "warning", "error"]] | None = None
    console_request_timeout_secs: int | None = None
    image_poll_timeout_secs: int | None = None
    image_stream_timeout_secs: int | None = None
    image_poll_initial_wait_secs: float | None = None
    image_poll_interval_secs: float | None = None
    image_account_concurrency: int | None = None
    account_processing_concurrency: int | None = None
    image_account_retry_enabled: bool | None = None
    image_upscale_enabled: bool | None = None
    image_upscale_engine: Literal["sharp_lanczos3", "pillow_lanczos"] | None = None
    image_max_account_attempts: int | None = None
    image_remove_conversation_after_result: bool | None = None
    image_settle_enabled: bool | None = None
    image_settle_secs: float | None = None


def gateway_enabled() -> bool:
    return bool(config.get().get(GATEWAY_SETTING, False))


def _require_admin(authorization: str | None) -> None:
    require_admin(authorization)


def _proxy_group_id(value: object) -> str:
    raw = str(value or "").strip()
    if raw.lower().startswith("group:"):
        raw = raw.split(":", 1)[1]
    return raw.strip()


def _proxy_target(value: str) -> tuple[str, str, int | None] | None:
    try:
        parsed = urlsplit(value)
        scheme = parsed.scheme.lower()
        host = (parsed.hostname or "").lower()
        port = parsed.port
    except ValueError:
        return None
    if not scheme or not host:
        return None
    if port is None:
        port = {"http": 80, "https": 443}.get(scheme)
    return scheme, host, port


def _redact_proxy_url(value: str) -> str:
    candidate = str(value or "").strip()
    try:
        parsed = urlsplit(candidate)
        if "@" not in parsed.netloc:
            return candidate
        host = parsed.hostname
        port = parsed.port
    except ValueError:
        return ""
    if not host:
        return ""
    host_text = f"[{host}]" if ":" in host else host
    port_text = f":{port}" if port is not None else ""
    return urlunsplit((
        parsed.scheme,
        f"{REDACTED_PROXY_AUTH}@{host_text}{port_text}",
        parsed.path,
        parsed.query,
        parsed.fragment,
    ))


def _is_redacted_proxy_url(value: str) -> bool:
    try:
        return urlsplit(str(value or "")).username == REDACTED_PROXY_AUTH
    except ValueError:
        return False


def _restore_proxy_url(value: str, stored: str) -> str:
    candidate = str(value or "").strip()
    if not candidate:
        if stored:
            return stored
        raise HTTPException(status_code=422, detail={"error": "proxy url is required"})
    if not _is_redacted_proxy_url(candidate):
        return candidate
    if not stored or _proxy_target(candidate) != _proxy_target(stored):
        raise HTTPException(
            status_code=422,
            detail={"error": "redacted proxy credentials do not match a saved proxy"},
        )
    return stored


def _restore_proxy_reference(
    reference: SafeProxyReference,
    stored: ProxyReference | None,
) -> ProxyReference:
    values = reference.model_dump(mode="python")
    if reference.mode == "custom":
        stored_url = stored.url if stored is not None and stored.mode == "custom" else ""
        values["url"] = _restore_proxy_url(reference.url, stored_url)
    try:
        return ProxyReference.model_validate(values)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"error": "proxy reference is invalid"}) from exc


def _restore_proxy_group_patch(
    patch: ProxyGroupPatch,
    view: ProxyView,
) -> ProxyGroupPatch:
    if patch.nodes is None:
        return patch
    group_id = _proxy_group_id(patch.id)
    stored_group = next((group for group in view.groups if group.id == group_id), None)
    stored_nodes = {
        node.id: node.url
        for node in (stored_group.nodes if stored_group is not None else [])
    }
    nodes = [
        node.model_copy(update={"url": _restore_proxy_url(node.url, stored_nodes.get(node.id, ""))})
        for node in patch.nodes
    ]
    return patch.model_copy(update={"nodes": nodes})


def _redact_proxy_reference(reference: ProxyReference | None) -> ProxyReference | None:
    if reference is None or reference.mode != "custom":
        return reference
    return reference.model_copy(update={"url": ""})


def _redact_proxy_node(node: ProxyNode) -> ProxyNode:
    return node


def _redact_proxy_group(group: ProxyGroup) -> ProxyGroup:
    return group.model_copy(update={"nodes": [_redact_proxy_node(node) for node in group.nodes]})


def _redact_proxy_view(view: ProxyView) -> ProxyView:
    return view.model_copy(update={
        "default_reference": _redact_proxy_reference(view.default_reference),
        "fallback_reference": _redact_proxy_reference(view.fallback_reference),
        "groups": [_redact_proxy_group(group) for group in view.groups],
    })


def _redact_proxy_defaults_mutation(result: ProxyDefaultsMutation) -> ProxyDefaultsMutation:
    return result.model_copy(update={
        "default_reference": _redact_proxy_reference(result.default_reference),
        "fallback_reference": _redact_proxy_reference(result.fallback_reference),
    })


def _redact_proxy_group_mutation(result: ProxyGroupMutation) -> ProxyGroupMutation:
    return result.model_copy(update={"group": _redact_proxy_group(result.group)})


def _proxy_payload(value: Any) -> dict[str, Any]:
    return value.model_dump(mode="json")


@router.get("/integration/health")
async def integration_health() -> dict[str, object]:
    """Safe liveness/configuration status; it deliberately has no credentials."""
    return {
        "status": "ok",
        "gateway": {"enabled": gateway_enabled()},
        "storage": {"encrypted": True, "backend": "sqlite"},
    }


@router.get("/integration/auth")
async def integration_auth(
    authorization: str | None = Header(default=None),
) -> dict[str, object]:
    """Validate a public source user key without accepting the provider master key."""
    token = extract_bearer_token(authorization)
    if token and hmac.compare_digest(token, runtime_key()):
        return JSONResponse(
            status_code=403,
            content={"authenticated": False, "role": "admin"},
        )
    identity = auth_service.authenticate(token)
    if identity is None:
        return JSONResponse(
            status_code=401,
            content={"authenticated": False, "role": None},
        )
    role = str(identity.get("role") or "").strip().lower()
    if role != "user":
        return JSONResponse(
            status_code=403,
            content={"authenticated": False, "role": role or None},
        )
    return {"authenticated": True, "role": "user"}


@router.get("/integration/gateway")
async def get_gateway(authorization: str | None = Header(default=None)) -> dict[str, bool]:
    _require_admin(authorization)
    return {"enabled": gateway_enabled()}


@router.patch("/integration/gateway")
async def patch_gateway(
    body: GatewayPatch, authorization: str | None = Header(default=None)
) -> dict[str, bool]:
    _require_admin(authorization)
    await run_in_threadpool(config.update, {GATEWAY_SETTING: body.enabled})
    return {"enabled": body.enabled}


async def _set_proxy(
    body: ProxyPatch, authorization: str | None
) -> dict[str, bool]:
    _require_admin(authorization)
    value = body.proxy_url
    if value is not None and not value.strip():
        raise HTTPException(status_code=422, detail={"error": "proxyUrl cannot be blank"})
    try:
        configured = await run_in_threadpool(
            proxy_management_service.save_magic_proxy_override,
            value,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"error": "proxyUrl is invalid"}) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail={"error": "proxy override could not be saved"}) from exc
    return {"configured": configured}


@router.patch("/integration/proxy")
async def patch_proxy(
    body: ProxyPatch, authorization: str | None = Header(default=None)
) -> dict[str, bool]:
    return await _set_proxy(body, authorization)


@router.post("/integration/proxy")
async def post_proxy(
    body: ProxyPatch, authorization: str | None = Header(default=None)
) -> dict[str, bool]:
    return await _set_proxy(body, authorization)


@router.get("/integration/proxy/resolve-node/{node_id}")
async def resolve_proxy_node(
    node_id: str,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_admin(authorization)
    raw_url = await run_in_threadpool(proxy_management_service.resolve_node_url, node_id)
    if not raw_url:
        raise HTTPException(status_code=404, detail={"error": f"节点 {node_id} 不存在或未配置 URL"})
    return {"node_id": node_id, "url": raw_url}


@router.get("/integration/proxy-selection")
async def get_proxy_selection(
    authorization: str | None = Header(default=None),
) -> dict[str, object]:
    _require_admin(authorization)
    return await run_in_threadpool(proxy_management_service.proxy_selection)


@router.patch("/integration/proxy-selection")
async def patch_proxy_selection(
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict[str, object]:
    _require_admin(authorization)
    try:
        body = await request.json()
        selection = ProxySelectionPatch.model_validate(body)
    except (ValidationError, ValueError) as exc:
        raise HTTPException(status_code=400, detail={"error": "代理选择参数无效"}) from exc
    try:
        return await run_in_threadpool(
            proxy_management_service.save_proxy_selection,
            enabled=selection.enabled,
            mode=selection.mode,
            native_source=selection.native_source,
        )
    except ProxySelectionUnavailableError as exc:
        raise HTTPException(status_code=409, detail={"error": str(exc)}) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail={"error": "代理选择保存失败"}) from exc


@router.get("/integration/statistics")
async def integration_statistics(
    time_range: Literal["24h", "7d", "30d"] = Query(default="24h"),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_admin(authorization)
    try:
        await run_in_threadpool(
            dashboard_metrics_service.reset_projection_schema_if_needed,
        )
        await run_in_threadpool(
            dashboard_metrics_service.sync_from_log_service,
            log_service,
        )
        summary = await run_in_threadpool(dashboard_metrics_service.summary, time_range)
        summary["runtime"] = await run_in_threadpool(runtime_snapshot)
        return summary
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail={"error": "statistics projection is unavailable"},
        ) from exc


@router.get("/api/proxy/view")
async def get_proxy_view(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _require_admin(authorization)
    view = await run_in_threadpool(proxy_management_service.view)
    return _proxy_payload(_redact_proxy_view(view))


@router.post("/api/proxy/defaults")
async def save_proxy_defaults(
    body: SafeProxyDefaultsPatch,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_admin(authorization)
    view = await run_in_threadpool(proxy_management_service.view)
    try:
        result = await run_in_threadpool(
            proxy_management_service.save_defaults,
            _restore_proxy_reference(body.default_reference, view.default_reference),
            _restore_proxy_reference(body.fallback_reference, view.fallback_reference)
            if body.fallback_reference is not None
            else None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": "proxy defaults are invalid"}) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail={"error": "proxy defaults could not be saved"}) from exc
    return _proxy_payload(_redact_proxy_defaults_mutation(result))


@router.post("/api/proxy/groups")
async def save_proxy_group(
    body: ProxyGroupPatch,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_admin(authorization)
    view = await run_in_threadpool(proxy_management_service.view)
    patch = _restore_proxy_group_patch(body, view)
    try:
        result = await run_in_threadpool(proxy_management_service.save_group, patch)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": proxy_group_error_text(exc)}) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail={"error": "proxy group could not be saved"}) from exc
    return _proxy_payload(_redact_proxy_group_mutation(result))


@router.delete("/api/proxy/groups/{group_id}")
async def delete_proxy_group(
    group_id: str,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_admin(authorization)
    try:
        result: ProxyGroupDeleteMutation = await run_in_threadpool(
            proxy_management_service.delete_group,
            group_id,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"error": "proxy group not found"}) from exc
    except ProxyGroupInUseError as exc:
        raise HTTPException(status_code=409, detail={"error": "proxy group is in use"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": proxy_group_error_text(exc)}) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail={"error": "proxy group could not be deleted"}) from exc
    return _proxy_payload(result)


@router.post("/api/proxy/nodes/import")
async def import_proxy_nodes(
    body: ProxyNodeImportPatch,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_admin(authorization)
    view = await run_in_threadpool(proxy_management_service.view)
    existing_urls = [node.url for group in view.groups for node in group.nodes]
    try:
        result = await run_in_threadpool(
            proxy_management_service.import_nodes,
            body.text,
            existing_urls,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": "proxy nodes could not be imported"}) from exc
    return _proxy_payload(result)


@router.post("/api/proxy/groups/test")
async def test_proxy_group(
    body: ProxyGroupTestPatch,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_admin(authorization)
    explicit_url = body.url.strip()
    if explicit_url:
        try:
            candidate = normalize_proxy_node_url(explicit_url)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail={"error": "proxy url is invalid"}) from exc
        result = await run_in_threadpool(test_proxy, candidate)
        return _proxy_payload(proxy_management_service.group_test_response([("", result)]))

    group_id = _proxy_group_id(body.id)
    if not group_id:
        raise HTTPException(status_code=400, detail={"error": "proxy group id is required"})
    groups = await run_in_threadpool(proxy_management_service.list_groups)
    group = next((item for item in groups.groups if item.id == group_id), None)
    if group is None:
        raise HTTPException(status_code=404, detail={"error": "proxy group not found"})
    node_id = body.node_id.strip()
    nodes = [
        node
        for node in group.nodes
        if node.enabled and node.url and (not node_id or node.id == node_id)
    ]
    if not nodes:
        raise HTTPException(status_code=400, detail={"error": "proxy group node url is required"})
    results = [
        (node.id, await run_in_threadpool(test_proxy, node.url))
        for node in nodes
    ]
    return _proxy_payload(proxy_management_service.group_test_response(results))


@router.get("/api/settings", response_model=SettingsView)
async def get_settings(authorization: str | None = Header(default=None)):
    _require_admin(authorization)
    return await run_in_threadpool(settings_management_service.view)


@router.patch("/api/settings", response_model=SettingsMutationResult)
async def patch_settings(
    body: SafeSettingsPatch, authorization: str | None = Header(default=None)
):
    _require_admin(authorization)
    payload = body.model_dump(exclude_unset=True)
    if any(value is None for value in payload.values()):
        raise HTTPException(status_code=422, detail={"error": "settings fields cannot be null"})
    try:
        source_patch = SettingsPatch.model_validate(payload)
        return await run_in_threadpool(settings_management_service.update, source_patch)
    except SettingsRevisionConflictError as exc:
        raise HTTPException(status_code=409, detail={"error": str(exc)}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc


@router.get("/api/model-catalog", response_model=ModelCatalogView)
async def model_catalog(authorization: str | None = Header(default=None)):
    require_identity(authorization)
    return await run_in_threadpool(get_model_catalog)


@router.get("/api/logs", response_model=CallSummaryPage)
async def get_logs(
    type: str = "",
    start_date: str = "",
    end_date: str = "",
    status: CallLogStatus = "",
    endpoint: str = "",
    model: str = "",
    account: str = "",
    conversation_id: str = "",
    search: str = "",
    limit: int = Query(default=200, ge=1, le=20_000),
    offset: int = Query(default=0, ge=0),
    authorization: str | None = Header(default=None),
):
    _require_admin(authorization)
    return await run_in_threadpool(
        log_service.list_page,
        type=type.strip(),
        start_date=start_date.strip(),
        end_date=end_date.strip(),
        status=status.strip(),
        endpoint=endpoint.strip(),
        model=model.strip(),
        account=account.strip(),
        conversation_id=conversation_id.strip(),
        search=search.strip(),
        limit=limit,
        offset=offset,
    )


@router.get("/api/logs/{log_id}", response_model=CallDetail)
async def get_log_detail(
    log_id: str, authorization: str | None = Header(default=None)
):
    _require_admin(authorization)
    detail = await run_in_threadpool(log_service.get_detail, log_id)
    if detail is None:
        raise HTTPException(status_code=404, detail={"error": "log not found"})
    return detail


class GenericProxyBindingPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str
    enabled: bool
    target: str = ""


@router.get("/api/proxy/generic-bindings")
async def get_generic_proxy_bindings(
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_admin(authorization)
    return await run_in_threadpool(proxy_management_service.generic_proxy_bindings)


@router.post("/api/proxy/generic-bindings")
async def save_generic_proxy_binding(
    body: GenericProxyBindingPatch,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_admin(authorization)
    try:
        return await run_in_threadpool(
            proxy_management_service.save_generic_proxy_binding,
            provider=body.provider,
            enabled=body.enabled,
            target=body.target,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": proxy_group_error_text(exc)}) from exc


class ProxyEgressResolvePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    group_id: str = ""
    node_id: str = ""


@router.post("/api/proxy/resolve-url")
async def resolve_proxy_egress_url(
    body: ProxyEgressResolvePatch,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_admin(authorization)
    try:
        proxy_url, group_id, node_id, image_concurrency_limit = await run_in_threadpool(
            proxy_settings.resolve_egress_url,
            body.group_id.strip(),
            body.node_id.strip(),
        )
    except ImageEgressDeadlineError as exc:
        raise HTTPException(status_code=503, detail={"error": str(exc)}) from exc
    except ValueError as exc:
        text = str(exc)
        if text.startswith("proxy group is unavailable: "):
            detail = f"代理组不存在或没有可用节点：{text.removeprefix('proxy group is unavailable: ')}"
        else:
            detail = "代理出口不可用，请检查通用代理分组与节点"
        raise HTTPException(status_code=409, detail={"error": detail}) from exc
    return {"proxy_url": proxy_url, "group_id": group_id, "node_id": node_id, "image_concurrency_limit": image_concurrency_limit}


@router.get("/api/generic-proxy/logs")
async def get_generic_proxy_logs(
    limit: int = Query(default=200, ge=1, le=20_000),
    offset: int = Query(default=0, ge=0),
    authorization: str | None = Header(default=None),
):
    _require_admin(authorization)
    return await run_in_threadpool(
        log_service.list_proxy_page,
        limit=limit,
        offset=offset,
    )


@router.get("/images/{image_path:path}", include_in_schema=False)
async def get_image(image_path: str):
    return get_image_response(image_path)


@router.get("/image-thumbnails/{image_path:path}", include_in_schema=False)
async def get_image_thumbnail(image_path: str):
    return get_thumbnail_response(image_path)
