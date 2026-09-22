import { resolveGlobalAiOpcPreset } from "@/lib/globalaiopc-catalog";
import { generationModelId, systemGenerationChannelId } from "@/lib/server/generation-channel";
import { generationMediaProxyHeaders } from "@/lib/server/generation-media-authorization";
import { finishGenerationAttempt } from "@/lib/server/generation-attempt";
import { fetchInternalApi } from "@/lib/server/internal-origin";
import { resolveModelRequestTimeoutMs } from "@/lib/server/model-request-policy";
import { isProviderBusinessError, providerQueryPaths, readProviderError, videoPollingPolicy } from "@/lib/server/provider-task-config";
import { registerGenerationTaskAssetsForUser } from "@/lib/server/creative-runtime-service";
import { normalizeVideoResult } from "@/lib/server/video-result-normalizer";
import { VIDEO_PROVIDER_FAILED, VIDEO_PROVIDER_SUCCESS, parseVideoProviderJson, readVideoProviderHttpError, readVideoProviderStatus, readVideoProviderUrl, videoProviderMediaUrl } from "@/lib/server/video-provider-response";
import { claimVideoTaskPoll, completeReconciledVideoTask, failReconciledVideoTask, getVideoTask, updateVideoTask, type VideoTask } from "@/lib/server/video-task-store";
import { writeVideoGenerationLog } from "@/lib/server/video-task-log";
import { maintenanceWorkerHeaders } from "@/lib/server/maintenance-auth";
import { systemAiBillingHeaders } from "@/lib/server/system-ai-billing";
import { refundVideoTask } from "@/lib/server/video-task-refund";
import { geminiVideoQueryPath, parseGeminiVideoOperation } from "@/lib/server/gemini-video-provider";
import { isDreaminaCliVideoTask, isDreaminaCliPersistedResultUrl, queryDreaminaCliVideoTask } from "@/lib/server/dreamina-cli-video-task";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { getDolaAccount, releaseDolaAccountAttempt, markDolaAccountQuotaExhausted, markDolaAccountRateLimited, markDolaAccountRestricted, setDolaAccountStatus } from "@/lib/server/dola/account-service";
import { getDolaGatewaySettings } from "@/lib/server/dola/gateway-store";
import { advanceDolaTaskLog, findDolaTaskLogIdByTaskId, retargetDolaRequestLogTask } from "@/lib/server/dola/log-store";
import { isDolaQuotaExhaustedError, isDolaRateLimitError, shouldRotateAccountForError } from "@/lib/dola-errors";
import { resolveDolaWatermarkUrlRemote } from "@/lib/server/dola/watermark-url";
import { resolveDolaProxyEgress } from "@/lib/server/dola/proxy";

export type VideoUpstreamStep = { state: "pending"; status: string } | { state: "result_ready"; status: string; resultUrl: string; watermarkPayload?: unknown } | { state: "needs_review"; status: string; error: string; verificationId?: string } | { state: "failed"; status: string; error: string };

