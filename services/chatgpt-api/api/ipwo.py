"""Admin-only IPWO proxy-source configuration and explicit diagnostics."""

from __future__ import annotations

import json
from typing import Literal

from fastapi import APIRouter, Header, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from api.support import require_admin
from services.ipwo_proxy_service import (
    IpwoProxyConfigurationError,
    IpwoProxyError,
    ipwo_proxy_service,
)


router = APIRouter()


class IpwoSettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    api_url: str | None = None
    protocol: Literal["http", "socks5"]
    regions: str
    timeout_seconds: int = Field(ge=1)


def _configuration_error(error: IpwoProxyError) -> HTTPException:
    return HTTPException(status_code=422, detail={"error": error.public_message})


@router.get("/integration/ipwo")
async def get_ipwo(authorization: str | None = Header(default=None)) -> dict[str, object]:
    require_admin(authorization)
    try:
        return await run_in_threadpool(ipwo_proxy_service.view)
    except Exception as exc:
        raise HTTPException(status_code=503, detail={"error": "IPWO 配置暂时不可用"}) from exc


@router.patch("/integration/ipwo")
async def patch_ipwo(
    body: IpwoSettingsPatch,
    authorization: str | None = Header(default=None),
) -> dict[str, object]:
    require_admin(authorization)
    try:
        return await run_in_threadpool(
            ipwo_proxy_service.save_settings,
            api_url=body.api_url,
            protocol=body.protocol,
            regions=body.regions,
            timeout_seconds=body.timeout_seconds,
        )
    except IpwoProxyConfigurationError as exc:
        raise _configuration_error(exc) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail={"error": "IPWO 配置保存失败"}) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail={"error": "IPWO 配置保存失败"}) from exc


def _ndjson_events():
    try:
        for event in ipwo_proxy_service.diagnostic_events():
            yield json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"
    except Exception:
        yield json.dumps({
            "stage": "configuration",
            "status": "error",
            "message": "IPWO 诊断中断",
            "elapsed_ms": 0,
            "done": True,
        }, ensure_ascii=False, separators=(",", ":")) + "\n"


@router.post("/integration/ipwo/test")
async def test_ipwo(authorization: str | None = Header(default=None)) -> StreamingResponse:
    """Run an explicit temporary diagnostic; it never changes proxy runtime mode."""
    require_admin(authorization)
    return StreamingResponse(
        _ndjson_events(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
