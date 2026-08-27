import { imageReferenceToFile } from "@/app/api/image-tasks/image-task-support";
import { buildMinimaxH3VideoRequest } from "@/lib/minimax-h3";
import { isExternallyReachableReferenceUrl } from "@/lib/server/provider-task-config";
import type { VideoGenerationReference } from "@/lib/video-reference-contract";

// EasyFrame MiniMax H3：带本地媒体文件时使用 multipart/form-data，images/videos/audios 字段接受 file|URL。
// 站点自产媒体即使被拼成公网 URL，也由服务端读取后作为文件提交，避免临时隧道或签名地址失效。
// 只有真正属于外部站点的公网媒体继续走 URL/JSON 原路径。
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
    if ([...images, ...videos, ...audios].every((url) => isExternalProviderReference(url, input.publicOrigin))) return undefined;

    const form = new FormData();
    form.set("model", payload.model);
    form.set("mode", payload.mode);
    form.set("resolution", payload.resolution);
    form.set("seconds", payload.seconds);
    form.set("prompt", payload.prompt);
    if (payload.aspect_ratio) form.set("aspect_ratio", payload.aspect_ratio);
    for (const [index, url] of images.entries()) {
        if (isExternalProviderReference(url, input.publicOrigin)) {
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

function isExternalProviderReference(url: string, publicOrigin: string) {
    const value = url.trim();
    if (!isExternallyReachableReferenceUrl(value)) return false;
    const origin = normalizeOrigin(publicOrigin);
    return !origin || !value.startsWith(`${origin}/`);
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
