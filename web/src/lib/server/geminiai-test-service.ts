import { createUpstream } from "@/app/api/video-generation-tasks/video-generation-route";
import type { PublicUser } from "@/lib/auth/store";
import { getAuthSettings } from "@/lib/auth/store";
import { startGenerationAttempt } from "@/lib/server/generation-attempt";
import { toSystemGenerationChannel } from "@/lib/server/generation-channel";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { geminiVideoCreatePath } from "@/lib/server/gemini-video-provider";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { GeminiAiProviderError } from "@/lib/server/geminiai-provider";
import { resolveSavedGeminiVideoBinding } from "@/lib/server/geminiai-service";
import { failVideoTaskFromWorker, persistVideoTaskResult, queryVideoTaskUpstream } from "@/lib/server/video-task-runtime";
import { createVideoTask, getVideoTask, transitionVideoTask, updateVideoTask, type VideoTask } from "@/lib/server/video-task-store";

export type GeminiAiVideoTestResult = {
    status: "running" | "succeeded" | "failed";
    model: string;
    taskId: string;
    channelId: string;
    statusUrl: string;
    elapsedMs: number;
    videoUrl?: string;
    error?: string;
};

export async function createGeminiAiVideoTest(request: Request, user: PublicUser, input: { model?: unknown; prompt?: unknown; channelId?: unknown; size?: unknown; quality?: unknown }) {
    const model = requiredText(input.model, "视频模型", 200);
    const prompt = requiredText(input.prompt, "测试提示词", 20_000);
    const channelId = requiredText(input.channelId, "Gemini/Veo 渠道", 200);
    const settings = await getAuthSettings();
    const binding = resolveSavedGeminiVideoBinding(settings, model, channelId);
    if (!binding) throw new GeminiAiProviderError("所选视频模型不属于已保存且已启用的 Google Gemini / Veo 渠道", 422);
    const channel = toSystemGenerationChannel(binding);
    const started = startGenerationAttempt([], { channelId: channel.channelId, model: channel.model, capability: "video" });
    const parameters = {
        size: optionalText(input.size, 32) || "16:9",
        vquality: optionalText(input.quality, 32) || settings.generationDefaults.videoQuality,
        videoSeconds: settings.generationDefaults.videoSeconds,
        videoGenerateAudio: true,
    };
    const task = await createVideoTask({
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        title: "GeminiAI 视频测试",
        config: channel,
        upstream: { id: "", provider: "generation", model: channel.model, pollPath: geminiVideoCreatePath(channel.model) },
        requestedDurationSeconds: parameters.videoSeconds,
        prompt,
        source: "geminiai-admin-test",
        attempts: started.attempts,
    });
    const beganAt = Date.now();
    try {
        const origin = resolveInternalOrigin(new URL(request.url).origin);
        const cookie = request.headers.get("cookie")?.trim() || "";
        const upstream = await createUpstream(user.id, origin, cookie, channel, prompt, parameters, [], settings.generationPointMultipliers, `geminiai-admin-test:${task.id}`);
        await updateVideoTask(task.id, { upstream, attempts: started.attempts });
        return toVideoTestResult({ ...task, upstream, attempts: started.attempts }, beganAt);
    } catch (error) {
        const message = toSafeGenerationErrorMessage(error, "Gemini/Veo 视频测试创建失败");
        const failed = await transitionVideoTask(task, { status: "error", error: message, retryable: true });
        return toVideoTestResult(failed || { ...task, status: "error", error: message, retryable: true }, beganAt);
    }
}

export async function refreshGeminiAiVideoTest(request: Request, user: PublicUser, taskId: string, channelId: string) {
    const task = await getVideoTask(requiredText(taskId, "视频任务", 200));
    if (!task || task.userId !== user.id || task.source !== "geminiai-admin-test") throw new GeminiAiProviderError("视频测试任务不存在", 404);
    if (task.config.channelId !== requiredText(channelId, "Gemini/Veo 渠道", 200) || task.config.advancedConfig?.protocol !== "gemini") throw new GeminiAiProviderError("视频测试任务与 Gemini/Veo 渠道不匹配", 403);
    if (task.status !== "running") return toVideoTestResult(task, Date.now());

    const origin = resolveInternalOrigin(new URL(request.url).origin);
    const cookie = request.headers.get("cookie")?.trim() || "";
    try {
        const step = await queryVideoTaskUpstream(task, origin, cookie);
        if (step.state === "failed") return toVideoTestResult((await failVideoTaskFromWorker(task, step.error)) || task, Date.now());
        if (step.state === "result_ready") return toVideoTestResult((await persistVideoTaskResult(task, step.resultUrl, origin, cookie)) || task, Date.now());
        return toVideoTestResult(task, Date.now());
    } catch (error) {
        return {
            ...toVideoTestResult(task, Date.now()),
            status: "failed",
            error: toSafeGenerationErrorMessage(error, "Gemini/Veo 视频状态查询失败"),
        };
    }
}

function toVideoTestResult(task: VideoTask, beganAt: number): GeminiAiVideoTestResult {
    const status = task.status === "success" ? "succeeded" : task.status === "error" || task.status === "cancelled" ? "failed" : "running";
    const channelId = task.config.channelId || "";
    return {
        status,
        model: task.config.model,
        taskId: task.id,
        channelId,
        statusUrl: `/api/admin/geminiai/test?taskId=${encodeURIComponent(task.id)}&channelId=${encodeURIComponent(channelId)}`,
        elapsedMs: Math.max(0, Date.now() - (task.createdAt || beganAt)),
        ...(status === "succeeded" && task.result?.url ? { videoUrl: task.result.url } : {}),
        ...(status === "failed" && task.error ? { error: task.error } : {}),
    };
}

function requiredText(value: unknown, label: string, maxLength: number) {
    const text = optionalText(value, maxLength);
    if (!text || /[\u0000-\u001f\u007f]/.test(text)) throw new GeminiAiProviderError(`${label}无效`, 400);
    return text;
}

function optionalText(value: unknown, maxLength: number) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}
