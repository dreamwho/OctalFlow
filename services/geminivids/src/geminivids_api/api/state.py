"""Runtime state container for the GeminiVids sidecar."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from geminivids_api.application.video_service import VideoService
from geminivids_api.infrastructure.account_store import AccountStore
from geminivids_api.infrastructure.task_store import TaskStore


@dataclass
class RuntimeState:
    accounts: Optional[AccountStore] = None
    tasks: Optional[TaskStore] = None
    videos: Optional[VideoService] = None


runtime_state = RuntimeState()
