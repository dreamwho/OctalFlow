import { basename, join } from "node:path";

import { hasProviderReadSignatureShape, isReferenceAssetUrl } from "@/lib/reference-asset-url";
import type { VideoGenerationReference } from "@/lib/video-reference-contract";
import { downloadMediaToFile } from "@/lib/server/media-download";
import { maintenanceWorkerContextHeaders } from "@/lib/server/maintenance-auth";
import { writeReferenceMediaFile } from "@/lib/server/reference-asset-store";
import { isDreaminaCliConfig, submitDreaminaCliTaskWithCreditObservation } from "@/lib/server/dreamina-cli-service";
import { assertDreaminaCliRegularFile, DreaminaCliProviderError, queryDreaminaCliTask, withDreaminaCliTempDirectory, type DreaminaCliRunner } from "@/lib/server/dreamina-cli-provider";
import { buildDreaminaCliSubmitArgs, dreaminaCliModel, normalizeDreaminaCliVideoParameters, type DreaminaCliCommand } from "@/lib/server/dreamina-cli-catalog";
import { finalizeDreaminaCliRequestLog } from "@/lib/server/dreamina-cli-store";
import type { SystemGenerationChannelConfig } from "@/lib/server/generation-channel";
import type { VideoTask } from "@/lib/server/video-task-store";

const MAX_REFERENCE_BYTES = {
    image: 20 * 1024 * 1024,
    video: 200 * 1024 * 1024,
    audio: 30 * 1024 * 1024,
} as const;

export type DreaminaCliVideoTaskInput = {
    userId: string;
    origin: string;
    cookie?: string;
    channel: SystemGenerationChannelConfig;
    prompt: string;
    raw: Record<string, unknown>;
    references: readonly VideoGenerationReference[];
    taskId?: string;
    attemptNo?: number;
    timeoutMs?: number;
    runner?: DreaminaCliRunner;
};

export type DreaminaCliVideoUpstream = {
    id: string;
    provider: "dreamina-cli";
    model: string;
    command: DreaminaCliCommand;
    pollPath: "query_result";
    queryPath: "query_result";
    transitionPrompts?: string[];
};

export type DreaminaCliVideoQuery =
    | { state: "pending"; status: string; creditCost?: number }
    | { state: "result_ready"; status: string; resultUrl: string; creditCost?: number }
    | { state: "needs_review"; status: string; error: string; creditCost?: number }
    | { state: "failed"; status: string; error: string; creditCost?: number };

export class DreaminaCliVideoTaskError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DreaminaCliVideoTaskError";
    }
}

export function isDreaminaCliVideoTask(config: Pick<SystemGenerationChannelConfig, "advancedConfig" | "channelId">) {
    return isDreaminaCliConfig(config);
}

export function dreaminaCliVideoCommand(references: readonly VideoGenerationReference[], options: { explicitRatio?: boolean; supportsMultimodal?: boolean } = {}) {
    const hasVideoOrAudio = references.some((reference) => reference.type === "video" || reference.type === "audio");
    const firstFrame = references.find((reference) => reference.role === "first_frame");
    const lastFrame = references.find((reference) => reference.role === "last_frame");
    if (hasVideoOrAudio) return "multimodal2video" as const;
    if (firstFrame && lastFrame) return "frames2video" as const;
    const imageCount = references.filter((reference) => reference.type === "image").length;
    if (imageCount === 0) return "text2video" as const;
    if (imageCount === 1) return options.explicitRatio && options.supportsMultimodal ? ("multimodal2video" as const) : ("image2video" as const);
    if (options.supportsMultimodal) return "multimodal2video" as const;
    return "multiframe2video" as const;
}

