"""Google Vids (docs.google.com/videos) pure-protocol client.

Protocol facts (captured 2026-10-01, account dreamwho@gmail.com):
- Submit: POST https://appsgenaiserver-pa.clients6.google.com/v1/genai/generate?key=<public key>
  * long-lived synchronous request: the HTTP response arrives when generation
    completes (~40s-3min) and embeds the watermark-free mp4 download URL.
  * auth: Cookie header scoped to exactly the .google.com jar + Authorization
    SAPISIDHASH (computed from SAPISID cookie, origin https://docs.google.com).
  * x-server-token is NOT required; the ?key= param alone is not enough (401).
  * body: positional JSON array (application/json+protobuf).
- Reference images (captured 2026-10-01):
  * upload: POST https://docs.google.com/upload/temporaryblob/videos?authuser=0
    with x-goog-upload-command:start -> x-goog-upload-url header; then PUT the
    raw bytes with x-goog-upload-command:"upload, finalize" and
    x-goog-upload-entity-md5 (hex md5). Response body: ["AVL_..."] blob token.
  * generate body then carries client_context[25] = [[[7x null,
    [uuid, [11x null, [8x null, [null,null,null,token,1], 4x null, name]]]]]]
    and the prompt slot becomes segments [text, " ", @reference].
- Download: GET the returned contribution-rt.usercontent.google.com URL with the
  same .google.com cookie scope (sending extra cross-domain cookies breaks it).
"""
from __future__ import annotations

import hashlib
import json
import random
import re
import time
import uuid as uuid_lib
from dataclasses import dataclass, field
from typing import Any

from curl_cffi import requests as creq

GENERATE_URL = (
    "https://appsgenaiserver-pa.clients6.google.com/v1/genai/generate"
    "?key=AIzaSyA-njTXslyyMKk1VOogRfVP59F6fNGeNW8"
)
UPLOAD_START_URL = "https://docs.google.com/upload/temporaryblob/videos?authuser=0"
VIDS_MIME = "application/vnd.google-apps.flix"
ORIGIN = "https://docs.google.com"

# Default captured generation params: [p0,p1,None,p3,p4,None,None,None,duration]
DEFAULT_PARAM_SLOTS = [0, 12, None, 0, 1, None, None, None, 10]

_MEDIA_RE = re.compile(
    r'"([0-9a-f]{40,})","bard_storage","temp_data","lookup_temp_data",'
    r'"(https://contribution-rt\.usercontent\.google\.com/download[^"]+)",'
    r'(\d+),(\d+),\["(\d+)"\]'
)


@dataclass
class VidsMaterial:
    token: str
    name: str = "图片 1"
    material_id: str = field(default_factory=lambda: str(uuid_lib.uuid4()).upper())

    def to_slot_entry(self) -> list[Any]:
        inner = [None] * 8 + [[None, None, None, self.token, 1]] + [None] * 4 + [self.name]
        return [None] * 7 + [[self.material_id, [None] * 11 + [inner]]]


@dataclass
class VidsGenerationResult:
    media_url: str
    width: int
    height: int
    duration_seconds: int
    storage_key: str
    raw: str


class VidsProtocolError(RuntimeError):
    def __init__(self, message: str, status: int | None = None, body: str = ""):
        super().__init__(message)
        self.status = status
        self.body = body[:2000]


def load_google_cookie_header(storage_state: dict) -> str:
    """Cookie header scoped to .google.com only — wider scopes get rejected."""
    pairs = []
    for c in storage_state.get("cookies", []):
        if c.get("domain") == ".google.com" and c.get("path", "/") == "/":
            pairs.append(f"{c['name']}={c['value']}")
    if not any(p.startswith(("SID=", "SAPISID=")) for p in pairs):
        raise VidsProtocolError("storage state has no .google.com SID/SAPISID cookies")
    return "; ".join(pairs)


def compute_sapisidhash(sapisid: str, origin: str = ORIGIN) -> str:
    ts = int(time.time())
    digest = hashlib.sha1(f"{ts} {sapisid} {origin}".encode()).hexdigest()
    return f"SAPISIDHASH {ts}_{digest}"


def _prompt_segments(prompt: str, materials: list[VidsMaterial] | None) -> list[list[Any]]:
    if not materials:
        return [[None, None, prompt]]
    segments: list[list[Any]] = [[None, None, prompt], [None, None, " "]]
    for material in materials:
        segments.append(
            [None] * 7
            + [[None, [None, None, material.name], [None] * 7 + [[material.material_id]]]]
        )
    return segments


def build_generate_body(
    doc_id: str,
    prompt: str,
    duration_seconds: int = 10,
    param_slots: list[Any] | None = None,
    materials: list[VidsMaterial] | None = None,
) -> str:
    slots = list(param_slots or DEFAULT_PARAM_SLOTS)
    slots[8] = duration_seconds
    request_id = f"goog_{random.randint(10**8, 10**9 - 1)}"
    doc_ref = [None, None, None, [[[None, None, None, None, None, None, None,
        [None, None, [[doc_id, VIDS_MIME, None, None, 1]]]]]]]
    client_context: list[Any] = [None] * 41
    client_context[0] = 9
    client_context[4] = request_id
    client_context[6] = "0"
    client_context[8] = doc_ref
    client_context[11] = [24, 0]
    client_context[13] = "en"
    client_context[19] = 1
    if materials:
        client_context[25] = [[entry for entry in (m.to_slot_entry() for m in materials)]]
    client_context[40] = 0
    body = [
        # captured outer flag: 374 text-only, 376 with reference materials
        376 if materials else 374,
        None,
        client_context,
        [None, None, None, [_prompt_segments(prompt, materials)]],
        [None, None, None, None, None, None, None, None, None, None, None,
         None, None, None, None, slots],
        [1, None, [[None, "1", 1189]]],
        1,
    ]
    return json.dumps(body, separators=(",", ":"), ensure_ascii=False)


