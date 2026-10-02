"""API schemas for GeminiVids sidecar."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

AspectRatio = Literal["16:9", "9:16"]
Resolution = Literal["720p", "1080p"]


class VideoCreateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=8000)
    aspect_ratio: AspectRatio = "16:9"
    resolution: Resolution = "720p"
    duration_seconds: int = Field(default=10, ge=4, le=10)
    # 参考图：data:image/...;base64 或 http(s) URL，按顺序作为“图片 1..N”素材
    images: list[str] = Field(default_factory=list, max_length=8)


class ImportCookiesRequest(BaseModel):
    cookies: str = Field(min_length=10)
    name: str | None = None
    email: str | None = None
    vids_doc_id: str | None = None


class ImportStorageStateRequest(BaseModel):
    storage_state: dict = Field(...)
    name: str | None = None
    email: str | None = None
    vids_doc_id: str | None = None


class UpdateAccountRequest(BaseModel):
    name: str | None = None
    vids_doc_id: str | None = None
    status: Literal["active", "invalid"] | None = None


class RuntimeProxyPayload(BaseModel):
    proxy_url: str
