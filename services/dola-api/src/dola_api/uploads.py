from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import string
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import parse_qsl, quote, urlencode, urlsplit

import httpx

from .page_scripts import PREPARE_UPLOAD_SCRIPT

IMAGEX_REGION = "us-east-1"
IMAGEX_SERVICE = "imagex"
IMAGEX_API_VERSION = "2018-08-01"
PREPARE_UPLOAD_BODY = {"tenant_id": "5", "scene_id": "4", "resource_type": 2}
DEFAULT_MAX_REFERENCE_BYTES = 20 * 1024 * 1024


def _random_base36(length: int = 11) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _sha256_hex(value: str | bytes) -> str:
    raw = value.encode("utf-8") if isinstance(value, str) else value
    return hashlib.sha256(raw).hexdigest()


def _hmac_sha256(key: str | bytes, value: str, *, hex_digest: bool = False) -> str | bytes:
    raw_key = key.encode("utf-8") if isinstance(key, str) else key
    digest = hmac.new(raw_key, value.encode("utf-8"), hashlib.sha256)
    return digest.hexdigest() if hex_digest else digest.digest()


def _aws_encode(value: str) -> str:
    return quote(str(value), safe="-_.~")


def _canonical_query_string(raw_url: str) -> str:
    pairs = [(_aws_encode(key), _aws_encode(value)) for key, value in parse_qsl(urlsplit(raw_url).query, keep_blank_values=True)]
    pairs.sort()
    return "&".join(f"{key}={value}" for key, value in pairs)


def _sign_imagex_request(*, method: str, raw_url: str, credentials: dict[str, str], body: str = "", include_payload_hash: bool = False) -> dict[str, str]:
    amz_date = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    date_stamp = amz_date[:8]
    payload_hash = _sha256_hex(body)
    canonical_headers_map = {"x-amz-date": amz_date, "x-amz-security-token": credentials["session_token"]}
    if include_payload_hash:
        canonical_headers_map["x-amz-content-sha256"] = payload_hash
    signed_header_names = sorted(canonical_headers_map)
    canonical_headers = "".join(f"{name}:{' '.join(str(canonical_headers_map[name]).strip().split())}\n" for name in signed_header_names)
    canonical_request = "\n".join(
        [
            method.upper(),
            urlsplit(raw_url).path or "/",
            _canonical_query_string(raw_url),
            canonical_headers,
            ";".join(signed_header_names),
            payload_hash,
        ]
    )
    credential_scope = f"{date_stamp}/{IMAGEX_REGION}/{IMAGEX_SERVICE}/aws4_request"
    string_to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, credential_scope, _sha256_hex(canonical_request)])
    date_key = _hmac_sha256(f"AWS4{credentials['secret_access_key']}", date_stamp)
    region_key = _hmac_sha256(date_key, IMAGEX_REGION)
    service_key = _hmac_sha256(region_key, IMAGEX_SERVICE)
    signing_key = _hmac_sha256(service_key, "aws4_request")
    signature = _hmac_sha256(signing_key, string_to_sign, hex_digest=True)
    headers = {
        "Authorization": f"AWS4-HMAC-SHA256 Credential={credentials['access_key_id']}/{credential_scope}, SignedHeaders={';'.join(signed_header_names)}, Signature={signature}",
        "X-Amz-Date": amz_date,
        "x-amz-security-token": credentials["session_token"],
    }
    if include_payload_hash:
        headers["X-Amz-Content-Sha256"] = payload_hash
    return headers


def _normalize_upload_credentials(token: Any) -> dict[str, str]:
    value = token if isinstance(token, dict) else {}
    credentials = {
        "access_key_id": value.get("access_key") or value.get("accessKeyId") or value.get("AccessKeyId") or value.get("AccessKeyID"),
        "secret_access_key": value.get("secret_key") or value.get("secretAccessKey") or value.get("SecretAccessKey"),
        "session_token": value.get("session_token") or value.get("sessionToken") or value.get("SessionToken"),
    }
    if not all(credentials.values()):
        raise RuntimeError("prepare_upload_credentials_incomplete")
    return {key: str(item) for key, item in credentials.items()}


