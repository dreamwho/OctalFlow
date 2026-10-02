"""视频生成任务存储与执行（内存 + data/tasks 落盘）。"""

from __future__ import annotations

import json
import secrets
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable


@dataclass
class VideoTask:
    id: str
    prompt: str
    aspect_ratio: str  # "16:9" | "9:16"
    resolution: str  # "720p" | "1080p"
    duration_seconds: int
    account_id: str | None = None
    status: str = "processing"  # processing | succeeded | failed
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    elapsed_seconds: float | None = None
    media_path: str | None = None
    media_size: int | None = None
    result_width: int | None = None
    result_height: int | None = None
    result_duration: int | None = None
    storage_key: str | None = None
    upstream_url: str | None = None
    param_slots: list[Any] | None = None
    reference_images: list[str] | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> VideoTask:
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in data.items() if k in known})


class TaskStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.media_dir = self.root / "media"
        self.media_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._tasks: dict[str, VideoTask] = {}
        self._load_all()

    def _task_path(self, task_id: str) -> Path:
        return self.root / f"{task_id}.json"

    def _load_all(self) -> None:
        for path in self.root.glob("vt_*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                task = VideoTask.from_dict(data)
                if task.status == "processing":
                    # 服务重启导致的长请求丢失：显式失败，允许上层重试
                    task.status = "failed"
                    task.error = "sidecar restarted during generation"
                    task.finished_at = time.time()
                    self._persist(task)
                self._tasks[task.id] = task
            except (OSError, ValueError, TypeError):
                continue

    def _persist(self, task: VideoTask) -> None:
        path = self._task_path(task.id)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(task.to_dict(), ensure_ascii=False, indent=1),
                       encoding="utf-8")
        tmp.replace(path)

    def create(self, prompt: str, aspect_ratio: str, resolution: str,
               duration_seconds: int, param_slots: list[Any] | None = None,
               reference_images: list[str] | None = None) -> VideoTask:
        task = VideoTask(
            id=f"vt_{secrets.token_hex(8)}",
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            resolution=resolution,
            duration_seconds=duration_seconds,
            param_slots=param_slots,
            reference_images=reference_images or None,
        )
        with self._lock:
            self._tasks[task.id] = task
            self._persist(task)
        return task

    def get(self, task_id: str) -> VideoTask | None:
        with self._lock:
            return self._tasks.get(task_id)

    def list(self, limit: int = 50, offset: int = 0) -> list[VideoTask]:
        with self._lock:
            items = sorted(self._tasks.values(), key=lambda t: t.created_at, reverse=True)
            return items[offset:offset + limit]

    def update(self, task_id: str, mutate: Callable[[VideoTask], None]) -> VideoTask | None:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return None
            mutate(task)
            task.updated_at = time.time()
            self._persist(task)
            return task

    def delete(self, task_id: str) -> bool:
        with self._lock:
            task = self._tasks.pop(task_id, None)
            if not task:
                return False
        path = self._task_path(task_id)
        path.unlink(missing_ok=True)
        if task.media_path:
            Path(task.media_path).unlink(missing_ok=True)
        return True

    def media_file(self, task_id: str) -> Path | None:
        task = self.get(task_id)
        if not task or not task.media_path:
            return None
        path = Path(task.media_path)
        return path if path.is_file() else None

    def new_media_path(self, task_id: str) -> Path:
        return self.media_dir / f"{task_id}.mp4"
