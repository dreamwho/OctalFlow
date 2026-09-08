# Video depth runtime notices

The project uses `depth-anything/Depth-Anything-V2-Small-hf` at revision
`5426e4f0f36572d16453bbda7a8389317b1bef99` for monocular depth estimation.
Run `download_model.py` after installing `requirements.txt`; by default the
checkpoint is stored under `services/video-depth/models/`. The three
`OCTALAICANVAS_VIDEO_DEPTH_*` environment variables can point to a different
Python interpreter, inference script, or model directory.

Depth Anything V2 Small is distributed under the Apache License 2.0. The model
card and repository license files are downloaded with the pinned model.

Runtime inference uses PyTorch, TorchVision, Hugging Face Transformers, and
Pillow under their respective upstream licenses.
