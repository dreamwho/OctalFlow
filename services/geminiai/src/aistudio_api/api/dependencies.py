"""Shared FastAPI dependencies."""

from __future__ import annotations

from fastapi import HTTPException, Request, Response

from aistudio_api.config import settings
from aistudio_api.application.api_service_common import current_request_account

from aistudio_api.infrastructure.gateway.client import AIStudioClient

from .state import runtime_state


def _extract_request_token(request: Request) -> str | None:
    api_key = (request.headers.get("x-api-key") or "").strip()
    if api_key:
        return api_key

    authorization = (request.headers.get("authorization") or "").strip()
    if not authorization:
        return None

    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer":
        return None

    token = token.strip()
    return token or None


def require_api_key(request: Request) -> None:
    if not settings.auth_enabled:
        return

    token = _extract_request_token(request)
    if token in settings.api_keys:
        return

    raise HTTPException(
        status_code=401,
        detail={"message": "Invalid or missing API key", "type": "authentication_error"},
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_client() -> AIStudioClient:
    if runtime_state.client is None:
        raise HTTPException(503, detail={"message": "Client not initialized", "type": "service_unavailable"})
    return runtime_state.client


def get_busy_lock():
    if runtime_state.busy_lock is None:
        raise HTTPException(503, detail={"message": "Server not ready", "type": "service_unavailable"})
    return runtime_state.busy_lock


def get_account_service():
    if runtime_state.account_service is None:
        raise HTTPException(503, detail={"message": "Account service not initialized", "type": "service_unavailable"})
    return runtime_state.account_service


def get_runtime_state():
    return runtime_state


def set_active_account_headers(response: Response) -> None:
    """Attach the account used by the completed request to its response.

    The Next.js request logger runs after the sidecar response arrives.  It
    must not make a second `/accounts/active` call because a following request
    may already have rotated the shared browser to another account.
    """
    remembered = current_request_account()
    if remembered is None:
        account_service = runtime_state.account_service
        account = account_service.get_active_account() if account_service else None
        remembered = (account.id, account.email) if account is not None else None
    if remembered is None:
        return
    account_id, account_email = remembered
    response.headers["X-AIStudio-Account-Id"] = account_id
    if account_email:
        response.headers["X-AIStudio-Account-Email"] = account_email
