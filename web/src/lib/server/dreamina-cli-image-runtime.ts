import { readFile, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

import sharp from "sharp";

import type { ImageTaskRunResult } from "@/app/api/image-tasks/image-task-types";
import { imageUnits } from "@/app/api/image-tasks/image-task-support";
import { consumeUserPoints, getAuthSettings, isAdminUserId } from "@/lib/auth/store";
import { parseImageDimensions } from "@/lib/image-size";
import { generationModelId } from "@/lib/server/generation-channel";
import { maxServerAssetBytes } from "@/lib/server/generation-log-repository";
import { MAX_GENERATED_IMAGE_INPUT_PIXELS } from "@/lib/server/generated-image-normalizer";
import { fetchInternalApi } from "@/lib/server/internal-origin";
import { GenerationSubmissionSafeFailure, generationSubmissionUncertainError } from "@/lib/server/generation-submission-error";
import { maintenanceWorkerContextHeaders } from "@/lib/server/maintenance-auth";
import { updateImageTask, type ImageTask, type ImageTaskReference } from "@/lib/server/image-task-store";

import { buildDreaminaCliSubmitArgs, DREAMINA_CLI_CHANNEL_ID, DREAMINA_CLI_PROTOCOL, DREAMINA_IMAGE_RATIOS, dreaminaCliModel, DreaminaCliCatalogError, type DreaminaCliSubmissionInput } from "./dreamina-cli-catalog";
import { assertDreaminaCliRegularFile, dreaminaCliTaskDirectory, DreaminaCliProviderError, queryDreaminaCliTask, removeDreaminaCliTaskDirectory, withDreaminaCliTempDirectory } from "./dreamina-cli-provider";
import { finalizeDreaminaCliRequestLog } from "./dreamina-cli-store";
import { DreaminaCliServiceError, submitDreaminaCliTaskWithCreditObservation } from "./dreamina-cli-service";

const UPSCALE_MODEL_ID = "dreamina-image-upscale";
const SEEDREAM_PREFIX = "dreamina-seedream-";

export function isDreaminaCliImageUpscaleTask(task: ImageTask) {
    return task.kind === "upscale" && task.config.model === UPSCALE_MODEL_ID && task.config.channelId === DREAMINA_CLI_CHANNEL_ID && task.config.advancedConfig?.protocol === DREAMINA_CLI_PROTOCOL;
}

export function isDreaminaCliSeedreamImageTask(task: ImageTask) {
    const model = dreaminaCliModel(task.config.model);
    return Boolean(task.config.advancedConfig?.protocol === DREAMINA_CLI_PROTOCOL && task.config.channelId === DREAMINA_CLI_CHANNEL_ID && task.config.model.startsWith(SEEDREAM_PREFIX) && model?.capability === "image" && !model.operationOnly);
}

export function isDreaminaCliImageTask(task: ImageTask) {
    return isDreaminaCliImageUpscaleTask(task) || isDreaminaCliSeedreamImageTask(task);
}

/**
 * Canvas operation-only path. The upstream output is never downsized: an
 * output outside the existing media safety boundary becomes needs_review.
 */
export async function runDreaminaCliImageUpscaleTask(task: ImageTask, origin: string, authContext: string): Promise<ImageTaskRunResult> {
    if (!isDreaminaCliImageUpscaleTask(task) || !task.upscale || task.references.length !== 1 || task.mask) throw new GenerationSubmissionSafeFailure("即梦图片超清任务参数无效");
    try {
        return await withDreaminaCliTempDirectory(
            async (directory) => {
                const image = await stageOwnedReference(task.references[0], directory, origin, authContext, 1);
                const input: DreaminaCliSubmissionInput = { command: "image_upscale", modelId: UPSCALE_MODEL_ID, images: [image], resolutionType: task.upscale!.resolutionType };
                buildDreaminaCliSubmitArgs(input);
                return submitDreaminaCliImageTask(task, input);
            },
            { prefix: task.id },
        );
    } catch (error) {
        throw submissionError(error);
    }
}

/** Seedream uses the controlled CLI path only for canonical Dreamina models. */
export async function runDreaminaCliSeedreamImageTask(task: ImageTask, origin: string, authContext: string): Promise<ImageTaskRunResult> {
    if (!isDreaminaCliSeedreamImageTask(task) || task.mask) throw new GenerationSubmissionSafeFailure("即梦 Seedream 图片任务参数无效");
    try {
        const placeholderImages = task.references.map((_, index) => `/staged/reference-${index + 1}.png`);
        // Validate model, prompt, image count, quality/resolution, and size before
        // staging or reserving credits; this is still before process spawn.
        buildDreaminaCliSubmitArgs(buildDreaminaCliSeedreamImageSubmission(task, placeholderImages));
        return await withDreaminaCliTempDirectory(
            async (directory) => {
                const images = await Promise.all(task.references.map((reference, index) => stageOwnedReference(reference, directory, origin, authContext, index + 1)));
                const input = buildDreaminaCliSeedreamImageSubmission(task, images);
                buildDreaminaCliSubmitArgs(input);
                return submitDreaminaCliImageTask(task, input);
            },
            { prefix: task.id },
        );
    } catch (error) {
        throw submissionError(error);
    }
}

/** Pure request builder kept exported for fixture coverage; it never launches a CLI process. */
export function buildDreaminaCliSeedreamImageSubmission(task: Pick<ImageTask, "config" | "prompt" | "references">, images: string[]): DreaminaCliSubmissionInput {
    const model = dreaminaCliModel(task.config.model);
    if (!model || !task.config.model.startsWith(SEEDREAM_PREFIX) || model.capability !== "image" || model.operationOnly) throw new DreaminaCliCatalogError("即梦 Seedream 图片模型无效");
    if (images.length !== task.references.length || images.length > 10) throw new DreaminaCliCatalogError("即梦图生图最多支持十张已归属参考图");
    const command = images.length ? "image2image" : "text2image";
    const input: DreaminaCliSubmissionInput = {
        command,
        modelId: task.config.model,
        prompt: task.prompt.trim(),
        resolutionType: seedreamResolutionType(model.upstreamModel, task.config.quality),
        ...(images.length ? { images } : {}),
        ...seedreamSizing(task.config.size),
    };
    // Make catalogue validation part of the pure fixture contract, including
    // exact CLI custom-width limits and 3.0/3.1 image2image incompatibility.
    buildDreaminaCliSubmitArgs(input);
    return input;
}

async function submitDreaminaCliImageTask(task: ImageTask, input: DreaminaCliSubmissionInput): Promise<ImageTaskRunResult> {
    const billing = await reservePlatformPoints(task);
    const submission = await submitDreaminaCliTaskWithCreditObservation(input, { taskId: task.id, attemptNo: task.attemptNo, modelId: task.config.model });
    return {
        dataUrl: "",
        pending: { id: submission.submitId, mediaBaseUrl: "dreamina-cli", pollBaseUrl: "dreamina-cli" },
        ...billing,
    };
}

async function reservePlatformPoints(task: ImageTask) {
    const settings = await getAuthSettings();
    const model = generationModelId(task.config);
    const upstreamModel = dreaminaCliModel(task.config.model)?.upstreamModel || "";
    if (!hasConfiguredPlatformPrice(settings.modelPointCosts, [model, task.config.model, upstreamModel]) || (await isAdminUserId(task.userId))) return {};
    try {
        const points = await consumeUserPoints(task.userId, model, imageUnits(task.config.quality, settings.generationPointMultipliers.imageQuality), "image", `image-task:${task.id}:attempt:${task.attemptNo || 1}`);
        await updateImageTask(task.id, { billing: { pointsCost: points.cost, pointsRecordId: points.recordId, refunded: false } });
        return { pointsRemaining: points.remaining, pointsCost: points.cost, pointsRecordId: points.recordId };
    } catch (error) {
        throw new GenerationSubmissionSafeFailure(error instanceof Error ? error.message : "平台积分预扣失败");
    }
}

function hasConfiguredPlatformPrice(costs: Record<string, number>, candidates: string[]) {
    const keys = Object.keys(costs || {}).map((item) => item.trim().toLowerCase());
    return keys.includes("__default__") || candidates.some((candidate) => keys.includes(candidate.trim().toLowerCase()));
}

export async function queryDreaminaCliImageTask(task: ImageTask): Promise<ImageTaskRunResult> {
    const upstream = task.upstream;
    if (!upstream?.id || !isDreaminaCliImageTask(task)) throw new GenerationSubmissionSafeFailure("即梦 CLI 图片任务缺少有效上游任务 ID");
    const startedAt = Date.now();
    try {
        const directory = await dreaminaCliTaskDirectory(task.id);
        const query = await queryDreaminaCliTask({ submitId: upstream.id, downloadDir: directory });
        if (query.state === "pending") {
            return { dataUrl: "", pending: upstream };
        }
        if (query.state === "failed") {
            await finalizeQueryLog(task, "failed", { state: "failed", status: query.status }, query.error || "即梦 CLI 图片任务失败", query.creditCost);
            await removeDreaminaCliTaskDirectory(task.id).catch(() => undefined);
            throw new GenerationSubmissionSafeFailure(query.error || "即梦 CLI 图片任务失败");
        }
        const results = await Promise.all(query.files.map((file) => readSafeImageOutput(file, directory, isDreaminaCliImageUpscaleTask(task))));
        if (!results.length) return needsReview(upstream, "即梦 CLI 未返回可持久化的图片");
        await finalizeQueryLog(task, "success", { state: "succeeded", status: query.status, outputCount: results.length }, undefined, query.creditCost);
        await removeDreaminaCliTaskDirectory(task.id).catch(() => undefined);
        return { ...results[0], results };
    } catch (error) {
        if (error instanceof GenerationSubmissionSafeFailure) throw error;
        if (error instanceof DreaminaCliProviderError && error.submissionState === "unknown") {
            throw error;
        }
        await finalizeQueryLog(task, "needs_review", { state: "needs_review", status: "query_contract_missing" }, safeMessage(error)).catch(() => undefined);
        return needsReview(upstream, safeMessage(error) || "即梦 CLI 查询结果无法安全确认");
    }
}

export async function queryDreaminaCliImageUpscaleTask(task: ImageTask) {
    return queryDreaminaCliImageTask(task);
}

function needsReview(upstream: NonNullable<ImageTask["upstream"]>, reason: string): ImageTaskRunResult {
    return { dataUrl: "", needsReview: { upstream, reason: reason.slice(0, 500) } };
}

async function stageOwnedReference(reference: ImageTaskReference, directory: string, origin: string, authContext: string, index: number) {
    const sourceUrl = ownedReferenceUrl(reference);
    if (!sourceUrl) throw new GenerationSubmissionSafeFailure("即梦 CLI 只接收已归属的站内图片素材");
    const headers = maintenanceWorkerContextHeaders(authContext) || (authContext ? { cookie: authContext } : undefined);
    const response = await fetchInternalApi(new URL(sourceUrl, origin), { headers, cache: "no-store" });
    if (!response.ok || !response.body) throw new GenerationSubmissionSafeFailure("即梦参考图读取失败");
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > maxServerAssetBytes("image")) throw new GenerationSubmissionSafeFailure("即梦参考图超过当前安全上传边界");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > maxServerAssetBytes("image")) throw new GenerationSubmissionSafeFailure("即梦参考图超过当前安全上传边界");
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0] || "";
    if (!mimeType.startsWith("image/")) throw new GenerationSubmissionSafeFailure("即梦参考素材不是有效图片");
    const path = join(directory, `input-${index}${imageExtension(mimeType, sourceUrl)}`);
    await writeFile(path, bytes, { mode: 0o600 });
    return path;
}

