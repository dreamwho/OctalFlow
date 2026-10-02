from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException

from .contracts import AccountInspectRequest, AdoptBrowserTaskRequest, BrowserQueryResultRequest, BrowserSubmitPrepareRequest, BrowserSubmitResultRequest, GoogleLoginRequest, GoogleLoginSessionRequest, VerificationInput, VerificationKeyboardInput, VerificationLease, VideoRequest
from .page_scripts import PREPARE_UPLOAD_SCRIPT
from .query import extract_generation_input
from .session import CamoufoxSessionPool, parse_browser_submission, prepare_browser_submission
from .uploads import PREPARE_UPLOAD_BODY

pool = CamoufoxSessionPool()

async def _parent_watchdog(parent_pid: int) -> None:
    """Shut down (closing browser children) once the spawning app is gone.

    The desktop app can be force-quit or crash without running its cleanup;
    without this watchdog the frozen provider and every Camoufox tree it opened
    stay orphaned. Two consecutive liveness misses guard against transient
    probe errors.
    """
    misses = 0
    while True:
        await asyncio.sleep(3)
        try:
            os.kill(parent_pid, 0)
            misses = 0
        except ProcessLookupError:
            misses += 1
        except OSError:
            misses = 0
        if misses >= 2:
            break
    try:
        await pool.close_all_sessions()
    finally:
        os._exit(0)

@asynccontextmanager
async def lifespan(_app: FastAPI):
    watchdog = None
    parent_pid = os.getenv("DOLA_PROVIDER_PARENT_PID", "").strip()
    if parent_pid.isdigit():
        watchdog = asyncio.create_task(_parent_watchdog(int(parent_pid)))
    try:
        yield
    finally:
        if watchdog:
            watchdog.cancel()
        try:
            await asyncio.wait_for(pool.close_all_sessions(), timeout=15)
        except Exception:
            pass

app = FastAPI(title="dreamyo Dola Camoufox Provider", lifespan=lifespan)


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


@app.get("/internal/runtime/v1/browser-submit/upload-script", dependencies=[Depends(require_internal)])
async def browser_upload_script() -> dict:
    return {"script": PREPARE_UPLOAD_SCRIPT, "body": PREPARE_UPLOAD_BODY}


@app.post("/internal/runtime/v1/browser-submit/prepare", dependencies=[Depends(require_internal)])
async def browser_submit_prepare(request: BrowserSubmitPrepareRequest) -> dict:
    try:
        return await prepare_browser_submission(request, request.uploadConfig)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.post("/internal/runtime/v1/browser-submit/parse", dependencies=[Depends(require_internal)])
async def browser_submit_parse(request: BrowserSubmitResultRequest) -> dict:
    return await parse_browser_submission(request.payload, request.cookie, request.proxyUrl)


@app.get("/internal/runtime/v1/tasks/{task_id}/browser-query", dependencies=[Depends(require_internal)])
async def prepare_browser_query(task_id: str) -> dict:
    try:
        return await pool.prepare_browser_query(task_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.post("/internal/runtime/v1/tasks/{task_id}/browser-result", dependencies=[Depends(require_internal)])
async def apply_browser_result(task_id: str, request: BrowserQueryResultRequest) -> dict:
    try:
        task = await pool.apply_browser_result(task_id, request)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return {**task.model_dump(by_alias=True, exclude_none=True), "input": extract_generation_input(request.payload)}


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


@app.post("/internal/runtime/v1/accounts/headed-test", dependencies=[Depends(require_internal)])
async def start_headed_test(request: AccountInspectRequest) -> dict:
    try:
        return await pool.start_headed_test(request)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

@app.get("/internal/runtime/v1/verifications/headed-tests", dependencies=[Depends(require_internal)])
async def list_headed_tests() -> dict:
    return {"items": pool.list_headed_tests()}


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
        **({"error": task.error} if task.error else {}),
        **({"rawError": task.rawError, "raw_error": task.rawError} if getattr(task, "rawError", None) else {}),
        "transport": "protocol-page-signed",
    }


@app.post("/internal/runtime/v1/images", dependencies=[Depends(require_internal)])
async def submit_image(request: VideoRequest) -> dict:
    return await submit(request)


@app.get("/internal/runtime/v1/videos/{task_id}", dependencies=[Depends(require_internal)])
async def query(task_id: str, refresh: bool = False) -> dict:
    task = await pool.get(task_id, refresh=refresh)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    payload = task.model_dump(by_alias=True, exclude_none=True)
    if task.conversationId:
        payload["conversation_id"] = task.conversationId
    if task.videoUrl:
        payload["video_url"] = task.videoUrl
    if getattr(task, "rawError", None):
        payload["raw_error"] = task.rawError
    if task.imageUrls:
        # OpenAI-compatible result envelope so standard clients and the image
        # task poller can read data[0].url directly.
        payload["data"] = [{"url": url} for url in task.imageUrls]
    return payload


@app.get("/internal/runtime/v1/images/{task_id}", dependencies=[Depends(require_internal)])
async def query_image(task_id: str, refresh: bool = False) -> dict:
    return await query(task_id, refresh)


@app.post("/internal/runtime/v1/tasks/{task_id}/rebind", dependencies=[Depends(require_internal)])
async def rebind_task(task_id: str, request: AccountInspectRequest) -> dict:
    try:
        await pool.rebind_task(task_id, request)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return await query(task_id)


@app.post("/internal/runtime/v1/tasks/adopt-browser", dependencies=[Depends(require_internal)])
async def adopt_browser_task(request: AdoptBrowserTaskRequest) -> dict:
    try:
        task = await pool.adopt_browser_task(request)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return task.model_dump(by_alias=True, exclude_none=True)


@app.post("/internal/runtime/v1/verifications/{verification_id}/open", dependencies=[Depends(require_internal)])
async def open_verification(verification_id: str) -> dict:
    try:
        return await pool.open_verification(verification_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


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


@app.post("/internal/runtime/v1/verifications/{verification_id}/keyboard", dependencies=[Depends(require_internal)])
async def verification_keyboard(verification_id: str, input: VerificationKeyboardInput) -> dict:
    try:
        return await pool.verification_keyboard(verification_id, input)
    except (ValueError, PermissionError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

@app.post("/internal/runtime/v1/verifications/{verification_id}/finalize", dependencies=[Depends(require_internal)])
async def finalize_headed_test(verification_id: str, request: VerificationLease) -> dict:
    try:
        return await pool.finalize_headed_test(verification_id, request)
    except PermissionError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.post("/internal/runtime/v1/verifications/{verification_id}/google-finalize", dependencies=[Depends(require_internal)])
async def finalize_google_login_session(verification_id: str, request: VerificationLease) -> dict:
    try:
        return await pool.finalize_google_login_session(verification_id, request)
    except PermissionError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
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


@app.post("/internal/runtime/v1/accounts/google-login/session", dependencies=[Depends(require_internal)])
async def start_google_login_session(request: GoogleLoginSessionRequest) -> dict:
    try:
        return await pool.start_google_login_session(request.ownerId, proxy_mode=request.proxyMode, proxy_url=request.proxyUrl, timeout_seconds=request.timeoutSeconds, headless=request.headless)
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


def main() -> None:
    import uvicorn

    uvicorn.run("dola_api.app:app", host="127.0.0.1", port=int(os.getenv("DOLA_PROVIDER_PORT", "18082")))
