import { normalizeVideoGenerationReferences, regularVideoReferences, videoFrameReferences, type VideoGenerationReference } from "@/lib/video-reference-contract";

export const MINIMAX_H3_MODELS = ["minimax-h3-mini", "minimax-h3-fast", "minimax-h3-base", "minimax-h3-pro"] as const;
export const MINIMAX_H3_RESOLUTIONS = ["480p", "720p"] as const;
export const MINIMAX_H3_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "9:21", "4:5", "5:4"] as const;
export const MINIMAX_H3_PROMPT_MAX_CHARS = 30_000;
const MINIMAX_H3_MAX_IMAGES = 9;
const MINIMAX_H3_MAX_VIDEOS = 3;
const MINIMAX_H3_MAX_AUDIOS = 3;
const MINIMAX_H3_MAX_MEDIA = 15;

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
