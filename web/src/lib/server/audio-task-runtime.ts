import { refundUserPoints } from "@/lib/auth/store";
import { fileTypeFromBuffer } from "file-type";
import { mediaTaskSource } from "@/lib/media-management-contract";
import { audioTaskRefundIdempotencyKey, refundAudioTask } from "@/lib/server/audio-task-refund";
import { getAudioTask, transitionAudioTask, updateAudioTask, type AudioTask } from "@/lib/server/audio-task-store";
import { generationModelId, systemGenerationChannelId } from "@/lib/server/generation-channel";
import { generationMediaProxyHeaders } from "@/lib/server/generation-media-authorization";
import { finishGenerationAttempt, startGenerationAttempt } from "@/lib/server/generation-attempt";
import { fetchInternalApi, isInternalApiBaseUrl } from "@/lib/server/internal-origin";
import { maintenanceWorkerHeaders } from "@/lib/server/maintenance-auth";
import { resolveModelRequestTimeoutMs } from "@/lib/server/model-request-policy";
import { buildProviderRequest, isProviderBusinessError, providerQueryPaths, readProviderError, readProviderString, resolvedProviderCreatePaths } from "@/lib/server/provider-task-config";
import { writePersistentMediaDataUrl } from "@/lib/server/reference-asset-store";
import { registerGenerationTaskAssetsForUser } from "@/lib/server/creative-runtime-service";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { GenerationSubmissionSafeFailure, GenerationSubmissionUncertainError, generationSubmissionResponseError, generationSubmissionUncertainError } from "@/lib/server/generation-submission-error";
import { systemAiBillingHeaders } from "@/lib/server/system-ai-billing";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import { appendMiniMaxRequestLog, saveMiniMaxMusicRecord, updateMiniMaxRequestLog } from "@/lib/server/minimax-audio-store";
import { resolveAudioSampleRate } from "@/lib/server/audio-task-config";

export type AudioUpstreamStep =
    | { state: "pending"; status: string; upstreamTaskId: string; createPath: string; pointsCost?: number; pointsRecordId?: string }
    | { state: "result_ready"; status: string; resultUrl: string; pointsCost?: number; pointsRecordId?: string }
    | { state: "completed" }
    | { state: "failed"; status: string; error: string };

