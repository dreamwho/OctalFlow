/**
 * The Dreamina binary is a local, server-owned provider.  This catalog is the
 * sole translation layer from OctalFlow model IDs to CLI flags: callers never
 * get to pass a subcommand or arbitrary argv through to the executable.
 */
export const DREAMINA_CLI_PROTOCOL = "dreamina-cli" as const;
export const DREAMINA_CLI_CHANNEL_ID = "dreamina-cli" as const;
export const DREAMINA_CLI_CHANNEL_NAME = "即梦 CLI";

export const DREAMINA_IMAGE_RATIOS = ["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"] as const;
export const DREAMINA_VIDEO_RATIOS = ["1:1", "3:4", "16:9", "4:3", "9:16", "21:9"] as const;
export const DREAMINA_UPSCALE_RESOLUTIONS = ["2k", "4k", "8k"] as const;
export const DREAMINA_VIDEO_RESOLUTIONS = ["480p", "720p", "1080p", "4k"] as const;

export type DreaminaCliCapability = "image" | "video";
export type DreaminaCliCommand = "text2image" | "image2image" | "image_upscale" | "text2video" | "image2video" | "frames2video" | "multiframe2video" | "multimodal2video";
export type DreaminaCliMediaRole = "image" | "first" | "last" | "video" | "audio";
export type DreaminaCliVideoCapabilities = {
    resolutions: readonly (typeof DREAMINA_VIDEO_RESOLUTIONS)[number][];
    minDurationSeconds: number;
    maxDurationSeconds: number;
    maxReferenceImages: number;
};
export type DreaminaCliVideoParameters = {
    videoResolution?: string;
    duration?: number;
};
export type DreaminaCliModel = {
    id: string;
    upstreamModel: string;
    displayName: string;
    capability: DreaminaCliCapability;
    commands: readonly DreaminaCliCommand[];
    command: string;
    description: string;
    vipOnly?: boolean;
    operationOnly?: boolean;
};

type ImageModelVersion = "3.0" | "3.1" | "4.0" | "4.1" | "4.5" | "4.6" | "4.7" | "5.0" | "5.0Pro";
type VideoModelVersion = "seedance1.0fast" | "seedance1.5pro" | "seedance2.0" | "seedance2.0fast" | "seedance2.0_vip" | "seedance2.0fast_vip" | "seedance2.0mini" | "seedance2.5";

const IMAGE_MODEL_VERSIONS: ReadonlyArray<{ id: string; version: ImageModelVersion; name: string; commands: readonly DreaminaCliCommand[]; resolutions: readonly string[] }> = [
    { id: "dreamina-seedream-3-0", version: "3.0", name: "Seedream 3.0", commands: ["text2image"], resolutions: ["1k", "2k"] },
    { id: "dreamina-seedream-3-1", version: "3.1", name: "Seedream 3.1", commands: ["text2image"], resolutions: ["1k", "2k"] },
    { id: "dreamina-seedream-4-0", version: "4.0", name: "Seedream 4.0", commands: ["text2image", "image2image"], resolutions: ["2k", "4k"] },
    { id: "dreamina-seedream-4-1", version: "4.1", name: "Seedream 4.1", commands: ["text2image", "image2image"], resolutions: ["2k", "4k"] },
    { id: "dreamina-seedream-4-5", version: "4.5", name: "Seedream 4.5", commands: ["text2image", "image2image"], resolutions: ["2k", "4k"] },
    { id: "dreamina-seedream-4-6", version: "4.6", name: "Seedream 4.6", commands: ["text2image", "image2image"], resolutions: ["2k", "4k"] },
    { id: "dreamina-seedream-4-7", version: "4.7", name: "Seedream 4.7", commands: ["text2image", "image2image"], resolutions: ["2k", "4k"] },
    { id: "dreamina-seedream-5-0", version: "5.0", name: "Seedream 5.0", commands: ["text2image", "image2image"], resolutions: ["2k", "4k"] },
    { id: "dreamina-seedream-5-0-pro", version: "5.0Pro", name: "Seedream 5.0 Pro", commands: ["text2image", "image2image"], resolutions: ["1.5k", "2k", "4k"] },
];

