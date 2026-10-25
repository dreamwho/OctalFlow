"""Persisted AI Studio model declarations; discovery never submits a prompt."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from threading import RLock

from pydantic import BaseModel, field_validator
from typing import Literal

from aistudio_api.infrastructure.account.account_store import _resolve_accounts_dir, _write_private_json

BUILT_IN_MODELS = [
    # Gemma 4 系列
    {"id": "gemma-4-31b-it", "object": "model", "created": 1700000000, "owned_by": "google"},
    {"id": "gemma-4-26b-a4b-it", "object": "model", "created": 1700000000, "owned_by": "google"},
    # Gemini 3 系列
    {"id": "gemini-3-flash-preview", "object": "model", "created": 1700000000, "owned_by": "google"},
    {"id": "gemini-3.5-flash", "object": "model", "created": 1700000000, "owned_by": "google"},
    {"id": "gemini-3.1-pro-preview", "object": "model", "created": 1700000000, "owned_by": "google"},
    {"id": "gemini-3.1-flash-lite", "object": "model", "created": 1700000000, "owned_by": "google"},
    {"id": "gemini-3.1-flash-image", "object": "model", "created": 1700000000, "owned_by": "google"},
    {"id": "gemini-nano-banana-2.1", "object": "model", "created": 1700000000, "owned_by": "google"},
    {"id": "gemini-3-pro-image", "object": "model", "created": 1700000000, "owned_by": "google"},
    # Gemini Omni 视频生成（AI Studio 页面自动化）
    {"id": "gemini-omni-1.1-flash", "object": "model", "created": 1700000000, "owned_by": "google"},
    {"id": "gemini-omni-flash-preview", "object": "model", "created": 1700000000, "owned_by": "google"},
    {"id": "gemini-3.1-flash-live-preview", "object": "model", "created": 1700000000, "owned_by": "google"},
    {"id": "gemini-3.1-flash-tts-preview", "object": "model", "created": 1700000000, "owned_by": "google"},
    # Gemini 2.5 系列
    {"id": "gemini-pro-latest", "object": "model", "created": 1700000000, "owned_by": "google"},
    {"id": "gemini-flash-latest", "object": "model", "created": 1700000000, "owned_by": "google"},
    {"id": "gemini-flash-lite-latest", "object": "model", "created": 1700000000, "owned_by": "google"},
]

_IMAGE_IDS = {"gemini-3.1-flash-image", "gemini-3-pro-image", "gemini-nano-banana-2.1"}
_lock = RLock()


class ModelDeclaration(BaseModel):
    id: str
    name: str = ""
    capability: Literal["text", "image"]

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        value = value.strip().removeprefix("models/")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", value):
            raise ValueError("模型 ID 只能包含字母、数字、点、下划线和连字符")
        if re.search(r"(?:^|[-_.])(omni|veo|audio|tts|speech|voice|music|sound|lyria|live)(?:$|[-_.])", value, re.I):
            raise ValueError("该模型需要独立的视频、音频或实时协议，不能作为文本或图片模型添加")
        return value

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        return value.strip()


def _path():
    return _resolve_accounts_dir() / "model-catalog.json"


def _stored():
    path = _path()
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"models": []}


def list_catalog() -> list[dict]:
    with _lock:
        entries = {model["id"]: {**model, "name": model["id"], "capability": "image" if model["id"] in _IMAGE_IDS else "text", "catalog_origin": "builtin"} for model in BUILT_IN_MODELS}
        entries.update({model["id"]: model for model in _stored()["models"]})
        return list(entries.values())


def find_model(model_id: str) -> dict | None:
    normalized = model_id.removeprefix("models/")
    return next((model for model in list_catalog() if model["id"] == normalized), None)


def save_declarations(models: list[ModelDeclaration], *, origin: str) -> list[dict]:
    with _lock:
        stored = _stored()
        entries = {model["id"]: model for model in stored["models"]}
        if origin == "manual" and any(find_model(model.id) for model in models):
            raise ValueError("模型已存在，请在目录中选择或测试该模型")
        for declaration in models:
            previous = entries.get(declaration.id)
            if origin == "aistudio" and previous and previous["catalog_origin"] == "manual":
                continue
            entries[declaration.id] = {**declaration.model_dump(), "name": declaration.name or declaration.id, "object": "model", "created": int(datetime.now(timezone.utc).timestamp()), "owned_by": "google", "catalog_origin": origin}
        _write_private_json(_path(), {"models": list(entries.values())})
        return list_catalog()