export async function refreshVideoTaskFromUpstream(task: VideoTask, origin: string, cookie: string) {
    const polling = taskPollingPolicy(task);
    const claimed = await claimVideoTaskPoll(task.id, polling.intervalMs);
    if (!claimed) return getVideoTask(task.id);

    const step = await queryVideoTaskUpstream(claimed, origin, cookie);
    if (step.state === "needs_review") {
        if (claimed.config.advancedConfig?.protocol === "dola" && claimed.upstream.accountId) await setDolaAccountStatus(claimed.upstream.accountId, "verification_required").catch(() => undefined);
        await scheduleGenerationTask("video", claimed.id, {
            executionPhase: "needs_review",
            nextPollAt: undefined,
            lastUpstreamStatus: step.status,
            resultPayload: { reviewReason: step.error.slice(0, 500), ...(step.verificationId ? { verificationId: step.verificationId } : {}) },
        });
        return getVideoTask(claimed.id);
    }
    if (step.state === "failed") {
        if (claimed.config.advancedConfig?.protocol === "dola" && shouldRotateAccountForError(step.error)) {
            const rotated = await rotateDolaRateLimitedVideoTask(claimed, origin, cookie, "", step.error);
            if (rotated) return rotated;
            if (isDolaRateLimitError(step.error)) {
                // 限流只是账号级瞬时状态，上游任务可能仍在生成：保持轮询等待真实终态。
                await scheduleGenerationTask("video", claimed.id, { executionPhase: "polling", lastUpstreamStatus: "rate_limited_polling", nextPollAt: Date.now() + taskPollingPolicy(claimed).intervalMs });
                return getVideoTask(claimed.id);
            }
            // 其余基础设施错误（如浏览器导航中断）上游任务通常已终止且换号配额用尽：判失败。
        }
        return failVideoTask(claimed, step.error);
    }
    if (step.state === "result_ready") return persistVideoTaskResult(claimed, step.resultUrl, origin, cookie, "", step.watermarkPayload);
    return getVideoTask(claimed.id);
}