const VIDEO_MODEL_VERSIONS: ReadonlyArray<{ id: string; version: VideoModelVersion; name: string; commands: readonly DreaminaCliCommand[]; vipOnly?: boolean }> = [
    { id: "dreamina-seedance-1-0-fast", version: "seedance1.0fast", name: "Seedance 1.0 Fast", commands: ["image2video"] },
    { id: "dreamina-seedance-1-5-pro", version: "seedance1.5pro", name: "Seedance 1.5 Pro", commands: ["image2video", "frames2video"] },
    { id: "dreamina-seedance-2-0", version: "seedance2.0", name: "Seedance 2.0", commands: ["text2video", "image2video", "frames2video", "multimodal2video"] },
    { id: "dreamina-seedance-2-0-fast", version: "seedance2.0fast", name: "Seedance 2.0 Fast", commands: ["text2video", "image2video", "frames2video", "multimodal2video"] },
    { id: "dreamina-seedance-2-0-vip", version: "seedance2.0_vip", name: "Seedance 2.0 VIP", commands: ["text2video", "image2video", "frames2video", "multimodal2video"], vipOnly: true },
    { id: "dreamina-seedance-2-0-fast-vip", version: "seedance2.0fast_vip", name: "Seedance 2.0 Fast VIP", commands: ["text2video", "image2video", "frames2video", "multimodal2video"], vipOnly: true },
    { id: "dreamina-seedance-2-0-mini", version: "seedance2.0mini", name: "Seedance 2.0 Mini", commands: ["text2video", "image2video", "frames2video", "multimodal2video"] },
    { id: "dreamina-seedance-2-5", version: "seedance2.5", name: "Seedance 2.5", commands: ["text2video", "image2video", "frames2video", "multimodal2video"], vipOnly: true },
];

export const DREAMINA_CLI_MODELS: readonly DreaminaCliModel[] = [
    ...IMAGE_MODEL_VERSIONS.map((model) => ({
        id: model.id,
        upstreamModel: model.version,
        displayName: model.name,
        capability: "image" as const,
        commands: model.commands,
        command: model.commands.join("、"),
        description: `支持 ${model.commands.includes("image2image") ? "文生图与图生图" : "文生图"}，分辨率 ${model.resolutions.join(" / ")}`,
    })),
    ...VIDEO_MODEL_VERSIONS.map((model) => ({
        id: model.id,
        upstreamModel: model.version,
        displayName: model.name,
        capability: "video" as const,
        commands: model.commands,
        command: model.commands.join("、"),
        description: `支持 ${model.commands.join("、")}`,
        ...(model.vipOnly ? { vipOnly: true } : {}),
    })),
    {
        id: "dreamina-image-upscale",
        upstreamModel: "image_upscale",
        displayName: "即梦图片超清",
        capability: "image",
        commands: ["image_upscale"],
        command: "image_upscale",
        description: "单图超清，支持 2K / 4K / 8K；4K 与 8K 需要 VIP。",
        operationOnly: true,
    },
    {
        id: "dreamina-multiframe-video",
        upstreamModel: "multiframe2video",
        displayName: "即梦智能多帧视频",
        capability: "video",
        commands: ["multiframe2video"],
        command: "multiframe2video",
        description: "固定模型的 2–20 图智能多帧视频，支持 720P / 1080P。",
        operationOnly: true,
    },
];

export const DREAMINA_CLI_MODEL_IDS = new Set(DREAMINA_CLI_MODELS.map((model) => model.id));
export const DREAMINA_CLI_OPERATION_ONLY_MODEL_IDS = new Set(DREAMINA_CLI_MODELS.filter((model) => model.operationOnly).map((model) => model.id));

export class DreaminaCliCatalogError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DreaminaCliCatalogError";
    }
}

export type DreaminaCliSubmissionInput = {
    command: DreaminaCliCommand;
    modelId?: string;
    prompt?: string;
    images?: string[];
    first?: string;
    last?: string;
    videos?: string[];
    audios?: string[];
    ratio?: string;
    width?: number;
    height?: number;
    resolutionType?: string;
    videoResolution?: string;
    duration?: number;
    generateNum?: number;
    transitionPrompts?: string[];
    transitionDurations?: number[];
};

export function dreaminaCliModel(modelId: string | undefined) {
    const key = modelId?.trim().toLowerCase() || "";
    return DREAMINA_CLI_MODELS.find((model) => model.id === key) || null;
}

export function dreaminaCliCatalogModels(capability?: DreaminaCliCapability) {
    return capability ? DREAMINA_CLI_MODELS.filter((model) => model.capability === capability) : DREAMINA_CLI_MODELS;
}

export function isDreaminaCliModelId(value: string | undefined) {
    return Boolean(value && DREAMINA_CLI_MODEL_IDS.has(value.trim().toLowerCase()));
}

