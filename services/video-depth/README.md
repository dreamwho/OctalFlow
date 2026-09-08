# 视频深度运行模块

该模块使用 Depth Anything V2 Small 将视频逐帧转换为灰白单目深度图，再由服务端保留原帧率并重新编码为 H.264 视频。它不依赖独立 Docker 服务，但运行机器必须已有 FFmpeg 和 Python 3。

## 本地准备

```bash
services/video-depth/setup_runtime.sh
```

脚本会在项目内创建隔离的 `.venv`、安装依赖并下载固定版本模型。服务端默认使用该虚拟环境，无需再配置环境变量。若系统默认 Python 不兼容，可把 Python 3.10–3.13 的解释器路径作为第一个参数传入，例如 `services/video-depth/setup_runtime.sh python3.12`。

脚本与模型默认从以下项目内路径读取：

- `services/video-depth/infer_depth_frames.py`
- `services/video-depth/models/depth-anything-v2-small-hf`

如需放到其他目录，可分别设置 `OCTALAICANVAS_VIDEO_DEPTH_PYTHON`、`OCTALAICANVAS_VIDEO_DEPTH_SCRIPT` 和 `OCTALAICANVAS_VIDEO_DEPTH_MODEL`。模型下载固定到 `5426e4f0f36572d16453bbda7a8389317b1bef99` 修订版本。
