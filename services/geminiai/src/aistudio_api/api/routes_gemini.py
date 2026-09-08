"""Gemini-compatible API routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response

from aistudio_api.application.api_service import handle_gemini_generate_content
from aistudio_api.api.response_models import GeminiGenerateContentResponse
from aistudio_api.infrastructure.gateway.client import AIStudioClient

from .dependencies import get_client, set_active_account_headers
from .schemas import GeminiGenerateContentRequest

router = APIRouter()


@router.post("/v1beta/{model_path:path}:generateContent", response_model=GeminiGenerateContentResponse)
async def generate_content(
    model_path: str,
    req: GeminiGenerateContentRequest,
    response: Response,
    client: AIStudioClient = Depends(get_client),
):
    result = await handle_gemini_generate_content(model_path, req, client, stream=False)
    set_active_account_headers(response)
    return result


@router.post("/v1beta/{model_path:path}:streamGenerateContent")
async def stream_generate_content(
    model_path: str,
    req: GeminiGenerateContentRequest,
    response: Response,
    client: AIStudioClient = Depends(get_client),
):
    result = await handle_gemini_generate_content(model_path, req, client, stream=True)
    set_active_account_headers(response)
    return result
