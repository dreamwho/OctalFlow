import type { LogicalModel, SystemModelChannel } from "@/lib/auth/store-types";
import { normalizeVideoGenerationReferences, regularVideoReferences, videoFrameReferences, type VideoGenerationReference } from "@/lib/video-reference-contract";

export const MINIMAX_H3_DEFAULT_BASE_URL = "https://minimax.api.easyframe.cn";
export const MINIMAX_H3_MODELS = ["minimax-h3-mini", "minimax-h3-fast", "minimax-h3-base", "minimax-h3-pro"] as const;
export const MINIMAX_H3_RESOLUTIONS = ["480p", "720p"] as const;
export const MINIMAX_H3_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "9:21", "4:5", "5:4"] as const;
export const MINIMAX_H3_PROMPT_MAX_CHARS = 30_000;
const MINIMAX_H3_MAX_IMAGES = 9;
const MINIMAX_H3_MAX_VIDEOS = 3;
const MINIMAX_H3_MAX_AUDIOS = 3;
const MINIMAX_H3_MAX_MEDIA = 15;

export type MinimaxH3ModelMeta = {
    id: (typeof MINIMAX_H3_MODELS)[number];
    label: string;
    tier: string;
    description: string;
    suggestedUse: string;
    resolutions: readonly string[];
    duration: string;
    supportedModes: readonly string[];
};

export const MINIMAX_H3_MODEL_METAS: readonly MinimaxH3ModelMeta[] = [
    {
        id: "minimax-h3-mini",
        label: "minimax-h3-mini",
        tier: "极速档",
        description: "轻量极速模型，生成延迟极低、出片高效，适合实时试拍、构图探索与分镜草稿验证。",
        suggestedUse: "分镜试拍、快速预览、即时生成",
        resolutions: MINIMAX_H3_RESOLUTIONS,
        duration: "5-15 秒",
        supportedModes: ["文生视频 (t2va)", "首帧 (i2va)", "首尾帧 (fl2va)", "多参考 (ref2va)"],
    },
    {
        id: "minimax-h3-fast",
        label: "minimax-h3-fast",
        tier: "高速档",
        description: "高速平衡模型，在较短生成耗时内提供更稳定的画面动态与主体一致性，兼顾速度与质量。",
        suggestedUse: "社交短视频、高频内容生产、广告草案",
        resolutions: MINIMAX_H3_RESOLUTIONS,
        duration: "5-15 秒",
        supportedModes: ["文生视频 (t2va)", "首帧 (i2va)", "首尾帧 (fl2va)", "多参考 (ref2va)"],
    },
    {
        id: "minimax-h3-base",
        label: "minimax-h3-base",
        tier: "标准档",
        description: "标准生产力模型，细节刻画细腻，镜头运动与物理世界动态更加自然流畅，适合正片创作。",
        suggestedUse: "商业宣发片、多镜头叙事、短剧正片",
        resolutions: MINIMAX_H3_RESOLUTIONS,
        duration: "5-15 秒",
        supportedModes: ["文生视频 (t2va)", "首帧 (i2va)", "首尾帧 (fl2va)", "多参考 (ref2va)"],
    },
    {
        id: "minimax-h3-pro",
        label: "minimax-h3-pro",
        tier: "旗舰档",
        description: "旗舰画质模型，支持高复杂度场景构图、微表情变化与电影级视听质感，呈现极致视效。",
        suggestedUse: "电影级特效、高质量精美镜头、旗舰视听创作",
        resolutions: MINIMAX_H3_RESOLUTIONS,
        duration: "5-15 秒",
        supportedModes: ["文生视频 (t2va)", "首帧 (i2va)", "首尾帧 (fl2va)", "多参考 (ref2va)"],
    },
] as const;

export function promoteMinimaxH3LogicalModels(models: LogicalModel[], channel: SystemModelChannel): { logicalModels: LogicalModel[]; aliases: Record<string, string> } {
    const h3Models = new Set<string>(MINIMAX_H3_MODELS.map((m) => m.toLowerCase()));
    const channelEnabledModels = new Set(channel.models.map((m) => m.trim().toLowerCase()));
    const aliases: Record<string, string> = {};
    const result: LogicalModel[] = [];
    const handled = new Set<string>();

    for (const model of models) {
        const idLower = model.id.trim().toLowerCase();
        if (h3Models.has(idLower)) {
            handled.add(idLower);
            const upstream = MINIMAX_H3_MODELS.find((m) => m.toLowerCase() === idLower) || model.id;
            const isModelInChannel = channelEnabledModels.has(upstream.toLowerCase());
            const existingBindings = model.bindings.filter((b) => b.channelId !== channel.id);
            const bindings = [...existingBindings];
            if (isModelInChannel && channel.enabled) {
                bindings.unshift({
                    id: `${channel.id}:${upstream}`,
                    channelId: channel.id,
                    upstreamModel: upstream,
                    enabled: true,
                    priority: 0,
                });
            }
            result.push({
                ...model,
                capability: "video",
                enabled: isModelInChannel ? true : model.enabled,
                bindings,
            });
        } else {
            result.push(model);
        }
    }

    // Ensure all enabled models in the channel have a corresponding logical model
    for (const modelId of MINIMAX_H3_MODELS) {
        const idLower = modelId.toLowerCase();
        if (channelEnabledModels.has(idLower) && !handled.has(idLower)) {
            handled.add(idLower);
            result.push({
                id: modelId,
                name: modelId,
                capability: "video",
                enabled: true,
                bindings: [
                    {
                        id: `${channel.id}:${modelId}`,
                        channelId: channel.id,
                        upstreamModel: modelId,
                        enabled: true,
                        priority: 0,
                    },
                ],
            });
        }
    }

    return { logicalModels: result, aliases };
}

