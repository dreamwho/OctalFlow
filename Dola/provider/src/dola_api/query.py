from __future__ import annotations

import base64
import json
import re
import time
import uuid
from typing import Any
from urllib.parse import urlencode

import httpx


def _walk(value: Any, depth: int = 0):
    if depth > 32:
        return
    yield value
    if isinstance(value, dict):
        for item in value.values():
            yield from _walk(item, depth + 1)
    elif isinstance(value, (list, tuple)):
        # SSE events arrive as (name, data) tuples; skipping them here made
        # every submit-stream extraction silently return empty.
        for item in value:
            yield from _walk(item, depth + 1)
    elif isinstance(value, str) and value.lstrip()[:1] in "[{":
        try:
            yield from _walk(json.loads(value), depth + 1)
        except Exception:
            pass


def _url_candidate(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    candidate = value.strip()
    if candidate.startswith(("http://", "https://")) or len(candidate) > 40:
        return candidate
    return ""


def _cookie_value(cookie: str, name: str) -> str:
    for part in cookie.split(";"):
        key, separator, value = part.strip().partition("=")
        if separator and key == name:
            return value.strip()
    return ""


def extract_video_url(value: Any) -> str:
    """Find Dola's video token before falling back to generic media URLs.

    Completed video messages use ``creations[].video.download_url`` in the
    chain response, while older responses expose ``main_url``/``video_url``.
    Prefer the verified creation path so a thumbnail or unrelated page URL
    cannot win merely because it appears earlier in the payload.
    """
    preferred_keys = ("download_url", "video_url", "videoUrl", "main_url", "play_url", "playUrl")
    for item in _walk(value):
        if not isinstance(item, dict):
            continue
        block = item.get("creation_block")
        if not isinstance(block, dict) or not isinstance(block.get("creations"), list):
            continue
        for creation in block["creations"]:
            if not isinstance(creation, dict) or str(creation.get("type") or "") != "2":
                continue
            video = creation.get("video")
            if not isinstance(video, dict):
                continue
            for key in preferred_keys:
                candidate = _url_candidate(video.get(key))
                if candidate:
                    return candidate
    for key in preferred_keys:
        for item in _walk(value):
            if isinstance(item, dict):
                candidate = _url_candidate(item.get(key))
                if candidate and (key in {"video_url", "videoUrl", "main_url"} or item.get("video") or item.get("creation_block") or item.get("creations") or item.get("video_model")):
                    return candidate
    for item in _walk(value):
        if isinstance(item, dict):
            video = item.get("video")
            if isinstance(video, dict):
                for key in preferred_keys:
                    candidate = _url_candidate(video.get(key))
                    if candidate:
                        return candidate
    for item in _walk(value):
        if isinstance(item, dict):
            candidate = _url_candidate(item.get("url"))
            if candidate and (item.get("creation_block") or item.get("creation") or item.get("video") or item.get("video_model")):
                return candidate
    return ""


def extract_image_urls(value: Any) -> list[str]:
    """Collect one preferred URL per image creation, excluding UI avatars."""
    urls: list[str] = []
    for node in _walk(value):
        if not isinstance(node, dict):
            continue
        block = node.get("creation_block")
        if not isinstance(block, dict) or not isinstance(block.get("creations"), list):
            continue
        for creation in block["creations"]:
            if not isinstance(creation, dict) or str(creation.get("type") or "") != "1":
                continue
            image = creation.get("image")
            if not isinstance(image, dict):
                continue
            candidates = [variant.get("url") for key in ("image_ori", "image_raw") if isinstance(variant := image.get(key), dict)]
            candidates.append(image.get("url"))
            url = next((_url_candidate(item) for item in candidates if _url_candidate(item)), "")
            if url and url not in urls:
                urls.append(url)
    return urls


def extract_conversation_id(value: Any) -> str:
    """Extract the upstream conversation ID from nested response JSON."""
    for item in _walk(value):
        if not isinstance(item, dict):
            continue
        for key in ("conversation_id", "conversationId"):
            candidate = str(item.get(key) or "").strip()
            if re.fullmatch(r"\d{12,32}", candidate) and set(candidate) != {"0"}:
                return candidate
    return ""


def extract_main_url(value: Any) -> str:
    """Backward-compatible alias used by the provider's result query."""
    return extract_video_url(value)


def extract_vod_payload(value: Any) -> dict[str, Any]:
    """Keep only the VOD fields needed to request Dola's no-watermark variant.

    Conversation responses contain many unrelated message fields.  Flatten the
    known VOD fields from every nested response so the persisted task metadata
    never needs to carry prompts, cookies, or full conversation content.
    """
    result: dict[str, Any] = {}
    for item in _walk(value):
        if not isinstance(item, dict):
            continue
        fallback_api = item.get("fallback_api")
        if isinstance(fallback_api, str) and fallback_api.strip() and "fallback_api" not in result:
            result["fallback_api"] = fallback_api.strip()
        key_seed = item.get("key_seed")
        if isinstance(key_seed, str) and key_seed.strip() and "key_seed" not in result:
            result["key_seed"] = key_seed.strip()
        video_list = item.get("video_list")
        if isinstance(video_list, dict) and "video_list" not in result:
            variants: dict[str, dict[str, Any]] = {}
            for name, variant in video_list.items():
                if not isinstance(variant, dict):
                    continue
                current = {key: variant[key] for key in ("main_url", "play_url", "vwidth", "vheight", "width", "height", "duration", "codec_type", "definition") if key in variant}
                if current:
                    variants[str(name)] = current
            if variants:
                result["video_list"] = variants
    return result


def decode_main_url(value: str) -> str:
    candidate = value.strip()
    if candidate.startswith(("http://", "https://")):
        return candidate
    for decoder in (base64.b64decode, base64.urlsafe_b64decode):
        try:
            padded = candidate + "=" * (-len(candidate) % 4)
            decoded = decoder(padded.encode("ascii")).decode("utf-8")
            if decoded.startswith(("http://", "https://")):
                return decoded
        except Exception:
            continue
    return ""


def _identity_query(identity: dict[str, str], cookie: str = "") -> str:
    values = {
        "version_code": "20800",
        "language": "zh",
        "device_platform": "web",
        "doubao_device_platform": "web",
        "doubao_pc_version": "3.36.11",
        "aid": "495671",
        "real_aid": "495671",
        "pkg_type": "release_version",
        "device_id": identity.get("device_id", ""),
        "pc_version": "3.36.11",
        "web_id": identity.get("web_id", ""),
        "tea_uuid": identity.get("tea_uuid", ""),
        "region": identity.get("region", "JP"),
        "sys_region": identity.get("sys_region", "JP"),
        "samantha_web": "1",
        "web_platform": "browser",
        "use-olympus-account": "1",
        "web_tab_id": identity.get("web_tab_id", ""),
        "channel": "g",
        "tz_name": identity.get("tz_name") or "Asia/Tokyo",
    }
    fp = _cookie_value(cookie, "s_v_web_id")
    ms_token = _cookie_value(cookie, "msToken")
    if fp:
        values["fp"] = fp
    if ms_token:
        values["msToken"] = ms_token
    return urlencode(values)


def _launch_query(cookie: str) -> str:
    """Build the unsigned query used by Dola's own account launch request.

    Browser capture confirmed that ``/alice/user/launch`` does not require
    ``a_bogus``.  It does require the ordinary web identity fields, so account
    login health can be checked without allocating a Camoufox process.
    """
    now_ms = int(time.time() * 1000)
    web_id = f"{now_ms}{uuid.uuid4().int % 1_000_000:06d}"[:19]
    region = _cookie_value(cookie, "flow_user_country") or "JP"
    return urlencode({
        "aid": "495671",
        "device_id": web_id,
        "device_platform": "web",
        "doubao_device_platform": "web",
        "doubao_pc_version": "3.36.11",
        "language": "zh",
        "pc_version": "3.36.11",
        "pkg_type": "release_version",
        "real_aid": "495671",
        "region": region,
        "samantha_web": "1",
        "sys_region": region,
        "tea_uuid": web_id,
        "use-olympus-account": "1",
        "version_code": "20800",
        "web_id": web_id,
        "web_platform": "browser",
        "web_tab_id": str(uuid.uuid4()),
    })


def parse_account_login_state(value: Any) -> str:
    if not isinstance(value, dict) or value.get("code") != 0:
        return "unknown"
    data = value.get("data")
    extra = data.get("extra") if isinstance(data, dict) else None
    flag = str(extra.get("is_login") if isinstance(extra, dict) else "").strip().lower()
    if flag in {"1", "true"}:
        return "ready"
    if flag in {"0", "false"}:
        return "needs_login"
    return "unknown"


async def probe_account_login(cookie: str, proxy_url: str | None = None) -> dict[str, Any]:
    """Check the Cookie login state through Dola's read-only launch protocol."""
    timeout = httpx.Timeout(30.0, connect=15.0)
    client_options: dict[str, Any] = {"timeout": timeout, "follow_redirects": False, "trust_env": False}
    if proxy_url:
        client_options["proxy"] = proxy_url
    try:
        async with httpx.AsyncClient(**client_options) as client:
            response = await client.post(
                f"https://www.dola.com/alice/user/launch?{_launch_query(cookie)}",
                headers=_headers(cookie),
                json={"select": {"launch_config": True, "assistant_bot_info": True, "landing_config": True, "user_info": True}},
            )
        try:
            payload = response.json()
        except (ValueError, json.JSONDecodeError):
            payload = {}
        return {
            "state": parse_account_login_state(payload),
            "httpStatus": response.status_code,
            "code": payload.get("code") if isinstance(payload, dict) else None,
            "transport": "http-launch",
        }
    except httpx.HTTPError as error:
        return {"state": "unknown", "transport": "http-launch", "error": type(error).__name__}


def _headers(cookie: str, conversation_id: str = "") -> dict[str, str]:
    return {
        "accept": "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9",
        "content-type": "application/json; encoding=utf-8",
        "agw-js-conv": "str",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36",
        "cookie": cookie,
        "origin": "https://www.dola.com",
        "referer": f"https://www.dola.com/chat/{conversation_id}" if conversation_id else "https://www.dola.com/chat/",
        "sec-ch-ua": '"Not-A.Brand";v="24", "Chromium";v="146"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
    }


async def fetch_video_url(cookie: str, conversation_id: str, identity: dict[str, str], proxy_url: str | None = None) -> str:
    result = await fetch_generation_result(cookie, conversation_id, identity, proxy_url)
    return str(result.get("url") or "")


async def fetch_video_result(cookie: str, conversation_id: str, identity: dict[str, str], proxy_url: str | None = None) -> dict[str, Any]:
    """Backward-compatible alias returning only the video result fields."""
    result = await fetch_generation_result(cookie, conversation_id, identity, proxy_url)
    return {"url": result.get("url") or "", "payload": result.get("payload")}


async def fetch_generation_result(cookie: str, conversation_id: str, identity: dict[str, str], proxy_url: str | None = None) -> dict[str, Any]:
    query = _identity_query(identity, cookie)
    timeout = httpx.Timeout(30.0, connect=15.0)
    client_options = {"timeout": timeout, "follow_redirects": False, "trust_env": False}
    if proxy_url:
        client_options["proxy"] = proxy_url
    payloads: list[Any] = []
    # The info endpoint may only expose the video cover while the chain
    # endpoint carries the finished creation, so both are always consulted and
    # a video result always wins over images collected along the way.
    async with httpx.AsyncClient(**client_options) as client:
        for path, request_payload in generation_query_payloads(conversation_id):
            try:
                response = await client.post(f"https://www.dola.com{path}?{query}", headers=_headers(cookie, conversation_id), json=request_payload)
                if response.status_code < 200 or response.status_code >= 300:
                    continue
                body = response.json()
                payloads.append(body)
            except (httpx.HTTPError, ValueError, json.JSONDecodeError):
                continue
    return parse_generation_payloads(payloads)


def generation_query_payloads(conversation_id: str) -> tuple[tuple[str, dict[str, Any]], ...]:
    info = {"cmd": 1110, "uplink_body": {"get_conv_info_uplink_body": {"conversation_id": conversation_id, "ext": {"cold_start": "true"}, "bot_id": "", "conversation_type": 3, "option": {"need_bot_info": True}}}, "sequence_id": conversation_id, "channel": 2, "version": "1"}
    single = {"cmd": 3100, "uplink_body": {"pull_singe_chain_uplink_body": {"conversation_id": conversation_id, "anchor_index": 9007199254740991, "conversation_type": 3, "direction": 1, "limit": 20, "ext": {}, "filter": {"index_list": []}, "evaluate_ab_params": "", "evaluate_common_params": ""}}, "sequence_id": "111", "channel": 2, "version": "1"}
    return (("/im/conversation/info", info), ("/im/chain/single", single))


def parse_generation_payloads(payloads: list[Any]) -> dict[str, Any]:
    video_url = ""
    image_urls: list[str] = []
    refusal = ""
    for body in payloads:
        if not refusal:
            refusal = _generation_refused(body)
        if not video_url:
            video_url = decode_main_url(extract_video_url(body) or "")
        for url in extract_image_urls(body):
            if url not in image_urls:
                image_urls.append(url)
    if video_url:
        return {"url": video_url, "imageUrls": image_urls, "payload": extract_vod_payload(payloads)}

    # Check for explicit failure inside creation blocks (e.g. status == 4/5, fail_msg/fail_code)
    creation_err_code, creation_err_msg = _extract_creation_failure(payloads)
    if creation_err_code or creation_err_msg:
        raw_assistant_text = _extract_assistant_text(payloads)
        err_msg = creation_err_msg or raw_assistant_text or creation_err_code
        return {
            "url": "",
            "imageUrls": [],
            "payload": extract_vod_payload(payloads),
            "error": creation_err_code or "upstream_generation_failed",
            "rawError": err_msg,
        }

    raw_assistant_text = _extract_assistant_text(payloads)
    classified_failure = _classify_refusal_code(raw_assistant_text)
    if classified_failure:
        return {
            "url": "", "imageUrls": [], "payload": extract_vod_payload(payloads),
            "error": classified_failure, "rawError": raw_assistant_text,
        }

    if image_urls:
        return {"url": "", "imageUrls": image_urls, "payload": extract_vod_payload(payloads)}

    # If a creation block is active (e.g. video.status == 1 generating), keep polling.
    if _has_creation_block(payloads):
        return {}

    if refusal:
        raw_error = raw_assistant_text or refusal
        return {
            "url": "",
            "imageUrls": [],
            "payload": extract_vod_payload(payloads),
            "error": refusal,
            "rawError": raw_error,
        }

    # Upstream answered with conversational refusal, clarification, or general
    # error text without creating a video/image task. Terminate as failed and
    # retain the exact upstream response text so request logs reflect reality.
    if raw_assistant_text:
        classified = _classify_refusal_code(raw_assistant_text)
        error_code = classified if classified else raw_assistant_text
        return {
            "url": "",
            "imageUrls": [],
            "payload": extract_vod_payload(payloads),
            "error": error_code,
            "rawError": raw_assistant_text,
        }

    return {}


def _extract_creation_failure(value: Any) -> tuple[str, str]:
    """Extract (error_code, error_msg) from a failed creation block if present."""
    for item in _walk(value):
        if not isinstance(item, dict):
            continue
        creations = []
        block = item.get("creation_block")
        if isinstance(block, dict) and isinstance(block.get("creations"), list):
            creations.extend(block["creations"])
        if item.get("type") in {1, 2, "1", "2"} and (
            item.get("video") or item.get("image") or item.get("creation_id")
        ):
            creations.append(item)

        for creation in creations:
            if not isinstance(creation, dict):
                continue
            media = creation.get("video") or creation.get("image") or creation
            if not isinstance(media, dict):
                continue
            status = media.get("status") if "status" in media else creation.get("status")
            fail_code = (
                media.get("fail_code")
                or media.get("failCode")
                or creation.get("fail_code")
                or creation.get("failCode")
            )
            fail_msg = (
                media.get("fail_msg")
                or media.get("failMsg")
                or media.get("error_msg")
                or media.get("errorMsg")
                or media.get("fail_reason")
                or media.get("fail_desc")
                or creation.get("fail_msg")
                or creation.get("failMsg")
                or creation.get("error_msg")
                or creation.get("errorMsg")
            )
            is_failed_status = str(status) in {"4", "5", "failed", "risk", "rejected"}
            raw_msg = str(fail_msg or "").strip()
            if is_failed_status or raw_msg or fail_code:
                classified = _classify_refusal_code(raw_msg)
                if not classified:
                    if str(status) == "5" or any(w in raw_msg for w in ("违规", "社区规范", "安全", "敏感", "未通过", "审核")):
                        classified = "content_policy_violation"
                    elif fail_code or is_failed_status:
                        classified = "upstream_generation_failed"
                error_detail = raw_msg or (f"fail_code: {fail_code}" if fail_code else "upstream_generation_failed")
                return classified or "upstream_generation_failed", error_detail
    return "", ""


def _is_user_message(msg: Any) -> bool:
    if not isinstance(msg, dict):
        return False
    holder = msg.get("message") if isinstance(msg.get("message"), dict) else msg
    sender_type = holder.get("sender_type")
    if sender_type in (1, "1"):
        return True
    if sender_type in (2, "2"):
        return False
    role = str(
        holder.get("role")
        or holder.get("author")
        or holder.get("sender")
        or holder.get("from")
        or ""
    ).strip().lower()
    if role in {"1", "user", "human"} or "user" in role:
        return True
    for flag in ("is_user", "from_user", "is_self", "user_send"):
        if holder.get(flag) in (True, 1, "1", "true"):
            return True
    return False


def _is_failed_creation(item: dict[str, Any]) -> bool:
    media = item.get("video") or item.get("image") or item
    if not isinstance(media, dict):
        return False
    status = str(media.get("status") if "status" in media else item.get("status") or "").strip()
    fail_code = media.get("fail_code") or media.get("failCode") or item.get("fail_code") or item.get("failCode")
    fail_msg = media.get("fail_msg") or media.get("failMsg") or media.get("error_msg") or item.get("fail_msg") or item.get("failMsg")
    return status in {"4", "5", "failed", "risk", "rejected"} or bool(fail_code) or bool(fail_msg)


def _has_creation_block(value: Any) -> bool:
    """Return True if any payload contains an ACTIVE (generating) creation block."""
    for item in _walk(value):
        if not isinstance(item, dict):
            continue
        creations = []
        block = item.get("creation_block")
        if isinstance(block, dict) and isinstance(block.get("creations"), list):
            creations.extend(block["creations"])
        if item.get("type") in {1, 2, "1", "2"} and (
            item.get("video") or item.get("image") or item.get("creation_id")
        ):
            creations.append(item)

        if creations:
            for c in creations:
                if isinstance(c, dict) and not _is_failed_creation(c):
                    return True
            continue

        if item.get("block_type") == 2074:
            content = item.get("content")
            if isinstance(content, dict):
                c_block = content.get("creation_block")
                if isinstance(c_block, dict) and isinstance(c_block.get("creations"), list):
                    for c in c_block["creations"]:
                        if isinstance(c, dict) and not _is_failed_creation(c):
                            return True
                    continue
            return True
    return False


def _extract_text_from_message(msg: dict[str, Any]) -> str:
    chunks: list[str] = []
    for item in _walk(msg):
        if not isinstance(item, dict):
            continue
        text_block = item.get("text_block")
        if isinstance(text_block, dict):
            t = text_block.get("text")
            if isinstance(t, str) and t.strip() and t.strip() not in chunks:
                chunks.append(t.strip())
        elif item.get("block_type") == 10000:
            c = item.get("content")
            if isinstance(c, dict) and isinstance(c.get("text_block"), dict):
                t = c["text_block"].get("text")
                if isinstance(t, str) and t.strip() and t.strip() not in chunks:
                    chunks.append(t.strip())
            elif isinstance(item.get("text"), str) and item["text"].strip() and item["text"].strip() not in chunks:
                chunks.append(item["text"].strip())
        elif isinstance(item.get("tts_content"), str):
            t = item["tts_content"].strip()
            if t and t not in chunks:
                chunks.append(t)
    return "\n".join(chunks)


def _extract_assistant_text(payloads: list[Any]) -> str:
    """Extract assistant response text when no video/image creation block was produced."""
    first_text = ""
    for body in payloads:
        for item in _walk(body):
            if not isinstance(item, dict):
                continue
            messages = item.get("messages")
            if isinstance(messages, list):
                for msg in reversed(messages):
                    if not isinstance(msg, dict):
                        continue
                    if _is_user_message(msg):
                        continue
                    text = _extract_text_from_message(msg)
                    if text:
                        if _classify_refusal_code(text):
                            return text
                        if not first_text:
                            first_text = text
    if first_text:
        return first_text
    fallback_chunks: list[str] = []
    for body in payloads:
        for item in _walk(body):
            if not isinstance(item, dict):
                continue
            if item.get("block_type") == 10000:
                text_block = item.get("text_block")
                if isinstance(text_block, dict) and isinstance(text_block.get("text"), str):
                    t = text_block["text"].strip()
                    if t and t not in fallback_chunks:
                        fallback_chunks.append(t)
                elif isinstance(item.get("text"), str) and item["text"].strip():
                    t = item["text"].strip()
                    if t and t not in fallback_chunks:
                        fallback_chunks.append(t)
            elif isinstance(item.get("tts_content"), str):
                t = item["tts_content"].strip()
                if t and t not in fallback_chunks:
                    fallback_chunks.append(t)
    return "\n".join(fallback_chunks)


def _classify_refusal_code(text: str) -> str:
    """Classify known refusal/failure categories or return empty if unknown."""
    if not text:
        return ""
    if any(k in text for k in ("违规", "社区规范", "内容安全", "涉及敏感", "无法通过审核", "未通过审核", "敏感内容", "无法生成")):
        if any(k in text for k in ("违规", "社区规范", "内容安全", "涉及敏感", "无法通过审核", "未通过审核", "敏感内容")):
            return "content_policy_violation"
    if "视频生成失败" in text or "图片生成失败" in text or "出了点问题" in text or "生成失败" in text:
        return "upstream_generation_failed"
    if (
        "生成次数已经到达上限" in text
        or "生成次数已到达上限" in text
        or "生成次数已达上限" in text
        or "生成次数已达到上限" in text
        or "明天再来免费生成" in text
        or "额度已用完" in text
        or "免费生成次数已用完" in text
        or "免费生成次数已经用完" in text
        or "今日额度已用完" in text
        or "今日生成次数已达上限" in text
        or "免费额度已用完" in text
        or ("生成次数" in text and ("上限" in text or "到达" in text or "达到" in text))
        or ("免费生成" in text and ("上限" in text or "用完" in text))
    ):
        return "upstream_quota_exhausted"
    if "无法生成" in text and "额度" in text:
        return "upstream_quota_insufficient"
    if "服务访问频繁" in text or "710022002" in text or ("频繁" in text and "稍后" in text):
        return "rate_limited"
    return ""


def _generation_refused(value: Any) -> str:
    """Return a short refusal reason when upstream answered without a creation.

    Covers plain failures, quota exhaustion ("今天的生成次数已经到达上限，明天再来免费生成吧"),
    and quota refusals ("需要消耗 N 个额度…无法生成"),
    both of which leave an accepted task with nothing to poll forever.  Dola's
    generic failure toast "出了点问题，请稍后重试。" is persisted as the
    assistant message and must terminate the task the same way.
    """
    for item in _walk(value):
        if not isinstance(item, str):
            continue
        code = _classify_refusal_code(item)
        if code:
            return code
    return ""


async def fetch_recent_conversation_id(cookie: str, identity: dict[str, str], proxy_url: str | None = None) -> str:
    """Recover the newest conversation only after a real submit ACK.

    The caller must gate this fallback on the submit stream's ACK marker; using
    the most recent conversation without that proof could attach an unrelated
    task to the current request.
    """
    query = _identity_query(identity, cookie)
    payload = {
        "cmd": 3200,
        "uplink_body": {
            "pull_recent_conv_chain_uplink_body": {
                "limit": 10,
                "message_count_per_conv": 10,
                "api_version": 1,
                "conv_version": 0,
                "direction": 3,
                "option": {
                    "not_need_message": True,
                    "need_complete_conversation": True,
                    "need_coco_conversation": True,
                    "need_coco_bot": True,
                },
            }
        },
        "sequence_id": str(uuid.uuid4()),
        "channel": 2,
        "version": "1",
    }
    timeout = httpx.Timeout(30.0, connect=15.0)
    client_options = {"timeout": timeout, "follow_redirects": False, "trust_env": False}
    if proxy_url:
        client_options["proxy"] = proxy_url
    try:
        async with httpx.AsyncClient(**client_options) as client:
            response = await client.post(f"https://www.dola.com/im/chain/recent_conv?{query}", headers=_headers(cookie), json=payload)
            if response.status_code < 200 or response.status_code >= 300:
                return ""
            return extract_conversation_id(response.json())
    except (httpx.HTTPError, ValueError, json.JSONDecodeError):
        return ""
