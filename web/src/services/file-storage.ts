"use client";

import { getServerMediaBlob, parseServerMediaUrl, serverMediaUrl, uploadServerMedia, type ServerMediaType } from "@/services/server-media-storage";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number; remoteUrl?: string; serverUrl?: string; dolaVodPayload?: unknown };

export async function uploadMediaFile(input: string | Blob, prefix = "file", options?: { onProgress?: (percent: number) => void }): Promise<UploadedFile> {
    const type = mediaType(input, prefix);
    const probe = probeLocalMediaMeta(input, type);
    try {
        const stored = await uploadServerMedia(input, type, undefined, options);
        return { ...stored, serverUrl: stored.url, ...probe.metadata() };
    } finally {
        probe.close();
    }
}

export async function uploadGeneratedMediaFile(input: string | Blob, type: Exclude<ServerMediaType, "image">): Promise<UploadedFile> {
    const stored = await uploadServerMedia(input, type, type === "video" ? 200 * 1024 * 1024 : 30 * 1024 * 1024);
    return withMediaMeta(stored);
}

export async function readStoredMediaFile(url: string, _type: Exclude<ServerMediaType, "image">, mimeType: string): Promise<UploadedFile | null> {
    const reference = parseServerMediaUrl(url);
    if (!reference) return null;
    return { url: reference.url, serverUrl: reference.url, storageKey: reference.storageKey, bytes: 0, mimeType };
}

async function withMediaMeta(stored: Awaited<ReturnType<typeof uploadServerMedia>>) {
    return { ...stored, serverUrl: stored.url };
}

function probeLocalMediaMeta(input: string | Blob, type: Exclude<ServerMediaType, "image">) {
    let metadata: Pick<UploadedFile, "width" | "height" | "durationMs"> = {};
    if (typeof input === "string" && !input.startsWith("data:")) return { metadata: () => metadata, close: () => {} };
    const url = input instanceof Blob ? URL.createObjectURL(input) : input;
    const media = document.createElement(type);
    media.onloadedmetadata = () => {
        metadata = {
            ...(type === "video" ? { width: (media as HTMLVideoElement).videoWidth || 1280, height: (media as HTMLVideoElement).videoHeight || 720 } : {}),
            ...(Number.isFinite(media.duration) ? { durationMs: Math.round(media.duration * 1000) } : {}),
        };
    };
    media.onerror = () => {};
    media.src = url;
    return {
        metadata: () => metadata,
        close: () => {
            media.onloadedmetadata = null;
            media.onerror = null;
            if (input instanceof Blob) URL.revokeObjectURL(url);
        },
    };
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    return serverMediaUrl(storageKey, fallback);
}

export function getMediaBlob(storageKey: string, fallback = "") {
    return getServerMediaBlob(storageKey, fallback);
}

export async function setMediaBlob(_storageKey: string, blob: Blob) {
    return (await uploadServerMedia(blob, blob.type.startsWith("audio/") ? "audio" : "video")).url;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    const storageKeys = Array.from(new Set(Array.from(keys, (key) => key.trim()).filter(Boolean)));
    if (!storageKeys.length) return { deletedFiles: 0, blocked: [] };
    const response = await fetch("/api/media-assets", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ storageKeys }) });
    const payload = (await response.json().catch(() => ({}))) as { data?: { deletedFiles?: number; blocked?: unknown[] }; msg?: string };
    if (!response.ok) throw new Error(payload.msg || "服务器媒体删除失败");
    if (payload.data?.blocked?.length) throw new Error("部分媒体仍被会话、项目或素材库引用，服务器文件已保留");
    return payload.data || { deletedFiles: 0, blocked: [] };
}

function mediaType(input: string | Blob, prefix: string): Exclude<ServerMediaType, "image"> {
    const mimeType = input instanceof Blob ? input.type : input.match(/^data:([^;,]+)/)?.[1] || "";
    return mimeType.startsWith("audio/") || prefix.startsWith("audio") ? "audio" : "video";
}
