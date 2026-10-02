"""生成参数 -> 协议槽位映射。

槽位布局（实测 2026-10-01，Omni 文生视频）：
    slots = [p0, p1, None, p3, p4, None, None, None, duration]
基线（720p / 横屏 16:9 / 10s）= [0, 12, None, 0, 1, None, None, None, 10]
响应以 width/height/duration 为事实基准；映射值由矩阵实测确定。
"""

from __future__ import annotations

from typing import Any

ASPECT_RATIOS = ("16:9", "9:16")
RESOLUTIONS = ("720p", "1080p")
DURATION_MIN = 4
DURATION_MAX = 10

# 实测映射表（2026-10-01 全组合协议验证）：
# p4 为「分辨率×比例」组合枚举：1=720p横 2=720p竖 3=360p横 4=360p竖 5=1080p横 6=1080p竖
# p8 = 时长秒（4-10）
_RESOLUTION_ASPECT_P4: dict[tuple[str, str], int] = {
    ("16:9", "720p"): 1,
    ("9:16", "720p"): 2,
    ("16:9", "1080p"): 5,
    ("9:16", "1080p"): 6,
}


class InvalidVideoParams(ValueError):
    pass


def validate_params(aspect_ratio: str, resolution: str, duration_seconds: int) -> None:
    if aspect_ratio not in ASPECT_RATIOS:
        raise InvalidVideoParams(
            f"aspect_ratio must be one of {ASPECT_RATIOS}, got {aspect_ratio!r}")
    if resolution not in RESOLUTIONS:
        raise InvalidVideoParams(
            f"resolution must be one of {RESOLUTIONS}, got {resolution!r}")
    if not isinstance(duration_seconds, int) or not (DURATION_MIN <= duration_seconds <= DURATION_MAX):
        raise InvalidVideoParams(
            f"duration_seconds must be an int within {DURATION_MIN}-{DURATION_MAX}, "
            f"got {duration_seconds!r}")


def build_param_slots(aspect_ratio: str, resolution: str, duration_seconds: int) -> list[Any]:
    validate_params(aspect_ratio, resolution, duration_seconds)
    p4 = _RESOLUTION_ASPECT_P4[(aspect_ratio, resolution)]
    return [0, 12, None, 0, p4, None, None, None, duration_seconds]
