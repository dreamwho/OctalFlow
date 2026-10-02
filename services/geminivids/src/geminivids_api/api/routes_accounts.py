"""账号管理路由（对齐 geminiai 契约 + vids 扩展字段）。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from geminivids_api.api.schemas import (
    ImportCookiesRequest,
    ImportStorageStateRequest,
    UpdateAccountRequest,
)
from geminivids_api.api.dependencies import require_api_key
from geminivids_api.infrastructure.account_store import (
    parse_cookie_string_to_storage_state,
)

from .state import runtime_state

router = APIRouter(prefix="/accounts", tags=["accounts"],
                   dependencies=[Depends(require_api_key)])


def _store():
    if runtime_state.accounts is None:
        raise HTTPException(503, "account store not ready")
    return runtime_state.accounts


@router.get("")
def list_accounts():
    return [m.to_dict() for m in _store().list_accounts()]


@router.get("/active")
def get_active_account():
    meta = _store().get_active_account()
    if not meta:
        raise HTTPException(404, detail={"message": "no active account"})
    return meta.to_dict()


@router.post("/{account_id}/activate")
def activate_account(account_id: str):
    try:
        meta = _store().set_active_account(account_id)
    except KeyError:
        raise HTTPException(404, detail={"message": "account not found"}) from None
    return meta.to_dict()


@router.delete("/{account_id}")
def delete_account(account_id: str):
    if not _store().delete_account(account_id):
        raise HTTPException(404, detail={"message": "account not found"})
    return {"ok": True}


@router.put("/{account_id}")
def update_account(account_id: str, payload: UpdateAccountRequest):
    try:
        meta = _store().update_account(
            account_id,
            name=payload.name,
            vids_doc_id=payload.vids_doc_id,
            status=payload.status,
        )
    except KeyError:
        raise HTTPException(404, detail={"message": "account not found"}) from None
    return meta.to_dict()


@router.post("/import-cookies")
def import_cookies(payload: ImportCookiesRequest):
    try:
        state = parse_cookie_string_to_storage_state(payload.cookies)
    except ValueError as exc:
        raise HTTPException(400, detail={"message": str(exc)}) from None
    meta = _store().save_account(
        payload.name or payload.email or "imported",
        state,
        email=payload.email,
        vids_doc_id=payload.vids_doc_id,
    )
    return {
        "account_id": meta.id,
        "name": meta.name,
        "email": meta.email,
        "cookie_count": len(state["cookies"]),
        "vids_doc_id": meta.vids_doc_id,
    }


@router.post("/import-storage-state")
def import_storage_state(payload: ImportStorageStateRequest):
    state = payload.storage_state
    cookies = state.get("cookies") or []
    if not any(c.get("name") in ("SID", "SAPISID") and
               c.get("domain", "").endswith("google.com") for c in cookies):
        raise HTTPException(400, detail={
            "message": "storage_state lacks .google.com SID/SAPISID cookies"})
    meta = _store().save_account(
        payload.name or payload.email or "imported",
        state,
        email=payload.email,
        vids_doc_id=payload.vids_doc_id,
    )
    return {
        "account_id": meta.id,
        "name": meta.name,
        "email": meta.email,
        "cookie_count": len(cookies),
        "vids_doc_id": meta.vids_doc_id,
    }