export function isDreaminaCliOperationOnlyModel(value: string | undefined) {
    return Boolean(value && DREAMINA_CLI_OPERATION_ONLY_MODEL_IDS.has(value.trim().toLowerCase()));
}

/**
 * Returns the executable Seedance constraints after the logical model has
 * resolved to its actual CLI model.  The caller may provide either the
 * catalog ID or the provider model ID from that resolved binding.
 */
export function dreaminaCliVideoCapabilities(modelIdOrUpstream: string | undefined): DreaminaCliVideoCapabilities | null {
    const model = dreaminaCliVideoModel(modelIdOrUpstream);
    if (!model) return null;
    if (model.id === "dreamina-multiframe-video") return { resolutions: ["720p", "1080p"], minDurationSeconds: 2, maxDurationSeconds: 8, maxReferenceImages: 20 };
    if (model.operationOnly) return null;
    const version = videoVersion(model);
    if (version === "seedance2.5") return { resolutions: ["480p", "720p", "1080p"], minDurationSeconds: 4, maxDurationSeconds: 30, maxReferenceImages: 30 };
    if (version === "seedance2.0_vip" || version === "seedance2.0fast_vip") return { resolutions: ["720p", "1080p", "4k"], minDurationSeconds: 4, maxDurationSeconds: 15, maxReferenceImages: 9 };
    if (version === "seedance1.0fast") return { resolutions: ["720p"], minDurationSeconds: 5, maxDurationSeconds: 10, maxReferenceImages: 1 };
    if (version === "seedance1.5pro") return { resolutions: ["720p"], minDurationSeconds: 5, maxDurationSeconds: 12, maxReferenceImages: 1 };
    return { resolutions: ["720p"], minDurationSeconds: 4, maxDurationSeconds: 15, maxReferenceImages: 9 };
}

/**
 * Normalizes provider-facing video values only for a known Seedance model.
 * This is intentionally a final execution guard: UI preferences and planner
 * defaults are allowed to be generic, but a resolved Mini model must never
 * receive an unsupported resolution or duration.
 */
export function normalizeDreaminaCliVideoParameters(modelIdOrUpstream: string | undefined, parameters: DreaminaCliVideoParameters): DreaminaCliVideoParameters {
    const capabilities = dreaminaCliVideoCapabilities(modelIdOrUpstream);
    if (!capabilities) return parameters;
    const requestedResolution = normalizeVideoResolution(parameters.videoResolution);
    const fallbackResolution = capabilities.resolutions.includes("720p") ? "720p" : capabilities.resolutions[0];
    const videoResolution = capabilities.resolutions.includes(requestedResolution as (typeof DREAMINA_VIDEO_RESOLUTIONS)[number]) ? requestedResolution : fallbackResolution;
    const duration = Number.isSafeInteger(parameters.duration) && (parameters.duration || 0) > 0 ? Math.min(capabilities.maxDurationSeconds, Math.max(capabilities.minDurationSeconds, parameters.duration!)) : parameters.duration;
    return { videoResolution, ...(duration !== undefined ? { duration } : {}) };
}

export function buildDreaminaCliSubmitArgs(input: DreaminaCliSubmissionInput) {
    const normalized = normalizeSubmission(input);
    const args: string[] = [normalized.command];
    switch (normalized.command) {
        case "text2image":
            args.push(requiredFlag("prompt", normalized.prompt));
            addImageSizingArgs(args, normalized);
            args.push(requiredFlag("resolution_type", normalized.resolutionType), requiredFlag("model_version", requiredModel(normalized).upstreamModel));
            addOptionalInteger(args, "generate_num", normalized.generateNum);
            break;
        case "image2image":
            args.push(requiredFlag("images", images(normalized, 1, 10).join(",")), requiredFlag("prompt", normalized.prompt));
            addImageSizingArgs(args, normalized);
            args.push(requiredFlag("resolution_type", normalized.resolutionType), requiredFlag("model_version", requiredModel(normalized).upstreamModel));
            addOptionalInteger(args, "generate_num", normalized.generateNum);
            break;
        case "image_upscale":
            args.push(requiredFlag("image", images(normalized, 1, 1)[0]), requiredFlag("resolution_type", normalized.resolutionType));
            break;
        case "text2video":
            args.push(requiredFlag("prompt", normalized.prompt), requiredFlag("video_resolution", normalized.videoResolution), requiredFlag("model_version", requiredModel(normalized).upstreamModel));
            addOptionalInteger(args, "duration", normalized.duration);
            addOptionalString(args, "ratio", normalized.ratio);
            break;
        case "image2video":
            args.push(requiredFlag("image", images(normalized, 1, 1)[0]), requiredFlag("prompt", normalized.prompt), requiredFlag("video_resolution", normalized.videoResolution), requiredFlag("model_version", requiredModel(normalized).upstreamModel));
            addOptionalInteger(args, "duration", normalized.duration);
            break;
        case "frames2video":
            args.push(
                requiredFlag("first", normalized.first),
                requiredFlag("last", normalized.last),
                requiredFlag("prompt", normalized.prompt),
                requiredFlag("video_resolution", normalized.videoResolution),
                requiredFlag("model_version", requiredModel(normalized).upstreamModel),
            );
            if (normalized.first === normalized.last) throw new DreaminaCliCatalogError("首帧和尾帧不能使用同一素材");
            addOptionalInteger(args, "duration", normalized.duration);
            break;
        case "multiframe2video":
            appendMultiFrameArgs(args, normalized);
            break;
        case "multimodal2video":
            appendMultimodalArgs(args, normalized);
            break;
    }
    args.push("--poll=0");
    return args;
}

