import { normalizeVideoGenerationReferences, regularVideoReferences, videoFrameReferences, type VideoGenerationReference } from "@/lib/video-reference-contract";

export const MINIMAX_H3_OFFICIAL_MODELS = ["MiniMax-H3"] as const;
export const MINIMAX_H3_OFFICIAL_RESOLUTIONS = ["768P", "2K"] as const;
export const MINIMAX_H3_OFFICIAL_ASPECT_RATIOS = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
const MINIMAX_H3_OFFICIAL_PROMPT_MAX_CHARS = 7_000;
const MINIMAX_H3_OFFICIAL_MAX_REFERENCE_IMAGES = 9;
const MINIMAX_H3_OFFICIAL_MAX_REFERENCE_VIDEOS = 3;
const MINIMAX_H3_OFFICIAL_MAX_REFERENCE_AUDIOS = 3;

export function assertMinimaxH3OfficialVideoReferences(references: VideoGenerationReference[]) {
    const normalized = normalizeVideoGenerationReferences(references);
    const { firstFrame, lastFrame } = videoFrameReferences(normalized);
    const regular = regularVideoReferences(normalized);
    if ((firstFrame || lastFrame) && regular.length) throw new Error("MiniMax-H3 首帧/尾帧模式不能与参考素材混用");
    if (regular.length) {
        const images = regular.filter((reference) => reference.type === "image");
        const videos = regular.filter((reference) => reference.type === "video");
        const audios = regular.filter((reference) => reference.type === "audio");
        if (images.length > MINIMAX_H3_OFFICIAL_MAX_REFERENCE_IMAGES) throw new Error(`MiniMax-H3 参考图片最多 ${MINIMAX_H3_OFFICIAL_MAX_REFERENCE_IMAGES} 张`);
        if (videos.length > MINIMAX_H3_OFFICIAL_MAX_REFERENCE_VIDEOS) throw new Error(`MiniMax-H3 参考视频最多 ${MINIMAX_H3_OFFICIAL_MAX_REFERENCE_VIDEOS} 个`);
        if (audios.length > MINIMAX_H3_OFFICIAL_MAX_REFERENCE_AUDIOS) throw new Error(`MiniMax-H3 参考音频最多 ${MINIMAX_H3_OFFICIAL_MAX_REFERENCE_AUDIOS} 个`);
    }
}

export function minimaxH3OfficialResolution(value: unknown) {
    const text = typeof value === "string" ? value.trim().toUpperCase() : "";
    return text === "2K" || text === "2KP" || text === "2160" || text === "2160P" ? "2K" : "768P";
}

export function buildMinimaxH3OfficialVideoRequest(input: { model: string; prompt: string; resolution: string; ratio?: string; duration: number; references: VideoGenerationReference[] }) {
    const model = input.model.trim();
    if (!MINIMAX_H3_OFFICIAL_MODELS.includes(model as (typeof MINIMAX_H3_OFFICIAL_MODELS)[number])) throw new Error("模型不在 MiniMax-H3 官方模型列表中");
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("MiniMax-H3 必须填写文本提示词");
    if (Array.from(prompt).length > MINIMAX_H3_OFFICIAL_PROMPT_MAX_CHARS) throw new Error(`MiniMax-H3 提示词不能超过 ${MINIMAX_H3_OFFICIAL_PROMPT_MAX_CHARS} 字符`);
    const duration = input.duration;
    if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw new Error("MiniMax-H3 时长必须是 4-15 秒整数");
    const resolution = minimaxH3OfficialResolution(input.resolution);

    const normalized = normalizeVideoGenerationReferences(input.references);
    const regular = regularVideoReferences(normalized);
    const { firstFrame, lastFrame } = videoFrameReferences(normalized);
    assertMinimaxH3OfficialVideoReferences(normalized);
    const referenceImages = uniqueUrls(regular.filter((reference) => reference.type === "image").map((reference) => reference.url));
    const referenceVideos = uniqueUrls(regular.filter((reference) => reference.type === "video").map((reference) => reference.url));
    const referenceAudios = uniqueUrls(regular.filter((reference) => reference.type === "audio").map((reference) => reference.url));
    const hasKeyframes = Boolean(firstFrame || lastFrame);
    const isTextToVideo = !hasKeyframes && !regular.length;

    const ratio = hasKeyframes ? "adaptive" : isTextToVideo ? validAspectRatio(input.ratio) || "16:9" : validAspectRatio(input.ratio) || "adaptive";

    const content = [
        { type: "text", text: prompt },
        ...(firstFrame ? [{ type: "image_url", image_url: { url: firstFrame.url }, role: "first_frame" as const }] : []),
        ...(lastFrame ? [{ type: "image_url", image_url: { url: lastFrame.url }, role: "last_frame" as const }] : []),
        ...referenceImages.map((url) => ({ type: "image_url", image_url: { url }, role: "reference_image" as const })),
        ...referenceVideos.map((url) => ({ type: "video_url", video_url: { url }, role: "reference_video" as const })),
        ...referenceAudios.map((url) => ({ type: "audio_url", audio_url: { url }, role: "reference_audio" as const })),
    ];

    return { model, content, resolution, duration, ratio };
}

function validAspectRatio(value: string | undefined) {
    const text = (value || "").trim();
    return MINIMAX_H3_OFFICIAL_ASPECT_RATIOS.includes(text as (typeof MINIMAX_H3_OFFICIAL_ASPECT_RATIOS)[number]) ? text : "";
}

function uniqueUrls(values: string[]) {
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
