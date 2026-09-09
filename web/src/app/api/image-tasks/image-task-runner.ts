import { generationModelId } from "@/lib/server/generation-channel";
import { recordGenerationTaskLogResult } from "@/lib/server/generation-log-task-service";
import type { ImageTask } from "@/lib/server/image-task-store";

import { chatGptApiExportUpscaleLongEdge, isChatGptApiImageTaskConfig } from "./image-task-chatgpt";
import { resolveResultSize } from "./image-task-size";

export function stableMediaUrl(value?: string) {
    return value && !value.startsWith("data:") && !value.startsWith("blob:") ? value : "";
}

export async function writeImageGenerationLog(task: ImageTask, status: "success" | "failed", result: Array<{ dataUrl?: string; remoteUrl?: string }> | { dataUrl?: string; remoteUrl?: string } | string, durationMs: number, error?: string) {
    const publicPrompt = task.publicPrompt?.trim() || task.prompt;
    const results = Array.isArray(result) ? result : [result];
    // A CLI upscale result must retain the upstream dimensions.  Never route it
    // through the normal workbench target-size resize path.
    const targetSize = task.kind === "upscale" ? undefined : resolveResultSize(task.config.quality, task.config.size || "auto");
    const upscaleLongEdge = isChatGptApiImageTaskConfig(task.config) ? chatGptApiExportUpscaleLongEdge(task.config.quality) : undefined;
    const assets = results.flatMap((item) => {
        const resultUrl = typeof item === "string" ? item : item.remoteUrl || item.dataUrl || "";
        return resultUrl ? [{ type: "image" as const, url: resultUrl, remoteUrl: typeof item === "string" ? undefined : item.remoteUrl, targetSize, upscaleLongEdge }] : [];
    });
    return recordGenerationTaskLogResult({
        logId: task.generationLogId,
        slotId: task.generationSlotId,
        clientRequestId: task.clientRequestId,
        taskId: task.id,
        userId: task.userId,
        username: task.username,
        displayName: task.displayName,
        kind: "image",
        source: task.source || "image-workbench",
        status,
        title: task.title || publicPrompt.slice(0, 36) || "图片生成",
        prompt: publicPrompt,
        model: generationModelId(task.config),
        summary: status === "success" ? (task.kind === "upscale" ? "图片超清调用完成" : task.kind === "edit" ? "图生图调用完成" : "文生图调用完成") : "图片生成失败",
        durationMs,
        assets,
        error,
        canRetry: status === "failed" && task.retryable === true,
        taskKind: task.kind,
        createdAt: task.createdAt,
    });
}