export function dreaminaCliRequiresVip(input: DreaminaCliSubmissionInput) {
    if (input.command === "image_upscale") return input.resolutionType === "4k" || input.resolutionType === "8k";
    return Boolean(dreaminaCliModel(input.modelId)?.vipOnly);
}

export function dreaminaCliCommandCapability(command: DreaminaCliCommand): DreaminaCliCapability {
    return command === "text2image" || command === "image2image" || command === "image_upscale" ? "image" : "video";
}

function normalizeSubmission(input: DreaminaCliSubmissionInput): DreaminaCliSubmissionInput {
    if (!isCommand(input.command)) throw new DreaminaCliCatalogError("即梦 CLI 命令无效");
    const prompt = cleanText(input.prompt);
    const images = cleanPaths(input.images);
    const videos = cleanPaths(input.videos);
    const audios = cleanPaths(input.audios);
    const first = cleanPath(input.first);
    const last = cleanPath(input.last);
    const ratio = cleanText(input.ratio);
    const resolutionType = cleanText(input.resolutionType);
    const videoResolution = cleanText(input.videoResolution);
    const modelId = cleanText(input.modelId).toLowerCase();
    const normalized = { ...input, prompt, images, videos, audios, first, last, ratio, resolutionType, videoResolution, modelId };
    validateCommand(normalized);
    return normalized;
}

function validateCommand(input: DreaminaCliSubmissionInput) {
    const command = input.command;
    const model = dreaminaCliModel(input.modelId);
    if (command === "image_upscale") {
        if (input.modelId && input.modelId !== "dreamina-image-upscale") throw new DreaminaCliCatalogError("图片超清只能使用即梦图片超清 operation");
        if (!DREAMINA_UPSCALE_RESOLUTIONS.includes(input.resolutionType as (typeof DREAMINA_UPSCALE_RESOLUTIONS)[number])) throw new DreaminaCliCatalogError("图片超清分辨率仅支持 2K、4K 或 8K");
        return;
    }
    if (command === "multiframe2video") {
        if (input.modelId && input.modelId !== "dreamina-multiframe-video") throw new DreaminaCliCatalogError("智能多帧视频使用固定即梦模型");
        if (input.videoResolution !== "720p" && input.videoResolution !== "1080p") throw new DreaminaCliCatalogError("智能多帧视频仅支持 720P 或 1080P");
        return;
    }
    if (!model || model.operationOnly || !model.commands.includes(command)) throw new DreaminaCliCatalogError("所选即梦模型不支持当前生成方式");
    if (model.capability !== dreaminaCliCommandCapability(command)) throw new DreaminaCliCatalogError("即梦模型能力与任务不匹配");
    if (command === "text2image" || command === "image2image") validateImageRequest(input, model);
    else validateVideoRequest(input, model);
}