export async function createAudioTaskUpstreamStep(task: AudioTask, origin: string, cookie = "", workerUserId = ""): Promise<AudioUpstreamStep> {
    const current = await getAudioTask(task.id);
    if (!current || current.status === "cancelled") return { state: "failed", status: "cancelled", error: "任务已取消" };
    const running = current.status === "pending" ? await transitionAudioTask(current, ["pending"], { status: "running" }) : current;
    if (!running) return { state: "failed", status: "conflict", error: "音频任务状态已变化" };
    if (running.upstream?.id) return queryAudioTaskUpstreamStep(running, origin, cookie, workerUserId);

    const candidates = [running.config, ...(running.candidateConfigs || [])];
    let attempts = running.attempts || [];
    let latestError = "没有可用的音频渠道";
    for (const [index, config] of candidates.entries()) {
        const started = startGenerationAttempt(attempts, { channelId: config.channelId, model: generationModelId(config), capability: "audio" });
        attempts = started.attempts;
        const candidate = { ...running, config, candidateConfigs: candidates.slice(index + 1), attempts, attemptNo: started.attempt.attemptNo, upstream: undefined, billing: undefined };
        await updateAudioTask(task.id, { config, candidateConfigs: candidate.candidateConfigs, attempts, attemptNo: candidate.attemptNo, upstream: undefined, billing: undefined });
        await scheduleGenerationTask("audio", task.id, { executionPhase: "submitting", nextPollAt: Date.now(), channelId: config.channelId, provider: config.advancedConfig?.protocol || config.apiFormat, lastUpstreamStatus: "submitting" });
        const minimaxLog = config.advancedConfig?.protocol === "minimax-audio" || config.advancedConfig?.protocol === "aliyun-bailian-audio" || config.advancedConfig?.protocol === "tencent-tokenhub-music"
            ? index === 0 && running.miniMaxRequestLogId
                ? { id: running.miniMaxRequestLogId, createdAt: new Date(running.createdAt).toISOString() }
                : await appendMiniMaxRequestLog({
                      userId: task.userId,
                      capability: config.audioMode === "music" || config.model.startsWith("music-") || config.model === "minimax-music-v3.0" ? "music" : "speech",
                      method: "POST",
                      path: config.advancedConfig?.createPath || (config.model.startsWith("music-") || config.model === "minimax-music-v3.0" ? "/v1/music_generation" : "/v1/t2a_v2"),
                      model: config.model,
                      statusCode: 0,
                      durationMs: 0,
                      phase: "running",
                      requestPreview: JSON.stringify({ model: config.model, mode: config.audioMode || "tts" }),
                      lifecycle: [{ at: new Date().toISOString(), phase: "running", message: config.advancedConfig?.protocol === "aliyun-bailian-audio" ? "已提交阿里云百炼音频请求" : config.advancedConfig?.protocol === "tencent-tokenhub-music" ? "已提交腾讯云 TokenHub 音乐请求" : "已提交 MiniMax 音频请求" }],
                      provider: config.advancedConfig?.protocol === "aliyun-bailian-audio" ? "aliyun-bailian" : config.advancedConfig?.protocol === "tencent-tokenhub-music" ? "tencent-tokenhub" : "minimax",
                  }).then((log) => {
                      void updateAudioTask(task.id, { miniMaxRequestLogId: log.id });
                      return log;
                  }).catch(() => undefined)
            : undefined;

        let minimaxResponseStatus = 0;
        try {
            const isQwen = config.advancedConfig?.protocol === "aliyun-bailian-audio";
            const qwenRate = boundedNumber(config.speed, 0.5, 2, 1);
            const qwenVolume = config.volume === "1" ? 50 : boundedNumber(config.volume, 0, 100, 50);
            const qwenPitch = config.pitch === "0" ? 1 : boundedNumber(config.pitch, 0.5, 2, 1);
            const defaults = {
                model: config.model,
                input: candidate.prompt,
                prompt: candidate.prompt,
                text: candidate.prompt,
                voice: config.voice,
                response_format: config.format,
                format: config.format,
                speed: Number(config.speed) || 1,
                rate: isQwen ? qwenRate : Number(config.speed) || 1,
                volume: isQwen ? qwenVolume : Number(config.volume) || 1,
                pitch: isQwen ? qwenPitch : Number(config.pitch) || 0,
                voice_setting: {
                    voice_id: config.voice,
                    speed: Number(config.speed) || 1,
                    vol: Number(config.volume) || 1,
                    pitch: Number(config.pitch) || 0,
                    ...(config.emotion ? { emotion: config.emotion } : {}),
                },
                audio_setting: {
                    sample_rate: Number(resolveAudioSampleRate(config.sampleRate, config.advancedConfig?.protocol)),
                    bitrate: Number(config.bitrate) || 128000,
                    format: config.format || "mp3",
                    channel: Number(config.channel) || 1,
                },
                sample_rate: Number(resolveAudioSampleRate(config.sampleRate, config.advancedConfig?.protocol)),
                language_boost: config.languageBoost || "",
                lyrics: config.lyrics || candidate.prompt,
                is_instrumental: config.isInstrumental === true,
                lyrics_optimizer: config.lyricsOptimizer !== false,
                instructions: config.instructions || "",
            };
            let payload: Record<string, unknown>;
            try {
                payload = buildProviderRequest(config.advancedConfig?.requestTemplate, defaults, defaults);
            } catch (error) {
                throw new GenerationSubmissionSafeFailure(error instanceof Error ? error.message : "音频请求模板无效");
            }
            if (minimaxLog) await updateMiniMaxRequestLog(minimaxLog.id, { statusCode: 0, durationMs: Date.now() - new Date(minimaxLog.createdAt).getTime(), phase: "running", requestPreview: JSON.stringify({ model: config.model, mode: config.audioMode || "tts", request: payload }), lifecycle: [{ at: new Date().toISOString(), phase: "running", message: config.advancedConfig?.protocol === "tencent-tokenhub-music" ? "开始调用腾讯云 TokenHub 音乐接口" : config.advancedConfig?.protocol === "aliyun-bailian-audio" ? "开始调用阿里云百炼音频接口" : "开始调用 MiniMax 音频接口" }] });
            const { response, path } = await createAudioUpstream(candidate, origin, cookie, workerUserId, payload);
            minimaxResponseStatus = response.status;
            if (minimaxLog) await updateMiniMaxRequestLog(minimaxLog.id, { statusCode: response.status, durationMs: Date.now() - new Date(minimaxLog.createdAt).getTime(), phase: response.ok ? "running" : "failed", ...(response.ok ? {} : { error: `HTTP ${response.status}` }) });
            const billing = readBilling(response.headers);
            if (billing.pointsRecordId) await updateAudioTask(task.id, { billing: { pointsCost: billing.pointsCost ?? 0, pointsRecordId: billing.pointsRecordId, refunded: false } });
            const contentType = response.headers.get("content-type")?.split(";")[0].toLowerCase() || "";
            if (!contentType.includes("json")) {
                const completed = await persistAudioBytes(candidate, origin, Buffer.from(await response.arrayBuffer()), contentType);
                if (completed?.status === "success") {
                    await markAudioAttemptSucceeded(candidate, billing);
                    if (minimaxLog) await updateMiniMaxRequestLog(minimaxLog.id, { statusCode: response.status, durationMs: Date.now() - new Date(minimaxLog.createdAt).getTime(), phase: "success", responsePreview: "音频已返回并持久化", lifecycle: [{ at: new Date().toISOString(), phase: "success", message: "音频已生成" }] });
                    return { state: "completed" };
                }
                return { state: "failed", status: completed?.status || "cancelled", error: completed?.error || "任务已取消" };
            }

            let data: unknown;
            try {
                data = await response.json();
            } catch {
                throw new GenerationSubmissionUncertainError("音频接口返回了无效 JSON，创建结果待确认");
            }
            if (isProviderBusinessError(data)) throw new GenerationSubmissionSafeFailure(readProviderError(data) || "音频接口返回失败");
            if (config.advancedConfig?.protocol === "minimax-audio") {
                const statusCode = readProviderString(data, "base_resp.status_code", []);
                if (statusCode && statusCode !== "0") throw new GenerationSubmissionSafeFailure(readProviderString(data, "base_resp.status_msg", []) || "MiniMax 音频接口返回失败");
                const hexAudio = readProviderString(data, "data.audio", []);
                if (isHexAudio(hexAudio)) {
                    const completed = await persistAudioBytes(candidate, origin, Buffer.from(hexAudio, "hex"), mimeFromFormat(config.format || "mp3"), false);
                    if (completed?.status === "success") {
                        await markAudioAttemptSucceeded(candidate, billing);
                        if (minimaxLog) await updateMiniMaxRequestLog(minimaxLog.id, { statusCode: response.status, durationMs: Date.now() - new Date(minimaxLog.createdAt).getTime(), phase: "success", responsePreview: "MiniMax 十六进制音频已解码并持久化", lifecycle: [{ at: new Date().toISOString(), phase: "success", message: "MiniMax 音频已完成" }] });
                        return { state: "completed" };
                    }
                    return { state: "failed", status: completed?.status || "cancelled", error: completed?.error || "任务已取消" };
                }
            }
            const directUrl = readProviderString(data, config.advancedConfig?.protocol === "aliyun-bailian-audio" ? "output.audio.url" : config.advancedConfig?.resultField, AUDIO_KEYS);
            if (directUrl) {
                const submittedAt = Date.now();
                await scheduleGenerationTask("audio", task.id, {
                    executionPhase: "result_ready",
                    channelId: config.channelId,
                    provider: config.advancedConfig?.protocol || config.apiFormat,
                    submittedAt,
                    nextPollAt: submittedAt,
                    lastUpstreamStatus: "completed",
                    resultPayload: { url: directUrl },
                });
                return { state: "result_ready", status: "completed", resultUrl: directUrl, ...billing };
            }
            const encodedAudio = readProviderString(data, "output.audio.data", []);
            if (encodedAudio) {
                const normalized = encodedAudio.replace(/^data:[^,]+,/, "").trim();
                if (normalized && /^[A-Za-z0-9+/=\s]+$/.test(normalized)) {
                    const completed = await persistAudioBytes(candidate, origin, Buffer.from(normalized, "base64"), mimeFromFormat(config.format || "mp3"), false);
                    if (completed?.status === "success") {
                        await markAudioAttemptSucceeded(candidate, billing);
                        if (minimaxLog) await updateMiniMaxRequestLog(minimaxLog.id, { statusCode: response.status, durationMs: Date.now() - new Date(minimaxLog.createdAt).getTime(), phase: "success", responsePreview: "阿里云百炼音频数据已解码并持久化", lifecycle: [{ at: new Date().toISOString(), phase: "success", message: "音频已生成" }] });
                        return { state: "completed" };
                    }
                    return { state: "failed", status: completed?.status || "cancelled", error: completed?.error || "任务已取消" };
                }
            }
            const id = readProviderString(data, undefined, ID_KEYS);
            if (!id) throw new GenerationSubmissionUncertainError("音频接口没有返回音频或任务 ID，创建结果待确认");
            await updateAudioTask(task.id, { upstream: { id, createPath: path } });
            const submittedAt = Date.now();
            await scheduleGenerationTask("audio", task.id, {
                executionPhase: "submitted",
                upstreamTaskId: id,
                channelId: config.channelId,
                provider: config.advancedConfig?.protocol || config.apiFormat,
                queryPath: config.advancedConfig?.queryPath,
                submittedAt,
                nextPollAt: submittedAt,
                lastUpstreamStatus: "submitted",
            });
            return { state: "pending", status: "submitted", upstreamTaskId: id, createPath: path, ...billing };
        } catch (error) {
            if (minimaxLog) await updateMiniMaxRequestLog(minimaxLog.id, { statusCode: minimaxResponseStatus || (error instanceof GenerationSubmissionSafeFailure ? error.status || 502 : 0), durationMs: Date.now() - new Date(minimaxLog.createdAt).getTime(), phase: "failed", error: error instanceof Error ? error.message.slice(0, 500) : "MiniMax 音频请求失败", lifecycle: [{ at: new Date().toISOString(), phase: "failed", message: error instanceof Error ? error.message.slice(0, 200) : "MiniMax 音频请求失败" }] }).catch(() => undefined);
            if (!(error instanceof GenerationSubmissionSafeFailure)) throw generationSubmissionUncertainError(error, "音频任务创建结果未知");
            latestError = error.message;
            attempts = finishGenerationAttempt(attempts, candidate.attemptNo, { status: "failed", error: latestError });
            await refundAudioCandidate(candidate);
            await updateAudioTask(task.id, { attempts, attemptNo: candidate.attemptNo, upstream: undefined, billing: undefined });
        }
    }
    return { state: "failed", status: "failed", error: latestError };
}

