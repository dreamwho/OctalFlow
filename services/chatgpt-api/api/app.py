"""The restricted provider application.

The upstream application factory intentionally is not used: it starts account
watchers, cleanup, backups, and UI/static routes that are outside this runtime.
"""

from __future__ import annotations

import hmac
from collections.abc import Iterable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

from services.internal_runtime import initialize_runtime_environment, runtime_key


initialize_runtime_environment()

from api.accounts import create_router as create_accounts_router
from api.ai import create_router as create_openai_router
from api.integration import gateway_enabled, router as integration_router
from api.ipwo import router as ipwo_router


_ALLOWED_SOURCE_ROUTES: set[tuple[str, str]] = {
    ("/api/auth/users", "GET"),
    ("/api/auth/users", "POST"),
    ("/api/auth/users/{key_id}", "POST"),
    ("/api/auth/users/{key_id}", "DELETE"),
    ("/api/accounts", "GET"),
    ("/api/accounts", "POST"),
    ("/api/accounts", "DELETE"),
    ("/api/accounts/update", "POST"),
    ("/api/accounts/batch-update", "POST"),
    ("/api/accounts/refresh-access-token", "POST"),
    ("/api/accounts/sync", "POST"),
    ("/api/accounts/refresh", "POST"),
    ("/api/accounts/operations/{progress_id}", "GET"),
    ("/api/accounts/refresh/progress/{progress_id}", "GET"),
    ("/v1/models", "GET"),
    ("/v1/chat/completions", "POST"),
    ("/v1/responses", "POST"),
    ("/v1/images/generations", "POST"),
    ("/v1/images/edits", "POST"),
}
_INTERNAL_DISPATCH_HEADER = "x-octal-internal-dispatch"


def _is_trusted_internal_dispatch(request: Request, expected_runtime_key: str) -> bool:
    return (
        hmac.compare_digest(request.headers.get(_INTERNAL_DISPATCH_HEADER, ""), "1")
        and hmac.compare_digest(
            request.headers.get("authorization", ""),
            f"Bearer {expected_runtime_key}",
        )
    )


def _add_allowlisted_source_routes(
    app: FastAPI, source_routes: Iterable[object]
) -> None:
    for route in source_routes:
        if not isinstance(route, APIRoute):
            continue
        methods = route.methods or set()
        if methods and all((route.path, method) in _ALLOWED_SOURCE_ROUTES for method in methods):
            app.router.routes.append(route)


def create_app() -> FastAPI:
    app = FastAPI(
        title="Octal Canvas internal ChatGPT provider",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.middleware("http")
    async def runtime_guard(request: Request, call_next):
        supplied = request.headers.get("x-octal-runtime-key", "")
        expected_runtime_key = runtime_key()
        if not supplied or not hmac.compare_digest(supplied, expected_runtime_key):
            return JSONResponse(
                status_code=401,
                content={"detail": {"error": "x-octal-runtime-key is required"}},
            )
        if (
            request.url.path.startswith("/v1/")
            or request.url.path.startswith("/images/")
            or request.url.path.startswith("/image-thumbnails/")
        ) and not gateway_enabled() and not _is_trusted_internal_dispatch(
            request,
            expected_runtime_key,
        ):
            return JSONResponse(
                status_code=503,
                content={"detail": {"error": "ChatGPT gateway is disabled"}},
            )
        return await call_next(request)

    _add_allowlisted_source_routes(app, create_accounts_router().routes)
    _add_allowlisted_source_routes(app, create_openai_router().routes)
    app.include_router(integration_router)
    app.include_router(ipwo_router)
    return app