function validateImageRequest(input: DreaminaCliSubmissionInput, model: DreaminaCliModel) {
    const version = imageVersion(model);
    const allowed = IMAGE_MODEL_VERSIONS.find((item) => item.version === version)?.resolutions || [];
    if (!allowed.includes(input.resolutionType || "")) throw new DreaminaCliCatalogError("所选 Seedream 模型不支持该图片分辨率");
    if (input.ratio && !DREAMINA_IMAGE_RATIOS.includes(input.ratio as (typeof DREAMINA_IMAGE_RATIOS)[number])) throw new DreaminaCliCatalogError("图片比例不受即梦 CLI 支持");
    const width = positiveInteger(input.width);
    const height = positiveInteger(input.height);
    if ((width === undefined) !== (height === undefined)) throw new DreaminaCliCatalogError("自定义宽高必须同时提供");
    if (width && height && input.ratio) throw new DreaminaCliCatalogError("自定义宽高不能与比例同时使用");
    if (width && height) validateImageDimensions(width, height, input.resolutionType || "");
    if (width && height && (version === "3.0" || version === "3.1") && input.resolutionType !== "2k") throw new DreaminaCliCatalogError("Seedream 3.0/3.1 的自定义宽高仅支持 2K");
    if (input.generateNum !== undefined && (!Number.isInteger(input.generateNum) || input.generateNum < 1 || input.generateNum > 10)) throw new DreaminaCliCatalogError("图片生成数量仅支持 1 到 10");
}

function validateVideoRequest(input: DreaminaCliSubmissionInput, model: DreaminaCliModel) {
    if (input.ratio && !DREAMINA_VIDEO_RATIOS.includes(input.ratio as (typeof DREAMINA_VIDEO_RATIOS)[number])) throw new DreaminaCliCatalogError("视频比例不受即梦 CLI 支持");
    const resolution = input.videoResolution || "";
    const duration = input.duration;
    const version = videoVersion(model);
    if (!videoResolutionAllowed(version, resolution)) throw new DreaminaCliCatalogError("所选 Seedance 模型不支持该视频清晰度");
    if (duration !== undefined && (!Number.isInteger(duration) || !videoDurationAllowed(version, duration))) throw new DreaminaCliCatalogError("所选 Seedance 模型不支持该视频时长");
    if (input.command === "multimodal2video") {
        const imageCount = input.images?.length || 0;
        const videoCount = input.videos?.length || 0;
        const audioCount = input.audios?.length || 0;
        if (!imageCount && !videoCount && !audioCount) throw new DreaminaCliCatalogError("全能参考视频至少需要一项图片、视频或音频素材");
        if (version === "seedance2.5") {
            if (imageCount > 30 || videoCount > 10 || audioCount > 10 || imageCount + videoCount + audioCount > 50) throw new DreaminaCliCatalogError("Seedance 2.5 全能参考素材数量超限");
        } else if (!imageCount && !videoCount) throw new DreaminaCliCatalogError("Seedance 2.0 全能参考至少需要图片或视频素材");
        else if (imageCount > 9 || videoCount > 3 || audioCount > 3 || imageCount + videoCount + audioCount > 12) throw new DreaminaCliCatalogError("Seedance 2.0 全能参考素材数量超限");
    }
}

function appendMultiFrameArgs(args: string[], input: DreaminaCliSubmissionInput) {
    const source = images(input, 2, 20);
    args.push(requiredFlag("images", source.join(",")), requiredFlag("video_resolution", input.videoResolution));
    if (source.length === 2) {
        args.push(requiredFlag("prompt", input.prompt));
        const duration = input.duration ?? 3;
        if (!Number.isFinite(duration) || duration < 1 || duration > 8 || duration < 2) throw new DreaminaCliCatalogError("两帧视频转场时长仅支持 2 到 8 秒");
        args.push(`--duration=${duration}`);
        return;
    }
    const prompts = (input.transitionPrompts || []).map(cleanText).filter(Boolean);
    const durations = input.transitionDurations || [];
    if (prompts.length !== source.length - 1) throw new DreaminaCliCatalogError("多帧视频每个转场都需要提示词");
    if (durations.length && durations.length !== source.length - 1) throw new DreaminaCliCatalogError("多帧视频转场时长数量不匹配");
    prompts.forEach((value) => args.push(`--transition-prompt=${value}`));
    if (durations.length) {
        durations.forEach((value) => {
            if (!Number.isFinite(value) || value < 1 || value > 8) throw new DreaminaCliCatalogError("多帧视频每段转场时长仅支持 1 到 8 秒");
            args.push(`--transition-duration=${value}`);
        });
    }
}