export async function queryAudioTaskUpstreamStep(task: AudioTask, origin: string, cookie = "", workerUserId = ""): Promise<AudioUpstreamStep> {
    if (!task.upstream?.id) return { state: "failed", status: "missing_upstream_id", error: "音频任务缺少上游任务 ID" };
    let lastError = "";
    for (const path of providerQueryPaths(task.config.advancedConfig, task.upstream.id, [`${task.upstream.createPath.replace(/\/+$/, "")}/${encodeURIComponent(task.upstream.id)}`])) {
        const response = await providerFetch(task, origin, cookie, workerUserId, path, { cache: "no-store", signal: AbortSignal.timeout(Math.min(resolveModelRequestTimeoutMs(task.config, "audio"), 60_000)) });
        const text = await response.text();
        if (!response.ok) {
            lastError = readAudioError(text, response.status);
            continue;
        }
        let data: unknown;
        try {
            data = JSON.parse(text);
        } catch {
            lastError = "音频任务查询返回了无效 JSON";
            continue;
        }
        const result = readProviderString(data, task.config.advancedConfig?.resultField, AUDIO_KEYS);
        const status = readProviderString(data, task.config.advancedConfig?.statusField, STATUS_KEYS).toLowerCase();
        if (result) return { state: "result_ready", status: status || "completed", resultUrl: result };
        if (FAILED.has(status)) return { state: "failed", status, error: readProviderString(data, undefined, ERROR_KEYS) || "音频生成失败" };
        return { state: "pending", status: status || "processing", upstreamTaskId: task.upstream.id, createPath: task.upstream.createPath };
    }
    throw new Error(lastError || "音频任务查询失败");
}