function ownedReferenceUrl(reference: ImageTaskReference) {
    for (const value of [reference.serverUrl, reference.url, reference.dataUrl]) {
        const candidate = value?.trim() || "";
        if (!candidate) continue;
        try {
            const parsed = new URL(candidate, "http://internal.invalid");
            if (/^\/api\/(?:reference-assets|generation-log-assets)\//.test(parsed.pathname)) return `${parsed.pathname}${parsed.search}`;
        } catch {
            // Try the next snapshot field rather than trusting an opaque URL.
        }
    }
    return "";
}

export async function readSafeImageOutput(file: string, directory: string, upscale: boolean) {
    const safeFile = await assertDreaminaCliRegularFile(file, directory);
    const details = await stat(safeFile);
    const boundaryMessage = upscale ? "即梦超清图片超过当前安全持久化边界，已保留待人工处理，未降采样" : "即梦图片超过当前安全持久化边界，已保留待人工处理";
    if (!details.size) throw new Error(boundaryMessage);
    const metadata = await sharp(safeFile, { failOn: "error", limitInputPixels: MAX_GENERATED_IMAGE_INPUT_PIXELS }).metadata();
    const width = Number(metadata.width || 0);
    const height = Number(metadata.height || 0);
    if (!width || !height || width * height > MAX_GENERATED_IMAGE_INPUT_PIXELS) throw new Error(boundaryMessage);
    const maxBytes = maxServerAssetBytes("image");
    let bytes: Buffer;
    let mimeType = imageMimeType(metadata.format, safeFile);
    if (details.size <= maxBytes) {
        bytes = await readFile(safeFile);
    } else {
        if (!upscale) throw new Error(boundaryMessage);
        // Dreamina 8K commonly returns a PNG just above the normal image-byte
        // boundary. Preserve every pixel and only change the container using
        // lossless WebP before handing it to the existing media repository.
        bytes = await sharp(safeFile, { failOn: "error", limitInputPixels: MAX_GENERATED_IMAGE_INPUT_PIXELS }).webp({ lossless: true, effort: 4 }).toBuffer();
        mimeType = "image/webp";
        if (!bytes.length || bytes.length > maxBytes) throw new Error(boundaryMessage);
    }
    return { dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`, width, height, bytes: bytes.length, mimeType };
}

function seedreamResolutionType(upstreamModel: string, quality: string | undefined) {
    const allowed = upstreamModel === "3.0" || upstreamModel === "3.1" ? ["1k", "2k"] : upstreamModel === "5.0Pro" ? ["1.5k", "2k", "4k"] : ["2k", "4k"];
    const normalized = quality?.trim().toLowerCase() || "";
    const requested = ["1k", "1.5k", "2k", "4k"].includes(normalized) ? normalized : normalized === "low" ? (upstreamModel === "5.0Pro" ? "1.5k" : "1k") : normalized === "high" || normalized === "hd" ? "4k" : "2k";
    return allowed.includes(requested) ? requested : "2k";
}

function seedreamSizing(size: string | undefined): Pick<DreaminaCliSubmissionInput, "ratio" | "width" | "height"> {
    const value = size?.trim() || "";
    if (!value || value.toLowerCase() === "auto") return {};
    const dimensions = parseImageDimensions(value);
    if (dimensions) return { width: dimensions.width, height: dimensions.height };
    if (DREAMINA_IMAGE_RATIOS.includes(value as (typeof DREAMINA_IMAGE_RATIOS)[number])) return { ratio: value };
    throw new DreaminaCliCatalogError("图片尺寸仅支持即梦 CLI 官方比例或精确宽x高");
}

function submissionError(error: unknown) {
    if (error instanceof GenerationSubmissionSafeFailure || error instanceof DreaminaCliCatalogError) return error instanceof GenerationSubmissionSafeFailure ? error : new GenerationSubmissionSafeFailure(error.message, 400);
    if (error instanceof DreaminaCliProviderError && error.submissionState !== "unknown") return new GenerationSubmissionSafeFailure(error.message, error.status);
    if (error instanceof DreaminaCliServiceError) return new GenerationSubmissionSafeFailure(error.message, error.status);
    return generationSubmissionUncertainError(error, "即梦 CLI 图片提交结果未知");
}

function imageExtension(mimeType: string, fallback: string) {
    if (mimeType === "image/jpeg") return ".jpg";
    if (mimeType === "image/png" || mimeType === "image/webp" || mimeType === "image/gif") return `.${mimeType.slice("image/".length)}`;
    const extension = extname(new URL(fallback, "http://internal.invalid").pathname).toLowerCase();
    return /^\.(?:png|jpe?g|webp|gif)$/i.test(extension) ? extension : ".png";
}

function imageMimeType(format: string | undefined, fallback: string) {
    if (format === "jpeg" || format === "jpg") return "image/jpeg";
    if (["png", "webp", "gif", "avif", "tiff"].includes(format || "")) return `image/${format}`;
    const extension = extname(fallback).toLowerCase();
    return extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : "image/png";
}

async function finalizeQueryLog(task: ImageTask, status: "success" | "failed" | "needs_review", resultSummary: Record<string, unknown>, error?: string, creditCost?: number) {
    await finalizeDreaminaCliRequestLog({
        submissionId: task.upstream?.id || "",
        status,
        ...(creditCost !== undefined ? { observedCreditDelta: creditCost, creditObservation: "official" } : {}),
        ...(error ? { errorCode: status === "needs_review" ? "query_contract_or_persistence_boundary" : "upstream_terminal", error } : {}),
        resultSummary,
    });
}

function safeMessage(error: unknown) {
    const message = error instanceof Error ? error.message : "即梦 CLI 查询结果无法安全确认";
    return message
        .replace(/(?:https?:\/\/|file:\/\/)[^\s"']+/gi, "[已隐藏地址]")
        .replace(/(?:^|\s)\/?(?:Users|home|tmp|var|private|workspace)\/[^\s"']+/g, " [已隐藏路径]")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);
}