/** 账号级错误允许换号；只有真实账号状态错误才写回账号池，浏览器/代理故障不污染账号。 */
export async function rotateDolaRateLimitedVideoTask(task: VideoTask, origin: string, cookie: string, workerUserId: string, error: string) {
    if (task.upstream.accountId) {
        if (isDolaQuotaExhaustedError(error)) await markDolaAccountQuotaExhausted(task.upstream.accountId, error.slice(0, 300)).catch(() => undefined);
        else if (isDolaRateLimitError(error)) await markDolaAccountRateLimited(task.upstream.accountId, error.slice(0, 300)).catch(() => undefined);
        else if (/proxy_region_blocked|country restricted|region-restricted/i.test(error)) await markDolaAccountRestricted(task.upstream.accountId, error.slice(0, 300)).catch(() => undefined);
        else if (/login|auth|cookie|credential|unauthorized|\b401\b/i.test(error)) await setDolaAccountStatus(task.upstream.accountId, "needs_login").catch(() => undefined);
        await releaseDolaAccountAttempt(task.upstream.accountId).catch(() => undefined);
    }
    const { rotationLimit } = await getDolaGatewaySettings();
    const payload = task.upstream.rotationPayload;
    if (!payload || (task.upstream.rotations || 0) >= rotationLimit) {
        console.warn(`[dola-rotate] 视频任务 ${task.id} 无法继续换号：${!payload ? "缺少原始请求载荷（旧任务）" : `已用尽 ${rotationLimit} 次轮换配额`}`);
        return null;
    }
    const createPath = task.config.advancedConfig?.createPath || "/v1/videos";
    let record: Record<string, unknown> | null;
    try {
        const response = await fetchInternalApi(`${origin}${task.config.baseUrl.replace(/\/+$/, "")}${createPath.startsWith("/") ? createPath : `/${createPath}`}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-dola-rotation-task": task.upstream.id, ...videoProxyHeaders(task, cookie, workerUserId) },
            body: JSON.stringify(payload),
            cache: "no-store",
            signal: AbortSignal.timeout(Math.min(resolveModelRequestTimeoutMs(task.config, "video"), 60_000)),
        });
        const text = await response.text();
        if (!response.ok) {
            console.warn(`[dola-rotate] 视频任务 ${task.id} 换号重提失败：HTTP ${response.status} ${text.slice(0, 200)}`);
            return null;
        }
        const parsed: unknown = parseVideoProviderJson(text);
        record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch (submitError) {
        console.warn(`[dola-rotate] 视频任务 ${task.id} 换号重提异常：`, submitError instanceof Error ? submitError.message : submitError);
        return null;
    }
    const newTaskId = typeof record?.taskId === "string" ? record.taskId : typeof record?.id === "string" ? record.id : "";
    if (!newTaskId || newTaskId === task.upstream.id) return null;
    const { resultUrl: _dropped, ...upstreamRest } = task.upstream;
    const nextAccountId = typeof record?.accountId === "string" && record.accountId ? record.accountId : task.upstream.accountId;
    const upstream = { ...upstreamRest, id: newTaskId, ...(nextAccountId ? { accountId: nextAccountId } : {}), rotations: (task.upstream.rotations || 0) + 1 };
    await updateVideoTask(task.id, { upstream });
    await scheduleGenerationTask("video", task.id, { executionPhase: "submitted", lastUpstreamStatus: "submitted", nextPollAt: Date.now() + taskPollingPolicy(task).intervalMs });
    // 把换号事件写回原任务的请求日志：请求日志详情的生命周期会显示 生成失败 → 已自动切换账号 → 继续生成
    const originalLogId = await safeFindDolaRuntimeTaskLog(task.upstream.id);
    const isQuota = isDolaQuotaExhaustedError(error);
    const switchReason = isQuota ? "今日生成次数已达上限 (daily quota reached limit)" : "上游账号触发限额（rate_limited） (upstream account rate-limited)";
    if (originalLogId) {
        await safeAdvanceDolaRotateLog(originalLogId, {
            phase: "generating",
            message: `账号 ${task.upstream.accountId || "未识别"} ${isQuota ? "今日生成次数已达上限" : "触发限额"}，已自动切换账号重试 (${switchReason}; auto-switched to another account)`,
            detail: `原账号 ${task.upstream.accountId || "未识别"} 已${isQuota ? "标记为额度已用完" : "按真实错误分类处理"}；新账号 ${nextAccountId || "未识别"}，新任务 ${newTaskId}，第 ${upstream.rotations as number} 次轮换。后续进度转由新账号接续执行。`,
            statusCode: 200,
        });
    }
    console.log(`[dola-rotate] 视频任务 ${task.id} ${isQuota ? "账号额度已用完" : "上游账号限额"}（${error.slice(0, 120)}），已自动切换账号重试：新任务 ${newTaskId}，账号 ${nextAccountId || "未识别"}`);
    // 轮换叠加日志：原请求日志转接到新任务 ID，账号名同步为新账号，后续轮询与结果继续写同一份日志。
    const nextAccountName = nextAccountId ? (await getDolaAccount(nextAccountId).catch(() => null))?.name : undefined;
    await retargetDolaRequestLogTask(task.upstream.id, newTaskId, nextAccountName).catch(() => undefined);
    return getVideoTask(task.id);
}

async function safeFindDolaRuntimeTaskLog(taskId: string) {
    try {
        return await findDolaTaskLogIdByTaskId(taskId, "runtime");
    } catch (error) {
        console.error("Failed to locate Dola runtime task log for rotation", error);
        return "";
    }
}

async function safeAdvanceDolaRotateLog(id: string, advance: Parameters<typeof advanceDolaTaskLog>[1]) {
    if (!id) return;
    try {
        await advanceDolaTaskLog(id, advance);
    } catch (error) {
        console.error("Failed to record Dola rotation into task log", error);
    }
}

export async function queryVideoTaskUpstream(task: VideoTask, origin: string, cookie = "", workerUserId = ""): Promise<VideoUpstreamStep> {
    if (task.upstream.resultUrl) return { state: "result_ready", status: "completed", resultUrl: task.upstream.resultUrl };
    if (isDreaminaCliVideoTask(task.config)) return queryDreaminaCliVideoTask(task);
    if (isGeminiVideoTask(task)) return queryGeminiVideoUpstream(task, origin, cookie, workerUserId);
    const data = await queryVideoUpstream(task, origin, cookie, workerUserId);
    const status = readVideoProviderStatus(data, task.config.advancedConfig?.statusField);
    const rawVerificationId = data && typeof data === "object" ? (data as Record<string, unknown>).verificationId ?? (data as Record<string, unknown>).verification_id : undefined;
    const verificationId = typeof rawVerificationId === "string" && rawVerificationId.trim() ? rawVerificationId.trim() : undefined;
    const isDola = task.config.advancedConfig?.protocol === "dola";
    if (status === "needs_review" || status === "verification_required" || (isDola && status === "submission_unknown")) {
        if (verificationId) {
            const error = isDola ? "Dola 需要人工完成页面验证" : "上游需要人工完成验证";
            return { state: "needs_review", status, error, verificationId };
        }
        const error = isDola
            ? status === "submission_unknown"
                ? "Dola 提交响应未返回任务标识，且未检测到验证页面"
                : "Dola 返回待确认状态，但未提供验证会话"
            : "上游返回待确认状态，但未提供验证会话";
        return { state: "failed", status: status || "failed", error };
    }
    const resultUrl = readVideoProviderUrl(data, task.config.advancedConfig?.resultField) || contentEndpointResultUrl(task, status);
    if (resultUrl || VIDEO_PROVIDER_SUCCESS.has(status)) {
        return resultUrl
            ? { state: "result_ready", status: status || "completed", resultUrl, ...(task.config.advancedConfig?.protocol === "dola" && data && typeof data === "object" && "vodPayload" in data ? { watermarkPayload: (data as Record<string, unknown>).vodPayload } : {}) }
            : { state: "failed", status: status || "completed", error: "视频任务已完成但没有返回视频地址" };
    }
    if (isProviderBusinessError(data) || VIDEO_PROVIDER_FAILED.has(status)) return { state: "failed", status: status || "failed", error: readProviderError(data) || "视频生成失败" };
    return { state: "pending", status: status || "processing" };
}

async function queryGeminiVideoUpstream(task: VideoTask, origin: string, cookie: string, workerUserId: string): Promise<VideoUpstreamStep> {
    const path = task.upstream.queryPath || geminiVideoQueryPath(task.config.model, task.upstream.id);
    const url = `${origin}${task.config.baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
    const response = await fetchInternalApi(url, {
        headers: videoProxyHeaders(task, cookie, workerUserId),
        cache: "no-store",
        signal: AbortSignal.timeout(Math.min(resolveModelRequestTimeoutMs(task.config, "video"), 60_000)),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(readVideoProviderHttpError(text, response.status));
    let data: unknown;
    try {
        data = parseVideoProviderJson(text);
    } catch (error) {
        throw error instanceof Error ? error : new Error("Gemini Veo 查询接口返回了无效 JSON");
    }
    const operation = parseGeminiVideoOperation(data);
    if (operation.state === "pending") return { state: "pending", status: operation.status };
    if (operation.state === "failed") return { state: "failed", status: operation.status, error: operation.error };
    return { state: "result_ready", status: operation.status, resultUrl: operation.resultUrl };
}

export async function persistVideoTaskResult(task: VideoTask, resultUrl: string, origin: string, cookie = "", workerUserId = "", watermarkPayload?: unknown) {
    return completeVideoTask(task, resultUrl, origin, cookie, workerUserId, watermarkPayload);
}

export async function failVideoTaskFromWorker(task: VideoTask, error: string, retryable = false) {
    return failVideoTask(task, error, retryable);
}

function taskPollingPolicy(task: VideoTask) {
    return videoPollingPolicy(Boolean(globalAiOpcPreset(task)));
}

async function completeVideoTask(task: VideoTask, resultUrl: string, origin: string, cookie: string, workerUserId = "", watermarkPayload?: unknown) {
    const beforePersistence = await getVideoTask(task.id);
    if (!beforePersistence || beforePersistence.status === "cancelled") {
        if (beforePersistence?.status === "cancelled") await refundVideoTask(beforePersistence);
        return beforePersistence;
    }
    task = beforePersistence;
    const attempts = finishGenerationAttempt(task.attempts || [], task.attempts?.at(-1)?.attemptNo || 1, {
        status: "succeeded",
        pointsCost: task.upstream.pointsCost,
        pointsRecordId: task.upstream.pointsRecordId,
    });
    await updateVideoTask(task.id, { attempts });
    const channelId = task.config.channelId || systemGenerationChannelId(task.config.baseUrl);
    const resolvedResultUrl = await resolveDolaResultUrl(task, resultUrl, watermarkPayload);
    const workerHeaders = new Headers(workerUserId ? maintenanceWorkerHeaders(workerUserId) : undefined);
    if (resolvedResultUrl && channelId) {
        Object.entries(generationMediaProxyHeaders({ userId: task.userId, taskType: "video", taskId: task.id, channelId, upstreamModel: task.config.model, url: resolvedResultUrl })).forEach(([key, value]) => workerHeaders.set(key, value));
    }
    const isDola = isDolaVideoTask(task);
    const result = task.result?.url
        ? task.result
        : isDreaminaCliVideoTask(task.config) && isDreaminaCliPersistedResultUrl(resolvedResultUrl)
          ? { url: resolvedResultUrl, mimeType: dreaminaCliResultMimeType(resolvedResultUrl), ...(task.requestedDurationSeconds ? { durationMs: task.requestedDurationSeconds * 1000 } : {}) }
          : await normalizeVideoResult({
                // Dola returns a first-party HTTPS VOD URL. It is intentionally
                // downloaded server-side and persisted as a private asset rather
                // than routed through the generic channel media proxy (whose
                // channel base URL is provider-managed and therefore empty).
                url: isDola ? resolvedResultUrl : videoProviderMediaUrl(task.config.baseUrl, resolvedResultUrl),
                origin,
                cookie,
                internalHeaders: workerHeaders,
                requestedDurationSeconds: task.requestedDurationSeconds,
                mimeType: "video/mp4",
                ownerUserId: task.userId,
                source: task.source,
                conversationId: task.conversationId,
                runId: task.runId,
                taskId: task.id,
                projectId: task.projectId,
            });
    const completed = await completeReconciledVideoTask(task.id, {
        ...result,
        ...(watermarkPayload !== undefined ? { dolaVodPayload: watermarkPayload } : {}),
        ...(isDola ? { unwatermarked: resolvedResultUrl !== resultUrl || watermarkPayload !== undefined } : {}),
    });
    if (!completed) {
        const latest = await getVideoTask(task.id);
        if (latest?.status === "cancelled") await refundVideoTask(latest);
        return latest;
    }
    await writeVideoGenerationLog(completed, "success");
    if (isDolaVideoTask(completed) && completed.upstream.accountId) {
        await releaseDolaAccountAttempt(completed.upstream.accountId).catch(() => undefined);
        await setDolaAccountStatus(completed.upstream.accountId, "ready").catch(() => undefined);
    }
    await registerVideoAsset(completed);
    return completed;
}

export function isDolaVideoTask(task: { config?: { channelId?: string; id?: string; advancedConfig?: { protocol?: string }; apiFormat?: string; model?: string; name?: string } | null; upstream?: { id?: string; provider?: string } }): boolean {
    const config = task?.config;
    if (config) {
        if (
            config.channelId === "dola" ||
            config.id === "dola" ||
            config.advancedConfig?.protocol === "dola" ||
            config.apiFormat === "dola" ||
            (typeof config.model === "string" && config.model.startsWith("dola-")) ||
            (typeof config.name === "string" && config.name.toLowerCase().includes("dola"))
        ) {
            return true;
        }
    }
    const upstream = task?.upstream;
    if (upstream) {
        if (
            (typeof upstream.id === "string" && upstream.id.startsWith("dola-")) ||
            (typeof upstream.provider === "string" && upstream.provider === "dola")
        ) {
            return true;
        }
    }
    return false;
}

async function resolveDolaResultUrl(task: VideoTask, resultUrl: string, watermarkPayload: unknown) {
    const isDola = isDolaVideoTask(task);
    const targetPayload = watermarkPayload ?? (task.result as Record<string, unknown> | undefined)?.dolaVodPayload;
    if (!isDola && !targetPayload) return resultUrl;
    if (!targetPayload) return resultUrl;
    const settings = await getDolaGatewaySettings().catch(() => ({ enabled: false, autoWatermark: true }));
    if (settings.autoWatermark === false) return resultUrl;
    try {
        const proxy = await resolveDolaProxyEgress().catch(() => ({ proxyUrl: undefined }));
        const resolved = await resolveDolaWatermarkUrlRemote(targetPayload, { proxyUrl: proxy.proxyUrl });
        if (resolved.downloadUrl) {
            console.log(`[dola-watermark] 视频任务 ${task.id} 自动去水印成功，已替换为无水印地址`);
            return resolved.downloadUrl;
        }
    } catch (error) {
        console.warn(`[dola-watermark] 视频任务 ${task.id} 自动去水印未成功，降级保留带水印原视频:`, error);
    }
    return resultUrl;
}

async function failVideoTask(task: VideoTask, error: string, retryable = true) {
    const attempts = finishGenerationAttempt(task.attempts || [], task.attempts?.at(-1)?.attemptNo || 1, { status: "failed", error });
    await updateVideoTask(task.id, { attempts });
    const failed = await failReconciledVideoTask(task.id, error, retryable);
    if (failed) {
        await writeVideoGenerationLog({ ...failed, attempts }, "failed", error, retryable);
        if (isDolaVideoTask(failed) && failed.upstream.accountId) await releaseDolaAccountAttempt(failed.upstream.accountId).catch(() => undefined);
        if (task.status === "running") await refundVideoTask(failed);
    }
    return failed || getVideoTask(task.id);
}

async function registerVideoAsset(task: VideoTask) {
    const url = task.result?.remoteUrl || task.result?.url;
    if (!url) return;
    await registerGenerationTaskAssetsForUser(task.userId, {
        ...task,
        taskId: task.id,
        title: task.prompt?.slice(0, 80) || "生成视频",
        assets: [{ type: "video", url, mimeType: task.result?.mimeType || "video/mp4", durationMs: task.result?.durationMs }],
    }).catch((error) => console.error("Creative video asset registration failed", error));
}

async function queryVideoUpstream(task: VideoTask, origin: string, cookie: string, workerUserId = "") {
    const createPath = task.upstream.pollPath || "/video/generations";
    const preset = globalAiOpcPreset(task);
    const seedanceSpecial = task.config.advancedConfig?.protocol === "seedance-special";
    const paths = preset?.queryPath
        ? [preset.queryPath.replace(/:(?:task_id|taskId|id)\b/g, encodeURIComponent(task.upstream.id))]
        : providerQueryPaths(task.config.advancedConfig, task.upstream.id, [
              `${createPath.replace(/\/+$/, "")}/${encodeURIComponent(task.upstream.id)}`,
              `/videos/${encodeURIComponent(task.upstream.id)}`,
              `/video/generations/${encodeURIComponent(task.upstream.id)}`,
              `/videos/generations/${encodeURIComponent(task.upstream.id)}`,
              `/result?id=${encodeURIComponent(task.upstream.id)}`,
          ]);
    let lastError = "";
    const isDola = task.config.advancedConfig?.protocol === "dola";
    for (const path of paths) {
        const response = await fetchInternalApi(`${origin}${task.config.baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`, {
            headers: videoProxyHeaders(task, cookie, workerUserId),
            cache: "no-store",
            signal: AbortSignal.timeout(Math.min(resolveModelRequestTimeoutMs(task.config, "video"), 60_000)),
        });
        if (seedanceSpecial && videoContentReady(response)) {
            await response.body?.cancel().catch(() => undefined);
            return { status: "completed", video_url: path };
        }
        const text = await response.text();
        if (!response.ok) {
            lastError = readVideoProviderHttpError(text, response.status);
            // Dola 轮询 404 且明确返回 task not found：上游任务已丢失（Provider 重启清理），属终态失败。
            if (isDola && response.status === 404 && /task not found/i.test(text)) {
                const notFoundError = new Error("Dola 任务在 Provider 中不存在（可能已被服务重启清理）");
                (notFoundError as { code?: string }).code = "DOLA_TASK_NOT_FOUND";
                throw notFoundError;
            }
            continue;
        }
        try {
            return parseVideoProviderJson(text);
        } catch (error) {
            if (!seedanceSpecial) throw error;
            lastError = "视频查询接口返回了非 JSON 内容";
        }
    }
    const contentPath = seedanceSpecial ? await readyVideoContentPath(task, origin, cookie, workerUserId) : "";
    if (contentPath) return { status: "completed", video_url: contentPath };
    throw new Error(lastError || "视频任务查询失败");
}

async function readyVideoContentPath(task: VideoTask, origin: string, cookie: string, workerUserId: string) {
    const id = encodeURIComponent(task.upstream.id);
    const paths = [`/v1/videos/${id}/content`, `/videos/${id}/content`];
    for (const path of paths) {
        const url = `${origin}${task.config.baseUrl.replace(/\/+$/, "")}${path}`;
        const headers = videoProxyHeaders(task, cookie, workerUserId);
        const head = await fetchInternalApi(url, { method: "HEAD", headers, cache: "no-store", signal: AbortSignal.timeout(60_000) }).catch(() => null);
        if (head && videoContentReady(head)) return path;
        if (head && ![405, 501].includes(head.status)) continue;
        const rangeHeaders = new Headers(headers);
        rangeHeaders.set("range", "bytes=0-0");
        const probe = await fetchInternalApi(url, { headers: rangeHeaders, cache: "no-store", signal: AbortSignal.timeout(60_000) }).catch(() => null);
        if (!probe) continue;
        const ready = videoContentReady(probe);
        await probe.body?.cancel().catch(() => undefined);
        if (ready) return path;
    }
    return "";
}

function videoContentReady(response: Response) {
    if (!response.ok) return false;
    const contentType = response.headers.get("content-type")?.toLowerCase() || "";
    const disposition = response.headers.get("content-disposition")?.toLowerCase() || "";
    return contentType.startsWith("video/") || contentType === "application/octet-stream" || /filename[^;]*\.(?:mp4|webm|mov|m4v)\b/.test(disposition);
}

function videoProxyHeaders(task: VideoTask, cookie: string, workerUserId: string) {
    return {
        ...(workerUserId ? maintenanceWorkerHeaders(workerUserId) : cookie ? { cookie } : {}),
        ...systemAiBillingHeaders(generationModelId(task.config), undefined, task.config.model),
    };
}

function globalAiOpcPreset(task: VideoTask) {
    const preset = resolveGlobalAiOpcPreset(task.config.advancedConfig, task.config.model);
    return preset?.capability === "video" ? preset : undefined;
}

function contentEndpointResultUrl(task: VideoTask, status: string) {
    const resultField = task.config.advancedConfig?.resultField || "";
    return VIDEO_PROVIDER_SUCCESS.has(status) && resultField.startsWith("/") && resultField.includes(":task_id") ? resultField.replace(/:task_id\b/g, encodeURIComponent(task.upstream.id)) : "";
}

function isGeminiVideoTask(task: VideoTask) {
    return task.config.apiFormat === "gemini" && task.config.advancedConfig?.protocol !== "globalaiopc";
}

function dreaminaCliResultMimeType(value: string) {
    const path = value.split("?", 1)[0].toLowerCase();
    return path.endsWith(".webm") ? "video/webm" : path.endsWith(".mov") ? "video/quicktime" : "video/mp4";
}
