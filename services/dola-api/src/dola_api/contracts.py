from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class VideoRequest(BaseModel):
    model: Literal["dola-seedance-2-5", "dola-seedance-2-0-fast", "dola-seedream-4-5"]
    prompt: str = Field(min_length=1, max_length=20_000)
    duration: int = 0
    ratio: str = "16:9"
    size: str | None = None
    references: list[dict] = Field(default_factory=list)
    accountId: str | None = None
    credentialVersion: int | None = None
    proxyMode: Literal["direct", "managed"] = "direct"
    proxySource: Literal["direct", "magic", "generic", "chained"] | None = None
    proxyTarget: str | None = None
    proxyUrl: str | None = None
    cookie: str | None = None
    requestId: str | None = None
    headless: bool | None = None


class VideoTask(BaseModel):
    id: str
    model: str
    status: Literal["queued", "running", "accepted", "completed", "failed", "needs_review"]
    accountId: str | None = None
    credentialVersion: int | None = None
    proxyMode: Literal["direct", "managed"] = "direct"
    proxySource: Literal["direct", "magic", "generic", "chained"] | None = None
    proxyTarget: str | None = None
    conversationId: str | None = None
    error: str | None = None
    verificationId: str | None = None
    videoUrl: str | None = None
    imageUrls: list[str] | None = None
    vodPayload: dict | list | None = None
    screenshotBase64: str | None = None
    diagnostics: dict | None = None


class AccountInspectRequest(BaseModel):
    accountId: str
    credentialVersion: int = 1
    proxyMode: Literal["direct", "managed"] = "direct"
    proxySource: Literal["direct", "magic", "generic", "chained"] | None = None
    proxyTarget: str | None = None
    proxyUrl: str | None = None
    cookie: str
    headless: bool | None = None
    authOnly: bool = False


class AccountQuota(BaseModel):
    bucket: str
    model: str | None = None
    unit: str = "unknown"
    remaining: int | None = None
    limit: int | None = None
    source: str = "upstream"


class VerificationInput(BaseModel):
    leaseToken: str = Field(min_length=16, max_length=256)
    action: Literal["down", "move", "up", "wheel"]
    x: float
    y: float
    deltaY: float | None = None


class VerificationLease(BaseModel):
    leaseToken: str = Field(min_length=16, max_length=256)


class VerificationKeyboardInput(VerificationLease):
    text: str = Field(min_length=1, max_length=500)


class GoogleLoginRequest(BaseModel):
    proxyMode: Literal["direct", "managed"] = "direct"
    proxySource: Literal["direct", "magic", "generic", "chained"] | None = None
    proxyTarget: str | None = None
    proxyUrl: str | None = None
    timeoutSeconds: int = 180