export async function persistAudioTaskResult(task: AudioTask, origin: string, resultUrl: string, cookie = "", workerUserId = "") {
    if (/^data:audio\//i.test(resultUrl)) {
        const asset = await writePersistentMediaDataUrl(resultUrl, "audio", mediaContext(task));
        return completeAudioTask(task, asset.url || `/api/reference-assets/${asset.token}`, resultUrl.slice(5, resultUrl.indexOf(";")) || mimeFromFormat(task.config.format || "mp3"));
    }
    const path = /^https?:\/\//i.test(resultUrl) ? `/_media?url=${encodeURIComponent(resultUrl)}` : `/${resultUrl.replace(/^\/+/, "")}`;
    const response = await providerFetch(task, origin, cookie, workerUserId, path, { signal: AbortSignal.timeout(resolveModelRequestTimeoutMs(task.config, "audio")) });
    if (!response.ok) throw new Error(readAudioError(await response.text(), response.status));
    return persistAudioBytes(task, origin, Buffer.from(await response.arrayBuffer()), response.headers.get("content-type")?.split(";")[0] || "");
}

export async function markAudioTaskFailed(task: AudioTask, error: string) {
    const current = (await getAudioTask(task.id)) || task;
    if (current.status === "cancelled" || current.status === "success") return current;
    const billing = current.billing;
    if (billing?.pointsRecordId && !billing.refunded) {
        await refundUserPoints(current.userId, generationModelId(current.config), billing.pointsCost, "audio", 1, audioTaskRefundIdempotencyKey({ id: current.id, attemptNo: current.attemptNo }), billing.pointsRecordId);
        await updateAudioTask(current.id, { billing: { ...billing, refunded: true } });
    }
    const attempts = finishGenerationAttempt(current.attempts || [], current.attemptNo || current.attempts?.at(-1)?.attemptNo || 1, { status: "failed", error, pointsCost: billing?.pointsCost, pointsRecordId: billing?.pointsRecordId });
    await updateAudioTask(current.id, { attempts, candidateConfigs: [], attemptNo: attempts.at(-1)?.attemptNo });
    const failed = await transitionAudioTask(current, ["pending", "running"], { status: "error", error: error.slice(0, 500), config: { ...current.config, apiKey: "" }, billing: billing ? { ...billing, refunded: true } : undefined });
    if (failed) {
        await settleAudioRequestLog(failed, "failed", error);
        await settleBailianAudioRecord(failed, { status: "failed", error: error.slice(0, 500) });
    }
    return failed;
}