export async function createDreaminaCliVideoUpstream(input: DreaminaCliVideoTaskInput): Promise<DreaminaCliVideoUpstream> {
    const configuredModel = dreaminaCliModel(input.channel.model);
    const command = dreaminaCliVideoCommand(input.references, {
        explicitRatio: hasExplicitRatio(input.raw.size),
        supportsMultimodal: Boolean(configuredModel?.commands.includes("multimodal2video")),
    });
    const model = canonicalVideoModel(input.channel.model, command);
    const staged = await withDreaminaCliTempDirectory(
        async (directory) => {
            const paths = await stageReferences(input.references, directory, input.origin, input.cookie);
            const submission = buildSubmissionInput(input, command, model.id, paths);
            try {
                buildDreaminaCliSubmitArgs(submission);
            } catch (error) {
                throw new DreaminaCliVideoTaskError(safeError(error));
            }
            return submitDreaminaCliTaskWithCreditObservation(submission, { taskId: input.taskId, attemptNo: input.attemptNo, modelId: model.id, timeoutMs: input.timeoutMs, runner: input.runner });
        },
        { prefix: input.taskId || "video" },
    );
    return {
        id: staged.submitId,
        provider: "dreamina-cli",
        model: model.id,
        command,
        pollPath: "query_result",
        queryPath: "query_result",
        ...(command === "multiframe2video" ? { transitionPrompts: transitionPrompts(input.raw, input.prompt, input.references) } : {}),
    };
}

export async function queryDreaminaCliVideoTask(task: VideoTask, options: { runner?: DreaminaCliRunner; timeoutMs?: number } = {}): Promise<DreaminaCliVideoQuery> {
    const submitId = task.upstream.id.trim();
    if (!submitId) throw new DreaminaCliVideoTaskError("即梦 CLI 任务缺少提交 ID");
    const startedAt = Date.now();
    try {
        const result = await withDreaminaCliTempDirectory(async (directory) => {
            const queried = await queryDreaminaCliTask({ submitId, downloadDir: directory }, options);
            if (queried.state === "pending") return { state: "pending", status: queried.status, ...(queried.creditCost !== undefined ? { creditCost: queried.creditCost } : {}) } as const;
            if (queried.state === "failed") return { state: "failed", status: queried.status, error: queried.error || "即梦 CLI 视频生成失败", ...(queried.creditCost !== undefined ? { creditCost: queried.creditCost } : {}) } as const;

            const output = queried.files.find((candidate) => /\.(?:mp4|webm|mov|m4v)$/i.test(basename(candidate)));
            if (!output) return { state: "needs_review", status: "result_persistence_failed", error: "即梦 CLI 已结束，但未返回可安全持久化的视频文件", ...(queried.creditCost !== undefined ? { creditCost: queried.creditCost } : {}) } as const;
            const safeOutput = await assertDreaminaCliRegularFile(output, directory);
            const asset = await writeReferenceMediaFile(safeOutput, "video", videoMimeType(safeOutput), true, {
                ownerUserId: task.userId,
                source: task.source || "dreamina-cli-video",
                conversationId: task.conversationId,
                runId: task.runId,
                taskId: task.id,
                projectId: task.projectId,
                originalName: basename(safeOutput),
            });
            const resultUrl = asset.url && isDreaminaCliPersistedResultUrl(asset.url) ? asset.url : referenceAssetPath(asset.token);
            return { state: "result_ready", status: queried.status, resultUrl, ...(queried.creditCost !== undefined ? { creditCost: queried.creditCost } : {}) } as const;
        });
        if (result.state !== "pending") {
            await finalizeVideoQueryLog(
                task,
                result.state === "failed" ? "failed" : result.state === "needs_review" ? "needs_review" : "success",
                { state: result.state, status: result.status },
                "error" in result ? result.error : undefined,
                result.creditCost,
            ).catch(() => undefined);
        }
        return result;
    } catch (error) {
        const message = safeError(error);
        if (error instanceof DreaminaCliProviderError && error.submissionState === "unknown") {
            throw error;
        }
        await finalizeVideoQueryLog(task, "needs_review", { state: "needs_review", status: "query_contract_missing" }, message).catch(() => undefined);
        return { state: "needs_review", status: "query_contract_missing", error: message || "即梦 CLI 查询结果无法安全确认" };
    }
}