def _max_reference_bytes() -> int:
    value = os.getenv("DOLA_REFERENCE_MAX_BYTES", "").strip()
    try:
        parsed = int(value)
    except ValueError:
        parsed = DEFAULT_MAX_REFERENCE_BYTES
    return max(1, min(parsed, DEFAULT_MAX_REFERENCE_BYTES))


def _proxy_options(proxy_url: str | None) -> dict[str, Any]:
    return {"proxy": proxy_url} if proxy_url else {}


async def _read_response_json(response: httpx.Response, label: str) -> dict[str, Any]:
    if response.status_code < 200 or response.status_code >= 300:
        raise RuntimeError(f"{label}_http_{response.status_code}")
    try:
        value = response.json()
    except (ValueError, json.JSONDecodeError) as error:
        raise RuntimeError(f"{label}_invalid_json") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"{label}_invalid_body")
    return value


async def _fetch_source_bytes(url: str, proxy_url: str | None) -> tuple[bytes, str, str]:
    parsed = urlsplit(url)
    if parsed.scheme == "data":
        header, separator, encoded = url.partition(",")
        if not separator or ";base64" not in header.lower():
            raise RuntimeError("reference_data_url_invalid")
        try:
            content = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as error:
            raise RuntimeError("reference_data_url_invalid") from error
        mime = header[5:].split(";", 1)[0] or "image/png"
        return _check_source_size(content), mime, "reference.png"
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise RuntimeError("reference_url_invalid")
    timeout = httpx.Timeout(45.0, connect=15.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=False, **_proxy_options(proxy_url)) as client:
        response = await client.get(url, headers={"accept": "image/*,*/*;q=0.8"})
        if response.status_code < 200 or response.status_code >= 300:
            raise RuntimeError(f"reference_fetch_http_{response.status_code}")
        content = _check_source_size(response.content)
        mime = response.headers.get("content-type", "").split(";", 1)[0].strip().lower() or "image/png"
        name = PurePosixPath(parsed.path).name or "reference.png"
        return content, mime, name


def _check_source_size(content: bytes) -> bytes:
    if not content or len(content) > _max_reference_bytes():
        raise RuntimeError("reference_image_too_large_or_empty")
    return content


async def _prepare_upload(page: Any) -> dict[str, Any]:
    result = await page.evaluate(PREPARE_UPLOAD_SCRIPT, {"body": PREPARE_UPLOAD_BODY})
    if not isinstance(result, dict):
        raise RuntimeError("prepare_upload_invalid_result")
    if not result.get("ok"):
        status = result.get("status", "unknown")
        raise RuntimeError(f"prepare_upload_http_{status}")
    data = result.get("json")
    if not isinstance(data, dict):
        raise RuntimeError("prepare_upload_invalid_json")
    if data.get("code") != 0:
        code = str(data.get("code") if data.get("code") is not None else "unknown")
        raise RuntimeError(f"prepare_upload_rejected_{code}")
    if not isinstance(data.get("data"), dict):
        raise RuntimeError("prepare_upload_config_missing")
    return data["data"]


