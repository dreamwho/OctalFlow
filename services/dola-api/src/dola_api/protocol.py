from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class DolaProfile:
    model: str
    upstream_model: str
    durations: tuple[int, ...]
    ratios: tuple[str, ...] = ("1:1", "3:4", "4:3", "9:16", "16:9", "21:9")
    capability: str = "video"


PROFILES = {
    "dola-seedance-2-5": DolaProfile("dola-seedance-2-5", "seedance_v2.5", (5, 10, 15, 30)),
    "dola-seedance-2-0-fast": DolaProfile("dola-seedance-2-0-fast", "seedance_v2.0", (5, 10, 15)),
    "dola-seedream-4-5": DolaProfile("dola-seedream-4-5", "Seedream 4.5", (), capability="image"),
}


def canonical_ratio(ratio: str, ratios: tuple[str, ...]) -> str:
    """Snap a (possibly reduced like 7:3) ratio onto the supported set by value."""
    value = (ratio or "").strip()
    if value in ratios:
        return value
    parts = value.replace("×", ":").replace("x", ":").split(":")
    if len(parts) != 2:
        return ""
    try:
        width, height = float(parts[0]), float(parts[1])
    except ValueError:
        return ""
    if width <= 0 or height <= 0:
        return ""
    target = width / height
    best, best_diff = "", 0.0
    for candidate in ratios:
        left, right = candidate.split(":", 1)
        diff = abs((int(left) / int(right)) - target)
        if not best or diff < best_diff:
            best, best_diff = candidate, diff
    return best


def validate_request(model: str, duration: int, ratio: str) -> DolaProfile:
    profile = PROFILES.get(model)
    if profile is None:
        raise ValueError("unsupported_model")
    canonical = canonical_ratio(ratio, profile.ratios)
    if ratio and not canonical:
        raise ValueError(f"unsupported_ratio:{ratio}")
    if profile.capability == "image":
        return profile
    if duration not in profile.durations:
        raise ValueError(f"unsupported_duration:{duration}")
    return profile

