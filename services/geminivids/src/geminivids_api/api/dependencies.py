"""Shared FastAPI dependencies."""

from __future__ import annotations

from fastapi import HTTPException, Request

from geminivids_api.config import settings


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
    return token.strip() or None


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