async def upload_reference(page: Any, item: dict[str, Any], proxy_url: str | None = None) -> dict[str, Any]:
    existing_uri = str(item.get("uri") or "").strip()
    if existing_uri:
        return {"uri": existing_uri, "name": str(item.get("name") or "image.png"), "width": int(item.get("width") or 0), "height": int(item.get("height") or 0), "mime": str(item.get("mime") or "image/png")}
    source_url = str(item.get("url") or item.get("dataUrl") or "").strip()
    if not source_url:
        raise RuntimeError("reference_url_missing")
    content, mime, file_name = await _fetch_source_bytes(source_url, proxy_url)
    upload_config = await _prepare_upload(page)
    credentials = _normalize_upload_credentials(upload_config.get("upload_auth_token"))
    service_id = str(upload_config.get("service_id") or "")
    imagex_host = str(upload_config.get("upload_host") or "imagex-ap-southeast-1.bytevcloudapi.com")
    if not service_id or not imagex_host:
        raise RuntimeError("prepare_upload_config_incomplete")
    ext = PurePosixPath(file_name).suffix.lower() or mimetypes.guess_extension(mime) or ".png"
    timeout = httpx.Timeout(90.0, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=False, **_proxy_options(proxy_url)) as client:
        apply_params = {"Action": "ApplyImageUpload", "Version": IMAGEX_API_VERSION, "ServiceId": service_id, "FileSize": str(len(content)), "FileExtension": ext, "s": _random_base36()}
        apply_url = f"https://{imagex_host}/?{urlencode(apply_params)}"
        apply_response = await client.get(apply_url, headers={"Accept": "*/*", **_sign_imagex_request(method="GET", raw_url=apply_url, credentials=credentials)})
        apply_data = await _read_response_json(apply_response, "apply_image_upload")
        upload_address = (apply_data.get("Result") or {}).get("UploadAddress") or {}
        store_infos = upload_address.get("StoreInfos") or []
        upload_hosts = upload_address.get("UploadHosts") or []
        store_info = store_infos[0] if isinstance(store_infos, list) and store_infos and isinstance(store_infos[0], dict) else {}
        upload_host = str(upload_hosts[0]) if isinstance(upload_hosts, list) and upload_hosts else ""
        session_key = str(upload_address.get("SessionKey") or "")
        store_uri = str(store_info.get("StoreUri") or "")
        store_auth = str(store_info.get("Auth") or "")
        if not upload_host or not session_key or not store_uri or not store_auth:
            raise RuntimeError("apply_image_upload_incomplete")
        upload_headers = {"Authorization": store_auth, "Content-CRC32": f"{binascii.crc32(content) & 0xFFFFFFFF:08x}", "Content-Disposition": f'attachment; filename="{file_name.replace(chr(34), "")}"', "Content-Type": "application/octet-stream"}
        if isinstance(upload_address.get("UploadHeader"), dict):
            upload_headers.update({str(key): str(value) for key, value in upload_address["UploadHeader"].items()})
        upload_url = f"https://{upload_host}/upload/v1/{store_uri}"
        upload_response = await client.post(upload_url, headers=upload_headers, content=content)
        upload_data = await _read_response_json(upload_response, "image_upload")
        if upload_data.get("code") != 2000:
            raise RuntimeError("image_upload_rejected")
        commit_url = f"https://{imagex_host}/?{urlencode({'Action': 'CommitImageUpload', 'Version': IMAGEX_API_VERSION, 'ServiceId': service_id})}"
        commit_body = json.dumps({"SessionKey": session_key}, separators=(",", ":"))
        commit_headers = {"Accept": "*/*", "Content-Type": "application/json", **_sign_imagex_request(method="POST", raw_url=commit_url, credentials=credentials, body=commit_body, include_payload_hash=True)}
        commit_response = await client.post(commit_url, headers=commit_headers, content=commit_body)
        commit_data = await _read_response_json(commit_response, "commit_image_upload")
    result = commit_data.get("Result") or {}
    results = result.get("Results") if isinstance(result, dict) else []
    plugins = result.get("PluginResult") if isinstance(result, dict) else []
    first_result = results[0] if isinstance(results, list) and results and isinstance(results[0], dict) else {}
    plugin = plugins[0] if isinstance(plugins, list) and plugins and isinstance(plugins[0], dict) else {}
    uri = str(first_result.get("Uri") or "")
    if not uri:
        raise RuntimeError("commit_image_upload_missing_uri")
    return {"uri": uri, "name": str(plugin.get("FileName") or PurePosixPath(uri).name or file_name), "width": int(plugin.get("ImageWidth") or item.get("width") or 0), "height": int(plugin.get("ImageHeight") or item.get("height") or 0), "size": int(plugin.get("ImageSize") or len(content)), "mime": mime}


async def resolve_references(page: Any, references: list[dict[str, Any]], proxy_url: str | None = None) -> list[dict[str, Any]]:
    resolved: list[dict[str, Any]] = []
    for item in references:
        resolved.append(await upload_reference(page, item, proxy_url))
    return resolved


__all__ = ["resolve_references", "upload_reference", "_sign_imagex_request"]
