"""OpenAI-compatible API routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile

from aistudio_api.application.api_service import handle_chat, handle_image_edit, handle_image_generation
from aistudio_api.api.response_models import (
    ImageGenerationResponse,
    ModelCardResponse,
    ModelListResponse,
    OpenAIChatCompletionResponse,
)
from aistudio_api.infrastructure.gateway.client import AIStudioClient

from .dependencies import get_client, set_active_account_headers
from .schemas import ChatRequest, ImageRequest
from aistudio_api.infrastructure.gateway.model_catalog import ModelDeclaration, find_model, list_catalog, save_declarations
from aistudio_api.application.api_service_common import account_request_lock

router = APIRouter()

@router.get("/v1/models", response_model=ModelListResponse)
async def list_models():
    return ModelListResponse(data=[ModelCardResponse(**model) for model in list_catalog()])


@router.post("/config/models", response_model=ModelListResponse)
async def add_model(payload: ModelDeclaration):
    try:
        return ModelListResponse(data=[ModelCardResponse(**model) for model in save_declarations([payload], origin="manual")])
    except ValueError as error:
        raise HTTPException(409, detail={"message": str(error), "type": "model_catalog_error"}) from error


@router.post("/config/models/sync", response_model=ModelListResponse)
async def sync_models(client: AIStudioClient = Depends(get_client)):
    try:
        async with account_request_lock():
            discovered = await client._session.discover_models()
        declarations = [ModelDeclaration(**model) for model in discovered]
        if not declarations:
            raise RuntimeError("AI Studio 未返回可用的文本或图片模型目录")
        return ModelListResponse(data=[ModelCardResponse(**model) for model in save_declarations(declarations, origin="aistudio")])
    except RuntimeError as error:
        raise HTTPException(502, detail={"message": str(error), "type": "model_catalog_error"}) from error


@router.get("/v1/models/{model_id:path}", response_model=ModelCardResponse)
async def get_model(model_id: str):
    model = find_model(model_id)
    if model:
        return ModelCardResponse(**model)
    raise HTTPException(status_code=404, detail={"message": f"Model '{model_id}' not found", "type": "invalid_request_error"})


@router.post("/v1/chat/completions", response_model=OpenAIChatCompletionResponse)
async def chat_completions(req: ChatRequest, response: Response, client: AIStudioClient = Depends(get_client)):
    result = await handle_chat(req, client)
    set_active_account_headers(response)
    return result


@router.post("/v1/images/generations", response_model=ImageGenerationResponse)
async def image_generations(req: ImageRequest, response: Response, client: AIStudioClient = Depends(get_client)):
    result = await handle_image_generation(req, client)
    set_active_account_headers(response)
    return result


@router.post("/v1/images/edits", response_model=ImageGenerationResponse)
async def image_edits(
    response: Response,
    prompt: str = Form(...),
    image: list[UploadFile] | None = File(None),
    mask: UploadFile | None = File(None),
    model: str = Form("gemini-3.1-flash-image"),
    n: int = Form(1),
    size: str = Form("1024x1024"),
    aspect_ratio: str | None = Form(None),
    image_size: str | None = Form(None),
    client: AIStudioClient = Depends(get_client),
):
    result = await handle_image_edit(
        prompt=prompt,
        image_files=image or [],
        mask_file=mask,
        model=model,
        n=n,
        size=size,
        aspect_ratio=aspect_ratio,
        image_size=image_size,
        client=client,
    )
    set_active_account_headers(response)
    return result