function appendMultimodalArgs(args: string[], input: DreaminaCliSubmissionInput) {
    const model = requiredModel(input);
    (input.images || []).forEach((value) => args.push(`--image=${value}`));
    (input.videos || []).forEach((value) => args.push(`--video=${value}`));
    (input.audios || []).forEach((value) => args.push(`--audio=${value}`));
    addOptionalString(args, "prompt", input.prompt);
    addOptionalInteger(args, "duration", input.duration);
    addOptionalString(args, "ratio", input.ratio);
    args.push(requiredFlag("video_resolution", input.videoResolution), requiredFlag("model_version", model.upstreamModel));
}

function addImageSizingArgs(args: string[], input: DreaminaCliSubmissionInput) {
    if (input.width && input.height) args.push(`--width=${input.width}`, `--height=${input.height}`);
    else addOptionalString(args, "ratio", input.ratio);
}

function requiredModel(input: DreaminaCliSubmissionInput) {
    const model = dreaminaCliModel(input.modelId);
    if (!model) throw new DreaminaCliCatalogError("即梦模型不存在");
    return model;
}

function dreaminaCliVideoModel(modelIdOrUpstream: string | undefined) {
    const key = modelIdOrUpstream?.trim().toLowerCase() || "";
    const model = dreaminaCliModel(key) || DREAMINA_CLI_MODELS.find((item) => item.upstreamModel.toLowerCase() === key);
    return model?.capability === "video" ? model : null;
}

function images(input: DreaminaCliSubmissionInput, minimum: number, maximum: number) {
    const values = input.images || [];
    if (values.length < minimum || values.length > maximum) throw new DreaminaCliCatalogError(`当前即梦命令需要 ${minimum === maximum ? minimum : `${minimum}-${maximum}`} 张图片`);
    return values;
}

function requiredFlag(name: string, value: string | undefined) {
    if (!value) throw new DreaminaCliCatalogError(`即梦 CLI 缺少 ${name} 参数`);
    return `--${name}=${value}`;
}

function addOptionalString(args: string[], name: string, value: string | undefined) {
    if (value) args.push(`--${name}=${value}`);
}

function addOptionalInteger(args: string[], name: string, value: number | undefined) {
    if (value !== undefined) args.push(`--${name}=${value}`);
}

function imageVersion(model: DreaminaCliModel) {
    return model.upstreamModel as ImageModelVersion;
}

function videoVersion(model: DreaminaCliModel) {
    return model.upstreamModel as VideoModelVersion;
}

function videoResolutionAllowed(version: VideoModelVersion, resolution: string) {
    return Boolean(dreaminaCliVideoCapabilities(version)?.resolutions.includes(resolution as (typeof DREAMINA_VIDEO_RESOLUTIONS)[number]));
}

function videoDurationAllowed(version: VideoModelVersion, duration: number) {
    const capabilities = dreaminaCliVideoCapabilities(version);
    return Boolean(capabilities && duration >= capabilities.minDurationSeconds && duration <= capabilities.maxDurationSeconds);
}

function normalizeVideoResolution(value: string | undefined) {
    const normalized = String(value || "720p")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "");
    if (normalized === "low") return "480p";
    if (["auto", "medium", "high"].includes(normalized)) return "720p";
    if (["4k", "2160", "2160p"].includes(normalized)) return "4k";
    if (["480", "480p", "720", "720p", "1080", "1080p"].includes(normalized)) return normalized.endsWith("p") ? normalized : `${normalized}p`;
    return "720p";
}

function validateImageDimensions(width: number, height: number, resolution: string) {
    const limits: Record<string, { min: number; max: number; pixels: number }> = {
        "1k": { min: 512, max: 2016, pixels: 1_763_584 },
        "1.5k": { min: 972, max: 2268, pixels: 2_359_296 },
        "2k": { min: 768, max: 3072, pixels: 4_194_304 },
        "4k": { min: 1536, max: 6240, pixels: 16_777_216 },
    };
    const limit = limits[resolution];
    if (!limit || width < limit.min || height < limit.min || width > limit.max || height > limit.max || width * height > limit.pixels) throw new DreaminaCliCatalogError("自定义图片宽高不在所选即梦分辨率支持范围内");
}

function cleanText(value: unknown) {
    return typeof value === "string" ? value.trim().slice(0, 20_000) : "";
}

function cleanPath(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanPaths(values: unknown) {
    return Array.isArray(values) ? values.map(cleanPath).filter((value): value is string => Boolean(value)) : [];
}

function positiveInteger(value: unknown) {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isCommand(value: unknown): value is DreaminaCliCommand {
    return typeof value === "string" && ["text2image", "image2image", "image_upscale", "text2video", "image2video", "frames2video", "multiframe2video", "multimodal2video"].includes(value);
}