export function assertMinimaxH3VideoReferences(references: VideoGenerationReference[]) {
    const { firstFrame, lastFrame } = videoFrameReferences(normalizeVideoGenerationReferences(references));
    const regular = regularVideoReferences(normalizeVideoGenerationReferences(references));
    if ((firstFrame || lastFrame) && regular.length) throw new Error("MiniMax H3 首帧/尾帧模式不能与普通参考素材混用");
    if (regular.length) {
        const images = regular.filter((reference) => reference.type === "image");
        const videos = regular.filter((reference) => reference.type === "video");
        const audios = regular.filter((reference) => reference.type === "audio");
        if (images.length > MINIMAX_H3_MAX_IMAGES) throw new Error(`MiniMax H3 参考图片最多 ${MINIMAX_H3_MAX_IMAGES} 张`);
        if (videos.length > MINIMAX_H3_MAX_VIDEOS) throw new Error(`MiniMax H3 参考视频最多 ${MINIMAX_H3_MAX_VIDEOS} 个`);
        if (audios.length > MINIMAX_H3_MAX_AUDIOS) throw new Error(`MiniMax H3 参考音频最多 ${MINIMAX_H3_MAX_AUDIOS} 个`);
        if (regular.length > MINIMAX_H3_MAX_MEDIA) throw new Error(`MiniMax H3 参考素材最多 ${MINIMAX_H3_MAX_MEDIA} 个`);
    }
}

export type MinimaxH3VideoMedia = {
    mode: "t2va" | "i2va" | "fl2va" | "ref2va";
    images: string[];
    videos: string[];
    audios: string[];
};

export function minimaxH3VideoMedia(references: VideoGenerationReference[]): MinimaxH3VideoMedia {
    const normalized = normalizeVideoGenerationReferences(references);
    const regular = regularVideoReferences(normalized);
    const { firstFrame, lastFrame } = videoFrameReferences(normalized);
    assertMinimaxH3VideoReferences(normalized);
    const images = uniqueUrls(regular.filter((reference) => reference.type === "image").map((reference) => reference.url));
    const videos = uniqueUrls(regular.filter((reference) => reference.type === "video").map((reference) => reference.url));
    const audios = uniqueUrls(regular.filter((reference) => reference.type === "audio").map((reference) => reference.url));
    const mode = regular.length ? "ref2va" : firstFrame && lastFrame ? "fl2va" : firstFrame ? "i2va" : "t2va";
    const keyframeImages = mode === "fl2va" ? [firstFrame!.url, lastFrame!.url] : mode === "i2va" ? [firstFrame!.url] : [];
    return { mode, images: [...keyframeImages, ...images], videos, audios };
}

export function buildMinimaxH3VideoRequest(input: { model: string; prompt: string; resolution: string; aspectRatio?: string; duration: number; references: VideoGenerationReference[] }) {
    const model = input.model.trim();
    if (!MINIMAX_H3_MODELS.includes(model as (typeof MINIMAX_H3_MODELS)[number])) throw new Error("模型不在 MiniMax H3 公开模型列表中");
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("MiniMax H3 必须填写文本提示词");
    if (Array.from(prompt).length > MINIMAX_H3_PROMPT_MAX_CHARS) throw new Error(`MiniMax H3 提示词不能超过 ${MINIMAX_H3_PROMPT_MAX_CHARS} 字符`);
    const duration = input.duration;
    if (!Number.isInteger(duration) || duration < 5 || duration > 15) throw new Error("MiniMax H3 时长必须是 5-15 秒整数");
    const resolution = input.resolution.trim() === "480p" ? "480p" : "720p";
    const aspectRatio = (input.aspectRatio || "").trim();

    const { mode, images, videos, audios } = minimaxH3VideoMedia(input.references);
    return {
        model,
        mode,
        resolution,
        seconds: String(duration),
        prompt,
        ...(MINIMAX_H3_ASPECT_RATIOS.includes(aspectRatio as (typeof MINIMAX_H3_ASPECT_RATIOS)[number]) ? { aspect_ratio: aspectRatio } : {}),
        ...(mode === "t2va" ? {} : { images }),
        ...(videos.length ? { videos } : {}),
        ...(audios.length ? { audios } : {}),
    };
}

function uniqueUrls(values: string[]) {
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