async function settleAudioRequestLog(task: AudioTask, phase: "success" | "failed", message: string) {
    if (!task.miniMaxRequestLogId) return;
    await updateMiniMaxRequestLog(task.miniMaxRequestLogId, {
        statusCode: phase === "success" ? 200 : 502,
        durationMs: Math.max(0, Date.now() - task.createdAt),
        phase,
        ...(phase === "success" ? { responsePreview: message } : { error: message.slice(0, 500) }),
        lifecycle: [{ at: new Date().toISOString(), phase, message: message.slice(0, 200) }],
    }).catch(() => undefined);
}

async function createAudioUpstream(task: AudioTask, origin: string, cookie: string, workerUserId: string, payload: Record<string, unknown>) {
    let lastError = "";
    let lastStatus = 0;
    const idempotencyKey = `audio-task:${task.id}:attempt:${task.attemptNo || 1}`;
    for (const path of resolvedProviderCreatePaths(task.config.advancedConfig, "audio", ["/audio/speech"])) {
        let response: Response;
        try {
            response = await providerFetch(task, origin, cookie, workerUserId, path, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Idempotency-Key": idempotencyKey,
                    "X-Client-Request-Id": idempotencyKey,
                    ...(task.config.baseUrl.startsWith("/") ? systemAiBillingHeaders(generationModelId(task.config), idempotencyKey, task.config.model) : {}),
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(resolveModelRequestTimeoutMs(task.config, "audio")),
            });
        } catch (error) {
            throw generationSubmissionUncertainError(error, "音频任务创建结果未知");
        }
        if (response.ok) return { response, path };
        lastError = readAudioError(await response.text(), response.status);
        lastStatus = response.status;
        const responseError = generationSubmissionResponseError(response.status, lastError);
        if (responseError instanceof GenerationSubmissionUncertainError) throw responseError;
    }
    throw new GenerationSubmissionSafeFailure(lastError || "没有可用的音频创建接口", lastStatus);
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

async function refundAudioCandidate(task: AudioTask) {
    const current = await getAudioTask(task.id);
    const billing = current?.billing;
    if (!billing?.pointsRecordId || billing.refunded) return;
    await refundUserPoints(task.userId, generationModelId(task.config), billing.pointsCost, "audio", 1, audioTaskRefundIdempotencyKey({ id: task.id, attemptNo: task.attemptNo }), billing.pointsRecordId);
}

