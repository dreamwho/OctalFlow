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
    elif isinstance(value, list):
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
    """Collect completed image URLs from creation blocks.

    Upstream returns ``creations[].image`` with ``image_ori``/``image_raw``
    variants; original (non ``_wm_`` template) URLs are preferred and every
    distinct URL is kept so callers can persist all results.
    """
    urls: list[str] = []

    def visit(node: Any, depth: int = 0) -> None:
        if depth > 32 or len(urls) > 32:
            return
        if isinstance(node, dict):
            image = node.get("image")
            if isinstance(image, dict):
                for key in ("image_ori", "image_raw"):
                    variant = image.get(key)
                    if isinstance(variant, dict):
                        url = _url_candidate(variant.get("url"))
                        if url and url not in urls:
                            urls.append(url)
                url = _url_candidate(image.get("url"))
                if url and url not in urls:
                    urls.append(url)
            for item in node.values():
                visit(item, depth + 1)
        elif isinstance(node, list):
            for item in node:
                visit(item, depth + 1)
        elif isinstance(node, str) and node.lstrip()[:1] in "[{":
            try:
                visit(json.loads(node), depth + 1)
            except Exception:
                pass

    visit(value)
    ordered = sorted(urls, key=lambda url: "_wm_" in url)
    return ordered


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
    if refusal:
        # Upstream answered with a refusal message (failure or insufficient
        # quota); without this check the task would stay accepted forever.
        return {"url": "", "imageUrls": [], "payload": extract_vod_payload(payloads), "error": refusal}
    if not video_url and not image_urls:
        return {}
    return {"url": video_url, "imageUrls": image_urls, "payload": extract_vod_payload(payloads)}


def _generation_refused(value: Any) -> str:
    """Return a short refusal reason when upstream answered without a creation.

    Covers plain failures and quota refusals ("需要消耗 N 个额度…无法生成"),
    both of which leave an accepted task with nothing to poll forever.
    """
    for item in _walk(value):
        if not isinstance(item, str):
            continue
        if "视频生成失败" in item or "图片生成失败" in item:
            return "upstream_generation_failed"
        if "无法生成" in item and "额度" in item:
            return "upstream_quota_insufficient"
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
