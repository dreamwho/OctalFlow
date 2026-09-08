#!/usr/bin/env python3
"""Generate temporally stable grayscale depth frames with Depth Anything V2."""

from __future__ import annotations

import argparse
import os
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert decoded video frames to grayscale monocular depth maps")
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--model-dir", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    input_dir = Path(args.input_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    model_dir = Path(args.model_dir).resolve()
    if not input_dir.is_dir() or not model_dir.is_dir():
        raise SystemExit("input frames or depth model directory does not exist")
    frames = sorted(path for path in input_dir.iterdir() if path.is_file() and path.suffix.lower() in {".png", ".jpg", ".jpeg"})
    if not frames:
        raise SystemExit("no decoded video frames were found")
    output_dir.mkdir(parents=True, exist_ok=True)

    import torch
    import torch.nn.functional as functional
    from PIL import Image
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation

    torch.set_num_threads(max(1, int(os.environ.get("OCTALAICANVAS_VIDEO_DEPTH_THREADS", "2"))))
    processor = AutoImageProcessor.from_pretrained(model_dir, local_files_only=True)
    model = AutoModelForDepthEstimation.from_pretrained(model_dir, local_files_only=True).eval()
    low_ema: float | None = None
    high_ema: float | None = None

    with torch.inference_mode():
        for completed, frame_path in enumerate(frames, start=1):
            with Image.open(frame_path) as source:
                image = source.convert("RGB")
            inputs = processor(images=image, return_tensors="pt")
            prediction = model(**inputs).predicted_depth
            prediction = functional.interpolate(prediction.unsqueeze(1), size=(image.height, image.width), mode="bicubic", align_corners=False)[0, 0].float()
            low = float(torch.quantile(prediction, 0.02))
            high = float(torch.quantile(prediction, 0.98))
            low_ema = low if low_ema is None else low_ema * 0.9 + low * 0.1
            high_ema = high if high_ema is None else high_ema * 0.9 + high * 0.1
            scale = max(high_ema - low_ema, 1e-6)
            normalized = ((prediction - low_ema) / scale).clamp(0, 1).mul(255).to(torch.uint8).cpu().numpy()
            Image.fromarray(normalized).save(output_dir / f"{frame_path.stem}.png", optimize=True)
            print(json.dumps({"completed": completed, "total": len(frames)}), flush=True)


if __name__ == "__main__":
    main()
