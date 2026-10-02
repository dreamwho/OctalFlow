"""视频生成任务路由：dola 风格 create/poll/media 契约。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from geminivids_api.api.schemas import VideoCreateRequest
from geminivids_api.api.dependencies import require_api_key
from geminivids_api.param_slots import InvalidVideoParams

from .state import runtime_state

router = APIRouter(prefix="/v1/videos", tags=["videos"],
                   dependencies=[Depends(require_api_key)])


def _service():
    if runtime_state.videos is None:
        raise HTTPException(503, "video service not ready")
    return runtime_state.videos


@router.post("")
def create_video(payload: VideoCreateRequest):
    try:
        return _service().submit(
            prompt=payload.prompt,
            aspect_ratio=payload.aspect_ratio,
            resolution=payload.resolution,
            duration_seconds=payload.duration_seconds,
            reference_images=payload.images,
        )
    except InvalidVideoParams as exc:
        raise HTTPException(400, detail={"message": str(exc)}) from None


@router.get("")
def list_videos(limit: int = 50, offset: int = 0):
    service = _service()
    return [service._task_view(t) for t in service.tasks.list(limit=min(limit, 200),
                                                              offset=offset)]


@router.get("/{video_id}")
def get_video(video_id: str):
    view = _service().task_view(video_id)
    if not view:
        raise HTTPException(404, detail={"message": "video task not found"})
    return view


@router.get("/{video_id}/media")
def get_video_media(video_id: str):
    path = _service().tasks.media_file(video_id)
    if not path:
        raise HTTPException(404, detail={"message": "media not ready"})
    return FileResponse(path, media_type="video/mp4", filename=f"{video_id}.mp4")


@router.get("/{video_id}/content")
def get_video_content(video_id: str):
    """与 /media 等价；/content 后缀对齐站内系统代理的查询路径模板。"""
    return get_video_media(video_id)


@router.delete("/{video_id}")
def delete_video(video_id: str):
    if not _service().tasks.delete(video_id):
        raise HTTPException(404, detail={"message": "video task not found"})
    return {"ok": True}
