"""FastAPI app wiring for the GeminiVids sidecar."""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

from geminivids_api.api import routes_accounts, routes_system, routes_videos
from geminivids_api.api.state import runtime_state
from geminivids_api.application.video_service import VideoService
from geminivids_api.config import settings
from geminivids_api.infrastructure.account_store import AccountStore
from geminivids_api.infrastructure.task_store import TaskStore


def _resolve_data_root() -> Path:
    env = os.getenv("GVIDS_DATA_DIR")
    if env:
        return Path(env)
    for candidate in (Path.cwd() / "data", Path(__file__).resolve().parents[3] / "data"):
        if candidate.is_dir():
            return candidate
    return Path.cwd() / "data"


@asynccontextmanager
async def lifespan(app: FastAPI):
    data_root = _resolve_data_root()
    accounts_dir = Path(settings.accounts_dir) if settings.accounts_dir else data_root / "accounts"
    tasks_dir = data_root / "tasks"
    runtime_state.accounts = AccountStore(accounts_dir)
    runtime_state.tasks = TaskStore(tasks_dir)
    runtime_state.videos = VideoService(runtime_state.accounts, runtime_state.tasks)
    yield
    runtime_state.videos = None
    runtime_state.tasks = None
    runtime_state.accounts = None


app = FastAPI(title="GeminiVids API", version="0.1.0", lifespan=lifespan)
app.include_router(routes_system.public_router)
app.include_router(routes_system.protected_router)
app.include_router(routes_accounts.router)
app.include_router(routes_videos.router)


@app.get("/")
def root():
    return {"service": "geminivids", "docs": "/docs", "health": "/health"}
