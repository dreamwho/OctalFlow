"""系统路由：health / stats / runtime proxy。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from geminivids_api.api.schemas import RuntimeProxyPayload
from geminivids_api.config import settings
from geminivids_api.api.dependencies import require_api_key

from .state import runtime_state

public_router = APIRouter(tags=["system"])
protected_router = APIRouter(tags=["system"], dependencies=[Depends(require_api_key)])


@public_router.get("/health")
def health():
    accounts = runtime_state.accounts
    account_count = len(accounts.list_accounts()) if accounts else 0
    return {
        "status": "ok",
        "service": "geminivids",
        "accounts": account_count,
        "proxy": bool(settings.proxy_url),
    }


@protected_router.get("/stats")
def stats():
    tasks = runtime_state.tasks
    if not tasks:
        raise HTTPException(503, "task store not ready")
    items = tasks.list(limit=1000)
    return {
        "total": len(items),
        "succeeded": sum(1 for t in items if t.status == "succeeded"),
        "failed": sum(1 for t in items if t.status == "failed"),
        "processing": sum(1 for t in items if t.status == "processing"),
    }


@protected_router.get("/runtime/proxy")
def get_runtime_proxy():
    return {"ok": True, "proxy_url": settings.proxy_url or ""}


@protected_router.post("/runtime/proxy")
def set_runtime_proxy(payload: RuntimeProxyPayload):
    url = payload.proxy_url.strip()
    if not url.startswith(("http://", "https://", "socks5://", "socks4://")):
        raise HTTPException(400, detail={
            "message": "proxy_url must be http(s):// or socks5:// scheme"})
    settings.proxy_url = url or None
    return {"ok": True, "proxy_url": settings.proxy_url}
