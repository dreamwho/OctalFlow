"""Private HTTP control plane for the traffic relay."""
from __future__ import annotations

import os
import secrets
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field

from .core import PinnedTarget, TrafficContext, TrafficMeter, TrafficMeterValidationError


class LeaseRequest(BaseModel):
    proxyUrl: str | None = None
    context: dict[str, Any]
    pinnedTargets: list[dict[str, Any]] = Field(default_factory=list)


class RequestTrafficQuery(BaseModel):
    requestIds: list[str] = Field(default_factory=list)
    taskIds: list[str] = Field(default_factory=list)


def create_app(meter: TrafficMeter | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        current = meter or TrafficMeter.from_environment()
        app.state.traffic_meter = current
        try:
            yield
        finally:
            await current.close()

    app = FastAPI(title="dreamyo traffic meter", lifespan=lifespan)

    async def require_key(x_traffic_key: str | None = Header(default=None)) -> None:
        expected = os.getenv("TRAFFIC_METER_KEY", "").strip()
        if not expected:
            raise HTTPException(status_code=503, detail="traffic_meter_key_unconfigured")
        if not x_traffic_key or not secrets.compare_digest(x_traffic_key, expected):
            raise HTTPException(status_code=401, detail="traffic_meter_auth_required")

    def current_meter(request: Request) -> TrafficMeter:
        return request.app.state.traffic_meter

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "boundary": "计量服务到上游代理或目标站的 TCP 字节流（含代理握手与 TLS 记录）；不含 IP/TCP 包头、重传、DNS UDP、代理后续跳点，不等同 ISP 或供应商账单。"}

    @app.post("/internal/leases", dependencies=[Depends(require_key)])
    async def create_lease(body: LeaseRequest, request: Request) -> dict[str, str]:
        try:
            context = TrafficContext.from_mapping(body.context)
            pins = [PinnedTarget.from_mapping(item) for item in body.pinnedTargets]
            lease_id, proxy_url = await current_meter(request).create_lease(body.proxyUrl, context, pins)
            return {"leaseId": lease_id, "proxyUrl": proxy_url}
        except TrafficMeterValidationError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @app.delete("/internal/leases/{lease_id}", dependencies=[Depends(require_key)])
    async def release_lease(lease_id: str, request: Request) -> dict[str, bool]:
        return {"released": await current_meter(request).release(lease_id)}

    @app.get("/internal/traffic", dependencies=[Depends(require_key)])
    async def query_traffic(
        request: Request,
        start: str,
        end: str,
        channelId: str | None = None,
        model: str | None = None,
        protocol: str | None = None,
        connectionMode: str | None = None,
        port: int | None = None,
        requestId: str | None = None,
        taskId: str | None = None,
        attemptId: str | None = None,
    ) -> dict[str, Any]:
        try:
            return current_meter(request).query(
                start,
                end,
                channel_id=channelId,
                model=model,
                protocol=protocol,
                connection_mode=connectionMode,
                port=port,
                request_id=requestId,
                task_id=taskId,
                attempt_id=attemptId,
            )
        except TrafficMeterValidationError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.get("/internal/traffic/tasks", dependencies=[Depends(require_key)])
    async def query_task_traffic(
        request: Request,
        start: str | None = None,
        end: str | None = None,
        channelId: str | None = None,
        model: str | None = None,
        protocol: str | None = None,
        connectionMode: str | None = None,
        port: int | None = None,
        requestId: str | None = None,
        taskId: str | None = None,
        attemptId: str | None = None,
        page: int = 1,
        pageSize: int = 20,
    ) -> dict[str, Any]:
        try:
            return current_meter(request).query_tasks(
                start=start,
                end=end,
                channel_id=channelId,
                model=model,
                protocol=protocol,
                connection_mode=connectionMode,
                port=port,
                request_id=requestId,
                task_id=taskId,
                attempt_id=attemptId,
                page=page,
                page_size=pageSize,
            )
        except TrafficMeterValidationError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post("/internal/traffic/requests", dependencies=[Depends(require_key)])
    async def query_request_traffic(body: RequestTrafficQuery, request: Request) -> dict[str, Any]:
        try:
            return current_meter(request).query_requests(body.requestIds, task_ids=body.taskIds)
        except TrafficMeterValidationError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    return app


app = create_app()


def main() -> None:
    import uvicorn

    try:
        port = int(os.getenv("TRAFFIC_METER_PORT", "18083"))
    except ValueError as error:
        raise RuntimeError("traffic_meter_port_invalid") from error
    # The private control plane and ephemeral relay listeners share the same
    # deployment boundary: Compose uses 0.0.0.0 on its private network, while
    # standalone/local runtime selects 127.0.0.1.
    host = os.getenv("TRAFFIC_METER_BIND_HOST", "0.0.0.0").strip() or "0.0.0.0"
    uvicorn.run("traffic_meter.main:app", host=host, port=port)