export function isDreaminaCliPersistedResultUrl(value: string) {
    try {
        const pathname = new URL(value, "https://octalflow.invalid").pathname;
        return /^\/api\/reference-assets\/permanent\/(?:\d{4}\/\d{2}\/\d{2}\/)?videos\/[^/]+$/i.test(pathname);
    } catch {
        return false;
    }
}

function buildSubmissionInput(input: DreaminaCliVideoTaskInput, command: DreaminaCliCommand, modelId: string, paths: StagedReferences) {
    const video = normalizeDreaminaCliVideoParameters(modelId, {
        videoResolution: normalizeVideoResolution(input.raw.vquality),
        duration: positiveDuration(input.raw.videoSeconds),
    });
    const base = {
        command,
        modelId,
        prompt: input.prompt,
        ratio: normalizeRatio(input.raw.size),
        videoResolution: video.videoResolution,
        duration: video.duration,
    };
    if (command === "text2video") return base;
    if (command === "image2video") return { ...base, images: [paths.images[0] || paths.first || ""] };
    if (command === "frames2video") return { ...base, first: paths.first, last: paths.last };
    if (command === "multiframe2video") {
        const prompts = transitionPrompts(input.raw, input.prompt, input.references);
        return { ...base, modelId: "dreamina-multiframe-video", images: paths.images, transitionPrompts: prompts };
    }
    return { ...base, images: paths.images, videos: paths.videos, audios: paths.audios };
}

function canonicalVideoModel(value: string, command: DreaminaCliCommand) {
    const modelId = value.trim();
    const model = dreaminaCliModel(modelId);
    if (!model || model.id !== modelId || model.capability !== "video") throw new DreaminaCliVideoTaskError("即梦 CLI 视频任务必须使用固定目录中的 canonical Seedance 模型 ID");
    if (command !== "multiframe2video" && !model.commands.includes(command)) throw new DreaminaCliVideoTaskError("所选 Seedance 模型不支持当前视频参考方式");
    if (command === "multiframe2video") {
        const fixed = dreaminaCliModel("dreamina-multiframe-video");
        if (!fixed) throw new DreaminaCliVideoTaskError("即梦 CLI 智能多帧模型目录缺失");
        return fixed;
    }
    return model;
}

type StagedReferences = { images: string[]; videos: string[]; audios: string[]; first?: string; last?: string };

async function stageReferences(references: readonly VideoGenerationReference[], directory: string, origin: string, cookie = ""): Promise<StagedReferences> {
    const staged: StagedReferences = { images: [], videos: [], audios: [] };
    for (const [index, reference] of references.entries()) {
        const source = normalizeReferenceSource(reference.url, origin);
        const target = join(directory, `${String(index).padStart(3, "0")}-${reference.type}${extension(reference.type)}`);
        try {
            const workerHeaders = maintenanceWorkerContextHeaders(cookie);
            await downloadMediaToFile(source, target, {
                origin,
                ...(workerHeaders ? { internalHeaders: workerHeaders } : { cookie: usableCookie(cookie) }),
                maxBytes: MAX_REFERENCE_BYTES[reference.type],
            });
        } catch (error) {
            throw new DreaminaCliVideoTaskError(`即梦 CLI 参考${reference.type === "image" ? "图" : reference.type === "video" ? "视频" : "音频"}暂存失败：${safeError(error)}`);
        }
        if (reference.type === "image") staged.images.push(target);
        else if (reference.type === "video") staged.videos.push(target);
        else staged.audios.push(target);
        if (reference.role === "first_frame") staged.first = target;
        if (reference.role === "last_frame") staged.last = target;
    }
    return staged;
}

function transitionPrompts(raw: Record<string, unknown>, prompt: string, references: readonly VideoGenerationReference[]) {
    const imageCount = references.filter((reference) => reference.type === "image").length;
    const required = Math.max(1, imageCount - 1);
    const value = raw.transitionPrompts ?? raw.transition_prompts;
    const provided = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim().slice(0, 20_000)) : [];
    return provided.length === required ? provided : Array.from({ length: required }, () => prompt.trim().slice(0, 20_000));
}