async function persistAudioBytes(task: AudioTask, origin: string, bytes: Buffer, responseMime: string, settleRequestLog = true) {
    if (!bytes.length || bytes.length > 30 * 1024 * 1024) throw new Error("音频结果为空或超过 30MB 限制");
    const detected = await fileTypeFromBuffer(bytes);
    const detectedMime = detected?.mime.startsWith("audio/") ? detected.mime : "";
    const declaredMime = responseMime.toLowerCase().startsWith("audio/") ? responseMime.toLowerCase() : "";
    if (!detectedMime && (!declaredMime || looksLikeTextResponse(bytes))) throw new GenerationSubmissionSafeFailure("音频接口返回的不是有效音频文件");
    const mimeType = detectedMime || declaredMime || mimeFromFormat(task.config.format || "mp3");
    const asset = await writePersistentMediaDataUrl(`data:${mimeType};base64,${bytes.toString("base64")}`, "audio", mediaContext(task));
    return completeAudioTask(task, asset.url || `/api/reference-assets/${asset.token}`, mimeType, settleRequestLog);
}

function looksLikeTextResponse(bytes: Buffer) {
    const prefix = bytes.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
    return prefix.startsWith("<!doctype") || prefix.startsWith("<html") || prefix.startsWith("{") || prefix.startsWith("[");
}

async function completeAudioTask(task: AudioTask, url: string, mimeType: string, settleRequestLog = true) {
    const current = await getAudioTask(task.id);
    if (!current || current.status === "cancelled") {
        if (current?.status === "cancelled") await refundAudioTask(current);
        return current;
    }
    const completed = await transitionAudioTask(current, ["pending", "running"], { status: "success", result: { url, mimeType }, config: { ...current.config, apiKey: "" }, billing: current.billing });
    if (!completed) {
        const latest = await getAudioTask(task.id);
        if (latest?.status === "cancelled") await refundAudioTask(latest);
        return latest;
    }
    if (settleRequestLog) await settleAudioRequestLog(completed, "success", "音频结果已生成并持久化");
    await settleBailianAudioRecord(completed, { status: "success", resultUrl: url, mimeType });
    await registerGenerationTaskAssetsForUser(completed.userId, {
        ...completed,
        taskId: completed.id,
        title: completed.prompt.slice(0, 80) || "生成音频",
        assets: [{ type: "audio", url, mimeType }],
    }).catch((error) => console.error("Creative audio asset registration failed", error));
    if ((completed.config.advancedConfig?.protocol === "minimax-audio" && completed.config.model.startsWith("music-")) || (completed.config.advancedConfig?.protocol === "tencent-tokenhub-music" && completed.config.model === "minimax-music-v3.0")) {
        await saveMiniMaxMusicRecord({ userId: completed.userId, name: completed.prompt.slice(0, 80) || "MiniMax 音乐", model: completed.config.model, prompt: completed.config.instructions || completed.prompt, lyrics: completed.config.lyrics || "", resultUrl: url, status: "success", metadata: { format: completed.config.format || "mp3", provider: completed.config.advancedConfig?.protocol === "tencent-tokenhub-music" ? "tencent-tokenhub" : "minimax" } }).catch((error) => console.error("MiniMax music record failed", error));
    }
    return completed;
}

async function settleBailianAudioRecord(task: AudioTask, patch: { status: "success" | "failed"; resultUrl?: string; mimeType?: string; error?: string }) {
    if (task.config.advancedConfig?.protocol !== "aliyun-bailian-audio") return;
    try {
        const store = await import("@/lib/server/minimax-audio-store");
        if (typeof store.updateBailianAudioRecord !== "function") return;
        const updated = await store.updateBailianAudioRecord(task.id, patch);
        if (updated || typeof store.saveBailianAudioRecord !== "function") return;
        await store.saveBailianAudioRecord({
            taskId: task.id,
            userId: task.userId,
            model: task.config.model,
            audioMode: task.config.audioMode || "tts",
            prompt: task.config.instructions || "",
            textContent: task.prompt,
            voice: task.config.voice,
            format: task.config.format,
            sampleRate: task.config.sampleRate,
            ...patch,
            metadata: { source: task.source || "", recovered: true },
        });
    } catch (error) {
        console.error("Bailian audio record update failed", error);
    }
}

