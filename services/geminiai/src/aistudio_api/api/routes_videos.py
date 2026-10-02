"""Gemini Omni 视频任务路由：/v1/videos 契约与 geminivids sidecar 对齐。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .dependencies import require_api_key
from .state import runtime_state

router = APIRouter(prefix="/v1/videos", tags=["videos"], dependencies=[Depends(require_api_key)])


class VideoCreateRequest(BaseModel):
    model: str = "gemini-omni-1.1-flash"
    prompt: str = Field(min_length=1, max_length=8000)
    duration_seconds: int = Field(default=10, ge=3, le=10)
    resolution: str = ""
    aspect_ratio: str = "auto"
    images: list[str] = Field(default_factory=list, max_length=4)


def _service():
    service = getattr(runtime_state, "omni_videos", None)
    if service is None:
        raise HTTPException(503, detail={"message": "video service not ready"})
    return service


@router.post("")
def create_video(payload: VideoCreateRequest):
    try:
        return _service().submit(
            model=payload.model,
            prompt=payload.prompt,
            duration=payload.duration_seconds,
            resolution=payload.resolution,
            aspect=payload.aspect_ratio,
            reference_images=payload.images,
        )
    except ValueError as exc:
        raise HTTPException(400, detail={"message": str(exc)}) from None


@router.get("")
def list_videos(limit: int = 50, offset: int = 0):
    service = _service()
    tasks = sorted(service.tasks._tasks.values(), key=lambda t: t.created_at, reverse=True)
    return [service._view(t) for t in tasks[offset : offset + min(limit, 200)]]


@router.get("/{video_id}")
def get_video(video_id: str):
    view = _service().task_view(video_id)
    if not view:
        raise HTTPException(404, detail={"message": "video task not found"})
    return view


@router.get("/{video_id}/media")
@router.get("/{video_id}/content")
def get_video_media(video_id: str):
    path = _service().tasks.media_file(video_id)
    if not path:
        raise HTTPException(404, detail={"message": "media not ready"})
    return FileResponse(path, media_type="video/mp4", filename=f"{video_id}.mp4")


@router.delete("/{video_id}")
def delete_video(video_id: str):
    if not _service().tasks.delete(video_id):
        raise HTTPException(404, detail={"message": "video task not found"})
    return {"ok": True}