function normalizeReferenceSource(value: string, origin: string) {
    const raw = value.trim();
    if (!raw || /^(?:file|data|blob):/i.test(raw) || (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(raw) && !isReferenceAssetUrl(raw) && !isGenerationAssetUrl(raw, origin)))
        throw new DreaminaCliVideoTaskError("即梦 CLI 不接受客户端本地路径，只能使用已授权参考素材地址");
    let url: URL;
    try {
        url = new URL(raw, origin || "https://octalflow.invalid");
    } catch {
        throw new DreaminaCliVideoTaskError("即梦 CLI 参考素材地址无效");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new DreaminaCliVideoTaskError("即梦 CLI 参考素材只支持 HTTP(S) 地址");
    if (isReferenceAssetUrl(raw)) {
        if (!hasProviderReadSignatureShape(raw)) throw new DreaminaCliVideoTaskError("即梦 CLI 只能读取已授权的参考素材地址");
        return `${url.pathname}${url.search}`;
    }
    if (isGenerationAssetUrl(raw, origin)) return `${url.pathname}${url.search}`;
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) throw new DreaminaCliVideoTaskError("即梦 CLI 参考素材必须是完整 HTTP(S) 地址");
    return url.toString();
}

function isGenerationAssetUrl(value: string, origin: string) {
    try {
        const url = new URL(value, origin || "https://octalflow.invalid");
        return url.origin === new URL(origin || "https://octalflow.invalid").origin && url.pathname.startsWith("/api/generation-log-assets/");
    } catch {
        return false;
    }
}

function referenceAssetPath(token: string) {
    const encoded = token
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/");
    return `/api/reference-assets/${encoded}`;
}

function normalizeRatio(value: unknown) {
    const text = typeof value === "string" ? value.trim().replace(/\s+/g, "") : "";
    return text || "16:9";
}

function hasExplicitRatio(value: unknown) {
    return typeof value === "string" && Boolean(value.trim()) && value.trim().toLowerCase() !== "auto";
}

function normalizeVideoResolution(value: unknown) {
    const text = String(value || "720")
        .trim()
        .toLowerCase();
    if (text === "low") return "480p";
    if (text === "auto" || text === "medium" || text === "high") return "720p";
    if (text === "4k") return "4k";
    const normalized = text.replace(/p$/, "");
    return normalized ? `${normalized}p` : "720p";
}

function positiveDuration(value: unknown) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function extension(type: VideoGenerationReference["type"]) {
    return type === "image" ? ".png" : type === "video" ? ".mp4" : ".mp3";
}

function videoMimeType(path: string) {
    return path.toLowerCase().endsWith(".webm") ? "video/webm" : path.toLowerCase().endsWith(".mov") ? "video/quicktime" : "video/mp4";
}

function usableCookie(value: string) {
    return value && !value.startsWith("octalaicanvas-worker-v1.") ? value : undefined;
}

function safeError(error: unknown) {
    const message = error instanceof Error ? error.message : "即梦 CLI 视频结果保存失败";
    return message
        .replace(/(?:https?:\/\/|file:\/\/)[^\s"']+/gi, "[已隐藏地址]")
        .replace(/(?:^|\s)\/?(?:Users|home|tmp|var|private|workspace)\/[^\s"']+/g, " [已隐藏路径]")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
}

async function finalizeVideoQueryLog(task: VideoTask, status: "success" | "failed" | "needs_review", resultSummary: Record<string, unknown>, error?: string, creditCost?: number) {
    await finalizeDreaminaCliRequestLog({
        submissionId: task.upstream.id,
        status,
        ...(creditCost !== undefined ? { observedCreditDelta: creditCost, creditObservation: "official" } : {}),
        resultSummary,
        ...(error ? { errorCode: status === "needs_review" ? "query_contract_or_persistence_boundary" : "upstream_terminal", error: safeError(new Error(error)) } : {}),
    });
}
