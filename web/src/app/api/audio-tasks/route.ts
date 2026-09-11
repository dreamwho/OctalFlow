import { after, NextResponse } from "next/server";

import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings, isAuthInputError } from "@/lib/auth/store";
import { mediaTaskSource } from "@/lib/media-management-contract";
import { resolveAudioTaskOptions } from "@/lib/server/audio-task-config";
import { createAudioTask, type AudioTask, type AudioTaskConfig, updateAudioTask } from "@/lib/server/audio-task-store";
import { generationModelId, toSystemGenerationChannel } from "@/lib/server/generation-channel";
import { runGenerationTaskRecoveryBatch } from "@/lib/server/generation-task-recovery-service";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { getStoredGenerationTaskByRequest, effectiveGenerationConcurrencyLimit, linkStoredGenerationTask, withGenerationConcurrencyLimit, type GenerationTaskContext } from "@/lib/server/generation-task-store";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { appendMiniMaxRequestLog, saveBailianAudioRecord } from "@/lib/server/minimax-audio-store";
import { checkGenerationRateLimit, rateLimitHeaders } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const rate = await checkGenerationRateLimit(user.id, request, "audio");
    if (!rate.allowed) return NextResponse.json({ error: "音频生成请求过于频繁，请稍后重试" }, { status: 429, headers: rateLimitHeaders(rate) });
    const settings = await getAuthSettings();
    const response = await withGenerationConcurrencyLimit(user.id, "audio", 10 * 60 * 1000, effectiveGenerationConcurrencyLimit(user.role, settings.generationConcurrency.audio), async () => {
        let body: { config?: AudioTaskConfig; prompt?: string; source?: string; context?: GenerationTaskContext };
        try {
            body = await readJsonBody(request);
        } catch (error) {
            if (isAuthInputError(error)) return NextResponse.json({ error: error.message }, { status: error.status });
            throw error;
        }
        if (body.config?.audioMode === "voice-clone" || body.config?.audioMode === "voice-design") {
            return NextResponse.json({ error: "音色复刻和音色设计必须先完成音色创建，再使用文转语音生成" }, { status: 422 });
        }
        const channels = resolveLogicalModelCandidates(settings, "audio", body.config?.model || settings.defaultModels.audioModel).map((resolved) => ({ ...toSystemGenerationChannel(resolved), channelId: resolved.channelId }));
        const prompt = String(body.prompt || "").trim();
        const supportedChannels = channels.filter((channel) => channel.apiFormat !== "gemini");
        if (!supportedChannels.length || !prompt) return NextResponse.json({ error: "音频任务参数不完整或渠道不支持" }, { status: 400 });
        const configs: AudioTaskConfig[] = supportedChannels
            .map((channel) => ({ ...channel, ...resolveAudioTaskOptions(body.config, settings.generationDefaults), instructions: clean(body.config?.instructions, 2_000) }))
            .filter((config) => isMiniMaxVoiceFeatureEnabled(config, config.audioMode));
        if (!configs.length) return NextResponse.json({ error: "音频渠道不可用或未启用" }, { status: 403 });
        const requestId = body.context?.clientRequestId?.trim();
        if (requestId) {
            const existing = await getStoredGenerationTaskByRequest<AudioTask>("audio", user.id, requestId, body.context?.attemptNo);
            if (existing) return NextResponse.json({ task: publicTask(existing) });
        }
        let task: AudioTask = await createAudioTask({ ...(body.context || {}), userId: user.id, config: configs[0], candidateConfigs: configs.slice(1), prompt: prompt.slice(0, 20_000), source: mediaTaskSource(body.source, body.context, "audio-task") });
        if (configs[0].advancedConfig?.protocol === "aliyun-bailian-audio") {
            await saveBailianAudioRecord({
                taskId: task.id,
                userId: user.id,
                model: configs[0].model,
                audioMode: configs[0].audioMode || "tts",
                prompt: configs[0].instructions || "",
                textContent: task.prompt,
                voice: configs[0].voice,
                format: configs[0].format,
                sampleRate: configs[0].sampleRate,
                status: "pending",
                metadata: { source: task.source || "", clientRequestId: body.context?.clientRequestId || "" },
            }).catch((error) => console.error("Bailian audio record create failed", error));
        }
        if (configs[0].advancedConfig?.protocol === "minimax-audio" || configs[0].advancedConfig?.protocol === "aliyun-bailian-audio" || configs[0].advancedConfig?.protocol === "tencent-tokenhub-music") {
            const log = await appendMiniMaxRequestLog({
                userId: user.id,
                capability: configs[0].audioMode === "music" || configs[0].model.startsWith("music-") || configs[0].model === "minimax-music-v3.0" ? "music" : "speech",
                method: "POST",
                path: configs[0].advancedConfig?.createPath || (configs[0].model.startsWith("music-") || configs[0].model === "minimax-music-v3.0" ? "/v1/music_generation" : "/v1/t2a_v2"),
                model: configs[0].model,
                statusCode: 0,
                durationMs: 0,
                phase: "queued",
                requestPreview: JSON.stringify({ model: configs[0].model, mode: configs[0].audioMode || "tts" }),
                lifecycle: [{ at: new Date().toISOString(), phase: "queued", message: configs[0].advancedConfig?.protocol === "aliyun-bailian-audio" ? "音频任务已提交，等待阿里云百炼执行" : configs[0].advancedConfig?.protocol === "tencent-tokenhub-music" ? "音频任务已提交，等待腾讯云 TokenHub 执行" : "音频任务已提交，等待 MiniMax 执行" }],
                provider: configs[0].advancedConfig?.protocol === "aliyun-bailian-audio" ? "aliyun-bailian" : configs[0].advancedConfig?.protocol === "tencent-tokenhub-music" ? "tencent-tokenhub" : "minimax",
            }).catch(() => undefined);
            if (log) task = (await updateAudioTask(task.id, { miniMaxRequestLogId: log.id })) || task;
        }
        await linkStoredGenerationTask("audio", task.id, body.context || {});
        const origin = resolveInternalOrigin(new URL(request.url).origin);
        const cookie = request.headers.get("cookie") || "";
        await scheduleGenerationTask("audio", task.id, { executionPhase: "created", channelId: task.config.channelId, provider: task.config.advancedConfig?.protocol || task.config.apiFormat, nextPollAt: Date.now(), lastUpstreamStatus: "created" });
        after(() => runGenerationTaskRecoveryBatch({ origin, cookie, limit: 1, taskIds: [task.id] }));
        return NextResponse.json({ task: publicTask(task) });
    });
    return response || NextResponse.json({ error: "当前用户音频任务已达到并发上限" }, { status: 429 });
}

function isMiniMaxVoiceFeatureEnabled(config: AudioTaskConfig, mode: string | undefined) {
    if (config.advancedConfig?.protocol !== "minimax-audio") return true;
    if (mode === "voice-clone") return config.advancedConfig.minimaxVoiceCloneEnabled !== false;
    if (mode === "voice-design") return config.advancedConfig.minimaxVoiceDesignEnabled !== false;
    return true;
}

function publicTask(task: AudioTask) {
    return { id: task.id, status: task.status, model: generationModelId(task.config), attemptNo: task.attemptNo, result: task.result, error: task.error };
}

function clean(value: unknown, max: number) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}