def parse_generate_response(text: str) -> VidsGenerationResult:
    m = _MEDIA_RE.search(text)
    if not m:
        raise VidsProtocolError(
            "no media result in generate response", body=text)
    return VidsGenerationResult(
        storage_key=m.group(1),
        media_url=m.group(2).replace("\\/", "/"),
        width=int(m.group(3)),
        height=int(m.group(4)),
        duration_seconds=int(m.group(5)),
        raw=text,
    )


class VidsProtocolClient:
    def __init__(self, storage_state: dict, proxy: str | None = None, timeout: int = 420):
        self.cookie_header = load_google_cookie_header(storage_state)
        self.sapisid = next(
            (c["value"] for c in storage_state.get("cookies", [])
             if c.get("name") == "SAPISID" and c.get("domain") == ".google.com"),
            "",
        )
        if not self.sapisid:
            raise VidsProtocolError("SAPISID cookie missing")
        self.proxy = proxy
        self.timeout = timeout

    def _headers(self) -> dict:
        return {
            "cookie": self.cookie_header,
            "authorization": compute_sapisidhash(self.sapisid),
            "content-type": "application/json+protobuf",
            "origin": ORIGIN,
            "referer": ORIGIN + "/",
            "accept": "*/*",
            "x-goog-authuser": "0",
        }

    def generate(
        self,
        doc_id: str,
        prompt: str,
        duration_seconds: int = 10,
        param_slots: list[Any] | None = None,
        materials: list[VidsMaterial] | None = None,
    ) -> VidsGenerationResult:
        body = build_generate_body(doc_id, prompt, duration_seconds, param_slots, materials)
        try:
            r = creq.post(
                GENERATE_URL,
                data=body.encode("utf-8"),
                headers=self._headers(),
                impersonate="chrome",
                timeout=self.timeout,
                proxies={"https": self.proxy, "http": self.proxy} if self.proxy else None,
            )
        except Exception as exc:  # network layer
            raise VidsProtocolError(f"generate request failed: {exc}") from exc
        if r.status_code != 200:
            raise VidsProtocolError(
                f"generate returned {r.status_code}", status=r.status_code, body=r.text)
        return parse_generate_response(r.text)

    def upload_material(self, data: bytes, timeout: int = 180) -> str:
        """Upload one reference image; returns the AVL_ blob token."""
        base_headers = {
            "cookie": self.cookie_header,
            "origin": ORIGIN,
            "referer": ORIGIN + "/videos/",
            "accept": "*/*",
        }
        proxies = {"https": self.proxy, "http": self.proxy} if self.proxy else None
        try:
            start = creq.post(
                UPLOAD_START_URL,
                data=b"",
                headers={
                    **base_headers,
                    "x-goog-upload-protocol": "resumable",
                    "x-goog-upload-command": "start",
                    "x-goog-upload-content-length": str(len(data)),
                    "x-goog-upload-file-name": "temporary_blob",
                    "content-type": "application/x-www-form-urlencoded;charset=utf-8",
                },
                impersonate="chrome",
                timeout=timeout,
                proxies=proxies,
            )
        except Exception as exc:
            raise VidsProtocolError(f"material upload start failed: {exc}") from exc
        if start.status_code != 200:
            raise VidsProtocolError(
                "material upload start failed",
                status=start.status_code, body=start.text)
        upload_url = start.headers.get("x-goog-upload-url") or ""
        if not upload_url.startswith("http"):
            raise VidsProtocolError(
                "material upload start returned no x-goog-upload-url", body=start.text)
        digest = hashlib.md5(data).hexdigest()
        try:
            finalize = creq.put(
                upload_url,
                data=data,
                headers={
                    **base_headers,
                    "x-goog-upload-command": "upload, finalize",
                    "x-goog-upload-offset": "0",
                    "x-goog-upload-entity-md5": digest,
                    "content-type": "application/x-www-form-urlencoded;charset=utf-8",
                },
                impersonate="chrome",
                timeout=timeout,
                proxies=proxies,
            )
        except Exception as exc:
            raise VidsProtocolError(f"material upload finalize failed: {exc}") from exc
        if finalize.status_code != 200:
            raise VidsProtocolError(
                "material upload finalize failed",
                status=finalize.status_code, body=finalize.text)
        try:
            payload = json.loads(finalize.text)
            token = payload[0] if isinstance(payload, list) and payload else ""
        except Exception:
            token = ""
        if not token.startswith("AVL_"):
            raise VidsProtocolError(
                "material upload returned no AVL_ token", body=finalize.text)
        return token

    def download(self, media_url: str, timeout: int = 300) -> bytes:
        try:
            r = creq.get(
                media_url,
                headers={
                    "cookie": self.cookie_header,
                    "referer": ORIGIN + "/",
                    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                },
                impersonate="chrome",
                timeout=timeout,
                proxies={"https": self.proxy, "http": self.proxy} if self.proxy else None,
            )
        except Exception as exc:
            raise VidsProtocolError(f"download failed: {exc}") from exc
        if r.status_code != 200 or len(r.content) < 10000 or r.content[4:8] != b"ftyp":
            raise VidsProtocolError(
                f"download returned {r.status_code} len={len(r.content)} "
                f"ct={r.headers.get('content-type')}")
        return r.content
