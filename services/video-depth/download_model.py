#!/usr/bin/env python3
"""Download the pinned Depth Anything V2 Small checkpoint for local inference."""

from __future__ import annotations

import os
from pathlib import Path

from huggingface_hub import snapshot_download


snapshot_download(
    repo_id="depth-anything/Depth-Anything-V2-Small-hf",
    revision=os.environ.get("OCTALAICANVAS_VIDEO_DEPTH_MODEL_REVISION", "5426e4f0f36572d16453bbda7a8389317b1bef99"),
    local_dir=os.environ.get("OCTALAICANVAS_VIDEO_DEPTH_MODEL", str(Path(__file__).resolve().parent / "models" / "depth-anything-v2-small-hf")),
    allow_patterns=["config.json", "preprocessor_config.json", "model.safetensors", "README.md", "LICENSE"],
)