async function markAudioAttemptSucceeded(task: AudioTask, billing: { pointsCost?: number; pointsRecordId?: string }) {
    const current = await getAudioTask(task.id);
    if (!current) return;
    const attempts = finishGenerationAttempt(current.attempts || [], current.attemptNo || 1, { status: "succeeded", pointsCost: billing.pointsCost, pointsRecordId: billing.pointsRecordId });
    await updateAudioTask(task.id, { attempts, attemptNo: attempts.at(-1)?.attemptNo, candidateConfigs: [], billing: billing.pointsRecordId ? { pointsCost: billing.pointsCost ?? 0, pointsRecordId: billing.pointsRecordId, refunded: false } : undefined });
}

function providerFetch(task: AudioTask, origin: string, cookie: string, workerUserId: string, path: string, init: RequestInit) {
    const url = task.config.baseUrl.startsWith("/") ? `${origin}${task.config.baseUrl.replace(/\/+$/, "")}${path}` : `${task.config.baseUrl.replace(/\/+$/, "")}${path}`;
    const headers = new Headers(init.headers);
    if (task.config.baseUrl.startsWith("/") && workerUserId) Object.entries(maintenanceWorkerHeaders(workerUserId)).forEach(([key, value]) => headers.set(key, value));
    else if (cookie) headers.set("cookie", cookie);
    if (task.config.baseUrl.startsWith("/")) Object.entries(systemAiBillingHeaders(generationModelId(task.config), undefined, task.config.model)).forEach(([key, value]) => headers.set(key, value));
    const mediaUrl = task.config.baseUrl.startsWith("/") ? mediaUrlFromProxyPath(path) : "";
    const channelId = task.config.channelId || systemGenerationChannelId(task.config.baseUrl);
    if (mediaUrl && channelId) Object.entries(generationMediaProxyHeaders({ userId: task.userId, taskType: "audio", taskId: task.id, channelId, upstreamModel: task.config.model, url: mediaUrl })).forEach(([key, value]) => headers.set(key, value));
    if (!task.config.baseUrl.startsWith("/")) headers.set(task.config.apiFormat === "gemini" ? "x-goog-api-key" : "authorization", task.config.apiFormat === "gemini" ? task.config.apiKey : `Bearer ${task.config.apiKey}`);
    return isInternalApiBaseUrl(task.config.baseUrl) ? fetchInternalApi(url, { ...init, headers }) : fetchSafeOutbound(url, { ...init, headers }, { allowProxyFakeIpSpace: true });
}

function mediaUrlFromProxyPath(path: string) {
    try {
        const parsed = new URL(path, "http://internal");
        return parsed.pathname === "/_media" ? parsed.searchParams.get("url")?.trim() || "" : "";
    } catch {
        return "";
    }
}

function readBilling(headers: Headers) {
    const raw = headers.get("x-octalaicanvas-points-cost");
    const value = raw === null ? undefined : Number(raw);
    return { pointsCost: value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined, pointsRecordId: headers.get("x-octalaicanvas-points-record-id") || undefined };
}

function mediaContext(task: AudioTask) {
    return { ownerUserId: task.userId, source: mediaTaskSource(task.source, task, "audio-task"), conversationId: task.conversationId, runId: task.runId, taskId: task.id, projectId: task.projectId };
}

function mimeFromFormat(format: string) {
    return format === "wav" ? "audio/wav" : format === "opus" ? "audio/ogg" : format === "aac" ? "audio/aac" : format === "flac" ? "audio/flac" : "audio/mpeg";
}

function readAudioError(value: string, status: number) {
    try {
        const payload = JSON.parse(value) as { msg?: string; message?: string; error?: string | { message?: string } };
        const message = typeof payload.error === "string" ? payload.error : payload.error?.message || payload.msg || payload.message;
        return message?.trim().slice(0, 500) || `音频生成失败（${status}）`;
    } catch {
        return value.trim().slice(0, 500) || `音频生成失败（${status}）`;
    }
}

const ID_KEYS = ["task_id", "taskId", "id", "job_id", "jobId", "generation_id", "generationId"];
const STATUS_KEYS = ["status", "state", "task_status", "taskStatus"];
const AUDIO_KEYS = ["audio_url", "audioUrl", "media_url", "mediaUrl", "output_url", "outputUrl", "result_url", "resultUrl", "url", "uri"];
const ERROR_KEYS = ["error_message", "errorMessage", "message", "msg", "error"];
const FAILED = new Set(["failed", "failure", "error", "cancelled", "canceled", "expired"]);

function isHexAudio(value: string) {
    const normalized = value.trim();
    return normalized.length >= 32 && normalized.length % 2 === 0 && /^[0-9a-f]+$/i.test(normalized);
}
