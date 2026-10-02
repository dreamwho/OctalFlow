from __future__ import annotations

from dataclasses import dataclass
import re


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


def sanitize_video_prompt_duration(prompt: str) -> str:
    """Strip explicit duration phrases from prompt to prevent Dola conversational LLM refusal.

    Dola's conversational assistant evaluates visible message text against a 4-15s
    dialog policy. If '30秒', '30s', '时长30秒', or a segment timeline like
    '0-2.5秒/2.5-6秒/27.2-30秒' appear in user_input_content or visible text, the
    LLM reads the over-15s intent and intercepts the turn with a conversational
    refusal instead of dispatching the structured video generation tool.
    The duration must be passed exclusively through ability_param['duration'].
    """
    if not prompt:
        return ""
    text = prompt
    # 1. '生成...30秒...视频' or '30秒视频'
    text = re.sub(
        r"生成(?:一段|一个)?\s*(?:\d+(?:\s*[-~到至]\s*\d+)?|\d+)\s*(?:秒钟?|s(?:ec(?:onds?)?)?)\s*(?:的)?(?:短?视频|片断|片段|微电影)?\s*[:：]?",
        "",
        text,
    )
    # 2. '视频时长: 30秒' / '时长为30秒' / '时长约28秒' / 'duration: 30s'
    text = re.sub(
        r"(?i)(?:视频)?时长\s*[:：=为是约]?\s*(?:大约)?\s*(?:\d+(?:\.\d+)?(?:\s*[-~到至]\s*\d+(?:\.\d+)?)?|\d+)\s*(?:秒钟?|s(?:ec(?:onds?)?)?)\b",
        "",
        text,
    )
    text = re.sub(r"(?i)\bduration\s*[:=]\s*\d+(?:\.\d+)?\s*s?\b", "", text)
    # 3. '30 秒完整分镜' / '30 秒脚本'：保留分镜/脚本的创作语义。
    text = re.sub(r"(?i)\d+(?:\.\d+)?\s*(?:秒钟?|s(?:ec(?:onds?)?)?)\s*(?=(?:完整)?分镜|脚本)", "", text)
    # 4. '30秒的短视频' / '15s微电影'
    text = re.sub(
        r"(?i)(?:\d+(?:\.\d+)?(?:\s*[-~到至]\s*\d+(?:\.\d+)?)?|\d+)\s*(?:秒钟?|s(?:ec(?:onds?)?)?)\s*(?:的)?(?:短?视频|片断|片段|微电影)",
        "",
        text,
    )
    # 5. 分段时间轴区间 '0-2.5秒：' / '2.5-6秒' / '27.2-30秒'：完整时间轴会让会话
    # 模型读出总时长（如 30 秒）并按 4-15s 对话策略拦截，必须整段去除。
    text = re.sub(
        r"(?i)(?<![\d.])(?:(?:约|大约)\s*)?\d+(?:\.\d+)?\s*[-–—~到至]\s*\d+(?:\.\d+)?\s*(?:秒钟?|s(?:ec(?:onds?)?)?)\s*[:：]?",
        "",
        text,
    )
    # 6. Other mentions of the requested duration (e.g. '完整 30 秒') must not
    # reach the conversational layer; duration is already in ability_param.
    text = re.sub(r"(?i)(?<![\d.])(?:15|30)\s*(?:秒钟?|s(?:ec(?:onds?)?)?)(?![\d.])", "", text)
    # 7. standalone '30秒' / '约28秒' / '2.5-6秒'
    text = re.sub(
        r"(?i)(?:^|(?<=[\s,，、;:：。！？]))(?:约|大约)?\s*(?:\d+(?:\.\d+)?(?:\s*[-–—~到至]\s*\d+(?:\.\d+)?)?|\d+)\s*(?:秒钟?|s(?:ec(?:onds?)?)?)(?=$|[\s,，、;:：。！？])",
        "",
        text,
    )
    # 8. Clean up duplicate delimiters
    text = re.sub(
        r"[,，、\s]+",
        lambda m: "，" if "，" in m.group() or "," in m.group() else " ",
        text,
    )
    text = re.sub(r"^[，,、\s:：]+|[，,、\s:：]+$", "", text)
    if text.startswith("生成视频：") or text.startswith("生成视频:"):
        rest = text[5:].strip()
        if rest:
            text = rest
    return text.strip()
