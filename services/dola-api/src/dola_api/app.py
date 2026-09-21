from __future__ import annotations

import os

from fastapi import Depends, FastAPI, Header, HTTPException

from .contracts import AccountInspectRequest, GoogleLoginRequest, VerificationInput, VerificationLease, VideoRequest
from .session import CamoufoxSessionPool

app = FastAPI(title="dreamyo Dola Camoufox Provider")
pool = CamoufoxSessionPool()


def require_internal(authorization: str | None = Header(default=None), x_api_key: str | None = Header(default=None)) -> None:
    expected = os.getenv("DOLA_PROVIDER_KEY", "").strip()
    supplied = (authorization or "").removeprefix("Bearer ").strip() or (x_api_key or "").strip()
    if not expected or supplied != expected:
        raise HTTPException(status_code=401, detail="provider authentication required")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "transport": "protocol-page-signed"}


@app.get("/internal/runtime/v1/models", dependencies=[Depends(require_internal)])
async def models() -> dict:
    return {"object": "list", "data": [
        {"id": "dola-seedance-2-5", "object": "model", "capability": "video"},
        {"id": "dola-seedance-2-0-fast", "object": "model", "capability": "video"},
        {"id": "dola-seedream-4-5", "object": "model", "capability": "image"},
    ]}


@app.post("/internal/runtime/v1/accounts/inspect", dependencies=[Depends(require_internal)])
async def inspect_account(request: AccountInspectRequest) -> dict:
    try:
        return await pool.inspect(request)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.post("/internal/runtime/v1/accounts/verify", dependencies=[Depends(require_internal)])
async def verify_account(request: AccountInspectRequest) -> dict:
    try:
        return await pool.verify_account(request)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.post("/internal/runtime/v1/videos", dependencies=[Depends(require_internal)])
async def submit(request: VideoRequest) -> dict:
    try:
        task = await pool.submit(request)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return {
        "id": task.id,
        "taskId": task.id,
        "status": task.status,
        "accountId": task.accountId,
        "proxyMode": task.proxyMode,
        "proxyTarget": task.proxyTarget,
        **({"conversationId": task.conversationId, "conversation_id": task.conversationId} if task.conversationId else {}),
        **({"verificationId": task.verificationId} if task.verificationId else {}),
        **({"screenshotBase64": task.screenshotBase64} if task.screenshotBase64 else {}),
        **({"diagnostics": task.diagnostics} if task.diagnostics else {}),
        **({"videoUrl": task.videoUrl, "video_url": task.videoUrl} if task.videoUrl else {}),
        **({"imageUrls": task.imageUrls} if task.imageUrls else {}),
        "transport": "protocol-page-signed",
    }


@app.post("/internal/runtime/v1/images", dependencies=[Depends(require_internal)])
async def submit_image(request: VideoRequest) -> dict:
    return await submit(request)


@app.get("/internal/runtime/v1/videos/{task_id}", dependencies=[Depends(require_internal)])
async def query(task_id: str) -> dict:
    task = await pool.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    payload = task.model_dump(by_alias=True, exclude_none=True)
    if task.conversationId:
        payload["conversation_id"] = task.conversationId
    if task.videoUrl:
        payload["video_url"] = task.videoUrl
    if task.imageUrls:
        # OpenAI-compatible result envelope so standard clients and the image
        # task poller can read data[0].url directly.
        payload["data"] = [{"url": url} for url in task.imageUrls]
    return payload


@app.get("/internal/runtime/v1/images/{task_id}", dependencies=[Depends(require_internal)])
async def query_image(task_id: str) -> dict:
    return await query(task_id)


@app.post("/internal/runtime/v1/verifications/{verification_id}/open", dependencies=[Depends(require_internal)])
async def open_verification(verification_id: str) -> dict:
    try:
        return await pool.open_verification(verification_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.post("/internal/runtime/v1/verifications/{verification_id}/input", dependencies=[Depends(require_internal)])
async def verification_input(verification_id: str, request: VerificationInput) -> dict:
    try:
        return await pool.verification_input(verification_id, request)
    except PermissionError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    except ValueError as error:
        status = 404 if str(error) == "verification_not_found" else 422
        raise HTTPException(status_code=status, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.post("/internal/runtime/v1/verifications/{verification_id}/resume", dependencies=[Depends(require_internal)])
async def resume_verification(verification_id: str, request: VerificationLease) -> dict:
    try:
        return await pool.resume_verification(verification_id, request)
    except PermissionError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    except ValueError as error:
        status = 404 if str(error) == "verification_not_found" else 409
        raise HTTPException(status_code=status, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.post("/internal/runtime/v1/verifications/{verification_id}/close", dependencies=[Depends(require_internal)])
async def close_verification(verification_id: str, request: VerificationLease) -> dict:
    try:
        return await pool.close_verification(verification_id, request)
    except PermissionError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    except ValueError as error:
        status = 404 if str(error) == "verification_not_found" else 409
        raise HTTPException(status_code=status, detail=str(error)) from error


@app.post("/internal/runtime/v1/accounts/google-login", dependencies=[Depends(require_internal)])
async def google_login(request: GoogleLoginRequest) -> dict:
    try:
        return await pool.start_google_login(
            proxy_mode=request.proxyMode,
            proxy_url=request.proxyUrl,
            timeout_seconds=request.timeoutSeconds,
        )
    except TimeoutError as error:
        raise HTTPException(status_code=408, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


def main() -> None:
    import uvicorn

    uvicorn.run("dola_api.app:app", host="127.0.0.1", port=int(os.getenv("DOLA_PROVIDER_PORT", "18082")))
