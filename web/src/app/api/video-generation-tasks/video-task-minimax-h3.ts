import { imageReferenceToFile } from "@/app/api/image-tasks/image-task-support";
import { buildMinimaxH3VideoRequest } from "@/lib/minimax-h3";
import { isExternallyReachableReferenceUrl } from "@/lib/server/provider-task-config";
import type { VideoGenerationReference } from "@/lib/video-reference-contract";

// EasyFrame MiniMax H3：带本地媒体文件时使用 multipart/form-data，images/videos/audios 字段接受 file|URL。
// 参考图无法被上游公网访问（站点未部署在公网）时下载为文件随表单提交；可公网访问时仍走 URL/JSON 原路径。
export async function buildMinimaxH3VideoFormData(input: {
    model: string;
    prompt: string;
    resolution: string;
    aspectRatio?: string;
    duration: number;
    references: VideoGenerationReference[];
    origin: string;
    publicOrigin: string;
    cookie: string;
}): Promise<FormData | undefined> {
    const payload = buildMinimaxH3VideoRequest({
        model: input.model,
        prompt: input.prompt,
        resolution: input.resolution,
        aspectRatio: input.aspectRatio,
        duration: input.duration,
        references: input.references,
    });
    const images = payload.images ?? [];
    const videos = payload.videos ?? [];
    const audios = payload.audios ?? [];
    if (!images.length && !videos.length && !audios.length) return undefined;
    if ([...images, ...videos, ...audios].every((url) => isExternallyReachableReferenceUrl(url))) return undefined;

    const form = new FormData();
    form.set("model", payload.model);
    form.set("mode", payload.mode);
    form.set("resolution", payload.resolution);
    form.set("seconds", payload.seconds);
    form.set("prompt", payload.prompt);
    if (payload.aspect_ratio) form.set("aspect_ratio", payload.aspect_ratio);
    for (const [index, url] of images.entries()) {
        if (isExternallyReachableReferenceUrl(url)) {
            form.append("images", url);
            continue;
        }
        const file = await imageReferenceToFile({ dataUrl: "", url: internalReferenceInput(url, input.publicOrigin) }, `reference-${index + 1}.png`, input.origin, input.cookie);
        form.append("images", file);
    }
    for (const url of videos) form.append("videos", url);
    for (const url of audios) form.append("audios", url);
    return form;
}

function internalReferenceInput(url: string, publicOrigin: string) {
    const value = url.trim();
    if (value.startsWith("/")) return value;
    const origin = normalizeOrigin(publicOrigin);
    if (!origin || !value.startsWith(`${origin}/`)) return value;
    return value.slice(origin.length);
}

function normalizeOrigin(value: string) {
    try {
        const url = new URL(value.trim());
        return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
    } catch {
        return "";
    }
}
